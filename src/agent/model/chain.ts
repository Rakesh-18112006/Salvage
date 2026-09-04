/**
 * A DecisionModel that falls back across PROVIDERS, not just across models.
 *
 * Every time this project has been unable to produce a live result, the cause was the
 * same: one vendor's quota ran out. A chain that only walks models inside a single
 * provider does not help, because quota is per project. This walks vendors.
 *
 *   Groq (primary)  ->  OpenRouter  ->  Gemini  ->  [deterministic fallback in AgentPolicy]
 *
 * The deterministic fallback is NOT in this chain. It lives in AgentPolicy and is
 * deliberately outside the model layer: it is not a worse model, it is a different kind
 * of thing, and the provenance report must be able to say plainly that no model answered.
 */
import { optionalEnv } from '../../config.ts';
import {
  LlmUnavailableError,
  type DecisionModel,
  type GenerateArgs,
  type GenerateResult,
  type ModelUsage,
} from './decisionModel.ts';
import { GeminiClient } from './gemini.ts';
import { groqClient, openRouterClient } from './openAiCompatible.ts';

interface Link {
  readonly name: string;
  readonly client: DecisionModel & { readonly usage: ModelUsage };
}

export class ModelChain implements DecisionModel {
  private readonly links: ReadonlyArray<Link>;

  constructor(links: ReadonlyArray<Link>) {
    if (links.length === 0) {
      throw new Error(
        'no model provider configured. Set GROQ_API_KEY (free, no card: ' +
          'https://console.groq.com), or OPENROUTER_API_KEY, or GEMINI_API_KEY. ' +
          'To run without any model, use --deterministic-only.',
      );
    }
    this.links = links;
  }

  /** Provider names in the order they will be tried. For the provenance report. */
  get providerNames(): string[] {
    return this.links.map((l) => l.name);
  }

  /** Combined usage across every provider, so reporting sees one number. */
  get usage(): ModelUsage {
    const total: ModelUsage = {
      calls: 0,
      failedCalls: 0,
      promptTokens: 0,
      outputTokens: 0,
      totalLatencyMs: 0,
      byModel: {},
    };
    for (const l of this.links) {
      total.calls += l.client.usage.calls;
      total.failedCalls += l.client.usage.failedCalls;
      total.promptTokens += l.client.usage.promptTokens;
      total.outputTokens += l.client.usage.outputTokens;
      total.totalLatencyMs += l.client.usage.totalLatencyMs;
      for (const [m, n] of Object.entries(l.client.usage.byModel)) {
        total.byModel[m] = (total.byModel[m] ?? 0) + n;
      }
    }
    return total;
  }

  async generateJson<T>(args: GenerateArgs, maxAttemptsPerModel = 2): Promise<GenerateResult<T>> {
    const failures: string[] = [];
    let lastStatus: number | null = null;

    for (const link of this.links) {
      try {
        return await link.client.generateJson<T>(args, maxAttemptsPerModel);
      } catch (err) {
        if (err instanceof LlmUnavailableError) {
          lastStatus = err.lastStatus;
          failures.push(`${link.name}(${err.lastStatus ?? '?'})`);
          continue; // try the next PROVIDER
        }
        throw err; // a bug in our code, not a provider problem
      }
    }

    throw new LlmUnavailableError(
      `every provider exhausted: ${failures.join(', ')}`,
      lastStatus,
    );
  }
}

/**
 * Build the chain from whatever keys are present, in priority order.
 *
 * Returns null when no provider is configured, so the caller can decide whether that is
 * an error (the user asked for a live run) or expected (--deterministic-only).
 */
export function buildModelChain(): ModelChain | null {
  const links: Link[] = [];

  const groq = groqClient();
  if (groq !== null) links.push({ name: 'groq', client: groq });

  const openrouter = openRouterClient();
  if (openrouter !== null) links.push({ name: 'openrouter', client: openrouter });

  if (optionalEnv('GEMINI_API_KEY', '') !== '') {
    links.push({ name: 'gemini', client: new GeminiClient() });
  }

  return links.length === 0 ? null : new ModelChain(links);
}
