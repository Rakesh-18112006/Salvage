/**
 * Transactional inbox.
 *
 * Spec Phase 2: "Duplicate webhook delivery deduped at the inbox on razorpay_event_id."
 *
 * Gateways retry webhooks. That is correct behaviour on their side and it means we WILL
 * receive the same event more than once. Dedupe belongs at the boundary, on the
 * provider's own event id, before any handler runs - not inside each handler, where
 * every new handler is a fresh chance to forget.
 *
 * `processed_at` is set in the SAME transaction as whatever the handler did, so an event
 * is never marked processed unless its effects committed.
 */
import type { PoolClient } from 'pg';

import { getPool, isUniqueViolation, withTransaction } from '../db/pool.ts';

export interface InboundEvent {
  readonly eventId: string;
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
}

export interface AcceptResult {
  readonly accepted: boolean;
  /** True when we had already seen this event id. The delivery is a no-op. */
  readonly duplicate: boolean;
}

/** Record an inbound event. Returns duplicate=true if this id has been seen before. */
export async function acceptEvent(event: InboundEvent): Promise<AcceptResult> {
  try {
    await getPool().query(
      `INSERT INTO inbox (razorpay_event_id, event_type, payload) VALUES ($1, $2, $3)`,
      [event.eventId, event.eventType, JSON.stringify(event.payload)],
    );
    return { accepted: true, duplicate: false };
  } catch (err) {
    if (isUniqueViolation(err)) return { accepted: false, duplicate: true };
    throw err;
  }
}

export interface InboxRow {
  razorpay_event_id: string;
  event_type: string;
  payload: Record<string, unknown>;
  received_at: Date;
  processed_at: Date | null;
}

/**
 * Claim one unprocessed event for handling.
 *
 * `FOR UPDATE SKIP LOCKED` lets many workers drain the inbox concurrently without any of
 * them blocking on, or stealing, another's row.
 */
export async function claimNextUnprocessed(
  handler: (event: InboxRow, client: PoolClient) => Promise<void>,
): Promise<InboxRow | null> {
  return withTransaction(async (client) => {
    const res = await client.query<InboxRow>(
      `SELECT * FROM inbox
        WHERE processed_at IS NULL
        ORDER BY received_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
    );
    const row = res.rows[0];
    if (row === undefined) return null;

    await handler(row, client);

    // Marked processed only because the handler's writes are in this same transaction.
    await client.query('UPDATE inbox SET processed_at = now() WHERE razorpay_event_id = $1', [
      row.razorpay_event_id,
    ]);
    return row;
  });
}

/** Drain the inbox until it is empty. Returns how many events were handled. */
export async function drainInbox(
  handler: (event: InboxRow, client: PoolClient) => Promise<void>,
  maxEvents = 10_000,
): Promise<number> {
  let handled = 0;
  while (handled < maxEvents) {
    const row = await claimNextUnprocessed(handler);
    if (row === null) break;
    handled++;
  }
  return handled;
}

export async function inboxStats(): Promise<{ total: number; unprocessed: number }> {
  const res = await getPool().query<{ total: string; unprocessed: string }>(
    `SELECT count(*)::text AS total,
            count(*) FILTER (WHERE processed_at IS NULL)::text AS unprocessed
       FROM inbox`,
  );
  const r = res.rows[0]!;
  return { total: Number(r.total), unprocessed: Number(r.unprocessed) };
}
