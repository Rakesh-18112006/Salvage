/**
 * Shared setup for the Phase 2 tests.
 *
 * These tests talk to a REAL Postgres and a REAL Redis (docker compose up -d). They are
 * not unit tests with the database mocked out, and that is deliberate: every guarantee
 * Phase 2 claims is enforced by a constraint, a trigger, or a lock. Mocking the database
 * would mock away the entire subject of the test.
 */
import { loadEnv } from '../../src/config.ts';
import { getPool } from '../../src/db/pool.ts';
import { migrate } from '../../src/db/migrate.ts';
import { truncateAll } from '../../src/durable/repo.ts';

loadEnv();

/**
 * Tests get their own queue.
 *
 * The chaos demo leaves worker CONTAINERS running, and they consume from the default
 * queue. Without this they silently steal the suite's jobs and process them with a
 * different configuration - which is exactly how the engine-equivalence test started
 * failing on one mystery case for reasons nothing in the test could explain.
 */
process.env.SALVAGE_QUEUE_NAME ??= 'salvage.test';

let prepared = false;

/** True when Postgres is reachable. Lets the suite skip cleanly instead of failing. */
export async function databaseAvailable(): Promise<boolean> {
  try {
    await getPool().query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

export async function prepareDatabase(): Promise<void> {
  if (!prepared) {
    await migrate({ quiet: true });
    prepared = true;
  }
  await truncateAll();
}

export const SKIP_MESSAGE =
  'Postgres is not reachable at DATABASE_URL. Run: docker compose up -d';

/**
 * Clear the queue between tests.
 *
 * Job ids are deterministic (`caseId#attemptNo`) so that an attempt can never be queued
 * twice - which is exactly what we want in production, and exactly what breaks test
 * isolation: BullMQ silently ignores an `add` whose job id already exists, including
 * ids left behind by a previous test run. Truncating Postgres is not enough; Redis
 * carries that state too.
 */
export async function clearQueues(): Promise<void> {
  const { createRecoveryQueue } = await import('../../src/queue/queues.ts');
  const queue = createRecoveryQueue();
  try {
    await queue.obliterate({ force: true });
  } finally {
    await queue.close();
  }
}

export async function redisAvailable(): Promise<boolean> {
  try {
    await clearQueues();
    return true;
  } catch {
    return false;
  }
}
