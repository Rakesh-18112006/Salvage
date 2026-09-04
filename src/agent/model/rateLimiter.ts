/**
 * Client-side pacing, shared by every model provider.
 *
 * Extracted rather than duplicated: the Gemini client learned this the hard way (firing
 * the agent's decisions in parallel at a quota-limited key produced mostly 429s), and any
 * new provider would have had to learn it again.
 *
 * At most `maxConcurrent` requests in flight, and at least `minIntervalMs` between
 * request starts.
 */
export class RateLimiter {
  private inFlight = 0;
  private lastStartedAt = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly maxConcurrent: number;
  private readonly minIntervalMs: number;

  constructor(maxConcurrent: number, minIntervalMs: number) {
    this.maxConcurrent = Math.max(1, maxConcurrent);
    this.minIntervalMs = Math.max(0, minIntervalMs);
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

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Statuses worth retrying: congestion, rate limits, transient server faults. */
export const RETRYABLE_STATUS: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

/**
 * A quota rejection is not congestion - it means we are asking too fast, or have run out
 * for the day. Retrying immediately makes it worse.
 */
export const QUOTA_BACKOFF_MS = 4_000;
