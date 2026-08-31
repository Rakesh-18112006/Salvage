/**
 * PHASE 2 ACCEPTANCE, part 1:
 *   "killing a worker mid-flight results in zero duplicate charges and zero lost cases"
 *
 * The worker is killed for real - a child process that calls process.exit(137), the code
 * Docker reports for SIGKILL - at each of the two dangerous points in the execution:
 * after the attempt is claimed, and after the rail has been called but before the outcome
 * is recorded. The second one is the case that actually loses money in naive systems.
 *
 * The assertion is made against the GATEWAY'S ledger, not ours. Asserting that our own
 * charge_attempts table has one row would be circular; asserting that the counterparty
 * only ever moved money once is the actual claim.
 */
import { strict as assert } from 'node:assert';
import { execFile } from 'node:child_process';
import { after, before, beforeEach, describe, test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { closePool, getPool } from '../src/db/pool.ts';
import { openCase } from '../src/durable/caseStore.ts';
import { executeAttempt } from '../src/durable/executor.ts';
import { attemptIdempotencyKey } from '../src/durable/idempotency.ts';
import { ledgerChargeCount, ledgerTotals, SimulatedRailClient } from '../src/durable/railClient.ts';
import { loadWorld, persistPopulation } from '../src/durable/repo.ts';
import { buildAtRiskPopulation } from '../src/sim/population.ts';
import { databaseAvailable, prepareDatabase, SKIP_MESSAGE } from './helpers/dbHarness.ts';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const CRASH_CHILD = join(HERE, 'helpers', 'crashChild.ts');

const SEED = 'crash-safety';
let available = false;

describe('crash safety', { concurrency: false }, () => {
  before(async () => {
    available = await databaseAvailable();
    if (available) await prepareDatabase();
  });

  beforeEach(async () => {
    if (!available) return;
    await prepareDatabase();
  });

  after(async () => {
    await closePool();
  });

  /** Seed one at-risk case and return everything the child process needs. */
  async function seedOneCase() {
    const population = buildAtRiskPopulation(SEED, 1);
    await persistPopulation(population);
    const atRisk = population.cases[0]!;
    const caseId = `case_crash_${atRisk.subscription.id}`;
    await openCase({
      id: caseId,
      subscriptionId: atRisk.subscription.id,
      cycleId: atRisk.cycleId,
      arm: 'control',
      diagnosis: 'UNKNOWN',
      openedAt: atRisk.scheduledAt,
      trueOpeningClass: atRisk.openingResult.trueClass ?? 'UNKNOWN',
    });
    return { atRisk, caseId };
  }

  async function runChild(
    caseId: string,
    attemptNo: number,
    simulatedAt: number,
    subscriptionId: string,
    crashAt: string | undefined,
  ): Promise<{ crashed: boolean; code: number | null }> {
    try {
      await execFileAsync(
        process.execPath,
        [CRASH_CHILD, SEED, caseId, String(attemptNo), String(simulatedAt), subscriptionId],
        { env: { ...process.env, ...(crashAt === undefined ? {} : { SALVAGE_CRASH_AT: crashAt }) } },
      );
      return { crashed: false, code: 0 };
    } catch (err) {
      const code = (err as { code?: number }).code ?? null;
      return { crashed: true, code };
    }
  }

  for (const crashPoint of ['after_claim', 'after_rail_call'] as const) {
    test(`worker killed ${crashPoint}: replay charges exactly once`, async (t) => {
      if (!available) return t.skip(SKIP_MESSAGE);

      const { atRisk, caseId } = await seedOneCase();
      const key = attemptIdempotencyKey(caseId, 2);

      // 1. A worker starts the attempt and is killed mid-flight.
      const crash = await runChild(
        caseId, 2, atRisk.scheduledAt, atRisk.subscription.id, crashPoint,
      );
      assert.equal(crash.crashed, true, 'child was supposed to die');
      assert.equal(crash.code, 137, 'child should die with SIGKILL-equivalent code 137');

      // 2. The attempt is left staked but unsettled - a lost case, if nobody reclaims it.
      const stranded = await getPool().query(
        `SELECT status FROM charge_attempts WHERE idempotency_key = $1`,
        [key],
      );
      assert.equal(stranded.rows.length, 1, 'the claim must survive the crash');
      assert.equal(stranded.rows[0]!.status, 'in_flight');

      // 3. A replacement worker reclaims and replays the SAME attempt.
      const world = await loadWorld(SEED);
      const subscription = world.subscription(atRisk.subscription.id);
      const replayed = await executeAttempt({
        caseId,
        attemptNo: 2,
        subscription,
        mandate: world.mandate(subscription.mandateId),
        customer: world.customer(subscription.customerId),
        cycleId: atRisk.cycleId,
        scheduledAt: atRisk.scheduledAt,
        rail: new SimulatedRailClient(world),
      });

      // 4. The case is resolved, not lost.
      assert.notEqual(replayed.status, undefined);
      const settled = await getPool().query<{ status: string; executed_at: Date | null }>(
        `SELECT status, executed_at FROM charge_attempts WHERE idempotency_key = $1`,
        [key],
      );
      assert.equal(settled.rows.length, 1, 'replay must not create a second attempt row');
      assert.notEqual(settled.rows[0]!.status, 'in_flight', 'replay must settle the attempt');

      // 5. THE CLAIM: the gateway moved money at most once.
      const ledger = await ledgerChargeCount(key);
      if (crashPoint === 'after_rail_call') {
        assert.notEqual(ledger, null, 'the rail had already seen this key before the crash');
        assert.equal(ledger!.chargeCount, 1, 'ZERO DUPLICATE CHARGES: charge_count must be 1');
        assert.ok(
          ledger!.requestCount >= 2,
          'the reclaimer must have re-presented the same key, not minted a new one',
        );
        assert.equal(
          replayed.servedFromRailLedger,
          true,
          'the replay must have been served from the gateway ledger, not charged again',
        );
      } else {
        // Killed before the rail was reached: exactly one charge, made by the reclaimer.
        assert.equal(ledger!.chargeCount, 1);
        assert.equal(ledger!.requestCount, 1);
      }

      const totals = await ledgerTotals();
      assert.equal(totals.charges, 1, 'exactly one money-moving charge across the whole run');
    });
  }

  test('an uninterrupted attempt is charged exactly once too (control for the above)', async (t) => {
    if (!available) return t.skip(SKIP_MESSAGE);

    const { atRisk, caseId } = await seedOneCase();
    const clean = await runChild(
      caseId, 2, atRisk.scheduledAt, atRisk.subscription.id, undefined,
    );
    assert.equal(clean.crashed, false);

    const totals = await ledgerTotals();
    assert.equal(totals.charges, 1);
    assert.equal(totals.requests, 1);
  });

  test('running the same attempt ten times still charges once', async (t) => {
    if (!available) return t.skip(SKIP_MESSAGE);

    const { atRisk, caseId } = await seedOneCase();
    const world = await loadWorld(SEED);
    const subscription = world.subscription(atRisk.subscription.id);
    const rail = new SimulatedRailClient(world);

    const results = [];
    for (let i = 0; i < 10; i++) {
      results.push(
        await executeAttempt({
          caseId,
          attemptNo: 2,
          subscription,
          mandate: world.mandate(subscription.mandateId),
          customer: world.customer(subscription.customerId),
          cycleId: atRisk.cycleId,
          scheduledAt: atRisk.scheduledAt,
          rail,
        }),
      );
    }

    const totals = await ledgerTotals();
    assert.equal(totals.charges, 1, 'ten executions, one charge');

    const rows = await getPool().query('SELECT * FROM charge_attempts WHERE case_id = $1', [caseId]);
    assert.equal(rows.rows.length, 1, 'ten executions, one attempt row');

    // Every call returns the same outcome; the customer's experience is identical.
    const statuses = new Set(results.map((r) => r.status));
    assert.equal(statuses.size, 1);
  });

  test('concurrent workers racing one attempt charge once', async (t) => {
    if (!available) return t.skip(SKIP_MESSAGE);

    const { atRisk, caseId } = await seedOneCase();
    const world = await loadWorld(SEED);
    const subscription = world.subscription(atRisk.subscription.id);

    // Eight workers fire the same attempt simultaneously, each with its own rail client.
    const racers = Array.from({ length: 8 }, () =>
      executeAttempt({
        caseId,
        attemptNo: 2,
        subscription,
        mandate: world.mandate(subscription.mandateId),
        customer: world.customer(subscription.customerId),
        cycleId: atRisk.cycleId,
        scheduledAt: atRisk.scheduledAt,
        rail: new SimulatedRailClient(world),
      }),
    );
    const settled = await Promise.allSettled(racers);
    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    assert.ok(fulfilled.length > 0, 'at least one racer must complete');

    const totals = await ledgerTotals();
    assert.equal(totals.charges, 1, 'eight concurrent workers, one charge');

    const rows = await getPool().query('SELECT * FROM charge_attempts WHERE case_id = $1', [caseId]);
    assert.equal(rows.rows.length, 1, 'eight concurrent workers, one attempt row');
  });
});
