/**
 * Per-bank circuit breakers.
 *
 * Spec section 6: "if open for that bank, DEFER; do not burn an attempt."
 *
 * State is persisted rather than held in memory, for a specific reason: a worker restart
 * must not forget that a rail is down and immediately fire a fresh round of attempts into
 * it. In-memory breakers reset on deploy, which is exactly when you least want them to.
 *
 *   closed    -> normal traffic
 *   open      -> reject immediately; DEFER instead of attempting
 *   half_open -> allow ONE probe; success closes, failure re-opens
 */
import type { Timestamp } from '../domain/types.ts';
import { getPool, withTransaction } from '../db/pool.ts';

/** Consecutive downtime responses before the breaker opens. */
export const FAILURE_THRESHOLD = 3;

/** How long the breaker stays open before allowing a probe. */
export const COOLDOWN_MS = 30 * 60_000;

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerRow {
  bank_code: string;
  state: BreakerState;
  consecutive_failures: number;
  opened_at: Date | null;
  half_open_at: Date | null;
}

async function ensureRow(bankCode: string): Promise<void> {
  await getPool().query(
    `INSERT INTO circuit_breakers (bank_code, state, consecutive_failures)
     VALUES ($1, 'closed', 0)
     ON CONFLICT (bank_code) DO NOTHING`,
    [bankCode],
  );
}

export async function getBreaker(bankCode: string): Promise<BreakerRow> {
  await ensureRow(bankCode);
  const res = await getPool().query<BreakerRow>(
    'SELECT bank_code, state, consecutive_failures, opened_at, half_open_at FROM circuit_breakers WHERE bank_code = $1',
    [bankCode],
  );
  return res.rows[0]!;
}

export interface BreakerDecision {
  readonly allowed: boolean;
  readonly state: BreakerState;
  /** When the breaker is open, the earliest instant worth trying again. */
  readonly retryAfter: Timestamp | null;
  readonly reason: string;
}

/**
 * May we present a charge to this bank right now?
 *
 * An open breaker whose cooldown has elapsed transitions to half_open and lets exactly
 * one probe through - the probe is how we learn the rail came back.
 */
export async function checkBreaker(bankCode: string, now: Timestamp): Promise<BreakerDecision> {
  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO circuit_breakers (bank_code, state, consecutive_failures)
       VALUES ($1, 'closed', 0) ON CONFLICT (bank_code) DO NOTHING`,
      [bankCode],
    );
    const res = await client.query<BreakerRow>(
      'SELECT * FROM circuit_breakers WHERE bank_code = $1 FOR UPDATE',
      [bankCode],
    );
    const row = res.rows[0]!;

    if (row.state === 'closed') {
      return { allowed: true, state: 'closed' as const, retryAfter: null, reason: 'breaker closed' };
    }

    if (row.state === 'half_open') {
      return {
        allowed: true,
        state: 'half_open' as const,
        retryAfter: null,
        reason: 'half-open probe',
      };
    }

    const openedAt = row.opened_at?.getTime() ?? now;
    const cooldownEndsAt = openedAt + COOLDOWN_MS;
    if (now >= cooldownEndsAt) {
      await client.query(
        `UPDATE circuit_breakers SET state = 'half_open', half_open_at = $2, updated_at = now()
          WHERE bank_code = $1`,
        [bankCode, new Date(now)],
      );
      return {
        allowed: true,
        state: 'half_open' as const,
        retryAfter: null,
        reason: 'cooldown elapsed, promoting to half-open probe',
      };
    }

    return {
      allowed: false,
      state: 'open' as const,
      retryAfter: cooldownEndsAt,
      reason: `breaker open for ${bankCode}; do not burn an attempt`,
    };
  });
}

/** A downtime response. Opens the breaker once the threshold is crossed. */
export async function recordFailure(bankCode: string, now: Timestamp): Promise<BreakerState> {
  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO circuit_breakers (bank_code, state, consecutive_failures)
       VALUES ($1, 'closed', 0) ON CONFLICT (bank_code) DO NOTHING`,
      [bankCode],
    );
    const res = await client.query<BreakerRow>(
      'SELECT * FROM circuit_breakers WHERE bank_code = $1 FOR UPDATE',
      [bankCode],
    );
    const row = res.rows[0]!;
    const failures = row.consecutive_failures + 1;

    // A failed probe in half_open re-opens immediately; the rail is not back.
    const shouldOpen = row.state === 'half_open' || failures >= FAILURE_THRESHOLD;
    const nextState: BreakerState = shouldOpen ? 'open' : 'closed';

    await client.query(
      `UPDATE circuit_breakers
          SET state = $2,
              consecutive_failures = $3,
              opened_at = CASE WHEN $2 = 'open' THEN $4::timestamptz ELSE opened_at END,
              updated_at = now()
        WHERE bank_code = $1`,
      [bankCode, nextState, failures, new Date(now)],
    );
    return nextState;
  });
}

/** A successful charge. Closes the breaker and clears the failure run. */
export async function recordSuccess(bankCode: string, now: Timestamp): Promise<void> {
  await getPool().query(
    `INSERT INTO circuit_breakers (bank_code, state, consecutive_failures, updated_at)
     VALUES ($1, 'closed', 0, $2)
     ON CONFLICT (bank_code) DO UPDATE
       SET state = 'closed', consecutive_failures = 0, opened_at = NULL,
           half_open_at = NULL, updated_at = $2`,
    [bankCode, new Date(now)],
  );
}

export async function allBreakers(): Promise<BreakerRow[]> {
  const res = await getPool().query<BreakerRow>(
    'SELECT * FROM circuit_breakers ORDER BY bank_code',
  );
  return res.rows;
}
