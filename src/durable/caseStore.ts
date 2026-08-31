/**
 * The recovery-case state machine, persisted.
 *
 *   OPEN -> AWAITING_RETRY <-> AWAITING_CUSTOMER
 *                |
 *                v
 *     RECOVERED | EXHAUSTED | HUMAN_QUEUE
 *
 * Every transition uses optimistic concurrency (`WHERE version = $n`) so two workers
 * racing the same case cannot both advance it. The loser gets a version conflict and
 * backs off rather than writing over the winner.
 *
 * Every transition also appends to `case_events` in the SAME transaction. That is what
 * makes the Phase 2 acceptance criterion achievable: replaying the event log has to
 * reconstruct identical case state, which is only true if state and log can never
 * diverge.
 */
import type { PoolClient } from 'pg';

import type { Arm, CaseOutcome, CaseState, Timestamp } from '../domain/types.ts';
import type { FailureClass } from '../domain/taxonomy.ts';
import { getPool, isUniqueViolation, withTransaction } from '../db/pool.ts';

export class VersionConflictError extends Error {
  readonly caseId: string;
  readonly expectedVersion: number;

  constructor(caseId: string, expectedVersion: number) {
    super(`case ${caseId} was modified concurrently (expected version ${expectedVersion})`);
    this.name = 'VersionConflictError';
    this.caseId = caseId;
    this.expectedVersion = expectedVersion;
  }
}

export interface CaseRow {
  id: string;
  subscription_id: string;
  cycle_id: string;
  arm: Arm;
  state: CaseState;
  version: number;
  diagnosis: FailureClass;
  attempts_used: number;
  contacts_used: number;
  opened_at: Date;
  closed_at: Date | null;
  outcome: CaseOutcome | null;
  recovered_paise: string;
  cost_paise: string;
  true_opening_class: FailureClass;
}

const TERMINAL_STATES: ReadonlySet<CaseState> = new Set<CaseState>([
  'RECOVERED',
  'EXHAUSTED',
  'HUMAN_QUEUE',
]);

/** Legal transitions. Anything absent here is a bug, and is rejected before it persists. */
const ALLOWED: Readonly<Record<CaseState, ReadonlyArray<CaseState>>> = {
  OPEN: ['AWAITING_RETRY', 'AWAITING_CUSTOMER', 'RECOVERED', 'EXHAUSTED', 'HUMAN_QUEUE'],
  AWAITING_RETRY: ['AWAITING_RETRY', 'AWAITING_CUSTOMER', 'RECOVERED', 'EXHAUSTED', 'HUMAN_QUEUE'],
  AWAITING_CUSTOMER: ['AWAITING_RETRY', 'AWAITING_CUSTOMER', 'RECOVERED', 'EXHAUSTED', 'HUMAN_QUEUE'],
  RECOVERED: [],
  EXHAUSTED: [],
  HUMAN_QUEUE: [],
};

export function isTerminalState(s: CaseState): boolean {
  return TERMINAL_STATES.has(s);
}

export function assertTransitionAllowed(from: CaseState, to: CaseState): void {
  if (!ALLOWED[from].includes(to)) {
    throw new Error(`illegal case transition ${from} -> ${to}`);
  }
}

export interface OpenCaseArgs {
  readonly id: string;
  readonly subscriptionId: string;
  readonly cycleId: string;
  readonly arm: Arm;
  readonly diagnosis: FailureClass;
  readonly openedAt: Timestamp;
  readonly trueOpeningClass: FailureClass;
}

/**
 * Open a case, or return the existing one.
 *
 * Idempotent by construction: `recovery_cases_one_per_cycle` means a redelivered webhook
 * or a racing scheduler cannot open a second case for the same failure. Two cases for
 * one cycle would be two independent retry budgets pointed at the same customer.
 */
