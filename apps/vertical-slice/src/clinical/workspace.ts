/**
 * The clinician-facing API over the event-sourced core.
 *
 * Every mutation here goes through EventLog.append, so provenance capture is
 * structural rather than a convention callers have to remember (ADR-0004).
 * There is deliberately no method that writes a resource without an actor.
 */

import type { AiProvenance, Actor, ClinicalEvent, ReviewAction } from '../core/events.ts';
import type { EventLog } from '../core/eventLog.ts';
import { pendingReview } from '../core/projection.ts';
import type { Extraction, ExtractedFinding } from '../ai/extract.ts';
import { renderNote, type NoteDraft } from '../ai/note.ts';
import type {
  ClinicalResource,
  DocumentReference,
  Encounter,
  Patient,
} from '../fhir/types.ts';
import { materialize, promoteToAccepted, spanExtensions } from './materialize.ts';

export type Clinician = { id: string; display: string; role: string };

export type DraftRef = {
  eventId: string;
  resourceId: string;
  resourceType: ClinicalResource['resourceType'];
  finding: ExtractedFinding;
};

const ENCOUNTER_CLASS = 'http://terminology.hl7.org/CodeSystem/v3-ActCode';
const LOINC_PROGRESS_NOTE = { system: 'http://loinc.org', code: '11506-3', display: 'Progress note' };

function humanActor(clinician: Clinician): Actor {
  return { kind: 'human', id: clinician.id, display: clinician.display, role: clinician.role };
}

export type NoteContext = {
  patientId: string;
  encounterId: string;
  recordedAt: string;
  noteId: string;
};

/**
 * Render a note draft into a DocumentReference.
 *
 * Exported because a clinician who revises the note before signing needs to
 * produce the same shape — the revised note is still a note, not a different
 * kind of artifact.
 */
export function buildNoteDocument(draft: NoteDraft, ctx: NoteContext): DocumentReference {
  return {
    resourceType: 'DocumentReference',
    id: ctx.noteId,
    extension: spanExtensions(draft.sentences.flatMap((s) => s.spans)),
    status: 'current',
    docStatus: 'preliminary',
    type: { coding: [LOINC_PROGRESS_NOTE], text: 'Progress note' },
    subject: { reference: `Patient/${ctx.patientId}` },
    date: ctx.recordedAt,
    content: [
      {
        attachment: {
          contentType: 'text/plain',
          title: 'Ambient-drafted progress note (SOAP)',
          data: Buffer.from(renderNote(draft), 'utf8').toString('base64'),
        },
      },
    ],
    context: { encounter: [{ reference: `Encounter/${ctx.encounterId}` }] },
  };
}

function aiActor(provenance: AiProvenance): Actor {
  return {
    kind: 'ai',
    id: provenance.modelId,
    display: `${provenance.modelId}@${provenance.modelVersion}`,
    provenance,
  };
}

export class ClinicalWorkspace {
  #log: EventLog;

  constructor(log: EventLog) {
    this.#log = log;
  }

  get log(): EventLog {
    return this.#log;
  }

