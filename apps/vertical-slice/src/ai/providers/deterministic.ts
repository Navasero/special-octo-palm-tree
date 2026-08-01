/**
 * ============================================================================
 * A DETERMINISTIC STAND-IN FOR THE MID-TIER MODEL — NOT A LANGUAGE MODEL.
 * ============================================================================
 *
 * This provider is rule-based: lexicon matching, a spoken-number parser, and
 * templated note assembly. It exists so the slice runs end to end with no
 * network, no API key, and no nondeterminism — which is what makes the eval
 * harness and the offline/air-gapped path testable at all.
 *
 * It is NOT the ambient AI described in Layer 1, and its accuracy on real
 * encounters would be poor. A real deployment implements `ModelProvider`
 * against an actual inference API and registers it with the router; nothing
 * else in this codebase changes, because every capability depends on the
 * router rather than on any particular model.
 *
 * What it does demonstrate faithfully: span-linked provenance, code-switched
 * input handling, confidence propagation, and the draft→review→sign contract.
 */

import {
  BP_PANEL,
  CONCEPTS,
  parseSpokenNumber,
  TRIGGERS,
  type Concept,
} from '../lexicon.ts';
import type { ExtractedFinding, ExtractionResult } from '../extract.ts';
import { promptHashFor } from '../extract.ts';
import type { NoteDraft, NoteSentence } from '../note.ts';
import type { ModelProvider } from '../router.ts';
import { spanOf, type Transcript, type TranscriptSpan, type Utterance } from '../transcript.ts';
import type { CodingSuggestion } from '../../billing/coding.ts';
import { TERMINOLOGY_VERSION } from '../lexicon.ts';

type Token = { text: string; start: number; end: number };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  const re = /[A-Za-z0-9]+/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    tokens.push({ text: match[0].toLowerCase(), start: match.index, end: re.lastIndex });
  }
  return tokens;
}

const PLAUSIBLE_SYSTOLIC = { min: 70, max: 260 };
const PLAUSIBLE_DIASTOLIC = { min: 40, max: 160 };

/**
 * Find a blood pressure reading stated either as digits ("150/95") or as
 * words ("one-fifty over ninety-five"), which is how it is usually dictated.
 *
 * Rather than one brittle regex, this locates the separator and then widens
 * the token window on each side until both sides parse to a physiologically
 * plausible number. Implausible parses are rejected, so "five over ten" in
 * some unrelated sentence doesn't become a vital sign.
 */
export function detectBloodPressure(
  text: string,
): { systolic: number; diastolic: number; matchText: string } | null {
  const separator = /\s+over\s+|\s*\/\s*/i.exec(text);
  if (!separator) return null;

  const sepStart = separator.index;
  const sepEnd = sepStart + separator[0].length;
  const tokens = tokenize(text);
  const before = tokens.filter((t) => t.end <= sepStart);
  const after = tokens.filter((t) => t.start >= sepEnd);
  if (before.length === 0 || after.length === 0) return null;

  for (let bw = Math.min(3, before.length); bw >= 1; bw--) {
    const beforeWindow = before.slice(before.length - bw);
    const systolic = parseSpokenNumber(beforeWindow.map((t) => t.text).join(' '));
    if (
      systolic === null ||
      systolic < PLAUSIBLE_SYSTOLIC.min ||
      systolic > PLAUSIBLE_SYSTOLIC.max
    ) {
      continue;
    }
    for (let aw = Math.min(3, after.length); aw >= 1; aw--) {
      const afterWindow = after.slice(0, aw);
      const diastolic = parseSpokenNumber(afterWindow.map((t) => t.text).join(' '));
      if (
        diastolic === null ||
        diastolic < PLAUSIBLE_DIASTOLIC.min ||
        diastolic > PLAUSIBLE_DIASTOLIC.max ||
        diastolic >= systolic
      ) {
        continue;
      }
      return {
        systolic,
        diastolic,
        matchText: text.slice(beforeWindow[0].start, afterWindow.at(-1)!.end),
      };
    }
  }
  return null;
}

