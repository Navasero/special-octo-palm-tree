/**
 * End-to-end vertical slice: one patient, one encounter, ambient note →
 * structured FHIR → signed → billed.
 *
 * Run: npm run demo    (or: node --experimental-strip-types src/demo.ts)
 */

import { EventLog, deterministicClock } from './core/eventLog.ts';
import { chartFor, pendingReview } from './core/projection.ts';
import { ledger, modelStats, toFhirProvenance } from './core/provenance.ts';
import { extractFindings } from './ai/extract.ts';
import { generateNote, renderNote, renderNoteWithCitations } from './ai/note.ts';
import { ModelRouter, type RoutingContext } from './ai/router.ts';
import { createDeterministicProvider } from './ai/providers/deterministic.ts';
import { hasCodeSwitching, languagesIn } from './ai/transcript.ts';
import { buildNoteDocument, ClinicalWorkspace, type Clinician } from './clinical/workspace.ts';
import {
  approveClaim,
  buildDraftClaim,
  fileDraftClaim,
  suggestCoding,
} from './billing/coding.ts';
import type { MedicationRequest } from './fhir/types.ts';
import { ENCOUNTER_TRANSCRIPT } from '../fixtures/encounter-transcript.ts';

const line = (char = '─') => console.log(char.repeat(78));
function heading(step: string, title: string): void {
  console.log('');
  line();
  console.log(`${step}  ${title}`);
  line();
}

const clinician: Clinician = {
  id: 'prac-0007',
  display: 'Dr. A. Reyes',
  role: 'Physician',
};

const clock = deterministicClock('2026-03-02T09:00:00.000Z');
const log = new EventLog('tenant-district-hospital-01', clock);
const workspace = new ClinicalWorkspace(log);

const router = new ModelRouter([createDeterministicProvider()]);
const routing: RoutingContext = {
  connectivity: 'offline', // the rural clinic, mid-outage (assumption #7)
  identifiedPhi: true,
  latencyBudgetMs: 20_000, // ambient note draft ready within 20s
};

// ─── 1. Register the patient ────────────────────────────────────────────────
heading('1.', 'Patient registration');

const patient = workspace.registerPatient(
  {
    id: 'pat-0001',
    identifier: [
      { system: 'http://vita-emr.org/mpi', value: 'MPI-000001' },
      { system: 'http://vita-emr.org/national-id', value: 'NID-1990-4471' },
    ],
    name: [{ family: 'Bautista', given: ['Maria', 'Corazon'] }],
    gender: 'female',
    birthDate: '1968-07-14',
    communication: [
      { language: { coding: [{ system: 'urn:ietf:bcp:47', code: 'fil' }] }, preferred: true },
      { language: { coding: [{ system: 'urn:ietf:bcp:47', code: 'en' }] } },
    ],
  },
  clinician,
);
console.log(`Registered ${patient.name[0].given.join(' ')} ${patient.name[0].family} (${patient.id})`);

// ─── 2. Open the encounter ──────────────────────────────────────────────────
heading('2.', 'Encounter');

const encounter = workspace.openEncounter(
  { id: 'enc-0001', patientId: patient.id, class: 'AMB', start: '2026-03-02T09:05:00.000Z' },
  clinician,
);
console.log(`Opened ${encounter.id} (${encounter.class.code}, ${encounter.status})`);

// ─── 3. Ambient capture ─────────────────────────────────────────────────────
heading('3.', 'Ambient capture → structured extraction (Layer 1)');

const transcript = ENCOUNTER_TRANSCRIPT;
console.log(`Transcript ${transcript.id}: ${transcript.utterances.length} utterances`);
console.log(`Languages: ${languagesIn(transcript).join(', ')}`);
console.log(`Intra-sentential code-switching: ${hasCodeSwitching(transcript) ? 'yes' : 'no'}`);

const extraction = extractFindings(router, transcript, routing);
console.log(`\nRouting: ${extraction.decision.rationale}`);
for (const skip of extraction.decision.skipped) {
  console.log(`  skipped ${skip.tier}: ${skip.reason}`);
}
console.log(`\nExtracted ${extraction.findings.length} findings:`);
for (const finding of extraction.findings) {
  const cite = finding.spans.map((s) => `${s.utteranceId}@${s.audioStartMs}ms`).join(', ');
  console.log(
    `  [${finding.kind.padEnd(10)}] ${finding.display.padEnd(22)} ` +
      `conf=${finding.confidence.toFixed(2)}  ← ${cite}`,
  );
}

// ─── 4. File as FHIR drafts ─────────────────────────────────────────────────
heading('4.', 'Drafts filed as FHIR resources');

const recordedAt = '2026-03-02T09:22:00.000Z';
const drafts = workspace.fileDrafts(extraction, {
  patientId: patient.id,
  encounterId: encounter.id,
  recordedAt,
});
for (const draft of drafts) {
  console.log(`  ${draft.resourceType.padEnd(20)} ${draft.resourceId}   (event ${draft.eventId})`);
}
console.log(`\n${pendingReview(log, patient.id).length} drafts awaiting clinician review.`);

