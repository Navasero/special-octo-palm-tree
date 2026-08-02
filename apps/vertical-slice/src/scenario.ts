/**
 * The vertical-slice encounter, run start to finish with no output.
 *
 * Extracted so the demo narration, the API server's seed data, and the tests
 * all exercise literally the same flow. A demo that runs a different code
 * path from the tests is a demo that can pass while the product is broken.
 */

import { EventLog, deterministicClock, type Clock } from './core/eventLog.ts';
import { extractFindings, type Extraction } from './ai/extract.ts';
import { generateNote, type GeneratedNote } from './ai/note.ts';
import { ModelRouter, type RoutingContext } from './ai/router.ts';
import { createDeterministicProvider } from './ai/providers/deterministic.ts';
import type { Transcript } from './ai/transcript.ts';
import {
  buildNoteDocument,
  ClinicalWorkspace,
  type Clinician,
  type DraftRef,
} from './clinical/workspace.ts';
import {
  approveClaim,
  buildDraftClaim,
  fileDraftClaim,
  suggestCoding,
  type CodingResult,
} from './billing/coding.ts';
import type {
  Claim,
  DocumentReference,
  Encounter,
  MedicationRequest,
  Patient,
} from './fhir/types.ts';
import { ENCOUNTER_TRANSCRIPT } from '../fixtures/encounter-transcript.ts';

export const DEMO_TENANT = 'tenant-district-hospital-01';

export const DEMO_CLINICIAN: Clinician = {
  id: 'prac-0007',
  display: 'Dr. A. Reyes',
  role: 'Physician',
};

/** The rural clinic mid-outage: offline, identified PHI, 20s note budget. */
export const DEMO_ROUTING: RoutingContext = {
  connectivity: 'offline',
  identifiedPhi: true,
  latencyBudgetMs: 20_000,
};

export type ReviewRecord = {
  resourceId: string;
  action: 'accept' | 'edit' | 'reject';
  note: string;
};

export type EncounterScenario = {
  log: EventLog;
  workspace: ClinicalWorkspace;
  router: ModelRouter;
  transcript: Transcript;
  patient: Patient;
  encounter: Encounter;
  extraction: Extraction;
  drafts: DraftRef[];
  note: GeneratedNote;
  filedNote: { document: DocumentReference; eventId: string };
  /** Message from the signature attempt made before review — proof the guard
   *  fired, captured rather than swallowed so the demo can show it. */
  refusedSignature: string;
  reviews: ReviewRecord[];
  rejectedConceptKeys: string[];
  /** Extraction filtered to what survived review; what the note and the claim
   *  are both built from. */
  accepted: Extraction;
  revisedNote: GeneratedNote;
  signed: DocumentReference;
  closedEncounter: Encounter;
  coding: CodingResult;
  claim: Claim;
  approvedClaim: Claim;
};

const RECORDED_AT = '2026-03-02T09:22:00.000Z';

