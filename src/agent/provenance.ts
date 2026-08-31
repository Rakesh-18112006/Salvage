/**
 * WHO ACTUALLY MADE THE DECISIONS.
 *
 * A single source of truth for the one claim this project must never get wrong: whether
 * a set of results was produced by the language model or by the deterministic fallback.
 *
 * The distinction is easy to lose by accident. `--deterministic-only` is an INTENT flag;
 * so is "we constructed a GeminiClient". Neither tells you whether the model answered.
 * On a quota-limited key every call can fail, the deterministic fallback silently carries
 * the whole run, and the output still says "Gemini" at the top unless something checks.
 * That happened during development, which is why this exists.
 *
 * Provenance is therefore derived from what was OBSERVED - counts of decisions actually
 * produced by each path - never from configuration.
 */
import type { AgentStats } from './agentPolicy.ts';
import type { GeminiUsage } from './geminiClient.ts';

export type ProvenanceKind =
  /** The model was never enabled. Honest, reproducible, and needs no API key. */
  | 'deterministic-only'
  /** The model was enabled and answered for the majority of model-eligible decisions. */
  | 'model-driven'
  /** The model was enabled and answered, but the fallback carried most of the run. */
  | 'model-degraded'
  /** The model was enabled and answered NOTHING. These are fallback results. */
  | 'fallback-only';

export interface Provenance {
  readonly kind: ProvenanceKind;
  /** Safe to describe as an AI/model-driven result? */
  readonly isModelDriven: boolean;
  /** One-line label for a header. Never overstates. */
  readonly label: string;
  /** Fuller sentence for a banner or a report. */
  readonly detail: string;
  readonly modelCalls: number;
  readonly cacheHits: number;
  readonly fallbacks: number;
  readonly triaged: number;
  readonly decisions: number;
  readonly failedCalls: number;
}

export interface ProvenanceInput {
  /** Was the model enabled at all for this run? */
  readonly modelEnabled: boolean;
  /**
   * Narrowed to the five counters provenance actually reasons about, rather than the
   * whole of AgentStats. Provenance is the one claim this project must not get wrong,
   * and a wide input type invites a future counter to start quietly influencing it.
   */
  readonly stats: Pick<
    AgentStats,
    'decisions' | 'triagedDeterministically' | 'modelCalls' | 'cacheHits' | 'fallbacks'
  >;
  readonly usage: GeminiUsage | null;
}

/**
 * Decide how a run may be described.
 *
 * `model-driven` requires that the model answered for MORE decisions than the fallback
 * did. A run where the fallback carried the majority is `model-degraded` and must not be
 * presented as an AI result without that qualifier.
 */
export function provenanceOf(input: ProvenanceInput): Provenance {
  const { stats } = input;
  const failedCalls = input.usage?.failedCalls ?? 0;

  // Decisions the model actually produced, counting cache hits: a cached decision was
  // still authored by the model, once, for that exact context.
  const fromModel = stats.modelCalls + stats.cacheHits;

  const base = {
    modelCalls: stats.modelCalls,
    cacheHits: stats.cacheHits,
    fallbacks: stats.fallbacks,
    triaged: stats.triagedDeterministically,
    decisions: stats.decisions,
    failedCalls,
  };

  if (!input.modelEnabled) {
    return {
      ...base,
      kind: 'deterministic-only',
      isModelDriven: false,
      label: 'DETERMINISTIC ONLY — no model calls',
      detail:
        'The model was not enabled for this run. Every decision came from deterministic ' +
        'triage and the fallback policy. These results are fully reproducible without an ' +
        'API key, and must NOT be described as AI or model-driven.',
    };
  }

  if (stats.modelCalls === 0) {
    return {
      ...base,
      kind: 'fallback-only',
      isModelDriven: false,
      label: 'FALLBACK ONLY — the model answered nothing',
      detail:
        `The model was enabled but produced ZERO successful calls (${failedCalls} failed). ` +
        'Every decision came from the deterministic fallback. These numbers describe the ' +
        'fallback policy and must NOT be reported as a model-driven result.',
    };
  }

  if (stats.fallbacks > fromModel) {
    return {
      ...base,
      kind: 'model-degraded',
      isModelDriven: false,
      label: `PARTIALLY MODEL-DRIVEN — fallback carried the majority`,
      detail:
        `The model answered ${fromModel} decisions but the deterministic fallback carried ` +
        `${stats.fallbacks}. The fallback decided most of this run, so it should be ` +
        'described as partially model-driven, with the split stated.',
    };
  }

  return {
    ...base,
    kind: 'model-driven',
    isModelDriven: true,
    label: `MODEL-DRIVEN — ${stats.modelCalls} live calls, ${stats.cacheHits} cached`,
    detail:
      `The model authored ${fromModel} of ${stats.decisions} decisions ` +
      `(${stats.modelCalls} live calls, ${stats.cacheHits} served from the decision cache). ` +
      `${stats.triagedDeterministically} were settled by deterministic triage before the ` +
      `model was consulted, and ${stats.fallbacks} fell back.`,
  };
}
