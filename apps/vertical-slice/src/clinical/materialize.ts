/**
 * Extraction findings → FHIR resource drafts (ADR-0001).
 *
 * Draft status is expressed in FHIR's own vocabulary rather than a bespoke
 * "isDraft" flag: a drafted Condition is `provisional`, a drafted
 * MedicationRequest is `draft`, a drafted Observation is `preliminary`. An
 * external FHIR client therefore sees the review state correctly without
 * knowing anything about VITA, and an unreviewed draft can never be mistaken
 * for attested content.
 */

import type { ExtractedFinding } from '../ai/extract.ts';
import { BP_DIASTOLIC, BP_SYSTOLIC } from '../ai/lexicon.ts';
import type { TranscriptSpan } from '../ai/transcript.ts';
import {
  VITA_EXT,
  type AllergyIntolerance,
  type ClinicalResource,
  type Condition,
  type Extension,
  type MedicationRequest,
  type Observation,
} from '../fhir/types.ts';

const CLINICAL_STATUS = 'http://terminology.hl7.org/CodeSystem/condition-clinical';
const VER_STATUS = 'http://terminology.hl7.org/CodeSystem/condition-ver-status';
const CATEGORY = 'http://terminology.hl7.org/CodeSystem/condition-category';
const OBS_CATEGORY = 'http://terminology.hl7.org/CodeSystem/observation-category';
const ALLERGY_CLINICAL = 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical';
const ALLERGY_VER = 'http://terminology.hl7.org/CodeSystem/allergyintolerance-verification';

/**
 * Carry the transcript spans onto the resource itself, so "why is this in my
 * chart?" is answerable from the resource a client already holds — without a
 * second round trip to the provenance ledger.
 */
export function spanExtensions(spans: TranscriptSpan[]): Extension[] {
  return spans.map((span) => ({
    url: `${VITA_EXT}/transcript-span`,
    valueString: `${span.utteranceId}#${span.startChar}-${span.endChar}@${span.audioStartMs}-${span.audioEndMs}ms`,
  }));
}

function confidenceExtension(confidence: number): Extension {
  return { url: `${VITA_EXT}/ai-confidence`, valueDecimal: confidence };
}

export type MaterializeContext = {
  patientId: string;
  encounterId: string;
  recordedAt: string;
};

/** Stable, collision-free within a patient — also keeps demo output readable. */
export function draftResourceId(finding: ExtractedFinding, ctx: MaterializeContext): string {
  const prefix = { condition: 'cond', allergy: 'alrg', medication: 'medrx', vital: 'obs' }[
    finding.kind
  ];
  return `${prefix}-${ctx.patientId}-${finding.conceptKey}`;
}

export function materialize(
  finding: ExtractedFinding,
  ctx: MaterializeContext,
): ClinicalResource {
  const id = draftResourceId(finding, ctx);
  const subject = { reference: `Patient/${ctx.patientId}` };
  const encounter = { reference: `Encounter/${ctx.encounterId}` };
  const extension = [...spanExtensions(finding.spans), confidenceExtension(finding.confidence)];

  switch (finding.kind) {
    case 'condition': {
      const condition: Condition = {
        resourceType: 'Condition',
        id,
        extension,
        clinicalStatus: { coding: [{ system: CLINICAL_STATUS, code: 'active' }] },
        // Provisional until a clinician accepts it. This is the FHIR-native
        // expression of "AI output is a draft".
        verificationStatus: { coding: [{ system: VER_STATUS, code: 'provisional' }] },
        category: [{ coding: [{ system: CATEGORY, code: 'encounter-diagnosis' }] }],
        code: finding.code,
        subject,
        encounter,
        recordedDate: ctx.recordedAt,
      };
      return condition;
    }

    case 'allergy': {
      const allergy: AllergyIntolerance = {
        resourceType: 'AllergyIntolerance',
        id,
        extension: [
          ...extension,
          // Patient-reported vs clinically verified changes how allergy
          // checking should weight this (data dictionary local extension).
          { url: `${VITA_EXT}/allergy-source-confidence`, valueString: 'patient-reported' },
        ],
        clinicalStatus: { coding: [{ system: ALLERGY_CLINICAL, code: 'active' }] },
        verificationStatus: { coding: [{ system: ALLERGY_VER, code: 'unconfirmed' }] },
        code: finding.code,
        patient: subject,
        recordedDate: ctx.recordedAt,
        reaction: finding.allergy?.manifestations.length
          ? [{ manifestation: finding.allergy.manifestations }]
          : undefined,
      };
      return allergy;
    }

    case 'medication': {
      const med = finding.medication!;
      const dosage =
        med.dose > 0
          ? `${med.dose} ${med.doseUnit} ${med.frequency}`
          : `As directed (${med.frequency})`;
      const request: MedicationRequest = {
        resourceType: 'MedicationRequest',
        id,
        extension,
        status: 'draft',
        intent: 'proposal',
        medicationCodeableConcept: finding.code,
        subject,
        encounter,
        authoredOn: ctx.recordedAt,
        dosageInstruction: [{ text: dosage }],
      };
      return request;
    }

    case 'vital': {
      const vital = finding.vital!;
      const observation: Observation = {
        resourceType: 'Observation',
        id,
        extension,
        status: 'preliminary',
        category: [{ coding: [{ system: OBS_CATEGORY, code: 'vital-signs' }] }],
        code: finding.code,
        subject,
        encounter,
        effectiveDateTime: ctx.recordedAt,
        component: [
          {
            code: BP_SYSTOLIC,
            valueQuantity: {
              value: vital.systolic,
              unit: 'mmHg',
              system: 'http://unitsofmeasure.org',
              code: vital.unit,
            },
          },
          {
            code: BP_DIASTOLIC,
            valueQuantity: {
              value: vital.diastolic,
              unit: 'mmHg',
              system: 'http://unitsofmeasure.org',
              code: vital.unit,
            },
          },
        ],
      };
      return observation;
    }
  }
}

/**
 * Promote a draft to attested state when a clinician accepts it. Mirrors
 * `materialize`'s status choices in reverse.
 */
export function promoteToAccepted(resource: ClinicalResource): ClinicalResource {
  const next = structuredClone(resource);
  switch (next.resourceType) {
    case 'Condition':
      next.verificationStatus = { coding: [{ system: VER_STATUS, code: 'confirmed' }] };
      return next;
    case 'AllergyIntolerance':
      next.verificationStatus = { coding: [{ system: ALLERGY_VER, code: 'confirmed' }] };
      return next;
    case 'MedicationRequest':
      next.status = 'active';
      next.intent = 'order';
      return next;
    case 'Observation':
      next.status = 'final';
      return next;
    default:
      return next;
  }
}
