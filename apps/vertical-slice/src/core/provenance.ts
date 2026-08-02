/**
 * Provenance ledger (ADR-0004) — queries over the AI-authored subset of the
 * event log, plus the FHIR `Provenance` projection for API consumers.
 *
 * There is no separate ledger store. These are views over core/eventLog.ts,
 * which is what guarantees provenance can't drift from the clinical record:
 * they are the same events.
 */

import { isAiAuthored, type AiProvenance, type ClinicalEvent, type ReviewAction } from './events.ts';
import type { EventLog } from './eventLog.ts';
import type { Provenance } from '../fhir/types.ts';

export type LedgerEntry = {
  eventId: string;
  recordedAt: string;
  resourceType: string;
  resourceId: string;
  provenance: AiProvenance;
  /** The clinician's disposition, once reviewed. */
  review?: {
    action: ReviewAction;
    by: string;
    at: string;
    eventId: string;
  };
};

/** Every AI-touched record, with the clinician's disposition resolved. */
export function ledger(log: EventLog): LedgerEntry[] {
  const reviews = new Map<string, ClinicalEvent>();
  for (const event of log.all()) {
    if (event.reviewOf) reviews.set(event.reviewOf.draftEventId, event);
  }

  return log
    .all()
    .filter(isAiAuthored)
    .map((event) => {
      // Narrowed by isAiAuthored, but the type guard doesn't carry through map.
      const actor = event.actor as Extract<ClinicalEvent['actor'], { kind: 'ai' }>;
      const review = reviews.get(event.id);
      return {
        eventId: event.id,
        recordedAt: event.recordedAt,
        resourceType: event.resourceType,
        resourceId: event.resourceId,
        provenance: actor.provenance,
        review:
          review && review.reviewOf
            ? {
                action: review.reviewOf.action,
                by: review.actor.display,
                at: review.recordedAt,
                eventId: review.id,
              }
            : undefined,
      };
    });
}

export type ModelStats = {
  modelId: string;
  tier: string;
  drafts: number;
  accepted: number;
  edited: number;
  rejected: number;
  pending: number;
  /** edited + rejected over reviewed drafts. The number the governance
   *  committee watches — auto-suppression triggers above 0.9 for interruptive
   *  CDS rules (docs/vita-emr/06-ai-governance.md §4). */
  overrideRate: number | null;
  totalCostUsd: number;
  p50LatencyMs: number | null;
};

export function modelStats(log: EventLog): ModelStats[] {
  const grouped = new Map<string, LedgerEntry[]>();
  for (const entry of ledger(log)) {
    const key = `${entry.provenance.modelId}@${entry.provenance.tier}`;
    grouped.set(key, [...(grouped.get(key) ?? []), entry]);
  }

  return [...grouped.values()].map((entries) => {
    const count = (action: ReviewAction) =>
      entries.filter((e) => e.review?.action === action).length;
    const accepted = count('accept');
    const edited = count('edit');
    const rejected = count('reject');
    const reviewed = accepted + edited + rejected;
    const latencies = entries.map((e) => e.provenance.latencyMs).sort((a, b) => a - b);

    return {
      modelId: entries[0].provenance.modelId,
      tier: entries[0].provenance.tier,
      drafts: entries.length,
      accepted,
      edited,
      rejected,
      pending: entries.length - reviewed,
      overrideRate: reviewed === 0 ? null : (edited + rejected) / reviewed,
      totalCostUsd: Number(
        entries.reduce((sum, e) => sum + e.provenance.costUsd, 0).toFixed(6),
      ),
      p50LatencyMs: latencies.length ? latencies[Math.floor(latencies.length / 2)] : null,
    };
  });
}

/**
 * Project the internal ledger events for one resource into a FHIR
 * `Provenance` resource. Generated on read, never stored separately
 * (ADR-0004) — so the FHIR API and the internal ledger cannot disagree.
 */
export function toFhirProvenance(log: EventLog, resourceId: string): Provenance | null {
  const events = log.forResource(resourceId);
  if (events.length === 0) return null;
  const latest = events.at(-1)!;

  return {
    resourceType: 'Provenance',
    id: `prov-${resourceId}`,
    target: [{ reference: `${latest.resourceType}/${resourceId}` }],
    recorded: latest.recordedAt,
    agent: events.map((event) => ({
      type: {
        coding: [
          {
            system: 'http://terminology.hl7.org/CodeSystem/provenance-participant-type',
            code: event.actor.kind === 'ai' ? 'assembler' : 'author',
          },
        ],
        text: event.actor.kind === 'ai' ? 'AI draft' : `${event.actor.role} (human)`,
      },
      who: { reference: `Device/${event.actor.id}`, display: event.actor.display },
    })),
    entity: events
      .filter(isAiAuthored)
      .flatMap((event) =>
        (event.actor as Extract<ClinicalEvent['actor'], { kind: 'ai' }>).provenance.inputRefs.map(
          (ref) => ({ role: 'source' as const, what: { reference: ref } }),
        ),
      ),
  };
}