/**
 * Dose stated after a drug name: "five milligrams", "50 mg".
 *
 * Searches from the end of the drug name, not from its start — otherwise
 * "add losartan fifty milligrams" reads the drug name itself as part of the
 * number and fails to parse.
 */
function detectDose(text: string, fromIndex: number): { dose: number; unit: string } | null {
  const tail = text.slice(fromIndex);
  const match = /([\w\s-]{1,24}?)\s*(milligrams?|mg)\b/i.exec(tail);
  if (!match) return null;
  const dose = parseSpokenNumber(match[1]);
  if (dose === null || dose <= 0) return null;
  return { dose, unit: 'mg' };
}

const FREQUENCIES: { pattern: RegExp; text: string }[] = [
  // Ordered most-specific first: "twice daily" must be tested before the
  // generic "daily", or every twice-daily order is silently halved.
  { pattern: /\btwice (a|per) day\b|\btwice daily\b|\bbid\b|\bdalawang beses\b/i, text: 'twice daily' },
  { pattern: /\bat bedtime\b|\bbago matulog\b/i, text: 'at bedtime' },
  {
    pattern: /\bonce (a|per) day\b|\bonce daily\b|\bevery day\b|\baraw-araw\b|\bdaily\b|\bod\b/i,
    text: 'once daily',
  },
];

function detectFrequency(text: string): string | null {
  return FREQUENCIES.find((f) => f.pattern.test(text))?.text ?? null;
}

const CONTINUING = /\bstill (taking|on)\b|\bcontinue\b|\btuloy\b|\bituloy\b/gi;
const STARTING = /\badd\b|\bstart\b|\bsimulan\b|\bdagdag\b/gi;

function lastMatchBefore(pattern: RegExp, text: string, before: number): number {
  const re = new RegExp(pattern.source, pattern.flags);
  let last = -1;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index >= before) break;
    last = match.index;
  }
  return last;
}

/**
 * Decide whether a drug mention continues existing therapy or starts new
 * therapy, using the nearest preceding intent word rather than the presence
 * of one anywhere in the utterance.
 *
 * "Continue the amlodipine, and add losartan fifty milligrams" contains both
 * words; scanning the whole utterance would mark losartan as continuing, i.e.
 * silently turn a new prescription into an existing one. Defaults to
 * continuing, which is the safer error: it under-claims a new order rather
 * than fabricating one.
 */
function detectContinuing(text: string, drugIndex: number): boolean {
  const continuing = lastMatchBefore(CONTINUING, text, drugIndex);
  const starting = lastMatchBefore(STARTING, text, drugIndex);
  if (starting < 0) return true;
  if (continuing < 0) return false;
  return continuing > starting;
}

type Hit = {
  concept: Concept;
  utterance: Utterance;
  span: TranscriptSpan;
  matchIndex: number;
  matchEnd: number;
};

function findHits(transcript: Transcript): Hit[] {
  const hits: Hit[] = [];
  for (const utterance of transcript.utterances) {
    const lower = utterance.text.toLowerCase();
    const claimed: { start: number; end: number }[] = [];
    for (const { trigger, concept } of TRIGGERS) {
      const index = lower.indexOf(trigger);
      if (index < 0) continue;
      const end = index + trigger.length;
      // Longest triggers are matched first; skip a shorter trigger that falls
      // inside a region an earlier, longer one already claimed.
      if (claimed.some((c) => index >= c.start && end <= c.end)) continue;
      claimed.push({ start: index, end });
      hits.push({
        concept,
        utterance,
        span: spanOf(transcript, utterance.id, utterance.text.slice(index, end)),
        matchIndex: index,
        matchEnd: end,
      });
    }
  }
  return hits;
}

