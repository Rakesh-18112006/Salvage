/**
 * An OpenAI-compatible chat-completions client.
 *
 * One client covers Groq, OpenRouter, Together, Cerebras and anything else that speaks
 * the `/chat/completions` shape. That matters more than it sounds: the thing that has
 * repeatedly stopped this project is not a bad model, it is a single provider's quota
 * running out. A client that can only talk to one vendor turns that into a dead demo.
 *
 * PRIMARY PROVIDER: GROQ.
 * Chosen on measured evidence, not reputation. Verified 2026-08-31 against this key:
 *
 *   free tier          no card required. MEASURED from this key's own rate-limit
 *                      headers rather than taken from documentation: gpt-oss-120b gives
 *                      1,000 requests/day and 8,000 TOKENS PER MINUTE. Tokens are the
 *                      binding constraint - a decision costs roughly 600-800 tokens, so
 *                      the practical ceiling is about ten calls a minute, not the 30
 *                      req/min a summary would suggest. Pacing on requests alone walks
 *                      straight into 429s, which is exactly what the first run did.
 *   structured output  response_format json_schema with strict:true, which uses
 *                      CONSTRAINED DECODING - the schema match is guaranteed, not
 *                      best-effort. Stronger than what we had before.
 *   openai/gpt-oss-120b   1350ms   answered the project's central scenario CORRECTLY
 *                                  (insufficient funds on the 27th, paid on the 1st ->
 *                                  TIME_SHIFT_TO_INFLOW)
 *   openai/gpt-oss-20b     975ms   faster, but got that same scenario WRONG
 *                                  (proposed RETRY_SHORT_BACKOFF)
 *
 * So 120b leads and 20b is the fallback: on this task the larger model is right and the
 * smaller one is quick, and being quick about the wrong answer is not a trade worth
 * making. Re-measure before trusting this - it is one observation on one day.
 */
import { optionalEnv } from '../config.ts';
import {
  LlmUnavailableError,
  type DecisionModel,
  type GenerateArgs,
  type GenerateResult,
  type ModelUsage,
} from './geminiClient.ts';
import { QUOTA_BACKOFF_MS, RateLimiter, RETRYABLE_STATUS, sleep } from './rateLimiter.ts';

export interface OpenAiCompatibleOptions {
  readonly providerName: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly models: ReadonlyArray<string>;
  /** Groq and OpenAI support strict constrained decoding; some providers do not. */
  readonly strictSchema?: boolean;
  readonly maxConcurrent?: number;
  readonly minIntervalMs?: number;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
  error?: { message?: string; code?: string | number };
}

export class OpenAiCompatibleClient implements DecisionModel {
  readonly providerName: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly models: ReadonlyArray<string>;
  private readonly strictSchema: boolean;
  private readonly limiter: RateLimiter;
  /**
   * Adaptive pacing, from the provider's own rate-limit headers.
   *
   * A hard-coded interval is always a guess, and this project has already guessed wrong
   * twice. Groq's binding constraint on the free tier turned out to be TOKENS per minute
   * (8,000 for gpt-oss-120b), not requests per minute - so a client paced on RPM sails
   * straight into 429s. Reading `x-ratelimit-remaining-tokens` and
   * `x-ratelimit-reset-tokens` lets the client pause exactly as long as the provider says
   * it needs to, and keeps working if the account tier changes.
   */
  private pauseUntil = 0;
  private lastKnownLimits = '';

  readonly usage: ModelUsage = {
    calls: 0,
    failedCalls: 0,
    promptTokens: 0,
    outputTokens: 0,
    totalLatencyMs: 0,
    byModel: {},
  };

  constructor(opts: OpenAiCompatibleOptions) {
    this.providerName = opts.providerName;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.models = opts.models;
    this.strictSchema = opts.strictSchema ?? true;
    this.limiter = new RateLimiter(opts.maxConcurrent ?? 4, opts.minIntervalMs ?? 120);
  }

