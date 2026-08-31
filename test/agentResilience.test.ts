/**
 * Regression tests for the two ways the decision cache broke under concurrency.
 *
 * Both were found by running the real thing, not by reading the code, and both were
 * invisible at concurrency 1 - which is why they are pinned here.
 */
import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import type { CaseView, ChargeAttempt } from '../src/domain/types.ts';
import { AgentPolicy } from '../src/agent/agentPolicy.ts';
import {
  LlmUnavailableError,
  type DecisionModel,
  type GenerateArgs,
  type GenerateResult,
} from '../src/agent/geminiClient.ts';
import { buildAtRiskPopulation, World } from '../src/sim/population.ts';
import { DAY_MS, fromIst } from '../src/sim/clock.ts';

const SEED = 'resilience';

function view(): { view: CaseView; world: World } {
  const population = buildAtRiskPopulation(SEED, 1);
  const atRisk = population.cases[0]!;
  const openedAt = fromIst(2026, 3, 15, 6);
  const attempts: ChargeAttempt[] = [
    {
      id: 'a1',
      subscriptionId: atRisk.subscription.id,
      cycleId: atRisk.cycleId,
      attemptNo: 1,
      idempotencyKey: 'k1',
      rail: atRisk.mandate.rail,
      scheduledAt: openedAt,
      executedAt: openedAt,
      status: 'failed',
      rawErrorCode: 'SIM_INSUFFICIENT_FUNDS',
      rawErrorDesc: 'x',
      failureClass: 'INSUFFICIENT_FUNDS',
      classificationMatched: true,
      feePaise: 300,
    },
  ];
  return {
    world: population.world,
    view: {
      caseId: 'case_res',
      arm: 'agent',
      now: openedAt,
      subscription: atRisk.subscription,
      mandate: atRisk.mandate,
      customer: {
        id: atRisk.customer.id,
        tenureMonths: atRisk.customer.tenureMonths,
        preferredLanguage: atRisk.customer.preferredLanguage,
        bankCode: atRisk.customer.bankCode,
      },
      openedAt,
      attempts,
      attemptsUsed: 1,
      contactsUsed: 0,
      lastFailureClass: 'INSUFFICIENT_FUNDS',
      horizonEndsAt: openedAt + 13 * DAY_MS,
    },
  };
}

/** Slow model, so concurrent callers genuinely overlap on the in-flight promise. */
class SlowModel implements DecisionModel {
  calls = 0;
  private readonly delayMs: number;
  private readonly fail: boolean;
  constructor(delayMs: number, fail: boolean) {
    this.delayMs = delayMs;
    this.fail = fail;
  }
  async generateJson<T>(_args: GenerateArgs): Promise<GenerateResult<T>> {
    this.calls++;
    await new Promise((r) => setTimeout(r, this.delayMs));
    if (this.fail) throw new LlmUnavailableError('quota exceeded', 429);
    return {
      value: {
        diagnosis: 'INSUFFICIENT_FUNDS',
        confidence: 0.8,
        strategy: 'TIME_SHIFT_TO_INFLOW',
        alsoNotify: false,
        rationale: 'wait for the inflow',
      } as T,
      model: 'slow-stub',
      latencyMs: this.delayMs,
      promptTokens: 0,
      outputTokens: 0,
      attempts: 1,
    };
  }
}

describe('agent under concurrency', () => {
  test('a dozen concurrent cases with one signature make ONE model call', async () => {
    const model = new SlowModel(60, false);
    const { view: v, world } = view();
    const agent = new AgentPolicy({ world, seed: SEED, client: model });

    // Without in-flight deduplication all twelve miss the cache simultaneously, all
    // call the model, and eleven calls are wasted answering a question already asked.
    const bundles = await Promise.all(Array.from({ length: 12 }, () => agent.decide(v)));

    assert.equal(model.calls, 1, 'twelve concurrent identical contexts must cost one call');
    assert.equal(agent.stats.cacheHits, 11);
    for (const b of bundles) {
      assert.deepEqual(b.actions.map((a) => a.kind), ['TIME_SHIFT']);
    }
  });

  test('when the shared call fails, EVERY joiner falls back rather than throwing', async () => {
    // The bug this pins: a rejected in-flight promise reached every case waiting on it,
    // and only the case that created it had a catch. One quota rejection took down the
    // whole batch.
    const model = new SlowModel(60, true);
    const { view: v, world } = view();
    const agent = new AgentPolicy({ world, seed: SEED, client: model });

    const settled = await Promise.allSettled(
      Array.from({ length: 12 }, () => agent.decide(v)),
    );

    const rejected = settled.filter((r) => r.status === 'rejected');
    assert.deepEqual(
      rejected.map((r) => String((r as PromiseRejectedResult).reason).slice(0, 80)),
      [],
      'no case may be thrown out because a SHARED model call failed',
    );
    assert.equal(agent.stats.fallbacks, 12, 'all twelve must fall back deterministically');
    for (const r of settled) {
      const bundle = (r as PromiseFulfilledResult<Awaited<ReturnType<AgentPolicy['decide']>>>).value;
      assert.ok(bundle.actions.length > 0, 'every case must still get an action');
    }
  });

  test('a failed call does not poison the cache for later cases', async () => {
    const failing = new SlowModel(10, true);
    const { view: v, world } = view();
    const agent = new AgentPolicy({ world, seed: SEED, client: failing });

    await agent.decide(v);
    assert.equal(agent.stats.fallbacks, 1);

    // A second attempt must actually retry the model rather than replay the failure.
    await agent.decide(v);
    assert.equal(failing.calls, 2, 'the failed signature must not be cached');
  });
});
