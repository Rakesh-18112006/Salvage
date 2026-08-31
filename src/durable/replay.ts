/**
 * Event-log replay.
 *
 * Phase 2 acceptance: "replaying the full event log reconstructs identical case state."
 *
 * This is a real reducer over `case_events`, not a re-read of `recovery_cases` wearing a
 * disguise. It starts from nothing and folds the events, then the caller compares the
 * result against the stored row. If they ever disagree, either a write path mutated state
 * without logging it, or the log lies - and both are the kind of bug that only surfaces
 * during an audit, which is far too late.
 */
import type { Arm, CaseOutcome, CaseState } from '../domain/types.ts';
import type { FailureClass } from '../domain/taxonomy.ts';
import { getPool } from '../db/pool.ts';
import type { CaseRow } from './caseStore.ts';

export interface ReconstructedCase {
  id: string;
  subscriptionId: string;
  cycleId: string;
  arm: Arm;
  state: CaseState;
  version: number;
  diagnosis: FailureClass;
  attemptsUsed: number;
  contactsUsed: number;
  openedAt: number;
  closedAt: number | null;
  outcome: CaseOutcome | null;
  recoveredPaise: number;
  costPaise: number;
}

interface EventRow {
  case_id: string;
  seq: number;
  event_type: string;
  payload: Record<string, unknown>;
  occurred_at: Date;
}

/** Fold one case's events into state. Pure over its inputs. */
export function foldEvents(events: ReadonlyArray<EventRow>): ReconstructedCase | null {
  let acc: ReconstructedCase | null = null;

  for (const ev of events) {
    const p = ev.payload;
    switch (ev.event_type) {
      case 'CASE_OPENED':
        acc = {
          id: ev.case_id,
          subscriptionId: String(p.subscriptionId),
          cycleId: String(p.cycleId),
          arm: p.arm as Arm,
          state: 'OPEN',
          version: 1,
          diagnosis: p.diagnosis as FailureClass,
          attemptsUsed: 0,
          contactsUsed: 0,
          openedAt: ev.occurred_at.getTime(),
          closedAt: null,
          outcome: null,
          recoveredPaise: 0,
          costPaise: 0,
        };
        break;

      case 'ATTEMPT_CLAIMED':
        if (acc === null) throw new Error(`${ev.case_id}: ATTEMPT_CLAIMED before CASE_OPENED`);
        // A claim is not yet an attempt against the budget; the settle event counts it.
        break;

      case 'ATTEMPT_SETTLED':
        if (acc === null) throw new Error(`${ev.case_id}: ATTEMPT_SETTLED before CASE_OPENED`);
        acc.attemptsUsed += 1;
        acc.costPaise += typeof p.feePaise === 'number' ? p.feePaise : 0;
        if (p.status === 'failed') acc.diagnosis = p.failureClass as FailureClass;
        break;

      case 'NOTIFICATION_SENT':
        if (acc === null) throw new Error(`${ev.case_id}: NOTIFICATION_SENT before CASE_OPENED`);
        acc.contactsUsed += 1;
        break;

      default: {
        // Every transition event carries {from, to, version}; that is the contract
        // transitionCase() writes and the only shape this reducer relies on.
        if (acc === null) throw new Error(`${ev.case_id}: ${ev.event_type} before CASE_OPENED`);
        if (typeof p.to === 'string' && typeof p.version === 'number') {
          acc.state = p.to as CaseState;
          acc.version = p.version;
          if (typeof p.diagnosis === 'string') acc.diagnosis = p.diagnosis as FailureClass;
          if (typeof p.outcome === 'string') acc.outcome = p.outcome as CaseOutcome;
          if (typeof p.recoveredPaise === 'number') acc.recoveredPaise = p.recoveredPaise;
          if (typeof p.addCostPaise === 'number') acc.costPaise += p.addCostPaise;
          if (
            acc.state === 'RECOVERED' ||
            acc.state === 'EXHAUSTED' ||
            acc.state === 'HUMAN_QUEUE'
          ) {
            acc.closedAt = ev.occurred_at.getTime();
          }
        }
        break;
      }
    }
  }

  return acc;
}

export async function replayCase(caseId: string): Promise<ReconstructedCase | null> {
  const res = await getPool().query<EventRow>(
    'SELECT case_id, seq, event_type, payload, occurred_at FROM case_events WHERE case_id = $1 ORDER BY seq',
    [caseId],
  );
  return foldEvents(res.rows);
}

export interface ReplayDivergence {
  readonly caseId: string;
  readonly field: string;
  readonly stored: unknown;
  readonly replayed: unknown;
}

/** Compare a stored case row against the state its own event log implies. */
export function compareToStored(
  stored: CaseRow,
  replayed: ReconstructedCase | null,
): ReplayDivergence[] {
  if (replayed === null) {
    return [{ caseId: stored.id, field: '<entire case>', stored: stored.state, replayed: null }];
  }
  const checks: Array<[string, unknown, unknown]> = [
    ['state', stored.state, replayed.state],
    ['version', stored.version, replayed.version],
    ['diagnosis', stored.diagnosis, replayed.diagnosis],
    ['attempts_used', stored.attempts_used, replayed.attemptsUsed],
    ['contacts_used', stored.contacts_used, replayed.contactsUsed],
    ['outcome', stored.outcome, replayed.outcome],
    ['recovered_paise', Number(stored.recovered_paise), replayed.recoveredPaise],
    ['cost_paise', Number(stored.cost_paise), replayed.costPaise],
    ['closed_at', stored.closed_at?.getTime() ?? null, replayed.closedAt],
    ['opened_at', stored.opened_at.getTime(), replayed.openedAt],
  ];
  return checks
    .filter(([, a, b]) => a !== b)
    .map(([field, a, b]) => ({ caseId: stored.id, field, stored: a, replayed: b }));
}

/** Replay every case and report divergences. Empty result = the log is authoritative. */
export async function verifyAllCases(): Promise<{
  casesChecked: number;
  divergences: ReplayDivergence[];
}> {
  const stored = await getPool().query<CaseRow>('SELECT * FROM recovery_cases ORDER BY id');
  const divergences: ReplayDivergence[] = [];
  for (const row of stored.rows) {
    const replayed = await replayCase(row.id);
    divergences.push(...compareToStored(row, replayed));
  }
  return { casesChecked: stored.rows.length, divergences };
}
