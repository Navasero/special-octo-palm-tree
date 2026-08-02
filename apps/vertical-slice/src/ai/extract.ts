/**
 * Layer 1 structured extraction: transcript → FHIR resource drafts.
 *
 * Every finding carries the transcript spans it came from. Nothing is emitted
 * without a span — an assertion with no traceable source is the exact failure
 * mode the citation requirement exists to prevent, so it is enforced here
 * rather than left to the UI (see `assertTraceable`).
 */

import { sha256, type AiProvenance } from '../core/events.ts';
import type { CodeableConcept } from '../fhir/types.ts';
import type { ModelProvider, ModelRouter, RoutingContext, RoutingDecision } from './router.ts';
import { plainText, type Transcript, type TranscriptSpan } from './transcript.ts';

export type FindingKind = 'condition' | 'allergy' | 'medication' | 'vital';

export type ExtractedFinding = {
  kind: FindingKind;
  conceptKey: string;
  display: string;
  code: CodeableConcept;
  /** 0–1. Surfaced to the clinician alongside the draft (doctrine #4). */
  confidence: number;
  /** Non-empty by construction — see assertTraceable. */
  spans: TranscriptSpan[];
  vital?: { systolic: number; diastolic: number; unit: string };
  medication?: { dose: number; doseUnit: string; frequency: string; continuing: boolean };
  allergy?: { manifestations: CodeableConcept[] };
};

export type ExtractionResult = {
  findings: ExtractedFinding[];
  promptHash: string;
  latencyMs: number;
};

export type Extraction = {
  findings: ExtractedFinding[];
  decision: RoutingDecision;
  /** Null when no provider was available — the caller charts manually. */
  provenance: AiProvenance | null;
};

export function promptHashFor(transcript: Transcript): string {
  return sha256(plainText(transcript));
}

/**
 * Reject any finding that lost its provenance trail. Throwing is deliberate:
 * silently dropping the finding would hide an extractor bug, and showing it
 * would put an uncitable claim in front of a clinician.
 */
export function assertTraceable(findings: ExtractedFinding[]): void {
  const orphans = findings.filter((f) => f.spans.length === 0);
  if (orphans.length > 0) {
    throw new Error(
      `extraction produced ${orphans.length} finding(s) with no transcript span: ` +
        orphans.map((f) => f.conceptKey).join(', '),
    );
  }
}

export function extractFindings(
  router: ModelRouter,
  transcript: Transcript,
  ctx: RoutingContext,
): Extraction {
  const decision = router.select('extraction', ctx);
  const provider = decision.provider;

  if (!provider?.extract) {
    // No model available. The encounter proceeds; the clinician charts by
    // hand. This path is exercised by the AI-disabled test.
    return { findings: [], decision, provenance: null };
  }

  const result = provider.extract(transcript);
  assertTraceable(result.findings);
  router.record('extraction', provider, result.latencyMs);

  return {
    findings: result.findings,
    decision,
    provenance: buildProvenance(provider, result.promptHash, result.latencyMs, [
      `Transcript/${transcript.id}`,
      transcript.encounterRef,
    ], averageConfidence(result.findings)),
  };
}

export function averageConfidence(findings: ExtractedFinding[]): number {
  if (findings.length === 0) return 0;
  return Number(
    (findings.reduce((sum, f) => sum + f.confidence, 0) / findings.length).toFixed(3),
  );
}

export function buildProvenance(
  provider: ModelProvider,
  promptHash: string,
  latencyMs: number,
  inputRefs: string[],
  confidence: number,
): AiProvenance {
  return {
    modelId: provider.meta.id,
    modelVersion: provider.meta.version,
    tier: provider.meta.tier,
    promptHash,
    inputRefs,
    confidence,
    latencyMs,
    costUsd: provider.meta.costPerCallUsd,
  };
}
