/**
 * Dead letter queue, with replay.
 *
 * A DLQ that you can only read is a graveyard. The row stores the full job payload so a
 * dead letter can be put back on the queue once the cause is fixed - which is the only
 * reason to have one.
 */
import { getPool } from '../db/pool.ts';

export interface DeadLetterRow {
  id: string;
  source: string;
  job_name: string;
  payload: Record<string, unknown>;
  error: string;
  attempts: number;
  created_at: Date;
  replayed_at: Date | null;
}

export async function deadLetter(args: {
  source: string;
  jobName: string;
  payload: Record<string, unknown>;
  error: unknown;
  attempts: number;
}): Promise<void> {
  const message =
    args.error instanceof Error
      ? (args.error.stack ?? args.error.message)
      : String(args.error);
  await getPool().query(
    `INSERT INTO dead_letters (source, job_name, payload, error, attempts)
     VALUES ($1, $2, $3, $4, $5)`,
    [args.source, args.jobName, JSON.stringify(args.payload), message, args.attempts],
  );
}

export async function pendingDeadLetters(limit = 100): Promise<DeadLetterRow[]> {
  const res = await getPool().query<DeadLetterRow>(
    'SELECT * FROM dead_letters WHERE replayed_at IS NULL ORDER BY id LIMIT $1',
    [limit],
  );
  return res.rows;
}

/**
 * Replay pending dead letters through `resubmit`. A row is only marked replayed once
 * resubmission succeeded, so a failing replay can be run again safely.
 */
export async function replayDeadLetters(
  resubmit: (row: DeadLetterRow) => Promise<void>,
  limit = 100,
): Promise<{ replayed: number; failed: number }> {
  const rows = await pendingDeadLetters(limit);
  let replayed = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await resubmit(row);
      await getPool().query('UPDATE dead_letters SET replayed_at = now() WHERE id = $1', [row.id]);
      replayed++;
    } catch {
      failed++;
    }
  }
  return { replayed, failed };
}

export async function deadLetterStats(): Promise<{ total: number; pending: number }> {
  const res = await getPool().query<{ total: string; pending: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE replayed_at IS NULL)::text AS pending
       FROM dead_letters`,
  );
  const r = res.rows[0]!;
  return { total: Number(r.total), pending: Number(r.pending) };
}