export async function openCase(args: OpenCaseArgs): Promise<{ row: CaseRow; created: boolean }> {
  try {
    return await withTransaction(async (client) => {
      const res = await client.query<CaseRow>(
        `INSERT INTO recovery_cases
           (id, subscription_id, cycle_id, arm, state, version, diagnosis,
            attempts_used, contacts_used, opened_at, true_opening_class)
         VALUES ($1, $2, $3, $4, 'OPEN', 1, $5, 0, 0, $6, $7)
         RETURNING *`,
        [
          args.id,
          args.subscriptionId,
          args.cycleId,
          args.arm,
          args.diagnosis,
          new Date(args.openedAt),
          args.trueOpeningClass,
        ],
      );
      const row = res.rows[0]!;
      await appendEvent(client, row.id, 'CASE_OPENED', args.openedAt, {
        subscriptionId: args.subscriptionId,
        cycleId: args.cycleId,
        arm: args.arm,
        diagnosis: args.diagnosis,
      });
      return { row, created: true };
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = await loadCaseBy(args.subscriptionId, args.cycleId, args.arm);
    if (existing === null) throw err;
    return { row: existing, created: false };
  }
}

export async function loadCase(caseId: string): Promise<CaseRow | null> {
  const res = await getPool().query<CaseRow>('SELECT * FROM recovery_cases WHERE id = $1', [caseId]);
  return res.rows[0] ?? null;
}

export async function loadCaseBy(
  subscriptionId: string,
  cycleId: string,
  arm: Arm,
): Promise<CaseRow | null> {
  const res = await getPool().query<CaseRow>(
    'SELECT * FROM recovery_cases WHERE subscription_id = $1 AND cycle_id = $2 AND arm = $3',
    [subscriptionId, cycleId, arm],
  );
  return res.rows[0] ?? null;
}

export interface TransitionArgs {
  readonly caseId: string;
  readonly expectedVersion: number;
  readonly toState: CaseState;
  readonly at: Timestamp;
  readonly outcome?: CaseOutcome;
  readonly recoveredPaise?: number;
  readonly addCostPaise?: number;
  // NOTE: attempts_used and contacts_used are deliberately NOT settable here. They are
  // owned by the executor and the notifier respectively, each incrementing in the same
  // transaction that logs ATTEMPT_SETTLED / NOTIFICATION_SENT. Two write paths for one
  // counter is how a stored value and its event log drift apart.
  readonly diagnosis?: FailureClass;
  readonly eventType?: string;
  readonly eventPayload?: Record<string, unknown>;
}

/**
 * Advance a case. Throws VersionConflictError if another worker moved first.
 *
 * The caller is expected to reload and re-decide on conflict, never to retry blindly:
 * the winning worker may have already closed the case.
 */
export async function transitionCase(args: TransitionArgs): Promise<CaseRow> {
  return withTransaction(async (client) => {
    const current = await client.query<CaseRow>(
      'SELECT * FROM recovery_cases WHERE id = $1 FOR UPDATE',
      [args.caseId],
    );
    const row = current.rows[0];
    if (row === undefined) throw new Error(`unknown case ${args.caseId}`);
    if (row.version !== args.expectedVersion) {
      throw new VersionConflictError(args.caseId, args.expectedVersion);
    }
    assertTransitionAllowed(row.state, args.toState);

    const closing = isTerminalState(args.toState);
    if (closing && args.outcome === undefined) {
      throw new Error(`closing transition to ${args.toState} requires an outcome`);
    }

    const updated = await client.query<CaseRow>(
      `UPDATE recovery_cases
          SET state           = $2,
              version         = version + 1,
              diagnosis       = COALESCE($3, diagnosis),
              cost_paise      = cost_paise + $4,
              recovered_paise = COALESCE($5, recovered_paise),
              closed_at       = CASE WHEN $6::boolean THEN $7::timestamptz ELSE closed_at END,
              outcome         = COALESCE($8, outcome)
        WHERE id = $1 AND version = $9
        RETURNING *`,
      [
        args.caseId,
        args.toState,
        args.diagnosis ?? null,
        args.addCostPaise ?? 0,
        args.recoveredPaise ?? null,
        closing,
        new Date(args.at),
        args.outcome ?? null,
        args.expectedVersion,
      ],
    );

    const next = updated.rows[0];
    if (next === undefined) throw new VersionConflictError(args.caseId, args.expectedVersion);

    await appendEvent(
      client,
      args.caseId,
      args.eventType ?? `CASE_${args.toState}`,
      args.at,
      {
        from: row.state,
        to: args.toState,
        version: next.version,
        // Everything the replay reducer needs to reconstruct this transition without
        // consulting recovery_cases. If a field can change state, it belongs here.
        ...(args.diagnosis !== undefined ? { diagnosis: args.diagnosis } : {}),
        ...(args.outcome !== undefined ? { outcome: args.outcome } : {}),
        ...(args.recoveredPaise !== undefined ? { recoveredPaise: args.recoveredPaise } : {}),
        ...(args.addCostPaise !== undefined ? { addCostPaise: args.addCostPaise } : {}),
        ...(args.eventPayload ?? {}),
      },
    );

    return next;
  });
}

/**
 * Append to the case's event log. Always called inside the transaction that made the
 * state change, so state and log cannot diverge.
 */
export async function appendEvent(
  client: PoolClient,
  caseId: string,
  eventType: string,
  occurredAt: Timestamp,
  payload: Record<string, unknown>,
): Promise<number> {
  const res = await client.query<{ seq: number }>(
    `INSERT INTO case_events (case_id, seq, event_type, payload, occurred_at)
     VALUES ($1,
             (SELECT coalesce(max(seq), 0) + 1 FROM case_events WHERE case_id = $1),
             $2, $3, $4)
     RETURNING seq`,
    [caseId, eventType, JSON.stringify(payload), new Date(occurredAt)],
  );
  return res.rows[0]!.seq;
}

/** Cases that are still open, oldest first. */
export async function loadOpenCases(limit = 1000): Promise<CaseRow[]> {
  const res = await getPool().query<CaseRow>(
    'SELECT * FROM recovery_cases WHERE closed_at IS NULL ORDER BY opened_at LIMIT $1',
    [limit],
  );
  return res.rows;
}
