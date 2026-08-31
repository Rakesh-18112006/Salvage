/**
 * PHASE 2 ACCEPTANCE, part 2: the rest of the durable spine.
 *
 *   - duplicate webhook delivery deduped at the inbox on razorpay_event_id
 *   - webhook signatures verified against the raw body, timing-safely
 *   - two workers racing a case cannot both advance it
 *   - circuit breaker opens after N downtime responses, half-open probe after cooldown
 *   - the decision log and event log cannot be rewritten
 *   - dead letters can be replayed
 */
import { strict as assert } from 'node:assert';
import { after, before, beforeEach, describe, test } from 'node:test';

import { closePool, getPool } from '../src/db/pool.ts';
import {
  loadCase,
  openCase,
  transitionCase,
  VersionConflictError,
} from '../src/durable/caseStore.ts';
import { acceptEvent, drainInbox, inboxStats } from '../src/durable/inbox.ts';
import { enqueueOutbox, outboxStats, publishBatch } from '../src/durable/outbox.ts';
import { deadLetter, deadLetterStats, replayDeadLetters } from '../src/durable/deadLetters.ts';
import {
  checkBreaker,
  COOLDOWN_MS,
  FAILURE_THRESHOLD,
  getBreaker,
  recordFailure,
  recordSuccess,
} from '../src/durable/circuitBreaker.ts';
import { persistPopulation } from '../src/durable/repo.ts';
import { buildAtRiskPopulation } from '../src/sim/population.ts';
import { withTransaction } from '../src/db/pool.ts';
import { sign, verifySignature } from '../src/webhook/verify.ts';
import { createWebhookHandler, startWebhookServer } from '../src/webhook/server.ts';
import { databaseAvailable, prepareDatabase, SKIP_MESSAGE } from './helpers/dbHarness.ts';

const SEED = 'durable-spine';
let available = false;

async function seedCase(suffix = 'a') {
  const population = buildAtRiskPopulation(`${SEED}-${suffix}`, 1);
  await persistPopulation(population);
  const atRisk = population.cases[0]!;
  const caseId = `case_${suffix}_${atRisk.subscription.id}`;
  const { row } = await openCase({
    id: caseId,
    subscriptionId: atRisk.subscription.id,
    cycleId: atRisk.cycleId,
    arm: 'control',
    diagnosis: 'INSUFFICIENT_FUNDS',
    openedAt: atRisk.scheduledAt,
    trueOpeningClass: atRisk.openingResult.trueClass ?? 'UNKNOWN',
  });
  return { atRisk, caseId, row };
}

