/**
 * Append-only, hash-chained event log — the system of record (ADR-0002).
 *
 * Two properties this file is responsible for:
 *  1. Append-only: there is no update or delete. A correction is a new event
 *     (`op: 'amend'`), so history is never rewritten.
 *  2. Tamper-evident: each event hashes the previous event's hash, so altering
 *     any historical event invalidates every hash after it. `verifyChain()`
 *     detects this. Access control alone can't give you that
 *     (docs/vita-emr/07-threat-model.md, Tampering).
 *
 * In-memory here because this is a vertical slice; the interface is what a
 * durable implementation would satisfy. See README "What this slice is not".
 */

import {
  GENESIS_HASH,
  hashEvent,
  type ClinicalEvent,
  type EventInput,
} from './events.ts';
import type { ResourceType } from '../fhir/types.ts';

/** Injectable so demo and test output is reproducible. */
export type Clock = () => string;

export const systemClock: Clock = () => new Date().toISOString();

/**
 * Fixed-start clock advancing a whole second per call — deterministic runs
 * without threading timestamps through every call site.
 */
export function deterministicClock(startIso = '2026-03-02T09:00:00.000Z'): Clock {
  let tick = 0;
  const start = Date.parse(startIso);
  return () => new Date(start + tick++ * 1000).toISOString();
}

/**
 * Every read of PHI, recorded. Reads matter as much as writes
 * (docs/vita-emr/07-threat-model.md §3) and, unlike writes, they produce no
 * clinical event on their own — so the log has to capture them explicitly.
 * This is the concrete gap that document flags as an open engineering item.
 */
export type ReadAuditEntry = {
  at: string;
  actorId: string;
  patientId: string;
  purpose: string;
  resourceTypes: ResourceType[];
  /** Set when access was granted through break-the-glass, which mandates
   *  post-hoc review rather than merely being logged. */
  breakTheGlass?: { justification: string };
};

export class EventLog {
  #events: ClinicalEvent[] = [];
  #reads: ReadAuditEntry[] = [];
  #clock: Clock;
  #tenantId: string;

  constructor(tenantId: string, clock: Clock = systemClock) {
    this.#tenantId = tenantId;
    this.#clock = clock;
  }

  get tenantId(): string {
    return this.#tenantId;
  }

  append(input: EventInput): ClinicalEvent {
    if (input.tenantId !== this.#tenantId) {
      // Schema-per-tenant isolation (ADR-0008): a cross-tenant write is a
      // programming error, not a recoverable condition.
      throw new Error(
        `tenant mismatch: log is ${this.#tenantId}, event is ${input.tenantId}`,
      );
    }
    const prev = this.#events.at(-1);
    const unhashed = {
      ...input,
      seq: this.#events.length,
      id: `evt-${String(this.#events.length).padStart(4, '0')}`,
      recordedAt: this.#clock(),
      prevHash: prev?.hash ?? GENESIS_HASH,
    };
    const event: ClinicalEvent = { ...unhashed, hash: hashEvent(unhashed) };
    // Freeze so a caller holding a reference can't mutate history in place.
    this.#events.push(Object.freeze(structuredClone(event)));
    return event;
  }

  recordRead(entry: Omit<ReadAuditEntry, 'at'>): void {
    this.#reads.push(Object.freeze({ ...entry, at: this.#clock() }));
  }

  all(): readonly ClinicalEvent[] {
    return this.#events;
  }

  byId(eventId: string): ClinicalEvent | undefined {
    return this.#events.find((e) => e.id === eventId);
  }

  /** Every event touching a resource, oldest first — the resource's history. */
  forResource(resourceId: string): ClinicalEvent[] {
    return this.#events.filter((e) => e.resourceId === resourceId);
  }

  reads(): readonly ReadAuditEntry[] {
    return this.#reads;
  }

  /**
   * Recompute the chain. Returns the first event whose hash doesn't match, or
   * null when intact.
   */
  verifyChain(): { brokenAt: ClinicalEvent; reason: string } | null {
    let expectedPrev = GENESIS_HASH;
    for (const event of this.#events) {
      if (event.prevHash !== expectedPrev) {
        return { brokenAt: event, reason: 'prevHash does not match preceding event' };
      }
      const { hash, ...rest } = event;
      if (hashEvent(rest) !== hash) {
        return { brokenAt: event, reason: 'event body does not match its hash' };
      }
      expectedPrev = hash;
    }
    return null;
  }
}
