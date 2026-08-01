/**
 * The chart as a projection over the event log (ADR-0002).
 *
 * Reads never scan the event log directly in a production implementation —
 * the projection is materialized and read-optimized, because the ≤800ms
 * chart-open budget (docs/vita-emr/README.md → Section 10) can't survive a
 * per-read replay. This slice rebuilds on demand for clarity; the seam is the
 * same.
 */

import { isAiAuthored, type ClinicalEvent } from './events.ts';
import type { EventLog } from './eventLog.ts';
import type { ClinicalResource, ResourceType } from '../fhir/types.ts';

export type ChartEntry = {
  resource: ClinicalResource;
  /** The event that produced the current state of this resource. */
  lastEvent: ClinicalEvent;
  /** True when the current state was authored by an AI and no clinician has
   *  accepted, edited, or rejected it yet — i.e. still a draft (doctrine #4). */
  awaitingReview: boolean;
};

export type Chart = {
  patientId: string;
  entries: ChartEntry[];
  byType: (type: ResourceType) => ChartEntry[];
};

function subjectIdOf(resource: ClinicalResource): string | null {
  if (resource.resourceType === 'Patient') return resource.id;
  if (resource.resourceType === 'AllergyIntolerance') {
    return resource.patient.reference.split('/')[1] ?? null;
  }
  if (resource.resourceType === 'Claim') {
    return resource.patient.reference.split('/')[1] ?? null;
  }
  if ('subject' in resource) {
    return resource.subject.reference.split('/')[1] ?? null;
  }
  return null;
}

/**
 * Replay events into current resource state.
 *
 * A rejected AI draft is withdrawn from the chart entirely — it stays in the
 * event log (nothing is ever deleted) but it is not part of the clinical
 * record, because a clinician declined it. Rendering rejected drafts as chart
 * content would defeat the point of the reject action.
 */
export function project(log: EventLog): Map<string, ChartEntry> {
  const current = new Map<string, ChartEntry>();
  const rejected = new Set<string>();

  for (const event of log.all()) {
    if (event.reviewOf?.action === 'reject') {
      rejected.add(event.resourceId);
      current.delete(event.resourceId);
      continue;
    }
    if (rejected.has(event.resourceId)) {
      // A clinician rejected this draft; a later write revives it only if a
      // human authored that write.
      if (event.actor.kind !== 'human') continue;
      rejected.delete(event.resourceId);
    }
    current.set(event.resourceId, {
      resource: event.resource,
      lastEvent: event,
      awaitingReview: isAiAuthored(event),
    });
  }
  return current;
}

export function chartFor(
  log: EventLog,
  patientId: string,
  access: { actorId: string; purpose: string; breakTheGlass?: { justification: string } },
): Chart {
  const all = [...project(log).values()];
  const entries = all.filter((entry) => subjectIdOf(entry.resource) === patientId);

  // Every chart open is a PHI read, and gets logged as one.
  log.recordRead({
    actorId: access.actorId,
    patientId,
    purpose: access.purpose,
    breakTheGlass: access.breakTheGlass,
    resourceTypes: [...new Set(entries.map((e) => e.resource.resourceType))],
  });

  return {
    patientId,
    entries,
    byType: (type) => entries.filter((e) => e.resource.resourceType === type),
  };
}

/** AI-authored resources still awaiting a clinician's accept/edit/reject. */
export function pendingReview(log: EventLog, patientId: string): ChartEntry[] {
  return [...project(log).values()].filter(
    (entry) => entry.awaitingReview && subjectIdOf(entry.resource) === patientId,
  );
}

/**
 * Time travel: the chart as it stood immediately after a given event. Free
 * consequence of event sourcing — no extra machinery (ADR-0002).
 */
export function projectAsOf(log: EventLog, seq: number): Map<string, ChartEntry> {
  const truncated = {
    all: () => log.all().filter((e) => e.seq <= seq),
    recordRead: () => {},
  } as unknown as EventLog;
  return project(truncated);
}