describe('durable spine', { concurrency: false }, () => {
  before(async () => {
    available = await databaseAvailable();
    if (available) await prepareDatabase();
  });
  beforeEach(async () => {
    if (available) await prepareDatabase();
  });
  after(async () => {
    await closePool();
  });

  // --- inbox ------------------------------------------------------------------

  test('a redelivered webhook is deduped on razorpay_event_id', async (t) => {
    if (!available) return t.skip(SKIP_MESSAGE);

    const event = {
      eventId: 'evt_razorpay_abc123',
      eventType: 'payment.failed',
      payload: { amount: 49900 },
    };

    const first = await acceptEvent(event);
    assert.equal(first.duplicate, false);

    // The gateway retries. Five more times, for good measure.
    for (let i = 0; i < 5; i++) {
      const again = await acceptEvent(event);
      assert.equal(again.duplicate, true, 'redelivery must be recognised as a duplicate');
    }

    const stats = await inboxStats();
    assert.equal(stats.total, 1, 'six deliveries, one inbox row');
  });

  test('an event is marked processed only if the handler committed', async (t) => {
    if (!available) return t.skip(SKIP_MESSAGE);

    await acceptEvent({ eventId: 'evt_fail', eventType: 'payment.failed', payload: {} });

    // Handler throws: the transaction rolls back and processed_at must stay NULL.
    await assert.rejects(
      drainInbox(async () => {
        throw new Error('handler blew up');
      }),
      /handler blew up/,
    );
    let stats = await inboxStats();
    assert.equal(stats.unprocessed, 1, 'a failed handler must not mark the event processed');

    // Handler succeeds: now it is processed, and a second drain finds nothing.
    const handled = await drainInbox(async () => {});
    assert.equal(handled, 1);
    stats = await inboxStats();
    assert.equal(stats.unprocessed, 0);
    assert.equal(await drainInbox(async () => {}), 0);
  });

  // --- webhook signature -------------------------------------------------------

  test('webhook signatures are verified, and a tampered body is rejected', async () => {
    const secret = 'test_secret';
    const body = JSON.stringify({ id: 'evt_1', event: 'payment.failed' });

    assert.equal(verifySignature(body, sign(body, secret), secret), true);
    assert.equal(verifySignature(body, sign(body, 'wrong_secret'), secret), false);
    assert.equal(verifySignature(`${body} `, sign(body, secret), secret), false);
    assert.equal(verifySignature(body, undefined, secret), false);
    assert.equal(verifySignature(body, '', secret), false);
    assert.equal(verifySignature(body, 'deadbeef', secret), false, 'wrong length must not throw');
  });

  test('the ingress rejects unsigned requests and accepts duplicates with 200', async (t) => {
    if (!available) return t.skip(SKIP_MESSAGE);

    const secret = 'ingress_secret';
    const handle = await startWebhookServer({ port: 0, secret });
    try {
      const url = `http://127.0.0.1:${handle.port}/webhooks/razorpay`;
      const body = JSON.stringify({ id: 'evt_http_1', event: 'payment.failed', payload: {} });

      const unsigned = await fetch(url, { method: 'POST', body });
      assert.equal(unsigned.status, 401, 'an unsigned webhook must be rejected');

      const forged = await fetch(url, {
        method: 'POST',
        body,
        headers: { 'x-razorpay-signature': sign(body, 'not_the_secret') },
      });
      assert.equal(forged.status, 401, 'a forged signature must be rejected');

      const headers = { 'x-razorpay-signature': sign(body, secret) };
      const ok = await fetch(url, { method: 'POST', body, headers });
      assert.equal(ok.status, 200);
      assert.equal(((await ok.json()) as { duplicate: boolean }).duplicate, false);

      // A redelivery must return 2xx. Returning an error would make the gateway retry
      // forever, turning correct dedupe into an infinite loop.
      const dup = await fetch(url, { method: 'POST', body, headers });
      assert.equal(dup.status, 200);
      assert.equal(((await dup.json()) as { duplicate: boolean }).duplicate, true);

      assert.equal((await inboxStats()).total, 1);
    } finally {
      await handle.close();
    }
  });

  test('the ingress refuses to start without a secret', async () => {
    await assert.rejects(
      startWebhookServer({ port: 0, secret: '' }),
      /refusing to start unauthenticated/,
    );
    // The handler factory is still constructible for tests that supply their own secret.
    assert.equal(typeof createWebhookHandler('s', '/x'), 'function');
  });

  // --- optimistic locking ------------------------------------------------------

  test('opening the same case twice returns the existing case, never a second one', async (t) => {
    if (!available) return t.skip(SKIP_MESSAGE);

    const { atRisk, caseId } = await seedCase('dup');
    const again = await openCase({
      id: `${caseId}_different_id`,
      subscriptionId: atRisk.subscription.id,
      cycleId: atRisk.cycleId,
      arm: 'control',
      diagnosis: 'INSUFFICIENT_FUNDS',
      openedAt: atRisk.scheduledAt,
      trueOpeningClass: 'INSUFFICIENT_FUNDS',
    });
    assert.equal(again.created, false, 'the second open must not create a case');
    assert.equal(again.row.id, caseId, 'it must return the case that already exists');

    const count = await getPool().query('SELECT count(*)::int AS n FROM recovery_cases');
    assert.equal(count.rows[0]!.n, 1, 'one cycle, one case, one retry budget');
  });

  test('two workers racing a case: exactly one wins, the loser is told', async (t) => {
    if (!available) return t.skip(SKIP_MESSAGE);

    const { atRisk, caseId, row } = await seedCase('race');

    const both = await Promise.allSettled([
      transitionCase({
        caseId,
        expectedVersion: row.version,
        toState: 'AWAITING_RETRY',
        at: atRisk.scheduledAt,
        eventType: 'WORKER_A',
      }),
      transitionCase({
        caseId,
        expectedVersion: row.version,
        toState: 'EXHAUSTED',
        at: atRisk.scheduledAt,
        outcome: 'exhausted',
        eventType: 'WORKER_B',
      }),
    ]);

    const winners = both.filter((r) => r.status === 'fulfilled');
    const losers = both.filter((r) => r.status === 'rejected');
    assert.equal(winners.length, 1, 'exactly one worker may advance the case');
    assert.equal(losers.length, 1);
    assert.ok(
      (losers[0] as PromiseRejectedResult).reason instanceof VersionConflictError,
      'the loser must get a VersionConflictError, not a silent overwrite',
    );

    const final = await loadCase(caseId);
    assert.equal(final!.version, row.version + 1, 'version advances exactly once');
  });

  test('a closed case cannot be reopened or advanced', async (t) => {
    if (!available) return t.skip(SKIP_MESSAGE);

    const { atRisk, caseId, row } = await seedCase('closed');
    const closed = await transitionCase({
      caseId,
      expectedVersion: row.version,
      toState: 'RECOVERED',
      at: atRisk.scheduledAt,
      outcome: 'recovered',
      recoveredPaise: atRisk.subscription.amountPaise,
    });

    await assert.rejects(
      transitionCase({
        caseId,
        expectedVersion: closed.version,
        toState: 'AWAITING_RETRY',
        at: atRisk.scheduledAt,
      }),
      /illegal case transition RECOVERED -> AWAITING_RETRY/,
    );
  });

  test('a closing transition without an outcome is refused', async (t) => {
    if (!available) return t.skip(SKIP_MESSAGE);
    const { atRisk, caseId, row } = await seedCase('noout');
    await assert.rejects(
      transitionCase({
        caseId,
        expectedVersion: row.version,
        toState: 'EXHAUSTED',
        at: atRisk.scheduledAt,
      }),
      /requires an outcome/,
    );
  });

  // --- circuit breaker ---------------------------------------------------------

  test('the breaker opens after consecutive downtime and defers instead of attempting', async (t) => {
    if (!available) return t.skip(SKIP_MESSAGE);

    const bank = 'SIMBANK_D';
    const t0 = Date.UTC(2026, 2, 15, 6);

    let decision = await checkBreaker(bank, t0);
    assert.equal(decision.allowed, true, 'a healthy bank is not blocked');

    for (let i = 1; i < FAILURE_THRESHOLD; i++) {
      await recordFailure(bank, t0);
      assert.equal((await getBreaker(bank)).state, 'closed', 'below threshold stays closed');
    }
    await recordFailure(bank, t0);
    assert.equal((await getBreaker(bank)).state, 'open', 'threshold crossed: breaker opens');

    decision = await checkBreaker(bank, t0 + 60_000);
    assert.equal(decision.allowed, false, 'an open breaker must block the attempt');
    assert.equal(decision.retryAfter, t0 + COOLDOWN_MS);
    assert.match(decision.reason, /do not burn an attempt/);
  });

  test('after cooldown the breaker allows one probe; success closes it', async (t) => {
    if (!available) return t.skip(SKIP_MESSAGE);

    const bank = 'SIMBANK_B';
    const t0 = Date.UTC(2026, 2, 15, 6);
    for (let i = 0; i < FAILURE_THRESHOLD; i++) await recordFailure(bank, t0);
    assert.equal((await getBreaker(bank)).state, 'open');

    const probe = await checkBreaker(bank, t0 + COOLDOWN_MS + 1);
    assert.equal(probe.allowed, true, 'cooldown elapsed: one probe is allowed through');
    assert.equal((await getBreaker(bank)).state, 'half_open');

    await recordSuccess(bank, t0 + COOLDOWN_MS + 2);
    const healed = await getBreaker(bank);
    assert.equal(healed.state, 'closed');
    assert.equal(healed.consecutive_failures, 0);
  });

  test('a failed probe re-opens the breaker immediately', async (t) => {
    if (!available) return t.skip(SKIP_MESSAGE);

    const bank = 'SIMBANK_C';
    const t0 = Date.UTC(2026, 2, 15, 6);
    for (let i = 0; i < FAILURE_THRESHOLD; i++) await recordFailure(bank, t0);
    await checkBreaker(bank, t0 + COOLDOWN_MS + 1);
    assert.equal((await getBreaker(bank)).state, 'half_open');

    await recordFailure(bank, t0 + COOLDOWN_MS + 2);
    assert.equal(
      (await getBreaker(bank)).state,
      'open',
      'one failed probe is enough; the rail is not back',
    );
  });

  test('breaker state survives a process restart', async (t) => {
    if (!available) return t.skip(SKIP_MESSAGE);
    // Persisted, not in-memory: a deploy must not forget that a rail is down.
    const bank = 'SIMBANK_A';
    const t0 = Date.UTC(2026, 2, 15, 6);
    for (let i = 0; i < FAILURE_THRESHOLD; i++) await recordFailure(bank, t0);

    await closePool(); // simulate the process dying and a new one starting
    const afterRestart = await getBreaker(bank);
    assert.equal(afterRestart.state, 'open');
  });

  // --- append-only audit -------------------------------------------------------

  test('the decision log and event log cannot be updated or deleted', async (t) => {
    if (!available) return t.skip(SKIP_MESSAGE);

    const { caseId } = await seedCase('audit');
    await getPool().query(
      `INSERT INTO decisions (case_id, seq, agent_input_snapshot, agent_reasoning,
                              proposed_bundle, policy_verdict, final_bundle)
       VALUES ($1, 1, '{}', 'because', '{}', 'NOT_YET_IMPLEMENTED', '{}')`,
      [caseId],
    );

    await assert.rejects(
      getPool().query(`UPDATE decisions SET agent_reasoning = 'rewritten' WHERE case_id = $1`, [
        caseId,
      ]),
      /append-only/,
    );
    await assert.rejects(
      getPool().query(`DELETE FROM decisions WHERE case_id = $1`, [caseId]),
      /append-only/,
    );
    await assert.rejects(
      getPool().query(`UPDATE case_events SET event_type = 'FORGED' WHERE case_id = $1`, [caseId]),
      /append-only/,
    );
  });

  // --- outbox ------------------------------------------------------------------

  test('outbox events commit with their state change and publish at least once', async (t) => {
    if (!available) return t.skip(SKIP_MESSAGE);

    const { caseId } = await seedCase('outbox');

    // A rolled-back transaction must publish nothing.
    await assert.rejects(
      withTransaction(async (client) => {
        await enqueueOutbox(client, caseId, 'case.rolled_back', { x: 1 });
        throw new Error('rollback');
      }),
      /rollback/,
    );
    assert.equal((await outboxStats()).total, 0, 'a rolled-back event must not exist');

    await withTransaction(async (client) => {
      await enqueueOutbox(client, caseId, 'case.opened', { caseId });
    });
    assert.equal((await outboxStats()).unpublished, 1);

    const published: string[] = [];
    const n = await publishBatch(async (row) => {
      published.push(row.event_type);
    });
    assert.equal(n, 1);
    assert.deepEqual(published, ['case.opened']);
    assert.equal((await outboxStats()).unpublished, 0);
    assert.equal(await publishBatch(async () => {}), 0, 'nothing left to publish');
  });

  test('a publisher that throws leaves the event unpublished for the next sweep', async (t) => {
    if (!available) return t.skip(SKIP_MESSAGE);

    const { caseId } = await seedCase('outboxfail');
    await withTransaction(async (client) => {
      await enqueueOutbox(client, caseId, 'case.opened', { caseId });
    });

    await assert.rejects(
      publishBatch(async () => {
        throw new Error('broker down');
      }),
      /broker down/,
    );
    assert.equal((await outboxStats()).unpublished, 1, 'the event must survive for a retry');

    assert.equal(await publishBatch(async () => {}), 1);
    assert.equal((await outboxStats()).unpublished, 0);
  });

  // --- dead letters ------------------------------------------------------------

  test('dead letters are stored with their payload and can be replayed', async (t) => {
    if (!available) return t.skip(SKIP_MESSAGE);

    await deadLetter({
      source: 'recovery-worker',
      jobName: 'execute-attempt',
      payload: { caseId: 'case_x', attemptNo: 2 },
      error: new Error('rail timeout'),
      attempts: 3,
    });
    assert.equal((await deadLetterStats()).pending, 1);

    // A replay that fails leaves the row pending - a DLQ you can only drain once is a
    // DLQ that loses work the first time the fix is wrong.
    const failed = await replayDeadLetters(async () => {
      throw new Error('still broken');
    });
    assert.equal(failed.replayed, 0);
    assert.equal(failed.failed, 1);
    assert.equal((await deadLetterStats()).pending, 1);

    const resubmitted: unknown[] = [];
    const ok = await replayDeadLetters(async (row) => {
      resubmitted.push(row.payload);
    });
    assert.equal(ok.replayed, 1);
    assert.deepEqual(resubmitted, [{ caseId: 'case_x', attemptNo: 2 }]);
    assert.equal((await deadLetterStats()).pending, 0);
  });
});
