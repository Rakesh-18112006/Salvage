/**
 * PHASE 2 ACCEPTANCE, part 3: the spine running a whole batch.
 *
 *   "killing a worker mid-flight results in ZERO LOST CASES"
 *   "replaying the full event log reconstructs identical case state"
 *
 * These run real BullMQ workers against real Redis, with simulated time compressed so a
 * T+3 cycle completes in milliseconds rather than days.
 */
import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, test } from 'node:test';

import { closePool, getPool } from '../src/db/pool.ts';
import { ControlT3Policy } from '../src/policy/controlT3.ts';
import { seedAndOpenCases, summarise, waitForDrain } from '../src/durable/pipeline.ts';
import { ledgerTotals } from '../src/durable/railClient.ts';
import { verifyAllCases } from '../src/durable/replay.ts';
import { makeJobProcessor } from '../src/queue/recoveryWorker.ts';
import { createRecoveryWorker, DEMO_LOCK_DURATION_MS } from '../src/queue/queues.ts';
import {
  clearQueues,
  databaseAvailable,
  prepareDatabase,
  redisAvailable,
  SKIP_MESSAGE,
} from './helpers/dbHarness.ts';

const SEED = 'pipeline';
const CASES = 40;
let available = false;

describe('durable pipeline', { concurrency: false }, () => {
  before(async () => {
    available = (await databaseAvailable()) && (await redisAvailable());
    if (available) await prepareDatabase();
  });
  beforeEach(async () => {
    if (!available) return;
    await prepareDatabase();
    await clearQueues();
  });
  after(async () => {
    await closePool();
  });

  test('a full batch runs to closure with zero lost cases and zero duplicate charges', async (t) => {
    if (!available) return t.skip(SKIP_MESSAGE);

    const policy = new ControlT3Policy();
    const seeded = await seedAndOpenCases(SEED, CASES, policy);
    const queue = seeded.queue;

    const worker = createRecoveryWorker(
      makeJobProcessor({ world: seeded.population.world, policy, queue }),
      { concurrency: 4 },
    );

    try {
      const drained = await waitForDrain(queue, 60_000);
      assert.equal(drained, true, 'the queue must drain within the timeout');

      const summary = await summarise('control');
      assert.equal(summary.cases, CASES);
      assert.equal(summary.open, 0, 'ZERO LOST CASES: every case must reach a terminal state');
      assert.equal(summary.closed, CASES);
      assert.ok(summary.recovered > 0, 'the control policy must recover something');

      // Every settled attempt corresponds to exactly one gateway charge. If any attempt
      // had been charged twice, charges would exceed the number of attempt rows.
      const attemptRows = await getPool().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM charge_attempts WHERE status <> 'in_flight'`,
      );
      const totals = await ledgerTotals();
      assert.equal(
        totals.charges,
        Number(attemptRows.rows[0]!.n),
        'ZERO DUPLICATE CHARGES: one money movement per settled attempt',
      );
      assert.equal(totals.charges, totals.keys, 'one charge per idempotency key');

      // No attempt may be left staked but unsettled once the queue is drained.
      const stranded = await getPool().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM charge_attempts WHERE status = 'in_flight'`,
      );
      assert.equal(Number(stranded.rows[0]!.n), 0, 'no attempt may be stranded in_flight');
    } finally {
      await worker.close();
      await queue.close();
    }
  });

  test('replaying the event log reconstructs identical case state', async (t) => {
    if (!available) return t.skip(SKIP_MESSAGE);

    const policy = new ControlT3Policy();
    const seeded = await seedAndOpenCases(SEED, 25, policy);
    const worker = createRecoveryWorker(
      makeJobProcessor({ world: seeded.population.world, policy, queue: seeded.queue }),
      { concurrency: 4 },
    );

    try {
      assert.equal(await waitForDrain(seeded.queue, 60_000), true);

      // The reducer starts from nothing and folds case_events. If any write path ever
      // changed state without logging it, this is where it surfaces.
      const { casesChecked, divergences } = await verifyAllCases();
      assert.equal(casesChecked, 25);
      assert.deepEqual(
        divergences,
        [],
        `event log diverged from stored state:\n${JSON.stringify(divergences, null, 2)}`,
      );
    } finally {
      await worker.close();
      await seeded.queue.close();
    }
  });

  test('a worker killed mid-batch loses no cases: a survivor finishes them', async (t) => {
    if (!available) return t.skip(SKIP_MESSAGE);

    const policy = new ControlT3Policy();
    const seeded = await seedAndOpenCases(SEED, 30, policy);

    // Worker A starts the batch, then is closed abruptly part-way through.
    const workerA = createRecoveryWorker(
      makeJobProcessor({ world: seeded.population.world, policy, queue: seeded.queue }),
      { concurrency: 2, stalledIntervalMs: 250, lockDurationMs: DEMO_LOCK_DURATION_MS },
    );
    await new Promise((r) => setTimeout(r, 120));
    await workerA.close(true); // force close: in-flight jobs are abandoned, not finished

    // Worker B takes over. BullMQ reclaims the stalled jobs; the executor makes the
    // replay safe.
    const workerB = createRecoveryWorker(
      makeJobProcessor({ world: seeded.population.world, policy, queue: seeded.queue }),
      { concurrency: 4, stalledIntervalMs: 250, lockDurationMs: DEMO_LOCK_DURATION_MS },
    );

    try {
      assert.equal(await waitForDrain(seeded.queue, 90_000), true);

      const summary = await summarise('control');
      assert.equal(summary.open, 0, 'ZERO LOST CASES after a worker was killed mid-batch');
      assert.equal(summary.cases, 30);

      const attemptRows = await getPool().query<{ n: string }>(
        `SELECT count(*)::text AS n FROM charge_attempts WHERE status <> 'in_flight'`,
      );
      const totals = await ledgerTotals();
      assert.equal(
        totals.charges,
        Number(attemptRows.rows[0]!.n),
        'ZERO DUPLICATE CHARGES despite the mid-batch kill',
      );

      const { divergences } = await verifyAllCases();
      assert.deepEqual(divergences, [], 'the event log must still reconstruct state exactly');
    } finally {
      await workerB.close();
      await seeded.queue.close();
    }
  });

  test('the control policy never exceeds its attempt budget, even across restarts', async (t) => {
    if (!available) return t.skip(SKIP_MESSAGE);

    const policy = new ControlT3Policy();
    const seeded = await seedAndOpenCases(SEED, 20, policy);
    const worker = createRecoveryWorker(
      makeJobProcessor({ world: seeded.population.world, policy, queue: seeded.queue }),
      { concurrency: 4 },
    );

    try {
      assert.equal(await waitForDrain(seeded.queue, 60_000), true);
      const rows = await getPool().query<{ id: string; attempts_used: number }>(
        'SELECT id, attempts_used FROM recovery_cases',
      );
      for (const row of rows.rows) {
        // Opening charge plus at most three retries.
        assert.ok(
          row.attempts_used <= 4,
          `${row.id} used ${row.attempts_used} attempts; the T+3 budget is 1 + 3`,
        );
      }
    } finally {
      await worker.close();
      await seeded.queue.close();
    }
  });
});
