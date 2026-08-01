/**
 * Clinical concept lexicon with English and Filipino trigger phrases.
 *
 * Codes here are ILLUSTRATIVE. In the real system every binding is resolved
 * and version-pinned through the terminology service (ADR-0007), which owns
 * national formulary mappings and cross-maps; this slice stubs that service
 * with a static table so it can run offline. Do not treat any code below as
 * validated — validating them is exactly the terminology service's job.
 *
 * The bilingual triggers are not decoration: the target market's encounters
 * are routinely code-switched mid-sentence (assumption #5), so a lexicon that
 * only matched English would miss most of the patient's own utterances.
 */

import type { CodeableConcept } from '../fhir/types.ts';

export const SNOMED = 'http://snomed.info/sct';
export const LOINC = 'http://loinc.org';
export const ICD10 = 'http://hl7.org/fhir/sid/icd-10';
/** Placeholder for the national drug formulary (assumption #1 market). */
export const FORMULARY = 'http://vita-emr.org/fhir/CodeSystem/national-formulary';

/** Version tag the stub terminology service reports for every binding. */
export const TERMINOLOGY_VERSION = '2026-01-illustrative';

export type ConceptKind = 'condition' | 'allergen' | 'manifestation' | 'medication';

export type Concept = {
  key: string;
  kind: ConceptKind;
  display: string;
  code: CodeableConcept;
  /** Lowercase trigger phrases; longer phrases are matched first. */
  triggers: string[];
  /** Billing crosswalk, where one applies (ADR-0007 cross-map). */
  icd10?: { code: string; display: string };
};

function coded(system: string, code: string, display: string): CodeableConcept {
  return {
    coding: [{ system, code, display, version: TERMINOLOGY_VERSION }],
    text: display,
  };
}

export const CONCEPTS: Concept[] = [
  {
    key: 'cough',
    kind: 'condition',
    display: 'Cough',
    code: coded(SNOMED, '49727002', 'Cough'),
    triggers: ['cough', 'ubo', 'inuubo'],
    icd10: { code: 'R05', display: 'Cough' },
  },
  {
    key: 'headache',
    kind: 'condition',
    display: 'Headache',
    code: coded(SNOMED, '25064002', 'Headache'),
    triggers: ['headache', 'masakit ang ulo', 'sakit ng ulo', 'sumasakit ang ulo'],
    icd10: { code: 'R51', display: 'Headache' },
  },
  {
    key: 'fever',
    kind: 'condition',
    display: 'Fever',
    code: coded(SNOMED, '386661006', 'Fever'),
    triggers: ['fever', 'lagnat', 'nilalagnat'],
    icd10: { code: 'R50.9', display: 'Fever, unspecified' },
  },
  {
    key: 'dizziness',
    kind: 'condition',
    display: 'Dizziness',
    code: coded(SNOMED, '404640003', 'Dizziness'),
    triggers: ['dizzy', 'dizziness', 'hilo', 'nahihilo'],
    icd10: { code: 'R42', display: 'Dizziness and giddiness' },
  },
  {
    key: 'hypertension',
    kind: 'condition',
    display: 'Essential hypertension',
    code: coded(SNOMED, '59621000', 'Essential hypertension'),
    triggers: ['hypertension', 'high blood', 'altapresyon', 'alta presyon'],
    icd10: { code: 'I10', display: 'Essential (primary) hypertension' },
  },
  {
    key: 'penicillin',
    kind: 'allergen',
    display: 'Penicillin',
    code: coded(SNOMED, '373270004', 'Penicillin'),
    triggers: ['penicillin', 'penisilin'],
  },
  {
    key: 'rash',
    kind: 'manifestation',
    display: 'Eruption of skin',
    code: coded(SNOMED, '271807003', 'Eruption of skin'),
    triggers: ['rash', 'rashes', 'pantal'],
  },
  {
    key: 'pruritus',
    kind: 'manifestation',
    display: 'Itching',
    code: coded(SNOMED, '418290006', 'Itching'),
    triggers: ['itchy', 'itching', 'nangangati', 'makati'],
  },
  {
    key: 'amlodipine',
    kind: 'medication',
    display: 'Amlodipine',
    code: coded(FORMULARY, 'AML-TAB', 'Amlodipine tablet'),
    triggers: ['amlodipine'],
  },
  {
    key: 'losartan',
    kind: 'medication',
    display: 'Losartan',
    code: coded(FORMULARY, 'LOS-TAB', 'Losartan tablet'),
    triggers: ['losartan'],
  },
];

/** Longest trigger first, so "masakit ang ulo" wins over a bare "ulo". */
export const TRIGGERS: { trigger: string; concept: Concept }[] = CONCEPTS.flatMap((concept) =>
  concept.triggers.map((trigger) => ({ trigger, concept })),
).sort((a, b) => b.trigger.length - a.trigger.length);

export const BP_PANEL = coded(LOINC, '85354-9', 'Blood pressure panel');
export const BP_SYSTOLIC = coded(LOINC, '8480-6', 'Systolic blood pressure');
export const BP_DIASTOLIC = coded(LOINC, '8462-4', 'Diastolic blood pressure');

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4,
  five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};
const TEENS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/**
 * Parse a number that ASR may have emitted as words.
 *
 * Handles the colloquial hundreds form clinicians actually say for blood
 * pressure — "one fifty" for 150, "one forty over ninety" — which a naive
 * word-number parser reads as 1 and 50. Digits pass straight through.
 */
export function parseSpokenNumber(input: string): number | null {
  const cleaned = input.trim().toLowerCase().replace(/[^a-z0-9\s-]/g, '');
  if (/^\d+$/.test(cleaned)) return Number(cleaned);

  const tokens = cleaned.split(/[\s-]+/).filter(Boolean);
  if (tokens.length === 0) return null;

  let total = 0;
  let index = 0;

  // Explicit "N hundred ..." form.
  if (tokens[1] === 'hundred' && tokens[0] in UNITS) {
    total += UNITS[tokens[0]] * 100;
    index = 2;
  } else if (
    // Colloquial "one fifty" / "two twenty-five": a bare unit followed by a
    // tens or teens word means hundreds, not addition.
    tokens.length >= 2 &&
    tokens[0] in UNITS &&
    (tokens[1] in TENS || tokens[1] in TEENS)
  ) {
    total += UNITS[tokens[0]] * 100;
    index = 1;
  }

  let matched = index > 0;
  for (; index < tokens.length; index++) {
    const token = tokens[index];
    if (token in TENS) {
      total += TENS[token];
    } else if (token in TEENS) {
      total += TEENS[token];
    } else if (token in UNITS) {
      total += UNITS[token];
    } else if (/^\d+$/.test(token)) {
      total += Number(token);
    } else {
      // Strict: an unrecognised token invalidates the whole parse rather than
      // returning what was read so far. Callers widen the token window until
      // one parses cleanly, and a partial result would let the wrong window
      // win — "ninety five mataas" must fail so that "ninety five" is tried.
      return null;
    }
    matched = true;
  }
  return matched ? total : null;
}
