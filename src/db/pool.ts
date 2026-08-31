/** Postgres access. One pool per process, transactions as a first-class helper. */
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

import { optionalEnv } from '../config.ts';

export const DEFAULT_DATABASE_URL = 'postgres://salvage:salvage@localhost:55432/salvage';

/** Resolved lazily: reading env at module load would race .env loading. */
export function databaseUrl(): string {
  return optionalEnv('DATABASE_URL', DEFAULT_DATABASE_URL);
}

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool === null) {
    pool = new Pool({
      connectionString: databaseUrl(),
      max: 12,
      // A worker that cannot reach Postgres must fail fast and let its job be reclaimed,
      // not hang holding a charge half-executed.
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 10_000,
    });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool !== null) {
    await pool.end();
    pool = null;
  }
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: ReadonlyArray<unknown> = [],
): Promise<T[]> {
  const res = await getPool().query<T>(text, params as unknown[]);
  return res.rows;
}

export async function queryOne<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: ReadonlyArray<unknown> = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Run `fn` inside a transaction. Commits on return, rolls back on throw.
 *
 * This is the unit the inbox and outbox patterns depend on: the state change and the
 * event that announces it must commit together or not at all.
 */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection is already broken; the transaction is aborted either way.
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Postgres unique-violation. Used everywhere a race is resolved by "loser backs off". */
export const PG_UNIQUE_VIOLATION = '23505';

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: string }).code === PG_UNIQUE_VIOLATION
  );
}