function extract(transcript: Transcript): ExtractionResult {
  const started = Date.now();
  const hits = findHits(transcript);
  const findings: ExtractedFinding[] = [];

  // --- Conditions -----------------------------------------------------------
  const conditionHits = hits.filter((h) => h.concept.kind === 'condition');
  for (const concept of new Set(conditionHits.map((h) => h.concept))) {
    const spans = conditionHits.filter((h) => h.concept === concept).map((h) => h.span);
    const patientReported = conditionHits.some(
      (h) => h.concept === concept && h.utterance.speaker === 'patient',
    );
    findings.push({
      kind: 'condition',
      conceptKey: concept.key,
      display: concept.display,
      code: concept.code,
      // A symptom the patient volunteered is well-evidenced as a complaint;
      // one only the clinician named may be context rather than a diagnosis.
      confidence: patientReported ? 0.88 : 0.79,
      spans,
    });
  }

  // --- Allergies ------------------------------------------------------------
  const allergenHits = hits.filter((h) => h.concept.kind === 'allergen');
  for (const hit of allergenHits) {
    // Manifestations count only from the same utterance — a reaction
    // mentioned three turns away may belong to something else entirely.
    const manifestations = hits.filter(
      (h) => h.concept.kind === 'manifestation' && h.utterance.id === hit.utterance.id,
    );
    findings.push({
      kind: 'allergy',
      conceptKey: hit.concept.key,
      display: hit.concept.display,
      code: hit.concept.code,
      confidence: manifestations.length > 0 ? 0.93 : 0.81,
      spans: [hit.span, ...manifestations.map((m) => m.span)],
      allergy: { manifestations: manifestations.map((m) => m.concept.code) },
    });
  }

  // --- Medications ----------------------------------------------------------
  // A drug is usually named more than once in an encounter ("are you still
  // taking the amlodipine" ... "continue the amlodipine"). Those are one
  // medication, not two, so collapse to the mention carrying a parseable dose
  // — otherwise the chart shows duplicate drafts for the same drug.
  const medicationHits = hits.filter((h) => h.concept.kind === 'medication');
  const bestMedicationHit = new Map<string, Hit>();
  for (const hit of medicationHits) {
    const existing = bestMedicationHit.get(hit.concept.key);
    const hasDose = detectDose(hit.utterance.text, hit.matchEnd) !== null;
    if (!existing || (hasDose && detectDose(existing.utterance.text, existing.matchEnd) === null)) {
      bestMedicationHit.set(hit.concept.key, hit);
    }
  }

  for (const hit of bestMedicationHit.values()) {
    const text = hit.utterance.text;
    const dose = detectDose(text, hit.matchEnd);
    const frequency = detectFrequency(text);
    const continuing = detectContinuing(text, hit.matchIndex);
    findings.push({
      kind: 'medication',
      conceptKey: hit.concept.key,
      display: hit.concept.display,
      code: hit.concept.code,
      confidence: dose ? 0.92 : 0.7,
      spans: [hit.span],
      medication: {
        dose: dose?.dose ?? 0,
        doseUnit: dose?.unit ?? '',
        frequency: frequency ?? 'as directed',
        continuing,
      },
    });
  }

  // --- Vitals ---------------------------------------------------------------
  for (const utterance of transcript.utterances) {
    const bp = detectBloodPressure(utterance.text);
    if (!bp) continue;
    findings.push({
      kind: 'vital',
      conceptKey: 'blood-pressure',
      display: 'Blood pressure',
      code: BP_PANEL,
      // A measurement read aloud by the clinician is the strongest signal in
      // the transcript; it is still a draft the clinician confirms.
      confidence: 0.96,
      spans: [spanOf(transcript, utterance.id, bp.matchText)],
      vital: { systolic: bp.systolic, diastolic: bp.diastolic, unit: 'mm[Hg]' },
    });
  }

  return {
    findings,
    promptHash: promptHashFor(transcript),
    latencyMs: Math.max(1, Date.now() - started),
  };
}

function sentence(
  section: NoteSentence['section'],
  text: string,
  spans: TranscriptSpan[],
): NoteSentence {
  return { section, text, spans };
}

