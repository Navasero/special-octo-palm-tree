/**
 * Event types for the event-sourced clinical core (ADR-0002).
 *
 * Every state change to a FHIR resource is an immutable event. The chart is a
 * projection over these (core/projection.ts). AI-authored events carry a
 * mandatory provenance block, which is what makes the provenance ledger a
 * typed extension of this same log rather than a parallel audit system
 * (ADR-0004) — there is no write path that bypasses it.
 */

import { createHash } from 'node:crypto';
import type { ClinicalResource, ResourceType } from '../fhir/types.ts';

export type ModelTier = 'edge' | 'mid' | 'frontier';

/**
 * Captured for every AI-authored event. Mirrors the field list required by
 * docs/vita-emr/06-ai-governance.md §5.
 *
 * `promptHash` rather than the raw prompt is deliberate (ADR-0004): the raw
 * input is PHI-bearing and is not duplicated into the ledger. Reconstructing
 * full context for a governance incident review is a separate,
 * access-controlled path — out of scope for this slice.
 */
export type AiProvenance = {
  modelId: string;
  modelVersion: string;
  tier: ModelTier;
  promptHash: string;
  /** FHIR references (or transcript URIs) the model was given. */
  inputRefs: string[];
  confidence: number;
  latencyMs: number;
  costUsd: number;
};

export type Actor =
  | { kind: 'human'; id: string; display: string; role: string }
  | { kind: 'ai'; id: string; display: string; provenance: AiProvenance };

export type ReviewAction = 'accept' | 'edit' | 'reject';

/** Links a clinician's review back to the draft event it acted on. */
export type ReviewLink = {
  /** Event id of the AI draft being reviewed. */
  draftEventId: string;
  action: ReviewAction;
};

export type EventInput = {
  tenantId: string;
  actor: Actor;
  op: 'create' | 'update' | 'amend';
  resourceType: ResourceType;
  resourceId: string;
  resource: ClinicalResource;
  reviewOf?: ReviewLink;
};

export type ClinicalEvent = EventInput & {
  seq: number;
  id: string;
  recordedAt: string;
  /** Hash of the preceding event — makes tampering detectable, not merely
   *  forbidden by access control (docs/vita-emr/07-threat-model.md, Tampering). */
  prevHash: string;
  hash: string;
};

export const GENESIS_HASH = '0'.repeat(64);

/**
 * Stable stringify: key order must not affect the hash, or the chain would be
 * verifiable only by the process that wrote it.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
}

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function hashEvent(event: Omit<ClinicalEvent, 'hash'>): string {
  return sha256(`${event.prevHash}:${canonicalize(event)}`);
}

export function isAiAuthored(event: ClinicalEvent): boolean {
  return event.actor.kind === 'ai';
}
