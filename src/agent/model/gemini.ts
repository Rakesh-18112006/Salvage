/**
 * Gemini provider.
 *
 * Deliberately thin. It does four things the agent layer should not have to think about:
 * structured output, a model fallback chain, retry with backoff, and usage accounting.
 * It contains no recovery logic of any kind.
 *
 * Third in the chain behind Groq and OpenRouter (see chain.ts) since the migration on
 * 2026-08-31, and kept because a provider chain with one provider is not a chain.
 *
 * MODEL CHOICE, AND WHY IT IS NOT SIMPLY "THE NEWEST"
 * --------------------------------------------------
 * Measured against this API key on 2026-08-30, one identical trivial structured-output
 * call per model:
 *
 *     gemini-3.7-flash        265,756 ms   (and a 503 UNAVAILABLE on the prior attempt)
 *     gemini-3.6-flash         18,753 ms
 *     gemini-3.5-flash          1,643 ms
 *     gemini-3-flash-preview    2,351 ms
 *     gemini-2.5-flash          1,629 ms
 *
 * The newest models were heavily congested. A demo that has to make hundreds of calls
 * cannot be built on a 265-second p50, and Razorpay's stated criteria include execution
 * stability. So the default chain leads with a fast, reliable model and falls back.
 *
 * This is a CAPACITY OBSERVATION ON ONE DAY, not a claim about model quality. It is
 * recorded here so the choice can be re-checked rather than inherited. Override with
 * GEMINI_MODEL / GEMINI_FALLBACK_MODELS.
 */
import { GoogleGenAI } from '@google/genai';

import { optionalEnv, requireEnv } from '../../config.ts';
import {
  LlmUnavailableError,
  type DecisionModel,
  type GenerateArgs,
  type GenerateResult,
  type ModelUsage,
} from './decisionModel.ts';
import { QUOTA_BACKOFF_MS, RateLimiter, RETRYABLE_STATUS, sleep } from './rateLimiter.ts';

export const DEFAULT_MODEL = 'gemini-2.5-flash';
export const DEFAULT_FALLBACKS = ['gemini-3.5-flash', 'gemini-3-flash-preview'];

function statusOf(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /"code"\s*:\s*(\d{3})/.exec(msg) ?? /\b(\d{3})\b/.exec(msg);
  return m === null ? null : Number(m[1]);
}

export class GeminiClient implements DecisionModel {
  private readonly ai: GoogleGenAI;
  private readonly models: ReadonlyArray<string>;
  private readonly limiter: RateLimiter;
  readonly usage: ModelUsage = {
    calls: 0,
    failedCalls: 0,
    promptTokens: 0,
    outputTokens: 0,
    totalLatencyMs: 0,
    byModel: {},
  };