  registerPatient(
    input: Omit<Patient, 'resourceType' | 'meta'>,
    by: Clinician,
  ): Patient {
    const patient: Patient = { resourceType: 'Patient', ...input };
    this.#log.append({
      tenantId: this.#log.tenantId,
      actor: humanActor(by),
      op: 'create',
      resourceType: 'Patient',
      resourceId: patient.id,
      resource: patient,
    });
    return patient;
  }

  openEncounter(
    args: { id: string; patientId: string; class: 'AMB' | 'IMP' | 'EMER' | 'HH'; start: string },
    by: Clinician,
  ): Encounter {
    const encounter: Encounter = {
      resourceType: 'Encounter',
      id: args.id,
      status: 'in-progress',
      class: { system: ENCOUNTER_CLASS, code: args.class },
      subject: { reference: `Patient/${args.patientId}` },
      period: { start: args.start },
    };
    this.#log.append({
      tenantId: this.#log.tenantId,
      actor: humanActor(by),
      op: 'create',
      resourceType: 'Encounter',
      resourceId: encounter.id,
      resource: encounter,
    });
    return encounter;
  }

  finishEncounter(encounter: Encounter, end: string, by: Clinician): Encounter {
    const finished: Encounter = {
      ...encounter,
      status: 'finished',
      period: { ...encounter.period, end },
    };
    this.#log.append({
      tenantId: this.#log.tenantId,
      actor: humanActor(by),
      op: 'update',
      resourceType: 'Encounter',
      resourceId: finished.id,
      resource: finished,
    });
    return finished;
  }

  /** File AI-extracted findings as drafts. No-op when extraction produced none. */
  fileDrafts(
    extraction: Extraction,
    ctx: { patientId: string; encounterId: string; recordedAt: string },
  ): DraftRef[] {
    const batch = extraction.provenance;
    if (!batch) return [];

    return extraction.findings.map((finding) => {
      const resource = materialize(finding, ctx);
      // Per-finding provenance, not the batch average: a ledger that reports
      // one confidence for every draft in the encounter tells a reviewer
      // nothing about the draft actually in front of them.
      const actor = aiActor({
        ...batch,
        confidence: finding.confidence,
        // One extraction call produced every finding in this batch, so its
        // cost is amortised across them. Stamping the full call cost on each
        // draft would multiply the encounter's real inference spend by the
        // number of findings.
        costUsd: Number((batch.costUsd / Math.max(extraction.findings.length, 1)).toFixed(8)),
        inputRefs: [
          ...batch.inputRefs,
          ...finding.spans.map(
            (span) => `${batch.inputRefs[0]}#${span.utteranceId}:${span.startChar}-${span.endChar}`,
          ),
        ],
      });
      const event = this.#log.append({
        tenantId: this.#log.tenantId,
        actor,
        op: 'create',
        resourceType: resource.resourceType,
        resourceId: resource.id,
        resource,
      });
      return {
        eventId: event.id,
        resourceId: resource.id,
        resourceType: resource.resourceType,
        finding,
      };
    });
  }

  fileNoteDraft(
    draft: NoteDraft,
    provenance: AiProvenance,
    ctx: NoteContext,
  ): { document: DocumentReference; eventId: string } {
    const document = buildNoteDocument(draft, ctx);

    const event = this.#log.append({
      tenantId: this.#log.tenantId,
      actor: aiActor(provenance),
      op: 'create',
      resourceType: 'DocumentReference',
      resourceId: document.id,
      resource: document,
    });
    return { document, eventId: event.id };
  }

  /**
   * Record a clinician's disposition of a draft.
   *
   * `edit` takes the corrected resource from the caller rather than patching
   * it here — the clinician's version is authoritative, and guessing at a
   * merge would put words in their mouth.
   */
  review(
    draftEventId: string,
    action: ReviewAction,
    by: Clinician,
    edited?: ClinicalResource,
  ): ClinicalEvent {
    const draft = this.#log.byId(draftEventId);
    if (!draft) throw new Error(`no such draft event: ${draftEventId}`);
    if (draft.actor.kind !== 'ai') {
      throw new Error(`event ${draftEventId} is not an AI draft; nothing to review`);
    }
    if (action === 'edit' && !edited) {
      throw new Error('edit requires the corrected resource');
    }

    const resource =
      action === 'reject'
        ? draft.resource
        : promoteToAccepted(action === 'edit' ? edited! : draft.resource);

    return this.#log.append({
      tenantId: this.#log.tenantId,
      actor: humanActor(by),
      op: action === 'reject' ? 'amend' : 'update',
      resourceType: draft.resourceType,
      resourceId: draft.resourceId,
      resource,
      reviewOf: { draftEventId, action },
    });
  }

  /**
   * Sign the note. Signing is the clinician's attestation, so it is refused
   * while any other AI draft for this patient is still unreviewed — otherwise
   * a signature could imply agreement with content nobody has read.
   */
  signNote(
    noteEventId: string,
    by: Clinician,
    options: { signedAt: string; edited?: DocumentReference } = { signedAt: '' },
  ): DocumentReference {
    const noteEvent = this.#log.byId(noteEventId);
    if (!noteEvent) throw new Error(`no such note event: ${noteEventId}`);
    const patientId = (noteEvent.resource as DocumentReference).subject.reference.split('/')[1];

    const unreviewed = pendingReview(this.#log, patientId).filter(
      (entry) => entry.resource.id !== noteEvent.resourceId,
    );
    if (unreviewed.length > 0) {
      throw new Error(
        'cannot sign: unreviewed AI drafts remain — ' +
          unreviewed.map((u) => `${u.resource.resourceType}/${u.resource.id}`).join(', '),
      );
    }

    const base = (options.edited ?? noteEvent.resource) as DocumentReference;
    const signed: DocumentReference = {
      ...base,
      docStatus: 'final',
      author: [{ reference: `Practitioner/${by.id}`, display: by.display }],
      attester: [
        {
          mode: 'legal',
          time: options.signedAt,
          party: { reference: `Practitioner/${by.id}`, display: by.display },
        },
      ],
    };

    this.#log.append({
      tenantId: this.#log.tenantId,
      actor: humanActor(by),
      op: 'update',
      resourceType: 'DocumentReference',
      resourceId: signed.id,
      resource: signed,
      reviewOf: { draftEventId: noteEventId, action: options.edited ? 'edit' : 'accept' },
    });
    return signed;
  }
}
