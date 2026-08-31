/**
 * The idempotent, crash-safe charge executor.
 *
 * Phase 2 acceptance: "killing a worker mid-flight results in zero duplicate charges and
 * zero lost cases."
 *
 * The execution is three phases, and the ordering is the whole design:
 *
 *   A. CLAIM   insert charge_attempts with the derived key and status='in_flight'.
 *              Committed BEFORE the rail is called, so the intent to charge is durable
 *              even if the process dies one instruction later.
 *   B. CALL    present the charge to the rail, passing the same derived key.
 *   C. SETTLE  update the claim row with the outcome.
 *
 * Crashing in each window is survivable:
 *
 *   before A   nothing happened; the job reruns and claims cleanly.
 *   between A and B   claim exists as 'in_flight', rail never saw it. The reclaimer
 *                     calls the rail with the same key - first and only charge.
 *   between B and C   THE DANGEROUS ONE. The rail may have charged but we have no record
 *                     of the outcome. The reclaimer does NOT re-decide; it re-presents
 *                     the same idempotency key, and the gateway returns the original
 *                     outcome from its ledger without charging again.
 *   after C    the claim is settled; the reclaimer reads it and returns it unchanged.
 *
 * The guarantee therefore does not rest on the worker being careful. It rests on a UNIQUE
 * constraint plus a gateway that honours idempotency keys - both of which hold while the
 * process is dead.
 */
import type { Customer, Mandate, Subscription, Timestamp } from '../domain/types.ts';
import { classify, type FailureClass } from '../domain/taxonomy.ts';
import { COST } from '../assumptions.ts';
import { getPool, isUniqueViolation, withTransaction } from '../db/pool.ts';
import { appendEvent } from './caseStore.ts';
import { attemptIdempotencyKey } from './idempotency.ts';
import { SimulatedRailClient } from './railClient.ts';
import { recordFailure, recordSuccess } from './circuitBreaker.ts';

/**
 * Test-only crash injection. Set SALVAGE_CRASH_AT to a phase name and the executor kills
 * its own process there with SIGKILL semantics (process.exit) - a genuinely abrupt death,
 * not a thrown error that finally-blocks could tidy up after.
 */
export type CrashPoint = 'after_claim' | 'after_rail_call';

function maybeCrash(point: CrashPoint): void {
  if (process.env.SALVAGE_CRASH_AT === point) {
    // eslint-disable-next-line no-console
    console.error(`[crash-injection] dying at ${point}`);
    process.exit(137); // the exit code docker uses for SIGKILL
  }
}

export interface ExecuteAttemptArgs {
  readonly caseId: string;
  readonly attemptNo: number;
  readonly subscription: Subscription;
  readonly mandate: Mandate;
  readonly customer: Customer;
  readonly cycleId: string;
  readonly scheduledAt: Timestamp;
  readonly rail: SimulatedRailClient;
}

export interface ExecuteAttemptResult {
  readonly idempotencyKey: string;
  readonly status: 'success' | 'failed';
  readonly rawErrorCode: string;
  readonly rawErrorDesc: string;
  readonly failureClass: FailureClass;
  readonly classificationMatched: boolean;
  readonly feePaise: number;
  /** True when this call found the attempt already settled and charged nothing. */
  readonly servedFromExistingAttempt: boolean;
  /** True when the GATEWAY served its ledger rather than charging. Crash recovery. */
  readonly servedFromRailLedger: boolean;
}