export function runEncounterScenario(
  options: { clock?: Clock; transcript?: Transcript } = {},
): EncounterScenario {
  const clock = options.clock ?? deterministicClock('2026-03-02T09:00:00.000Z');
  const transcript = options.transcript ?? ENCOUNTER_TRANSCRIPT;

  const log = new EventLog(DEMO_TENANT, clock);
  const workspace = new ClinicalWorkspace(log);
  const router = new ModelRouter([createDeterministicProvider()]);

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
    DEMO_CLINICIAN,
  );

  const encounter = workspace.openEncounter(
    {
      id: 'enc-0001',
      patientId: patient.id,
      class: 'AMB',
      start: '2026-03-02T09:05:00.000Z',
    },
    DEMO_CLINICIAN,
  );

  const extraction = extractFindings(router, transcript, DEMO_ROUTING);
  const drafts = workspace.fileDrafts(extraction, {
    patientId: patient.id,
    encounterId: encounter.id,
    recordedAt: RECORDED_AT,
  });

  const note = generateNote(router, transcript, extraction, DEMO_ROUTING);
  if (!note.draft || !note.provenance) {
    throw new Error('scenario expects the note provider to be available');
  }
  const filedNote = workspace.fileNoteDraft(note.draft, note.provenance, {
    patientId: patient.id,
    encounterId: encounter.id,
    recordedAt: RECORDED_AT,
    noteId: 'note-0001',
  });

  // Attempt the signature too early on purpose: the guard is part of the
  // flow being demonstrated, not an error path bolted on.
  let refusedSignature = '';
  try {
    workspace.signNote(filedNote.eventId, DEMO_CLINICIAN, { signedAt: RECORDED_AT });
    throw new Error('scenario expected the premature signature to be refused');
  } catch (error) {
    refusedSignature = (error as Error).message;
  }

  const reviews: ReviewRecord[] = [];
  for (const draft of drafts) {
    if (draft.finding.conceptKey === 'fever') {
      // Extracted from the clinician's question ("May lagnat po ba kayo?"),
      // which the patient then denied.
      workspace.review(draft.eventId, 'reject', DEMO_CLINICIAN);
      reviews.push({
        resourceId: draft.resourceId,
        action: 'reject',
        note: 'patient denied fever; extracted from a question',
      });
      continue;
    }
    if (draft.finding.conceptKey === 'losartan') {
      const edited = structuredClone(log.byId(draft.eventId)!.resource) as MedicationRequest;
      edited.dosageInstruction = [{ text: '50 mg once daily in the morning' }];
      workspace.review(draft.eventId, 'edit', DEMO_CLINICIAN, edited);
      reviews.push({ resourceId: draft.resourceId, action: 'edit', note: 'dosage refined' });
      continue;
    }
    workspace.review(draft.eventId, 'accept', DEMO_CLINICIAN);
    reviews.push({ resourceId: draft.resourceId, action: 'accept', note: '' });
  }

  const rejectedConceptKeys = drafts
    .filter((draft) => log.forResource(draft.resourceId).some((e) => e.reviewOf?.action === 'reject'))
    .map((draft) => draft.finding.conceptKey);

  const accepted: Extraction = {
    ...extraction,
    findings: extraction.findings.filter((f) => !rejectedConceptKeys.includes(f.conceptKey)),
  };

  // The note was drafted before review and still asserts the rejected
  // finding, so it is regenerated from what survived and signed as an edit.
  const revisedNote = generateNote(router, transcript, accepted, DEMO_ROUTING);
  if (!revisedNote.draft) throw new Error('scenario expects a revised note draft');

  const signed = workspace.signNote(filedNote.eventId, DEMO_CLINICIAN, {
    signedAt: '2026-03-02T09:31:00.000Z',
    edited: buildNoteDocument(revisedNote.draft, {
      patientId: patient.id,
      encounterId: encounter.id,
      recordedAt: RECORDED_AT,
      noteId: 'note-0001',
    }),
  });

  const closedEncounter = workspace.finishEncounter(
    encounter,
    '2026-03-02T09:32:00.000Z',
    DEMO_CLINICIAN,
  );

  const coding = suggestCoding(router, accepted, DEMO_ROUTING);
  if (!coding.suggestion) throw new Error('scenario expects coding suggestions');

  const claim = buildDraftClaim({
    claimId: 'claim-0001',
    patientId: patient.id,
    note: signed,
    provider: DEMO_CLINICIAN,
    diagnoses: coding.suggestion.diagnoses,
    created: '2026-03-02T09:35:00.000Z',
  });
  const claimDraftEventId = fileDraftClaim(log, claim, coding.provenance);
  const approvedClaim = approveClaim(log, claim, DEMO_CLINICIAN, claimDraftEventId);

  return {
    log,
    workspace,
    router,
    transcript,
    patient,
    encounter,
    extraction,
    drafts,
    note,
    filedNote,
    refusedSignature,
    reviews,
    rejectedConceptKeys,
    accepted,
    revisedNote,
    signed,
    closedEncounter,
    coding,
    claim,
    approvedClaim,
  };
}