// ─── 5. Note generation ─────────────────────────────────────────────────────
heading('5.', 'Note generation, every sentence cited');

const note = generateNote(router, transcript, extraction, routing);
if (!note.draft || !note.provenance) throw new Error('demo expects a note draft');
console.log(renderNoteWithCitations(note.draft));

const filedNote = workspace.fileNoteDraft(note.draft, note.provenance, {
  patientId: patient.id,
  encounterId: encounter.id,
  recordedAt,
  noteId: 'note-0001',
});
console.log(`\nFiled ${filedNote.document.id} as docStatus=${filedNote.document.docStatus}`);

// ─── 6. The signing guard ───────────────────────────────────────────────────
heading('6.', 'Signing is refused while drafts are unreviewed');

try {
  workspace.signNote(filedNote.eventId, clinician, { signedAt: '2026-03-02T09:30:00.000Z' });
  console.log('!! expected the signature to be refused');
} catch (error) {
  console.log(`Refused, correctly: ${(error as Error).message.slice(0, 180)}…`);
}

// ─── 7. Clinician review ────────────────────────────────────────────────────
heading('7.', 'Clinician reviews each draft (accept / edit / reject)');

for (const draft of drafts) {
  if (draft.finding.conceptKey === 'fever') {
    // Extracted from the clinician's *question* ("May lagnat po ba kayo?"),
    // which the patient then denied. A textbook extraction error, and exactly
    // what the reject action is for.
    workspace.review(draft.eventId, 'reject', clinician);
    console.log(`  REJECT  ${draft.resourceId}  — patient denied fever; extracted from a question`);
    continue;
  }

  if (draft.finding.conceptKey === 'losartan') {
    const original = draft.finding;
    const edited = structuredClone(
      log.byId(draft.eventId)!.resource,
    ) as MedicationRequest;
    edited.dosageInstruction = [{ text: '50 mg once daily in the morning' }];
    workspace.review(draft.eventId, 'edit', clinician, edited);
    console.log(
      `  EDIT    ${draft.resourceId}  — dosage refined ` +
        `(conf was ${original.confidence.toFixed(2)})`,
    );
    continue;
  }

  workspace.review(draft.eventId, 'accept', clinician);
  console.log(`  ACCEPT  ${draft.resourceId}`);
}

// ─── 8. Sign ────────────────────────────────────────────────────────────────
heading('8.', 'Note revised to match the review, then signed');

// The note was drafted before review, so it still asserts the rejected fever.
// Signing it unchanged would attest to a finding the clinician just declined —
// so the note is regenerated from what survived review, and signing it counts
// as an edit of the AI draft rather than a clean accept.
const rejectedKeys = new Set(
  drafts
    .filter((d) => log.forResource(d.resourceId).some((e) => e.reviewOf?.action === 'reject'))
    .map((d) => d.finding.conceptKey),
);
const accepted = {
  ...extraction,
  findings: extraction.findings.filter((f) => !rejectedKeys.has(f.conceptKey)),
};

const revised = generateNote(router, transcript, accepted, routing);
if (!revised.draft) throw new Error('demo expects a revised note draft');
console.log(`Dropped from the note after review: ${[...rejectedKeys].join(', ') || '(nothing)'}`);

const signed = workspace.signNote(filedNote.eventId, clinician, {
  signedAt: '2026-03-02T09:31:00.000Z',
  edited: buildNoteDocument(revised.draft, {
    patientId: patient.id,
    encounterId: encounter.id,
    recordedAt,
    noteId: 'note-0001',
  }),
});
console.log(`docStatus=${signed.docStatus}, attested by ${signed.attester![0].party.display}`);

const closed = workspace.finishEncounter(encounter, '2026-03-02T09:32:00.000Z', clinician);
console.log(`Encounter ${closed.id} → ${closed.status}`);
console.log('');
console.log(Buffer.from(signed.content[0].attachment.data, 'base64').toString('utf8'));

// ─── 9. Coding and billing ──────────────────────────────────────────────────
heading('9.', 'Coding → draft claim → human approval');

// Coding runs over what the clinician actually accepted, not over the raw
// extraction — the rejected fever must never reach a claim.
const coding = suggestCoding(router, accepted, routing);
console.log('Suggested diagnoses:');
for (const diagnosis of coding.suggestion?.diagnoses ?? []) {
  const code = diagnosis.code.coding[0];
  console.log(`  ${code.code.padEnd(8)} ${code.display?.padEnd(34)} ${diagnosis.rationale}`);
}
console.log(`\nRejected and therefore not billed: ${[...rejectedKeys].join(', ') || '(none)'}`);

