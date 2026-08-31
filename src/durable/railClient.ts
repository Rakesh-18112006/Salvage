/**
 * ############################  SIMULATOR  ############################
 * A simulated payment gateway. Stands in for Razorpay's recurring-charge API.
 * It moves no money and talks to no network. Its decline codes are our own (SIM_*).
 * #####################################################################
 *
 * The one behaviour that matters here is IDEMPOTENCY, modelled the way real gateways
 * behave: a request carrying a key the gateway has already settled returns the ORIGINAL
 * outcome and does not charge again.
 *
 * The gateway's memory lives in its own table (`rail_idempotency_ledger`), deliberately
 * separate from our `charge_attempts`. If the crash-safety test asserted against our own
 * bookkeeping it would be circular; asserting against the counterparty's ledger is what
 * makes "zero duplicate charges" an actual finding rather than a restatement.
 */
import type { PoolClient } from 'pg';

import type { Customer, Mandate, Subscription, Timestamp } from '../domain/types.ts';
import { attemptCharge, type SimContext } from '../sim/paymentSimulator.ts';
import { getPool } from '../db/pool.ts';
import { optionalEnv } from '../config.ts';

/**
 * Simulated round-trip latency to the gateway.
 *
 * Zero by default so tests stay fast. The chaos demo sets it, because a charge that
 * settles in under a millisecond is never actually in flight when you kill the process -
 * and "killed mid-flight" is the whole claim being tested. A real gateway call takes
 * some hundreds of milliseconds, so this makes the window real rather than theoretical.
 */
function railLatencyMs(): number {
  return Number(optionalEnv('SALVAGE_RAIL_LATENCY_MS', '0'));
}

export interface RailChargeRequest {
  readonly idempotencyKey: string;
  readonly subscription: Subscription;
  readonly mandate: Mandate;
  readonly customer: Customer;
  readonly attemptNo: number;
  readonly at: Timestamp;
}

export interface RailChargeResponse {
  readonly status: 'success' | 'failed';
  readonly rawErrorCode: string;
  readonly rawErrorDesc: string;
  /** SIMULATOR ground truth. Never surfaced to a policy or to the agent. */
  readonly trueClass: string | null;
  /** True when the gateway served a previously settled key instead of charging again. */
  readonly replayedFromLedger: boolean;
}

export class SimulatedRailClient {
  private readonly ctx: SimContext;

  constructor(ctx: SimContext) {
    this.ctx = ctx;
  }

  /**
   * Present a charge. Safe to call any number of times with the same key: the first call
   * decides the outcome, every later call is served from the ledger.
   */
  async charge(req: RailChargeRequest): Promise<RailChargeResponse> {
    const existing = await this.lookup(req.idempotencyKey);
    if (existing !== null) {
      await getPool().query(
        `UPDATE rail_idempotency_ledger
            SET request_count = request_count + 1, last_seen_at = now()
          WHERE idempotency_key = $1`,
        [req.idempotencyKey],
      );
      return { ...existing, replayedFromLedger: true };
    }

    const latency = railLatencyMs();
    if (latency > 0) await new Promise((r) => setTimeout(r, latency));

    const outcome = attemptCharge(this.ctx, {
      subscription: req.subscription,
      mandate: req.mandate,
      customer: req.customer,
      attemptNo: req.attemptNo,
      at: req.at,
    });

    // Record the settlement. If two workers raced past the lookup, exactly one INSERT
    // wins; the loser gets no row back and is served the winner's outcome. So the
    // customer is charged once in a genuine race, not merely in the happy path.
    const inserted = await getPool().query(
      `INSERT INTO rail_idempotency_ledger
         (idempotency_key, subscription_id, amount_paise, status,
          raw_error_code, raw_error_desc, true_class, request_count, charge_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 1)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING idempotency_key`,
      [
        req.idempotencyKey,
        req.subscription.id,
        req.subscription.amountPaise,
        outcome.status,
        outcome.rawErrorCode,
        outcome.rawErrorDesc,
        outcome.trueClass,
      ],
    );

    if (inserted.rowCount === 1) {
      return {
        status: outcome.status,
        rawErrorCode: outcome.rawErrorCode,
        rawErrorDesc: outcome.rawErrorDesc,
        trueClass: outcome.trueClass,
        replayedFromLedger: false,
      };
    }

    // We lost the race. Serve the winner's outcome and count our request.
    await getPool().query(
      `UPDATE rail_idempotency_ledger
          SET request_count = request_count + 1, last_seen_at = now()
        WHERE idempotency_key = $1`,
      [req.idempotencyKey],
    );
    const settled = await this.lookup(req.idempotencyKey);
    if (settled === null) throw new Error('rail ledger row vanished after conflict');
    return { ...settled, replayedFromLedger: true };
  }

  private async lookup(
    key: string,
  ): Promise<Omit<RailChargeResponse, 'replayedFromLedger'> | null> {
    const rows = await getPool().query<{
      status: 'success' | 'failed';
      raw_error_code: string;
      raw_error_desc: string;
      true_class: string | null;
    }>(
      `SELECT status, raw_error_code, raw_error_desc, true_class
         FROM rail_idempotency_ledger WHERE idempotency_key = $1`,
      [key],
    );
    const row = rows.rows[0];
    if (row === undefined) return null;
    return {
      status: row.status,
      rawErrorCode: row.raw_error_code,
      rawErrorDesc: row.raw_error_desc,
      trueClass: row.true_class,
    };
  }
}

/** How many times money actually moved for this key. Must never exceed 1. */
export async function ledgerChargeCount(
  key: string,
  client?: PoolClient,
): Promise<{ requestCount: number; chargeCount: number } | null> {
  const runner = client ?? getPool();
  const rows = await runner.query<{ request_count: number; charge_count: number }>(
    'SELECT request_count, charge_count FROM rail_idempotency_ledger WHERE idempotency_key = $1',
    [key],
  );
  const row = rows.rows[0];
  return row === undefined
    ? null
    : { requestCount: row.request_count, chargeCount: row.charge_count };
}

/** Total money-moving charges recorded by the gateway, across all keys. */
export async function ledgerTotals(): Promise<{ keys: number; charges: number; requests: number }> {
  const rows = await getPool().query<{ keys: string; charges: string; requests: string }>(
    `SELECT count(*)::text AS keys,
            coalesce(sum(charge_count), 0)::text  AS charges,
            coalesce(sum(request_count), 0)::text AS requests
       FROM rail_idempotency_ledger`,
  );
  const r = rows.rows[0]!;
  return { keys: Number(r.keys), charges: Number(r.charges), requests: Number(r.requests) };
}
