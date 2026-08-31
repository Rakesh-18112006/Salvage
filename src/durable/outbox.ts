/**
 * Transactional outbox.
 *
 * The problem it solves: "update the database, then publish an event" is two systems and
 * therefore two failure modes - state changed but nobody was told, or everybody was told
 * about a change that then rolled back. Neither is acceptable when the event is "we
 * charged this customer".
 *
 * So the event is written to `outbox` inside the SAME transaction as the state change.
 * Publishing is a separate, at-least-once sweep. Consumers must be idempotent; ours are,
 * because every effect is keyed.
 */
import type { PoolClient } from 'pg';

import { getPool } from '../db/pool.ts';

/** Enqueue an event. MUST be called with the client of the transaction making the change. */
export async function enqueueOutbox(
  client: PoolClient,
  aggregateId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    'INSERT INTO outbox (aggregate_id, event_type, payload) VALUES ($1, $2, $3)',
    [aggregateId, eventType, JSON.stringify(payload)],
  );
}

export interface OutboxRow {
  id: string;
  aggregate_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  created_at: Date;
  published_at: Date | null;
}

/**
 * Publish a batch of unpublished events.
 *
 * `FOR UPDATE SKIP LOCKED` again: several publishers can run at once, and a publisher
 * that dies mid-batch simply leaves its rows unpublished for the next sweep.
 */
export async function publishBatch(
  publish: (row: OutboxRow) => Promise<void>,
  batchSize = 100,
): Promise<number> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const res = await client.query<OutboxRow>(
      `SELECT * FROM outbox
        WHERE published_at IS NULL
        ORDER BY id
        FOR UPDATE SKIP LOCKED
        LIMIT $1`,
      [batchSize],
    );
    for (const row of res.rows) {
      await publish(row);
      await client.query('UPDATE outbox SET published_at = now() WHERE id = $1', [row.id]);
    }
    await client.query('COMMIT');
    return res.rows.length;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function outboxStats(): Promise<{ total: number; unpublished: number }> {
  const res = await getPool().query<{ total: string; unpublished: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE published_at IS NULL)::text AS unpublished
       FROM outbox`,
  );
  const r = res.rows[0]!;
  return { total: Number(r.total), unpublished: Number(r.unpublished) };
}