const claim = buildDraftClaim({
  claimId: 'claim-0001',
  patientId: patient.id,
  note: signed,
  provider: clinician,
  diagnoses: coding.suggestion!.diagnoses,
  created: '2026-03-02T09:35:00.000Z',
});
const claimDraftEventId = fileDraftClaim(log, claim, coding.provenance);
console.log(
  `\nClaim ${claim.id}: status=${claim.status}, ` +
    `${claim.diagnosis.length} diagnoses, total ${claim.total!.value} ${claim.total!.currency}`,
);

const approved = approveClaim(log, claim, clinician, claimDraftEventId);
console.log(`After human approval: status=${approved.status} (approved by ${clinician.display})`);

// ─── 10. Chart, provenance, audit ───────────────────────────────────────────
heading('10.', 'Resulting chart');

const chart = chartFor(log, patient.id, { actorId: clinician.id, purpose: 'treatment' });
for (const entry of chart.entries) {
  const resource = entry.resource;
  const status =
    'docStatus' in resource
      ? resource.docStatus
      : 'status' in resource
        ? resource.status
        : 'verificationStatus' in resource
          ? resource.verificationStatus.coding[0].code
          : '—';
  console.log(`  ${resource.resourceType.padEnd(20)} ${resource.id.padEnd(28)} ${status}`);
}
console.log(`\nStill awaiting review: ${pendingReview(log, patient.id).length}`);

heading('11.', 'Provenance ledger (ADR-0004)');

for (const entry of ledger(log)) {
  const disposition = entry.review
    ? `${entry.review.action.toUpperCase()} by ${entry.review.by}`
    : 'PENDING';
  console.log(
    `  ${entry.resourceType.padEnd(20)} ${entry.provenance.modelId}@${entry.provenance.modelVersion} ` +
      `conf=${entry.provenance.confidence.toFixed(2)}  ${disposition}`,
  );
}

console.log('\nPer-model statistics (feeds override-rate monitoring):');
for (const stats of modelStats(log)) {
  console.log(
    `  ${stats.modelId} [${stats.tier}] drafts=${stats.drafts} ` +
      `accept=${stats.accepted} edit=${stats.edited} reject=${stats.rejected} ` +
      `overrideRate=${stats.overrideRate?.toFixed(2) ?? 'n/a'} cost=$${stats.totalCostUsd}`,
  );
}

console.log('\nFHIR Provenance projection for the signed note:');
console.log(JSON.stringify(toFhirProvenance(log, 'note-0001'), null, 2).split('\n').slice(0, 16).join('\n') + '\n  …');

heading('12.', 'Audit, integrity, cost');

console.log(`Events appended: ${log.all().length}`);
console.log(`PHI reads logged: ${log.reads().length}`);
for (const read of log.reads()) {
  console.log(`  ${read.at}  ${read.actorId} read ${read.patientId} for ${read.purpose}`);
}

const integrity = log.verifyChain();
console.log(`\nHash chain: ${integrity ? `BROKEN at ${integrity.brokenAt.id}` : 'intact'}`);

const cost = router.costSummary();
console.log(
  `\nInference cost for this encounter: $${cost.totalCostUsd} across ${cost.calls} calls`,
);
console.log(
  '  (the router counts invocations; the ledger above attributes cost to drafts, so the\n' +
    '   note regeneration after review shows in this total but produced no new draft)',
);
for (const [task, amount] of Object.entries(cost.byTask)) {
  console.log(`  ${task.padEnd(18)} $${amount}`);
}

// ─── 13. AI disabled ────────────────────────────────────────────────────────
heading('13.', 'The same workflow with AI fully disabled');

const offlineLog = new EventLog('tenant-district-hospital-01', deterministicClock());
const offlineWorkspace = new ClinicalWorkspace(offlineLog);
const noAi = ModelRouter.disabled();

offlineWorkspace.registerPatient(
  {
    id: 'pat-0002',
    identifier: [{ system: 'http://vita-emr.org/mpi', value: 'MPI-000002' }],
    name: [{ family: 'Santos', given: ['Jose'] }],
    gender: 'male',
    birthDate: '1975-02-02',
  },
  clinician,
);
offlineWorkspace.openEncounter(
  { id: 'enc-0002', patientId: 'pat-0002', class: 'AMB', start: '2026-03-02T10:00:00.000Z' },
  clinician,
);
const noAiExtraction = extractFindings(noAi, transcript, routing);
console.log(`Routing: ${noAiExtraction.decision.rationale}`);
console.log(`Findings: ${noAiExtraction.findings.length} (clinician charts manually)`);
console.log(
  `Chart still opens: ${
    chartFor(offlineLog, 'pat-0002', { actorId: clinician.id, purpose: 'treatment' }).entries.length
  } resources, no AI involved`,
);
console.log(`Inference cost: $${noAi.costSummary().totalCostUsd}`);

console.log('');
line('═');
console.log('Slice complete: ambient note → structured FHIR → signed → billed.');
line('═');