function generateNote(transcript: Transcript, extraction: ExtractionResult): NoteDraft {
  const started = Date.now();
  const sentences: NoteSentence[] = [];
  const by = (kind: ExtractedFinding['kind']) =>
    extraction.findings.filter((f) => f.kind === kind);

  const symptoms = by('condition').filter((f) => f.conceptKey !== 'hypertension');
  if (symptoms.length > 0) {
    sentences.push(
      sentence(
        'Subjective',
        `Patient reports ${symptoms.map((s) => s.display.toLowerCase()).join(', ')}.`,
        symptoms.flatMap((s) => s.spans),
      ),
    );
  }

  for (const allergy of by('allergy')) {
    const manifestations = allergy.allergy?.manifestations ?? [];
    const detail = manifestations.length
      ? ` with ${manifestations.map((m) => (m.text ?? '').toLowerCase()).join(' and ')}`
      : '';
    sentences.push(
      sentence(
        'Subjective',
        `Reported allergy to ${allergy.display.toLowerCase()}${detail}.`,
        allergy.spans,
      ),
    );
  }

  for (const vital of by('vital')) {
    sentences.push(
      sentence(
        'Objective',
        `Blood pressure ${vital.vital!.systolic}/${vital.vital!.diastolic} mmHg.`,
        vital.spans,
      ),
    );
  }

  const hypertension = by('condition').find((f) => f.conceptKey === 'hypertension');
  const elevated = by('vital').find((v) => (v.vital?.systolic ?? 0) >= 140);
  if (hypertension || elevated) {
    // Phrased as an observation about control, not as a new diagnosis — the
    // clinician's signature is what makes any assertion here theirs
    // (ADR-0010: documentation scope, not decision support).
    sentences.push(
      sentence(
        'Assessment',
        'Hypertension, above target on current therapy.',
        [...(hypertension?.spans ?? []), ...(elevated?.spans ?? [])],
      ),
    );
  }
  for (const symptom of symptoms) {
    sentences.push(
      sentence('Assessment', `${symptom.display} — documented this encounter.`, symptom.spans),
    );
  }

  for (const med of by('medication')) {
    const { dose, doseUnit, frequency, continuing } = med.medication!;
    const doseText = dose > 0 ? ` ${dose} ${doseUnit}` : '';
    sentences.push(
      sentence(
        'Plan',
        `${continuing ? 'Continue' : 'Start'} ${med.display.toLowerCase()}${doseText} ${frequency}.`,
        med.spans,
      ),
    );
  }

  return {
    format: 'SOAP',
    sentences,
    promptHash: extraction.promptHash,
    latencyMs: Math.max(1, Date.now() - started),
  };
}

function suggestCoding(extraction: ExtractionResult): CodingSuggestion {
  const started = Date.now();
  const diagnoses = extraction.findings
    .filter((f) => f.kind === 'condition')
    .map((finding) => {
      const icd10 = CONCEPTS.find((c) => c.key === finding.conceptKey)?.icd10;
      return icd10
        ? {
            code: {
              coding: [
                {
                  system: 'http://hl7.org/fhir/sid/icd-10',
                  code: icd10.code,
                  display: icd10.display,
                  version: TERMINOLOGY_VERSION,
                },
              ],
              text: icd10.display,
            },
            rationale: `Documented in the signed note as "${finding.display}".`,
            spans: finding.spans,
          }
        : null;
    })
    .filter((d): d is NonNullable<typeof d> => d !== null);

  return {
    diagnoses,
    promptHash: extraction.promptHash,
    latencyMs: Math.max(1, Date.now() - started),
  };
}

export function createDeterministicProvider(
  options: { available?: () => boolean } = {},
): ModelProvider {
  return {
    meta: {
      id: 'vita-stub-extractor',
      version: '0.1.0',
      tier: 'mid',
      supports: ['extraction', 'note-generation', 'coding'],
      runsOffline: true,
      dataResidency: 'in-country',
      typicalLatencyMs: 900,
      costPerCallUsd: 0.0021,
    },
    available: options.available ?? (() => true),
    extract,
    generateNote,
    suggestCoding,
  };
}