export async function executeAttempt(args: ExecuteAttemptArgs): Promise<ExecuteAttemptResult> {
  const key = attemptIdempotencyKey(args.caseId, args.attemptNo);
  const attemptId = `${args.caseId}_att_${args.attemptNo}`;

  // ---- Phase A: stake the claim, durably, before anything can move money ----------
  let claimed = false;
  try {
    await withTransaction(async (client) => {
      await client.query(
        `INSERT INTO charge_attempts
           (id, case_id, subscription_id, cycle_id, attempt_no, idempotency_key,
            rail, scheduled_at, executed_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, 'in_flight')`,
        [
          attemptId,
          args.caseId,
          args.subscription.id,
          args.cycleId,
          args.attemptNo,
          key,
          args.mandate.rail,
          new Date(args.scheduledAt),
        ],
      );
      await appendEvent(client, args.caseId, 'ATTEMPT_CLAIMED', args.scheduledAt, {
        attemptNo: args.attemptNo,
        idempotencyKey: key,
      });
    });
    claimed = true;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Someone claimed this exact attempt already: either a live racing worker, or our
    // own previous incarnation that died. Fall through and inspect it.
  }

  if (!claimed) {
    const settled = await loadSettledAttempt(key);
    if (settled !== null) {
      // Already finished. Return the recorded outcome; charge nothing.
      return { ...settled, servedFromExistingAttempt: true, servedFromRailLedger: false };
    }
    // Claim exists but is still 'in_flight' - a crashed predecessor. We take it over.
    // Re-presenting the SAME key is what makes this safe.
  }

  maybeCrash('after_claim');

  // ---- Phase B: present the charge -----------------------------------------------
  const response = await args.rail.charge({
    idempotencyKey: key,
    subscription: args.subscription,
    mandate: args.mandate,
    customer: args.customer,
    attemptNo: args.attemptNo,
    at: args.scheduledAt,
  });

  maybeCrash('after_rail_call');

  // ---- Phase C: settle -------------------------------------------------------------
  const classification =
    response.status === 'success'
      ? { failureClass: 'UNKNOWN' as FailureClass, matched: true }
      : classify(response.rawErrorCode);

  const feePaise = COST.gatewayFeePerAttemptPaise.value;

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE charge_attempts
          SET status = $2, executed_at = $3, raw_error_code = $4, raw_error_desc = $5,
              failure_class = $6, classification_matched = $7, fee_paise = $8
        WHERE idempotency_key = $1 AND status = 'in_flight'`,
      [
        key,
        response.status,
        new Date(args.scheduledAt),
        response.rawErrorCode,
        response.rawErrorDesc,
        response.status === 'success' ? 'UNKNOWN' : classification.failureClass,
        classification.matched,
        feePaise,
      ],
    );
    // The executor owns attempts_used, the attempt's fee, AND the diagnosis - all three
    // are derived from the attempt outcome, and all three are written in the SAME
    // transaction that logs ATTEMPT_SETTLED. One writer, one event, no drift.
    //
    // The replay test caught this: diagnosis was being logged to the event stream but
    // never written to recovery_cases, so the stored row stayed on its opening value
    // while the log knew better. That is exactly the divergence the reducer exists to
    // find, and it would have been invisible until someone audited a case.
    await client.query(
      `UPDATE recovery_cases
          SET attempts_used = attempts_used + 1,
              cost_paise    = cost_paise + $2,
              -- A SUCCESSFUL attempt leaves the diagnosis alone. A recovered case should
              -- still record WHY it failed - overwriting that with 'UNKNOWN' on the
              -- winning attempt erases the most useful field in the audit trail.
              diagnosis     = COALESCE($3, diagnosis)
        WHERE id = $1`,
      [
        args.caseId,
        feePaise,
        response.status === 'success' ? null : classification.failureClass,
      ],
    );
    await appendEvent(client, args.caseId, 'ATTEMPT_SETTLED', args.scheduledAt, {
      attemptNo: args.attemptNo,
      idempotencyKey: key,
      status: response.status,
      rawErrorCode: response.rawErrorCode,
      failureClass: response.status === 'success' ? 'UNKNOWN' : classification.failureClass,
      feePaise,
      servedFromRailLedger: response.replayedFromLedger,
    });
  });

  // The breaker tracks rail health, so it must only count genuine rail contact.
  if (response.status === 'failed' && classification.failureClass === 'BANK_DOWNTIME') {
    await recordFailure(args.mandate.bankCode, args.scheduledAt);
  } else if (response.status === 'success') {
    await recordSuccess(args.mandate.bankCode, args.scheduledAt);
  }

  return {
    idempotencyKey: key,
    status: response.status,
    rawErrorCode: response.rawErrorCode,
    rawErrorDesc: response.rawErrorDesc,
    failureClass: response.status === 'success' ? 'UNKNOWN' : classification.failureClass,
    classificationMatched: classification.matched,
    feePaise,
    servedFromExistingAttempt: false,
    servedFromRailLedger: response.replayedFromLedger,
  };
}

async function loadSettledAttempt(
  key: string,
): Promise<Omit<ExecuteAttemptResult, 'servedFromExistingAttempt' | 'servedFromRailLedger'> | null> {
  const res = await getPool().query<{
    status: 'in_flight' | 'success' | 'failed';
    raw_error_code: string;
    raw_error_desc: string;
    failure_class: FailureClass;
    classification_matched: boolean;
    fee_paise: string;
  }>(
    `SELECT status, raw_error_code, raw_error_desc, failure_class,
            classification_matched, fee_paise
       FROM charge_attempts WHERE idempotency_key = $1`,
    [key],
  );
  const row = res.rows[0];
  if (row === undefined || row.status === 'in_flight') return null;
  return {
    idempotencyKey: key,
    status: row.status,
    rawErrorCode: row.raw_error_code,
    rawErrorDesc: row.raw_error_desc,
    failureClass: row.failure_class,
    classificationMatched: row.classification_matched,
    feePaise: Number(row.fee_paise),
  };
}

/**
 * Attempts stranded 'in_flight' by a dead worker. The reaper hands these back to the
 * queue; `executeAttempt` then takes them over safely via the same idempotency key.
 */
export async function findStrandedAttempts(
  olderThanMs: number,
): Promise<Array<{ caseId: string; attemptNo: number; idempotencyKey: string }>> {
  const res = await getPool().query<{
    case_id: string;
    attempt_no: number;
    idempotency_key: string;
  }>(
    `SELECT case_id, attempt_no, idempotency_key
       FROM charge_attempts
      WHERE status = 'in_flight'
        AND created_at < now() - ($1::bigint * interval '1 millisecond')
      ORDER BY created_at`,
    [olderThanMs],
  );
  return res.rows.map((r) => ({
    caseId: r.case_id,
    attemptNo: r.attempt_no,
    idempotencyKey: r.idempotency_key,
  }));
}
