/**
 * Vertical-slice tests.
 *
 * Weighted toward the properties whose failure would be a patient-safety or
 * compliance problem rather than a bug: rejected drafts must not reach the
 * chart or a claim, unsigned notes must not be billable, AI output must be
 * traceable, and the record must remain usable with AI switched off.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { EventLog, deterministicClock } from '../src/core/eventLog.ts';
import { chartFor, pendingReview, project, projectAsOf } from '../src/core/projection.ts';
import { ledger, modelStats, toFhirProvenance } from '../src/core/provenance.ts';
import { canonicalize } from '../src/core/events.ts';
import { extractFindings } from '../src/ai/extract.ts';
import { generateNote } from '../src/ai/note.ts';
import { ModelRouter, type RoutingContext } from '../src/ai/router.ts';
import { createDeterministicProvider, detectBloodPressure } from '../src/ai/providers/deterministic.ts';
import { parseSpokenNumber } from '../src/ai/lexicon.ts';
import { hasCodeSwitching, spanOf } from '../src/ai/transcript.ts';
import { ClinicalWorkspace, buildNoteDocument, type Clinician } from '../src/clinical/workspace.ts';
import { approveClaim, buildDraftClaim, fileDraftClaim, suggestCoding } from '../src/billing/coding.ts';
import type { DocumentReference, MedicationRequest, Patient } from '../src/fhir/types.ts';
import { ENCOUNTER_TRANSCRIPT } from '../fixtures/encounter-transcript.ts';

const CLINICIAN: Clinician = { id: 'prac-0007', display: 'Dr. A. Reyes', role: 'Physician' };
const TENANT = 'tenant-test';
const ROUTING: RoutingContext = {
  connectivity: 'offline',
  identifiedPhi: true,
  latencyBudgetMs: 20_000,
};

const PATIENT: Omit<Patient, 'resourceType' | 'meta'> = {
  id: 'pat-0001',
  identifier: [{ system: 'http://vita-emr.org/mpi', value: 'MPI-000001' }],
  name: [{ family: 'Bautista', given: ['Maria'] }],
  gender: 'female',
  birthDate: '1968-07-14',
};

function setup(router = new ModelRouter([createDeterministicProvider()])) {
  const log = new EventLog(TENANT, deterministicClock());
  const workspace = new ClinicalWorkspace(log);
  const patient = workspace.registerPatient(PATIENT, CLINICIAN);
  const encounter = workspace.openEncounter(
    { id: 'enc-0001', patientId: patient.id, class: 'AMB', start: '2026-03-02T09:05:00.000Z' },
    CLINICIAN,
  );
  return { log, workspace, patient, encounter, router };
}

function runEncounter(router = new ModelRouter([createDeterministicProvider()])) {
  const ctx = setup(router);
  const extraction = extractFindings(router, ENCOUNTER_TRANSCRIPT, ROUTING);
  const drafts = ctx.workspace.fileDrafts(extraction, {
    patientId: ctx.patient.id,
    encounterId: ctx.encounter.id,
    recordedAt: '2026-03-02T09:22:00.000Z',
  });
  const note = generateNote(router, ENCOUNTER_TRANSCRIPT, extraction, ROUTING);
  const filedNote = ctx.workspace.fileNoteDraft(note.draft!, note.provenance!, {
    patientId: ctx.patient.id,
    encounterId: ctx.encounter.id,
    recordedAt: '2026-03-02T09:22:00.000Z',
    noteId: 'note-0001',
  });
  return { ...ctx, extraction, drafts, note, filedNote };
}

// ── Extraction ───────────────────────────────────────────────────────────────

describe('extraction', () => {
  test('reads a blood pressure dictated as words', () => {
    const bp = detectBloodPressure('One-fifty over ninety-five. Mataas pa rin.');
    assert.deepEqual(bp, { systolic: 150, diastolic: 95, matchText: 'One-fifty over ninety-five' });
  });

  test('reads a blood pressure written as digits', () => {
    const bp = detectBloodPressure('BP today 150/95 sitting');
    assert.equal(bp?.systolic, 150);
    assert.equal(bp?.diastolic, 95);
  });

  test('rejects implausible readings rather than inventing a vital sign', () => {
    assert.equal(detectBloodPressure('five over ten'), null);
    // Diastolic must be below systolic.
    assert.equal(detectBloodPressure('ninety over one-fifty'), null);
  });

  test('parses colloquial spoken hundreds', () => {
    assert.equal(parseSpokenNumber('one fifty'), 150);
    assert.equal(parseSpokenNumber('one-forty'), 140);
    assert.equal(parseSpokenNumber('two hundred'), 200);
    assert.equal(parseSpokenNumber('ninety-five'), 95);
    assert.equal(parseSpokenNumber('50'), 50);
  });

  test('parses strictly, so an unknown word invalidates the window', () => {
    // Returning a partial 95 here would let the wrong token window win when
    // the caller widens its search.
    assert.equal(parseSpokenNumber('ninety five mataas'), null);
    assert.equal(parseSpokenNumber('losartan fifty'), null);
  });

  test('handles a code-switched encounter', () => {
    assert.ok(hasCodeSwitching(ENCOUNTER_TRANSCRIPT));
    const { findings } = extractFindings(
      new ModelRouter([createDeterministicProvider()]),
      ENCOUNTER_TRANSCRIPT,
      ROUTING,
    );
    const keys = findings.map((f) => f.conceptKey).sort();
    // "ubo" and "masakit ang ulo" are only recoverable from the Filipino.
    assert.deepEqual(keys, [
      'amlodipine',
      'blood-pressure',
      'cough',
      'dizziness',
      'fever',
      'headache',
      'hypertension',
      'losartan',
      'penicillin',
    ]);
  });

  test('collapses repeated mentions of one drug into a single order', () => {
    const { findings } = extractFindings(
      new ModelRouter([createDeterministicProvider()]),
      ENCOUNTER_TRANSCRIPT,
      ROUTING,
    );
    const amlodipine = findings.filter((f) => f.conceptKey === 'amlodipine');
    assert.equal(amlodipine.length, 1, 'amlodipine is named twice but is one medication');
    assert.equal(amlodipine[0].medication?.dose, 5);
  });

  test('distinguishes continuing therapy from newly started therapy', () => {
    const { findings } = extractFindings(
      new ModelRouter([createDeterministicProvider()]),
      ENCOUNTER_TRANSCRIPT,
      ROUTING,
    );
    const amlodipine = findings.find((f) => f.conceptKey === 'amlodipine');
    const losartan = findings.find((f) => f.conceptKey === 'losartan');
    // Both appear in "Continue the amlodipine, and add losartan …".
    assert.equal(amlodipine?.medication?.continuing, true);
    assert.equal(losartan?.medication?.continuing, false, 'losartan is being added, not continued');
    assert.equal(losartan?.medication?.dose, 50);
    assert.equal(losartan?.medication?.frequency, 'once daily');
  });

  test('attaches an allergy reaction only from the same utterance', () => {
    const { findings } = extractFindings(
      new ModelRouter([createDeterministicProvider()]),
      ENCOUNTER_TRANSCRIPT,
      ROUTING,
    );
    const allergy = findings.find((f) => f.kind === 'allergy');
    assert.equal(allergy?.conceptKey, 'penicillin');
    assert.equal(allergy?.allergy?.manifestations.length, 2);
  });

  test('every finding is traceable to audio', () => {
    const { findings } = extractFindings(
      new ModelRouter([createDeterministicProvider()]),
      ENCOUNTER_TRANSCRIPT,
      ROUTING,
    );
    for (const finding of findings) {
      assert.ok(finding.spans.length > 0, `${finding.conceptKey} has no span`);
      for (const span of finding.spans) {
        assert.ok(span.audioEndMs > span.audioStartMs, 'span must resolve to a playable range');
      }
    }
  });

  test('a span points at the text it claims to', () => {
    const span = spanOf(ENCOUNTER_TRANSCRIPT, 'u9', 'penicillin');
    const utterance = ENCOUNTER_TRANSCRIPT.utterances.find((u) => u.id === 'u9')!;
    assert.equal(utterance.text.slice(span.startChar, span.endChar).toLowerCase(), 'penicillin');
  });
});

// ── Note generation ──────────────────────────────────────────────────────────

describe('note generation', () => {
  test('every sentence carries a citation', () => {
    const { note } = runEncounter();
    assert.ok(note.draft!.sentences.length > 0);
    for (const sentence of note.draft!.sentences) {
      assert.ok(sentence.spans.length > 0, `uncited: "${sentence.text}"`);
    }
  });

  test('note-level confidence is the weakest finding, not the average', () => {
    const { note, extraction } = runEncounter();
    const weakest = Math.min(...extraction.findings.map((f) => f.confidence));
    assert.equal(note.provenance!.confidence, weakest);
  });
});

// ── Review, signing, and the chart ───────────────────────────────────────────

describe('review and signing', () => {
  test('drafts land in the chart as provisional, not attested', () => {
    const { log, patient } = runEncounter();
    const chart = chartFor(log, patient.id, { actorId: CLINICIAN.id, purpose: 'treatment' });
    const condition = chart.byType('Condition')[0].resource;
    assert.equal(condition.resourceType, 'Condition');
    assert.equal(condition.verificationStatus.coding[0].code, 'provisional');
    const med = chart.byType('MedicationRequest')[0].resource as MedicationRequest;
    assert.equal(med.status, 'draft');
  });

  test('accepting promotes a draft to attested state', () => {
    const { log, workspace, drafts, patient } = runEncounter();
    const cough = drafts.find((d) => d.finding.conceptKey === 'cough')!;
    workspace.review(cough.eventId, 'accept', CLINICIAN);
    const entry = [...project(log).values()].find((e) => e.resource.id === cough.resourceId)!;
    assert.equal(entry.awaitingReview, false);
    const resource = entry.resource;
    assert.equal(resource.resourceType, 'Condition');
    assert.equal(resource.verificationStatus.coding[0].code, 'confirmed');
    assert.equal(chartFor(log, patient.id, { actorId: 'x', purpose: 'treatment' }).entries.length > 0, true);
  });

  test('a rejected draft leaves the chart but stays in the log', () => {
    const { log, workspace, drafts } = runEncounter();
    const fever = drafts.find((d) => d.finding.conceptKey === 'fever')!;
    workspace.review(fever.eventId, 'reject', CLINICIAN);

    const inChart = [...project(log).values()].some((e) => e.resource.id === fever.resourceId);
    assert.equal(inChart, false, 'rejected draft must not appear in the chart');
    assert.ok(
      log.forResource(fever.resourceId).length >= 2,
      'the rejection is still recorded — nothing is deleted',
    );
  });

  test('signing is refused while any draft is unreviewed', () => {
    const { workspace, filedNote } = runEncounter();
    assert.throws(
      () => workspace.signNote(filedNote.eventId, CLINICIAN, { signedAt: 'now' }),
      /unreviewed AI drafts remain/,
    );
  });

  test('signing succeeds once every draft is dispositioned', () => {
    const { workspace, drafts, filedNote, log, patient } = runEncounter();
    for (const draft of drafts) workspace.review(draft.eventId, 'accept', CLINICIAN);
    const signed = workspace.signNote(filedNote.eventId, CLINICIAN, {
      signedAt: '2026-03-02T09:31:00.000Z',
    });
    assert.equal(signed.docStatus, 'final');
    assert.equal(signed.attester?.[0].party.display, CLINICIAN.display);
    assert.equal(pendingReview(log, patient.id).length, 0);
  });

  test('reviewing a human-authored event is refused', () => {
    const { workspace, log } = runEncounter();
    const patientEvent = log.all().find((e) => e.resourceType === 'Patient')!;
    assert.throws(
      () => workspace.review(patientEvent.id, 'accept', CLINICIAN),
      /not an AI draft/,
    );
  });

  test('an edit requires the corrected resource', () => {
    const { workspace, drafts } = runEncounter();
    assert.throws(
      () => workspace.review(drafts[0].eventId, 'edit', CLINICIAN),
      /edit requires the corrected resource/,
    );
  });
});

// ── Billing gates ────────────────────────────────────────────────────────────

describe('billing', () => {
  function signedEncounter() {
    const ctx = runEncounter();
    for (const draft of ctx.drafts) {
      const action = draft.finding.conceptKey === 'fever' ? 'reject' : 'accept';
      ctx.workspace.review(draft.eventId, action, CLINICIAN);
    }
    const signed = ctx.workspace.signNote(ctx.filedNote.eventId, CLINICIAN, {
      signedAt: '2026-03-02T09:31:00.000Z',
    });
    const accepted = {
      ...ctx.extraction,
      findings: ctx.extraction.findings.filter((f) => f.conceptKey !== 'fever'),
    };
    const coding = suggestCoding(ctx.router, accepted, ROUTING);
    return { ...ctx, signed, coding };
  }

  test('a claim cannot be built from an unsigned note', () => {
    const { filedNote, extraction, router, patient } = runEncounter();
    const coding = suggestCoding(router, extraction, ROUTING);
    assert.throws(
      () =>
        buildDraftClaim({
          claimId: 'claim-0001',
          patientId: patient.id,
          note: filedNote.document,
          provider: CLINICIAN,
          diagnoses: coding.suggestion!.diagnoses,
          created: 'now',
        }),
      /refusing to build a claim from an unsigned note/,
    );
  });

  test('a rejected finding never reaches the claim', () => {
    const { signed, coding, patient } = signedEncounter();
    const claim = buildDraftClaim({
      claimId: 'claim-0001',
      patientId: patient.id,
      note: signed,
      provider: CLINICIAN,
      diagnoses: coding.suggestion!.diagnoses,
      created: 'now',
    });
    const codes = claim.diagnosis.map((d) => d.diagnosisCodeableConcept.coding[0].code);
    assert.ok(!codes.includes('R50.9'), 'rejected fever must not be billed');
    assert.ok(codes.includes('I10'), 'accepted hypertension should be billed');
  });

  test('a claim is created as draft and only a human activates it', () => {
    const { signed, coding, patient, log } = signedEncounter();
    const claim = buildDraftClaim({
      claimId: 'claim-0001',
      patientId: patient.id,
      note: signed,
      provider: CLINICIAN,
      diagnoses: coding.suggestion!.diagnoses,
      created: 'now',
    });
    assert.equal(claim.status, 'draft');

    const draftEventId = fileDraftClaim(log, claim, coding.provenance);
    const approved = approveClaim(log, claim, CLINICIAN, draftEventId);
    assert.equal(approved.status, 'active');

    const approval = log.forResource(claim.id).at(-1)!;
    assert.equal(approval.actor.kind, 'human', 'money is never moved by an agent');
    assert.equal(approval.reviewOf?.action, 'accept');
  });

  test('a claim with no diagnosis is refused', () => {
    const { signed, patient } = signedEncounter();
    assert.throws(
      () =>
        buildDraftClaim({
          claimId: 'c',
          patientId: patient.id,
          note: signed,
          provider: CLINICIAN,
          diagnoses: [],
          created: 'now',
        }),
      /no diagnosis/,
    );
  });
});

// ── Event log integrity and audit ────────────────────────────────────────────

describe('event log', () => {
  test('the hash chain verifies on an untouched log', () => {
    const { log } = runEncounter();
    assert.equal(log.verifyChain(), null);
  });

  test('tampering with a historical event is detected', () => {
    const { log } = runEncounter();
    // Reach past the API to simulate a database-level edit by an insider.
    const events = log.all() as unknown as Record<string, unknown>[];
    const target = { ...events[2] };
    target.resource = { ...(target.resource as object), id: 'tampered' };
    events[2] = target;

    const broken = log.verifyChain();
    assert.ok(broken, 'a modified event must break the chain');
    assert.equal(broken!.brokenAt.seq, 2);
  });

  test('cross-tenant writes are rejected', () => {
    const { log } = setup();
    assert.throws(
      () =>
        log.append({
          tenantId: 'some-other-hospital',
          actor: { kind: 'human', id: 'x', display: 'X', role: 'Physician' },
          op: 'create',
          resourceType: 'Patient',
          resourceId: 'pat-9999',
          resource: { ...PATIENT, resourceType: 'Patient' },
        }),
      /tenant mismatch/,
    );
  });

  test('canonicalization is key-order independent', () => {
    assert.equal(canonicalize({ a: 1, b: [2, { c: 3 }] }), canonicalize({ b: [2, { c: 3 }], a: 1 }));
  });

  test('reads of PHI are audited, including break-the-glass', () => {
    const { log, patient } = runEncounter();
    chartFor(log, patient.id, {
      actorId: 'prac-9999',
      purpose: 'emergency',
      breakTheGlass: { justification: 'unresponsive patient, no consent obtainable' },
    });
    const reads = log.reads();
    assert.equal(reads.length, 1);
    assert.equal(reads[0].actorId, 'prac-9999');
    assert.match(reads[0].breakTheGlass!.justification, /unresponsive/);
  });

  test('the chart can be reconstructed as of any point in history', () => {
    const { log } = runEncounter();
    const afterRegistration = projectAsOf(log, 0);
    assert.equal(afterRegistration.size, 1, 'only the patient existed at seq 0');
    assert.ok(project(log).size > afterRegistration.size);
  });
});

// ── Provenance ledger ────────────────────────────────────────────────────────

describe('provenance ledger', () => {
  test('every AI-authored record is in the ledger with its own confidence', () => {
    const { log, drafts } = runEncounter();
    const entries = ledger(log);
    assert.equal(entries.length, drafts.length + 1, 'drafts plus the note');
    const bp = entries.find((e) => e.resourceId.includes('blood-pressure'))!;
    const cough = entries.find((e) => e.resourceId.includes('cough'))!;
    assert.notEqual(bp.provenance.confidence, cough.provenance.confidence);
    for (const entry of entries) {
      assert.ok(entry.provenance.promptHash.length === 64, 'prompt hash recorded');
      assert.ok(entry.provenance.inputRefs.length > 0, 'inputs referenced');
    }
  });

  test('dispositions are resolved onto the ledger', () => {
    const { log, workspace, drafts } = runEncounter();
    workspace.review(drafts[0].eventId, 'accept', CLINICIAN);
    workspace.review(drafts[1].eventId, 'reject', CLINICIAN);

    const entries = ledger(log);
    assert.equal(entries.find((e) => e.eventId === drafts[0].eventId)!.review!.action, 'accept');
    assert.equal(entries.find((e) => e.eventId === drafts[1].eventId)!.review!.action, 'reject');
    assert.equal(entries.find((e) => e.eventId === drafts[2].eventId)!.review, undefined);
  });

  test('override rate is computed over reviewed drafts only', () => {
    const { log, workspace, drafts } = runEncounter();
    workspace.review(drafts[0].eventId, 'accept', CLINICIAN);
    workspace.review(drafts[1].eventId, 'reject', CLINICIAN);
    const stats = modelStats(log)[0];
    assert.equal(stats.accepted, 1);
    assert.equal(stats.rejected, 1);
    assert.equal(stats.overrideRate, 0.5);
    assert.ok(stats.pending > 0);
  });

  test('attributed cost does not multiply with the number of findings', () => {
    const { log, router } = runEncounter();
    const attributed = modelStats(log).reduce((sum, s) => sum + s.totalCostUsd, 0);
    assert.ok(
      attributed <= router.costSummary().totalCostUsd + 1e-9,
      `attributed $${attributed} exceeds actual $${router.costSummary().totalCostUsd}`,
    );
  });

  test('FHIR Provenance is projected from the same events', () => {
    const { log, drafts } = runEncounter();
    const provenance = toFhirProvenance(log, drafts[0].resourceId)!;
    assert.equal(provenance.resourceType, 'Provenance');
    assert.equal(provenance.target[0].reference, `Condition/${drafts[0].resourceId}`);
    assert.equal(provenance.agent[0].type.coding[0].code, 'assembler');
  });
});

// ── Routing and the AI-disabled path ─────────────────────────────────────────

describe('model routing', () => {
  test('an offline site is not routed to a provider that needs connectivity', () => {
    const cloudOnly = createDeterministicProvider();
    cloudOnly.meta = { ...cloudOnly.meta, runsOffline: false, id: 'cloud-only' };
    const router = new ModelRouter([cloudOnly]);

    const decision = router.select('extraction', { ...ROUTING, connectivity: 'offline' });
    assert.equal(decision.provider, null);
    assert.ok(decision.skipped.some((s) => s.reason.includes('requires connectivity')));

    const online = router.select('extraction', { ...ROUTING, connectivity: 'online' });
    assert.equal(online.provider?.meta.id, 'cloud-only');
  });

  test('identified PHI is not routed across a border', () => {
    const offshore = createDeterministicProvider();
    offshore.meta = { ...offshore.meta, dataResidency: 'cross-border', id: 'offshore' };
    const router = new ModelRouter([offshore]);

    assert.equal(router.select('extraction', { ...ROUTING, identifiedPhi: true }).provider, null);
    assert.equal(
      router.select('extraction', { ...ROUTING, identifiedPhi: false }).provider?.meta.id,
      'offshore',
    );
  });

  test('a provider slower than the budget is skipped', () => {
    const slow = createDeterministicProvider();
    slow.meta = { ...slow.meta, typicalLatencyMs: 60_000 };
    const decision = new ModelRouter([slow]).select('note-generation', ROUTING);
    assert.equal(decision.provider, null);
    assert.ok(decision.skipped.some((s) => s.reason.includes('exceeds budget')));
  });

  test('an unavailable provider falls through instead of failing', () => {
    const down = createDeterministicProvider({ available: () => false });
    const decision = new ModelRouter([down]).select('extraction', ROUTING);
    assert.equal(decision.provider, null);
    assert.match(decision.rationale, /proceeds without AI assistance/);
  });
});

describe('with AI fully disabled', () => {
  test('the encounter still works and costs nothing', () => {
    const router = ModelRouter.disabled();
    const { workspace, patient, encounter, log } = setup(router);

    const extraction = extractFindings(router, ENCOUNTER_TRANSCRIPT, ROUTING);
    assert.equal(extraction.findings.length, 0);
    assert.equal(extraction.provenance, null);
    assert.match(extraction.decision.rationale, /disabled/);

    // Filing an empty extraction is a no-op, not an error.
    assert.deepEqual(
      workspace.fileDrafts(extraction, {
        patientId: patient.id,
        encounterId: encounter.id,
        recordedAt: 'now',
      }),
      [],
    );

    const note = generateNote(router, ENCOUNTER_TRANSCRIPT, extraction, ROUTING);
    assert.equal(note.draft, null);

    // The chart is still there, and a clinician can still chart by hand.
    const chart = chartFor(log, patient.id, { actorId: CLINICIAN.id, purpose: 'treatment' });
    assert.equal(chart.entries.length, 2);
    assert.equal(router.costSummary().totalCostUsd, 0);
    assert.equal(ledger(log).length, 0);
  });

  test('a note charted entirely by hand can still be signed and billed', () => {
    const router = ModelRouter.disabled();
    const { workspace, patient, encounter, log } = setup(router);

    // No AI anywhere in this path: the clinician writes the note themselves.
    const typed = buildNoteDocument(
      {
        format: 'SOAP',
        sentences: [
          {
            section: 'Assessment',
            text: 'Hypertension follow-up, typed by hand.',
            spans: [spanOf(ENCOUNTER_TRANSCRIPT, 'u11', 'hypertension')],
          },
        ],
        promptHash: '',
        latencyMs: 0,
      },
      {
        patientId: patient.id,
        encounterId: encounter.id,
        recordedAt: 'now',
        noteId: 'note-manual',
      },
    );
    const manual: DocumentReference = {
      ...typed,
      docStatus: 'final',
      attester: [
        { mode: 'legal', time: 'now', party: { reference: `Practitioner/${CLINICIAN.id}` } },
      ],
    };
    log.append({
      tenantId: TENANT,
      actor: { kind: 'human', ...CLINICIAN },
      op: 'create',
      resourceType: 'DocumentReference',
      resourceId: manual.id,
      resource: manual,
    });

    const claim = buildDraftClaim({
      claimId: 'claim-manual',
      patientId: patient.id,
      note: manual,
      provider: CLINICIAN,
      diagnoses: [
        {
          code: { coding: [{ system: 'http://hl7.org/fhir/sid/icd-10', code: 'I10' }] },
          rationale: 'Charted by the clinician.',
          spans: [],
        },
      ],
      created: 'now',
    });
    assert.equal(claim.status, 'draft');
    assert.equal(ledger(log).length, 0, 'no AI touched this encounter');
  });
});
