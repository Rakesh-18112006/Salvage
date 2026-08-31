/**
 * CROSS-VALIDATION: the in-memory runner and the durable spine must agree.
 *
 * There are now two engines that can run the same seeded scenario - Phase 1's in-memory
 * case runner, and Phase 2's Postgres + queue pipeline. If they disagree on the same
 * seed, one of them is wrong, and every number this project reports afterwards is
 * suspect. So the agreement is asserted rather than assumed.
 *
 * Circuit breakers are switched OFF for the equivalence run, because the in-memory
 * runner does not have them. The second test switches them on and shows the difference
 * is confined to exactly the cases a breaker deferred - a real behavioural difference,
 * measured rather than hand-waved.
 */
import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, test } from 'node:test';

import { closePool, getPool } from '../src/db/pool.ts';
import { ControlT3Policy } from '../src/policy/controlT3.ts';
import { runBatch } from '../src/engine/runner.ts';
import { caseOutcomes, seedAndOpenCases, waitForDrain } from '../src/durable/pipeline.ts';
import { createRecoveryWorker, DEMO_LOCK_DURATION_MS } from '../src/queue/queues.ts';
import { makeJobProcessor } from '../src/queue/recoveryWorker.ts';
import {
  clearQueues,
  databaseAvailable,
  prepareDatabase,
  redisAvailable,
  SKIP_MESSAGE,
} from './helpers/dbHarness.ts';

const SEED = '20260101';
const CASES = 120;
let available = false;

async function runDurable(breakersEnabled: boolean) {
  const policy = new ControlT3Policy();
  const seeded = await seedAndOpenCases(SEED, CASES, policy, undefined, breakersEnabled);
  const worker = createRecoveryWorker(
    makeJobProcessor({
      world: seeded.population.world,
      policy,
      queue: seeded.queue,
      breakersEnabled,
    }),
    { concurrency: 4, stalledIntervalMs: 250, lockDurationMs: DEMO_LOCK_DURATION_MS },
  );
  try {
    assert.equal(await waitForDrain(seeded.queue, 120_000), true, 'queue must drain');
    return await caseOutcomes();
  } finally {
    await worker.close();
    await seeded.queue.close();
  }
}

describe('engine equivalence', { concurrency: false }, () => {
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

  test('with breakers off, the durable spine reproduces the in-memory runner exactly', async (t) => {
    if (!available) return t.skip(SKIP_MESSAGE);

    const { arms } = await runBatch(SEED, CASES, [new ControlT3Policy()]);
    const inMemory = arms[0]!.cases;
    const durable = await runDurable(false);

    assert.equal(durable.size, inMemory.length, 'both engines must run the same cohort');

    const divergences: string[] = [];
    for (const c of inMemory) {
      const d = durable.get(c.subscriptionId);
      if (d === undefined) {
        divergences.push(`${c.subscriptionId}: missing from the durable run`);
        continue;
      }
      if (c.outcome !== d.outcome) {
        divergences.push(`${c.subscriptionId}: outcome ${c.outcome} vs ${d.outcome}`);
      }
      if (c.attempts.length !== d.attempts) {
        divergences.push(
          `${c.subscriptionId}: attempts ${c.attempts.length} vs ${d.attempts}`,
        );
      }
      if (c.closedAt !== d.closedAt) {
        divergences.push(`${c.subscriptionId}: closedAt ${c.closedAt} vs ${d.closedAt}`);
      }
    }

    assert.deepEqual(
      divergences,
      [],
      `the two engines disagree on the same seed:\n  ${divergences.slice(0, 15).join('\n  ')}`,
    );
  });

  test('with breakers on, differences are confined to breaker-deferred cases', async (t) => {
    if (!available) return t.skip(SKIP_MESSAGE);

    const { arms } = await runBatch(SEED, CASES, [new ControlT3Policy()]);
    const inMemory = new Map(arms[0]!.cases.map((c) => [c.subscriptionId, c]));
    const durable = await runDurable(true);

    // Which cases did a breaker actually touch?
    const deferred = await getPool().query<{ subscription_id: string }>(
      `SELECT DISTINCT c.subscription_id
         FROM case_events e JOIN recovery_cases c ON c.id = e.case_id
        WHERE e.event_type = 'ATTEMPT_DEFERRED_BY_BREAKER'`,
    );
    const deferredIds = new Set(deferred.rows.map((r) => r.subscription_id));

    const unexplained: string[] = [];
    for (const [sid, d] of durable) {
      const m = inMemory.get(sid);
      if (m === undefined) continue;
      const differs = m.outcome !== d.outcome || m.attempts.length !== d.attempts;
      if (differs && !deferredIds.has(sid)) {
        unexplained.push(
          `${sid}: ${m.outcome}/${m.attempts.length} vs ${d.outcome}/${d.attempts}`,
        );
      }
    }

    assert.deepEqual(
      unexplained,
      [],
      'every difference must be attributable to a circuit-breaker deferral:\n  ' +
        unexplained.slice(0, 15).join('\n  '),
    );
  });
});
