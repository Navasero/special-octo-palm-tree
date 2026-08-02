/**
 * Tiered model router (ADR-0005).
 *
 * Selects a provider per invocation from task class, connectivity, data
 * residency, and latency budget — then falls back down the tier chain when the
 * preferred tier is unreachable. When nothing is available it returns null,
 * and every caller treats that as "proceed without AI assistance". That is the
 * mechanism behind the rule that the EMR stays fully functional with all AI
 * disabled: no clinical path is allowed to depend on a model answering.
 */

import type { ModelTier } from '../core/events.ts';
import type { Transcript } from './transcript.ts';
import type { ExtractionResult } from './extract.ts';
import type { NoteDraft } from './note.ts';
import type { CodingSuggestion } from '../billing/coding.ts';

export type TaskClass = 'transcription' | 'extraction' | 'note-generation' | 'coding';

export type RoutingContext = {
  connectivity: 'online' | 'offline';
  /** Identified PHI is confined to in-country providers under the residency
   *  placeholder in assumption #6. De-identified payloads may cross borders. */
  identifiedPhi: boolean;
  latencyBudgetMs: number;
};

export type ProviderMeta = {
  id: string;
  version: string;
  tier: ModelTier;
  supports: TaskClass[];
  runsOffline: boolean;
  dataResidency: 'in-country' | 'cross-border';
  typicalLatencyMs: number;
  costPerCallUsd: number;
};

/**
 * A provider implements whichever tasks it declares in `meta.supports`.
 *
 * This is the seam a real model plugs into: implement this interface against
 * an inference API and register it with the router. Nothing else in the slice
 * changes — capabilities depend on the router, not on any specific model.
 */
export type ModelProvider = {
  meta: ProviderMeta;
  available: () => boolean;
  extract?: (transcript: Transcript) => ExtractionResult;
  generateNote?: (transcript: Transcript, extraction: ExtractionResult) => NoteDraft;
  suggestCoding?: (extraction: ExtractionResult) => CodingSuggestion;
};

/** Cheapest adequate tier first; frontier only where reasoning warrants it. */
const TIER_PREFERENCE: Record<TaskClass, ModelTier[]> = {
  transcription: ['edge', 'mid'],
  extraction: ['mid', 'edge'],
  'note-generation': ['mid', 'edge'],
  coding: ['mid', 'edge'],
};

export type RoutingDecision = {
  task: TaskClass;
  provider: ModelProvider | null;
  /** Why the chosen provider was chosen, or why none was. */
  rationale: string;
  /** Tiers skipped before landing on the chosen one. */
  skipped: { tier: ModelTier; reason: string }[];
};

export class ModelRouter {
  #providers: ModelProvider[];
  #enabled: boolean;
  #invocations: { task: TaskClass; providerId: string; costUsd: number; latencyMs: number }[] = [];

  constructor(providers: ModelProvider[], options: { enabled?: boolean } = {}) {
    this.#providers = providers;
    this.#enabled = options.enabled ?? true;
  }

  /** The "AI fully disabled" configuration — a supported, tested mode. */
  static disabled(): ModelRouter {
    return new ModelRouter([], { enabled: false });
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  select(task: TaskClass, ctx: RoutingContext): RoutingDecision {
    if (!this.#enabled) {
      return { task, provider: null, rationale: 'AI disabled by configuration', skipped: [] };
    }

    const skipped: { tier: ModelTier; reason: string }[] = [];

    for (const tier of TIER_PREFERENCE[task]) {
      const candidates = this.#providers.filter(
        (p) => p.meta.tier === tier && p.meta.supports.includes(task),
      );
      if (candidates.length === 0) {
        skipped.push({ tier, reason: 'no provider registered for this task at this tier' });
        continue;
      }
      for (const provider of candidates) {
        const reason = this.#rejectionReason(provider, ctx);
        if (reason) {
          skipped.push({ tier, reason: `${provider.meta.id}: ${reason}` });
          continue;
        }
        return {
          task,
          provider,
          rationale: `${tier} tier via ${provider.meta.id}`,
          skipped,
        };
      }
    }

    return {
      task,
      provider: null,
      rationale: 'no eligible provider; caller proceeds without AI assistance',
      skipped,
    };
  }

  #rejectionReason(provider: ModelProvider, ctx: RoutingContext): string | null {
    if (!provider.available()) return 'unavailable';
    if (ctx.connectivity === 'offline' && !provider.meta.runsOffline) {
      return 'requires connectivity';
    }
    if (ctx.identifiedPhi && provider.meta.dataResidency === 'cross-border') {
      return 'cross-border residency not permitted for identified PHI';
    }
    if (provider.meta.typicalLatencyMs > ctx.latencyBudgetMs) {
      return `latency ${provider.meta.typicalLatencyMs}ms exceeds budget ${ctx.latencyBudgetMs}ms`;
    }
    return null;
  }

  record(task: TaskClass, provider: ModelProvider, latencyMs: number): void {
    this.#invocations.push({
      task,
      providerId: provider.meta.id,
      costUsd: provider.meta.costPerCallUsd,
      latencyMs,
    });
  }

  /** Per-encounter inference cost — tracked as a first-class metric. */
  costSummary(): { calls: number; totalCostUsd: number; byTask: Record<string, number> } {
    const byTask: Record<string, number> = {};
    for (const inv of this.#invocations) {
      byTask[inv.task] = Number(((byTask[inv.task] ?? 0) + inv.costUsd).toFixed(6));
    }
    return {
      calls: this.#invocations.length,
      totalCostUsd: Number(this.#invocations.reduce((s, i) => s + i.costUsd, 0).toFixed(6)),
      byTask,
    };
  }
}
