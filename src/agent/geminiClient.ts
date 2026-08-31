/**
 * Gemini client.
 *
 * Deliberately thin. It does four things the agent layer should not have to think about:
 * structured output, a model fallback chain, retry with backoff, and usage accounting.
 * It contains no recovery logic of any kind.
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

import { optionalEnv, requireEnv } from '../config.ts';

export const DEFAULT_MODEL = 'gemini-2.5-flash';
export const DEFAULT_FALLBACKS = ['gemini-3.5-flash', 'gemini-3-flash-preview'];

/** Errors worth retrying: congestion, rate limits, and transient server faults. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/**
 * A quota rejection is not congestion - it means we are asking too fast, and retrying
 * immediately makes it worse. It gets a much longer backoff than a 503.
 */
const QUOTA_BACKOFF_MS = 4_000;

/**
 * Client-side rate limiting.
 *
 * The API key in use is quota-limited, and firing the agent's decisions at it in
 * parallel produced mostly 429s. Rather than treat that as the API's problem, the
 * client paces itself: at most `maxConcurrent` requests in flight, and at least
 * `minIntervalMs` between request starts. Tune with GEMINI_MAX_CONCURRENT and
 * GEMINI_MIN_INTERVAL_MS.
 */
class RateLimiter {
  private inFlight = 0;
  private lastStartedAt = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly maxConcurrent: number;
  private readonly minIntervalMs: number;

  constructor(maxConcurrent: number, minIntervalMs: number) {
    this.maxConcurrent = maxConcurrent;
    this.minIntervalMs = minIntervalMs;
  }

  async acquire(): Promise<void> {
    while (this.inFlight >= this.maxConcurrent) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.inFlight++;
    const wait = this.lastStartedAt + this.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastStartedAt = Date.now();
  }

  release(): void {
    this.inFlight--;
    this.waiters.shift()?.();
  }
}

export interface GenerateArgs {
  readonly system: string;
  readonly user: string;
  readonly responseSchema: unknown;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
}

/**
 * The narrow surface the agent depends on. Declared as an interface so a test can supply
 * a stub - a model that always proposes retrying a revoked mandate, or one that is always
 * unavailable - without a network call. Guard rails you cannot test are decoration.
 */
export interface DecisionModel {
  generateJson<T>(args: GenerateArgs, maxAttemptsPerModel?: number): Promise<GenerateResult<T>>;
}

export interface GenerateResult<T> {
  readonly value: T;
  readonly model: string;
  readonly latencyMs: number;
  readonly promptTokens: number;
  readonly outputTokens: number;
  readonly attempts: number;
}

export class LlmUnavailableError extends Error {
  readonly lastStatus: number | null;
  constructor(message: string, lastStatus: number | null) {
    super(message);
    this.name = 'LlmUnavailableError';
    this.lastStatus = lastStatus;
  }
}

function statusOf(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /"code"\s*:\s*(\d{3})/.exec(msg) ?? /\b(\d{3})\b/.exec(msg);
  return m === null ? null : Number(m[1]);
}

export interface ModelUsage {
  calls: number;
  failedCalls: number;
  promptTokens: number;
  outputTokens: number;
  totalLatencyMs: number;
  byModel: Record<string, number>;
}

/** Kept as an alias so existing imports and tests keep working. */
export type GeminiUsage = ModelUsage;

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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