  constructor(opts: { apiKey?: string; models?: ReadonlyArray<string> } = {}) {
    const apiKey = opts.apiKey ?? requireEnv('GEMINI_API_KEY');
    this.ai = new GoogleGenAI({ apiKey });
    this.models =
      opts.models ??
      [
        optionalEnv('GEMINI_MODEL', DEFAULT_MODEL),
        ...optionalEnv('GEMINI_FALLBACK_MODELS', DEFAULT_FALLBACKS.join(','))
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s !== ''),
      ];
    this.limiter = new RateLimiter(
      Number(optionalEnv('GEMINI_MAX_CONCURRENT', '2')),
      Number(optionalEnv('GEMINI_MIN_INTERVAL_MS', '350')),
    );
  }

  /**
   * Generate a JSON value conforming to `responseSchema`.
   *
   * Walks the model chain; within each model, retries retryable statuses with
   * exponential backoff. Throws LlmUnavailableError only when the entire chain is
   * exhausted - at which point the caller is expected to fall back to deterministic
   * behaviour rather than fail the case.
   */
  async generateJson<T>(args: GenerateArgs, maxAttemptsPerModel = 2): Promise<GenerateResult<T>> {
    const timeoutMs = args.timeoutMs ?? 20_000;
    let lastStatus: number | null = null;
    let lastError: unknown = null;
    let attempts = 0;

    // Set when the project-wide quota is exhausted. Walking to another model is
    // pointless in that case - the quota is per PROJECT, not per model, so every
    // remaining model returns the same 429 more slowly. Fail fast to the deterministic
    // fallback instead of spending thirty seconds proving the point.
    let quotaExhausted = false;

    for (const model of this.models) {
      if (quotaExhausted) break;
      for (let attempt = 1; attempt <= maxAttemptsPerModel; attempt++) {
        attempts++;
        const startedAt = Date.now();
        await this.limiter.acquire();
        try {
          const response = await this.withTimeout(
            this.ai.models.generateContent({
              model,
              contents: args.user,
              config: {
                systemInstruction: args.system,
                responseMimeType: 'application/json',
                // The canonical schema is standard JSON Schema (lowercase types), which
                // is what every OpenAI-compatible provider expects. Gemini wants the
                // uppercase spelling, so the adaptation happens here rather than forcing
                // every other provider to speak Gemini's dialect.
                responseSchema: toGeminiSchema(args.responseSchema) as never,
                // Temperature 0: the same case must not get a different decision on a
                // re-run. Determinism is a project rule, not a preference.
                temperature: args.temperature ?? 0,
                ...(args.maxOutputTokens === undefined
                  ? {}
                  : { maxOutputTokens: args.maxOutputTokens }),
              },
            }),
            timeoutMs,
          );

          const latencyMs = Date.now() - startedAt;
          const text = response.text;
          if (text === undefined || text.trim() === '') {
            throw new Error('model returned an empty response');
          }

          const value = JSON.parse(text) as T;

          this.usage.calls++;
          this.usage.promptTokens += response.usageMetadata?.promptTokenCount ?? 0;
          this.usage.outputTokens += response.usageMetadata?.candidatesTokenCount ?? 0;
          this.usage.totalLatencyMs += latencyMs;
          this.usage.byModel[model] = (this.usage.byModel[model] ?? 0) + 1;

          return {
            value,
            model,
            latencyMs,
            promptTokens: response.usageMetadata?.promptTokenCount ?? 0,
            outputTokens: response.usageMetadata?.candidatesTokenCount ?? 0,
            attempts,
          };
        } catch (err) {
          lastError = err;
          lastStatus = statusOf(err);
          this.usage.failedCalls++;

          const retryable = lastStatus !== null && RETRYABLE_STATUS.has(lastStatus);
          const timedOut = err instanceof Error && err.message === 'llm call timed out';
          if (!retryable && !timedOut) break; // a schema or auth error will not improve

          if (lastStatus === 429) {
            // One backoff-and-retry on the same model, then give up on the whole chain.
            if (attempt >= maxAttemptsPerModel) {
              quotaExhausted = true;
              break;
            }
            await sleep(QUOTA_BACKOFF_MS);
            continue;
          }
          if (attempt < maxAttemptsPerModel) await sleep(250 * 2 ** (attempt - 1));
        } finally {
          this.limiter.release();
        }
      }
    }

    throw new LlmUnavailableError(
      `all models exhausted (${this.models.join(', ')}): ` +
        (lastError instanceof Error ? lastError.message.slice(0, 200) : String(lastError)),
      lastStatus,
    );
  }

  private async withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('llm call timed out')), ms);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/** Uppercase the `type` keywords and drop keywords Gemini's schema dialect rejects. */
function toGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (schema === null || typeof schema !== 'object') return schema;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (k === 'additionalProperties') continue; // not part of Gemini's dialect
    if (k === 'type' && typeof v === 'string') {
      out[k] = v.toUpperCase();
      continue;
    }
    out[k] = toGeminiSchema(v);
  }
  return out;
}