  async generateJson<T>(args: GenerateArgs, maxAttemptsPerModel = 2): Promise<GenerateResult<T>> {
    const timeoutMs = args.timeoutMs ?? 20_000;
    let lastStatus: number | null = null;
    let lastError: unknown = null;
    let attempts = 0;
    let quotaExhausted = false;

    for (const model of this.models) {
      if (quotaExhausted) break;
      for (let attempt = 1; attempt <= maxAttemptsPerModel; attempt++) {
        attempts++;
        const startedAt = Date.now();
        await this.limiter.acquire();
        try {
          // Respect a pause the provider's own headers asked for.
          const waitMs = this.pauseUntil - Date.now();
          if (waitMs > 0) await sleep(Math.min(waitMs, 65_000));

          const body = {
            model,
            messages: [
              { role: 'system', content: args.system },
              { role: 'user', content: args.user },
            ],
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'recovery_decision',
                strict: this.strictSchema,
                schema: args.responseSchema,
              },
            },
            // Temperature 0: the same case must not get a different decision on a re-run.
            temperature: args.temperature ?? 0,
            ...(args.maxOutputTokens === undefined
              ? {}
              : { max_completion_tokens: args.maxOutputTokens }),
          };

          const res = await this.withTimeout(
            fetch(`${this.baseUrl}/chat/completions`, {
              method: 'POST',
              headers: {
                authorization: `Bearer ${this.apiKey}`,
                'content-type': 'application/json',
              },
              body: JSON.stringify(body),
            }),
            timeoutMs,
          );

          this.noteRateLimits(res.headers);

          if (!res.ok) {
            lastStatus = res.status;
            if (res.status === 429) {
              // Prefer the provider's own retry-after over our backoff constant.
              const retryAfter = parseDuration(res.headers.get('retry-after'));
              if (retryAfter !== null) this.pauseUntil = Date.now() + retryAfter;
            }
            const text = await res.text();
            throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
          }

          const json = (await res.json()) as ChatCompletionResponse;
          const content = json.choices?.[0]?.message?.content;
          if (content === undefined || content.trim() === '') {
            throw new Error('provider returned an empty completion');
          }

          const value = JSON.parse(content) as T;
          const latencyMs = Date.now() - startedAt;
          const promptTokens = json.usage?.prompt_tokens ?? 0;
          const outputTokens = json.usage?.completion_tokens ?? 0;

          this.usage.calls++;
          this.usage.promptTokens += promptTokens;
          this.usage.outputTokens += outputTokens;
          this.usage.totalLatencyMs += latencyMs;
          const label = `${this.providerName}:${model}`;
          this.usage.byModel[label] = (this.usage.byModel[label] ?? 0) + 1;

          return { value, model: label, latencyMs, promptTokens, outputTokens, attempts };
        } catch (err) {
          lastError = err;
          this.usage.failedCalls++;

          const timedOut = err instanceof Error && err.message === 'llm call timed out';
          const retryable = lastStatus !== null && RETRYABLE_STATUS.has(lastStatus);
          if (!retryable && !timedOut) break; // a schema or auth error will not improve

          if (lastStatus === 429) {
            // Quota is per PROJECT, not per model: walking the model list after a 429
            // just earns the same rejection more slowly.
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
      `${this.providerName} exhausted (${this.models.join(', ')}): ` +
        (lastError instanceof Error ? lastError.message.slice(0, 200) : String(lastError)),
      lastStatus,
    );
  }

  /** Read the provider's rate-limit headers and pause pre-emptively when it is tight. */
  private noteRateLimits(headers: Headers): void {
    const remainingTokens = Number(headers.get('x-ratelimit-remaining-tokens') ?? NaN);
    const resetTokensMs = parseDuration(headers.get('x-ratelimit-reset-tokens'));
    const limitTokens = Number(headers.get('x-ratelimit-limit-tokens') ?? NaN);

    if (Number.isFinite(limitTokens)) {
      this.lastKnownLimits =
        `${headers.get('x-ratelimit-remaining-requests') ?? '?'}/` +
        `${headers.get('x-ratelimit-limit-requests') ?? '?'} req, ` +
        `${headers.get('x-ratelimit-remaining-tokens') ?? '?'}/${limitTokens} tok`;
    }

    // Below roughly two calls' worth of headroom, wait for the window to reset rather
    // than spend the remainder and take a 429.
    const headroom = Number.isFinite(limitTokens) ? Math.max(1500, limitTokens * 0.15) : 1500;
    if (Number.isFinite(remainingTokens) && remainingTokens < headroom && resetTokensMs !== null) {
      this.pauseUntil = Math.max(this.pauseUntil, Date.now() + resetTokensMs + 250);
    }
  }

  /** What the provider last told us about our budget. For the usage report. */
  get rateLimitStatus(): string {
    return this.lastKnownLimits;
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

/** Parse "39.022s", "24m28.8s", "1.5m", "2" (seconds) into milliseconds. */
export function parseDuration(raw: string | null): number | null {
  if (raw === null || raw.trim() === '') return null;
  const v = raw.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Number(v) * 1000; // bare seconds
  const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h)/g;
  let ms = 0;
  let matched = false;
  for (const m of v.matchAll(re)) {
    matched = true;
    const n = Number(m[1]);
    const unit = m[2];
    ms += unit === 'ms' ? n : unit === 's' ? n * 1000 : unit === 'm' ? n * 60_000 : n * 3_600_000;
  }
  return matched ? ms : null;
}

// ---------------------------------------------------------------------------
// Provider presets
// ---------------------------------------------------------------------------

export const GROQ_DEFAULT_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'];

/** Groq, if GROQ_API_KEY is set. Free tier, no card, strict schema support. */
export function groqClient(): OpenAiCompatibleClient | null {
  const apiKey = optionalEnv('GROQ_API_KEY', '');
  if (apiKey === '') return null;
  return new OpenAiCompatibleClient({
    providerName: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKey,
    models: optionalEnv('GROQ_MODELS', GROQ_DEFAULT_MODELS.join(','))
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
    strictSchema: true,
    // Measured on this key 2026-08-31: gpt-oss-120b allows 1,000 requests/day and
    // 8,000 TOKENS per minute. Tokens bind long before requests do - a decision costs
    // roughly 600-800 tokens, so the practical ceiling is about ten calls a minute.
    // These are a conservative floor; the client then paces itself from the response
    // headers, which is what actually keeps it under the limit.
    maxConcurrent: 2,
    minIntervalMs: 1_200,
  });
}

/**
 * OpenRouter, if OPENROUTER_API_KEY is set. Deliberately NOT the primary: its free tier
 * allows 50 requests/day without credits, which is about one run of this project.
 * Useful as one more link in the chain, not as the thing the demo depends on.
 */
export function openRouterClient(): OpenAiCompatibleClient | null {
  const apiKey = optionalEnv('OPENROUTER_API_KEY', '');
  if (apiKey === '') return null;
  return new OpenAiCompatibleClient({
    providerName: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey,
    models: optionalEnv('OPENROUTER_MODELS', 'deepseek/deepseek-chat-v3.1:free')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
    // Free community models vary in schema support; ask for best-effort rather than
    // having the request rejected outright for requesting constrained decoding.
    strictSchema: false,
    maxConcurrent: 2,
    minIntervalMs: 600,
  });
}
