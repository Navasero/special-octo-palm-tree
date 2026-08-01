/**
 * Minimal FHIR R4 resource shapes for the vertical slice.
 *
 * Per ADR-0001 these are the *native* system-of-record shapes, not an export
 * format — the event log (core/eventLog.ts) stores these directly and the
 * chart projection hands them straight to callers. Only the elements the
 * slice actually exercises are typed here; the profile set they correspond
 * to is docs/vita-emr/04-fhir-data-dictionary.md.
 *
 * The VITA extension namespace is a placeholder pending a real registered
 * canonical URL (see docs/vita-emr/04-fhir-data-dictionary.md).
 */

export const VITA_EXT = 'http://vita-emr.org/fhir/StructureDefinition';

export type Coding = {
  system: string;
  code: string;
  display?: string;
  /** Terminology-service version the code was resolved against (ADR-0007). */
  version?: string;
};

export type CodeableConcept = {
  coding: Coding[];
  text?: string;
};

export type Reference = {
  reference: string;
  display?: string;
};

export type Extension = {
  url: string;
  valueString?: string;
  valueDecimal?: number;
  valueBoolean?: boolean;
  valueReference?: Reference;
};

export type Quantity = {
  value: number;
  unit: string;
  system?: string;
  code?: string;
};

export type Period = {
  start: string;
  end?: string;
};

type ResourceBase = {
  id: string;
  meta?: { profile?: string[]; lastUpdated?: string };
  extension?: Extension[];
};

export type Patient = ResourceBase & {
  resourceType: 'Patient';
  identifier: { system: string; value: string; type?: CodeableConcept }[];
  name: { family: string; given: string[] }[];
  gender: 'male' | 'female' | 'other' | 'unknown';
  birthDate: string;
  /** BCP-47 tags; assumption #5 allows a code-switched pair (e.g. en + fil). */
  communication?: { language: CodeableConcept; preferred?: boolean }[];
};

export type Encounter = ResourceBase & {
  resourceType: 'Encounter';
  status: 'planned' | 'in-progress' | 'finished' | 'cancelled';
  class: Coding;
  subject: Reference;
  period: Period;
  reasonCode?: CodeableConcept[];
};

export type Condition = ResourceBase & {
  resourceType: 'Condition';
  clinicalStatus: CodeableConcept;
  verificationStatus: CodeableConcept;
  category: CodeableConcept[];
  code: CodeableConcept;
  subject: Reference;
  encounter: Reference;
  recordedDate: string;
};

export type Observation = ResourceBase & {
  resourceType: 'Observation';
  status: 'preliminary' | 'final' | 'amended' | 'entered-in-error';
  category: CodeableConcept[];
  code: CodeableConcept;
  subject: Reference;
  encounter: Reference;
  effectiveDateTime: string;
  valueQuantity?: Quantity;
  valueString?: string;
  component?: {
    code: CodeableConcept;
    valueQuantity?: Quantity;
  }[];
};

export type MedicationRequest = ResourceBase & {
  resourceType: 'MedicationRequest';
  status: 'draft' | 'active' | 'stopped' | 'cancelled';
  intent: 'proposal' | 'plan' | 'order';
  medicationCodeableConcept: CodeableConcept;
  subject: Reference;
  encounter: Reference;
  authoredOn: string;
  dosageInstruction?: { text: string }[];
};

export type AllergyIntolerance = ResourceBase & {
  resourceType: 'AllergyIntolerance';
  clinicalStatus: CodeableConcept;
  verificationStatus: CodeableConcept;
  code: CodeableConcept;
  patient: Reference;
  recordedDate: string;
  reaction?: { manifestation: CodeableConcept[]; severity?: string }[];
};

export type DocumentReference = ResourceBase & {
  resourceType: 'DocumentReference';
  status: 'current' | 'superseded' | 'entered-in-error';
  /** `preliminary` until a clinician signs; `final` once attested. */
  docStatus: 'preliminary' | 'final' | 'amended';
  type: CodeableConcept;
  subject: Reference;
  date: string;
  author?: Reference[];
  /** Present only once signed — the clinician's attestation (ADR-0010). */
  attester?: { mode: 'legal'; time: string; party: Reference }[];
  content: { attachment: { contentType: string; data: string; title?: string } }[];
  context?: { encounter: Reference[] };
};

export type Claim = ResourceBase & {
  resourceType: 'Claim';
  status: 'draft' | 'active' | 'cancelled';
  type: CodeableConcept;
  use: 'claim' | 'preauthorization';
  patient: Reference;
  created: string;
  provider: Reference;
  priority: CodeableConcept;
  diagnosis: { sequence: number; diagnosisCodeableConcept: CodeableConcept }[];
  item: {
    sequence: number;
    productOrService: CodeableConcept;
    net?: { value: number; currency: string };
  }[];
  total?: { value: number; currency: string };
};

/**
 * Projected from the internal provenance ledger for FHIR API consumers
 * (ADR-0004) — never authored independently, so there is exactly one
 * authoritative copy of provenance.
 */
export type Provenance = ResourceBase & {
  resourceType: 'Provenance';
  target: Reference[];
  recorded: string;
  agent: {
    type: CodeableConcept;
    who: Reference;
    onBehalfOf?: Reference;
  }[];
  entity?: { role: 'source' | 'derivation'; what: Reference }[];
};

export type ClinicalResource =
  | Patient
  | Encounter
  | Condition
  | Observation
  | MedicationRequest
  | AllergyIntolerance
  | DocumentReference
  | Claim;

export type ResourceType = ClinicalResource['resourceType'];
