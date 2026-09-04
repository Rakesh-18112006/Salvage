/**
 * The contract between the agent and whatever model answers it.
 *
 * Every provider in this folder implements `DecisionModel` and nothing wider. The agent
 * imports only from here, so swapping Groq for OpenRouter for Gemini - or for a stub in a
 * test - is a change of one construction site and nothing else.
 *
 * It is declared as an interface rather than a class for the sake of the tests. A guard
 * rail you cannot exercise is decoration, and the interesting cases are all adversarial:
 * a model that proposes retrying a revoked mandate, one that answers with garbage, one
 * that is simply unavailable. Each of those is three lines of stub here and would be an
 * afternoon of mocking against a concrete client.
 */

export interface GenerateArgs {
  readonly system: string;
  readonly user: string;
  readonly responseSchema: unknown;
  readonly temperature?: number;
  readonly maxOutputTokens?: number;
  readonly timeoutMs?: number;
}

/** The narrow surface the agent depends on. */
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

/**
 * Raised when a provider could not be reached at all, as opposed to answering badly.
 *
 * The distinction matters upstream: an unavailable model falls back to the deterministic
 * policy and the case still resolves, whereas a malformed answer is sanitised and counted.
 * Conflating the two would let a dead API look like a working one.
 */
export class LlmUnavailableError extends Error {
  readonly lastStatus: number | null;
  constructor(message: string, lastStatus: number | null) {
    super(message);
    this.name = 'LlmUnavailableError';
    this.lastStatus = lastStatus;
  }
}

/**
 * What a run actually cost, accumulated by the client.
 *
 * `provenance.ts` derives "was this a model-driven result?" from these observed counts
 * rather than from any flag the caller passed, which is why they live on the client and
 * not on the agent.
 */
export interface ModelUsage {
  calls: number;
  failedCalls: number;
  promptTokens: number;
  outputTokens: number;
  totalLatencyMs: number;
  byModel: Record<string, number>;
}
