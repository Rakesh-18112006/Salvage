/**
 * THE ABLATION LADDER AND THE MISSPECIFIED WORLDS.
 *
 * Two claims in this project are now load-bearing in the pitch and neither is obvious
 * from reading the code, so both are pinned here:
 *
 *   1. The control arm is already smart retry, because the policy gate refuses terminal
 *      and unclassified charges for EVERY arm. If that ever stops being true, the claim
 *      "our baseline is not a strawman" becomes false and this suite must fail rather
 *      than let it be repeated.
 *
 *   2. The agent's beliefs do not move when the world does. That asymmetry is the whole
 *      of the misspecification experiment; if a perturbation ever leaked into
 *      `assumptions.ts` the experiment would silently become a tautology again.
 */
import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import type { ActionKind, CaseView, ChargeAttempt } from '../src/domain/types.ts';
import { isTerminal, type FailureClass } from '../src/domain/taxonomy.ts';
import { AgentPolicy } from '../src/agent/agentPolicy.ts';
import { believedSelfHeal } from '../src/agent/costModel.ts';
import { get_customer_payment_history } from '../src/agent/tools.ts';
import { SIM } from '../src/assumptions.ts';
import { runArm } from '../src/engine/runner.ts';
import { ClassAwareRetryPolicy, InflowTimedRetryPolicy } from '../src/policy/ablation.ts';
import { ControlT3Policy } from '../src/policy/controlT3.ts';
import { SCENARIOS, scenarioByName } from '../src/eval/misspecification.ts';
import { buildAtRiskPopulation } from '../src/sim/population.ts';
import { DEFAULT_WORLD_PARAMS } from '../src/sim/worldParams.ts';
import { shortfallProbability, depletionOffsetDays } from '../src/sim/paymentSimulator.ts';
import { DAY_MS, HOUR_MS, fromIst } from '../src/sim/clock.ts';

const SEED = '20260101';
const CASES = 200;

// ---------------------------------------------------------------------------
// The world parameters, and the asymmetry the experiment depends on
// ---------------------------------------------------------------------------

describe('world parameters', () => {
  test('the defaults reproduce assumptions.ts exactly', () => {
    // If these ever drift, every "baseline" figure quietly stops being the baseline.
    const d = DEFAULT_WORLD_PARAMS;
    assert.equal(d.shortfallDailyFailureRate, SIM.shortfallDailyFailureRate.value);
    assert.equal(d.fundedDailyFailureRate, SIM.fundedDailyFailureRate.value);
    assert.equal(d.baseTechnicalDeclineRate, SIM.baseTechnicalDeclineRate.value);
    assert.equal(d.unmappedCodeRate, SIM.unmappedCodeRate.value);
    assert.equal(d.dailySelfHealRate, SIM.dailySelfHealRate.value);
    assert.equal(d.remandateCompletionBase, SIM.remandateCompletionBase.value);
    assert.equal(d.paymentLinkCompletionBase, SIM.paymentLinkCompletionBase.value);
    assert.equal(d.customerActionMedianHours, SIM.customerActionMedianHours.value);
    assert.equal(d.notifyUpliftOnSelfHeal, SIM.notifyUpliftOnSelfHeal.value);
  });

  test('perturbing the world does NOT move the agent\'s beliefs', () => {
    // The load-bearing asymmetry. `believedSelfHeal` reads assumptions.ts; the simulator
    // reads the params bag. Perturbing the bag must leave the belief stale and wrong,
    // because being wrong about the world is the condition under test.
    const population = buildAtRiskPopulation(SEED, 1, {
      params: { ...DEFAULT_WORLD_PARAMS, dailySelfHealRate: 0.5 },
    });
    const atRisk = population.cases[0]!;
    const now = fromIst(2026, 3, 15, 6);
    const view = {
      now,
      horizonEndsAt: now + 10 * DAY_MS,
      contactsUsed: 0,
      subscription: atRisk.subscription,
    } as unknown as CaseView;
    const history = { reliabilityBand: 'mixed', tenureMonths: 12 } as ReturnType<
      typeof get_customer_payment_history
    >;

    const believed = believedSelfHeal(view, history, 72);
    // Three days at the ASSUMED 3.5% daily rate, not the world's 50%.
    const expected = 1 - Math.pow(1 - SIM.dailySelfHealRate.value, 3);
    assert.ok(
      Math.abs(believed - expected) < 1e-9,
      `agent believes ${believed}, should still believe ${expected} from assumptions.ts`,
    );
  });

  test('perturbing the world DOES move the simulator', () => {
    const customer = buildAtRiskPopulation(SEED, 1).cases[0]!.customer;
    const ts = fromIst(2026, 3, 26, 6);
    const base = shortfallProbability(customer, 99_900, ts, DEFAULT_WORLD_PARAMS);
    const perturbed = shortfallProbability(customer, 99_900, ts, {
      ...DEFAULT_WORLD_PARAMS,
      shortfallDailyFailureRate: 0.1,
      fundedDailyFailureRate: 0.1,
    });
    assert.notEqual(base, perturbed);
    assert.equal(perturbed, 0.1);
  });

  test('the payday model is genuinely parameterised', () => {
    const customer = buildAtRiskPopulation(SEED, 1).cases[0]!.customer;
    const base = depletionOffsetDays(customer, 99_900, DEFAULT_WORLD_PARAMS);
    const early = depletionOffsetDays(customer, 99_900, {
      ...DEFAULT_WORLD_PARAMS,
      depletionBaseDays: 0,
      depletionReliabilityScale: 30,
    });
    assert.ok(early < base, `early depletion ${early} should precede baseline ${base}`);
  });
});

describe('the misspecification scenarios', () => {
  test('every scenario name is unique', () => {
    const names = SCENARIOS.map((s) => s.name);
    assert.equal(new Set(names).size, names.length);
  });

  test('the baseline scenario really is the default world', () => {
    assert.deepEqual(scenarioByName('baseline').params, DEFAULT_WORLD_PARAMS);
  });

  test('every non-baseline scenario actually changes something', () => {
    // A scenario identical to the default would appear in the results table looking like
    // evidence of robustness while testing nothing at all.
    for (const s of SCENARIOS) {
      if (s.name === 'baseline') continue;
      assert.notDeepEqual(s.params, DEFAULT_WORLD_PARAMS, `${s.name} changes nothing`);
    }
  });

  test('an unknown scenario name is refused with the list of valid ones', () => {
    assert.throws(() => scenarioByName('nope'), /unknown scenario.*baseline/s);
  });
});

// ---------------------------------------------------------------------------
// The ablation arms
// ---------------------------------------------------------------------------

function viewFor(cls: FailureClass, attemptsUsed = 1): CaseView {
  const population = buildAtRiskPopulation(SEED, 1);
  const atRisk = population.cases[0]!;
  const openedAt = fromIst(2026, 3, 12, 10);

  const attempts: ChargeAttempt[] = Array.from({ length: attemptsUsed }, (_, i) => ({
    id: `a${i}`,
    subscriptionId: atRisk.subscription.id,
    cycleId: atRisk.cycleId,
    attemptNo: i + 1,
    idempotencyKey: `k${i}`,
    rail: atRisk.mandate.rail,
    scheduledAt: openedAt,
    executedAt: openedAt,
    status: 'failed',
    rawErrorCode: `SIM_${cls}`,
    rawErrorDesc: '',
    failureClass: cls,
    classificationMatched: true,
    feePaise: 300,
  }));

  return {
    caseId: 'case_abl',
    arm: 'control',
    now: openedAt,
    subscription: atRisk.subscription,
    mandate: atRisk.mandate,
    customer: {
      id: atRisk.customer.id,
      tenureMonths: 12,
      preferredLanguage: 'english',
      bankCode: atRisk.mandate.bankCode,
    },
    openedAt,
    attempts,
    attemptsUsed,
    contactsUsed: 0,
    lastFailureClass: cls,
    horizonEndsAt: openedAt + 13 * DAY_MS,
  };
}

const TERMINALS: ReadonlyArray<FailureClass> = [
  'MANDATE_REVOKED', 'MANDATE_EXPIRED', 'MANDATE_NOT_ACTIVE',
  'AMOUNT_EXCEEDS_MANDATE', 'CARD_EXPIRED', 'ACCOUNT_CLOSED',
  'ACCOUNT_FROZEN', 'RISK_DECLINE',
];

describe('the retry-only ablation arms', () => {
  const world = buildAtRiskPopulation(SEED, 1).world;
  const arms = [
    ['class-aware', new ClassAwareRetryPolicy()],
    ['inflow-timed', new InflowTimedRetryPolicy(world)],
  ] as const;

  for (const [label, policy] of arms) {
    test(`${label}: never proposes a charge on a terminal class`, () => {
      for (const cls of TERMINALS) {
        assert.ok(isTerminal(cls));
        const kinds = policy.decide(viewFor(cls)).actions.map((a) => a.kind);
        assert.deepEqual(kinds, ['STOP'], `${cls} produced ${kinds.join(', ')}`);
      }
    });

    test(`${label}: never auto-retries an unclassified failure`, () => {
      const kinds = policy.decide(viewFor('UNKNOWN')).actions.map((a) => a.kind);
      assert.deepEqual(kinds, ['STOP']);
    });

    test(`${label}: is a retry SCHEDULER - it emits nothing but RETRY_NOW and STOP`, () => {
      // The category boundary. An arm that could re-mandate or send a link would not be
      // answering "isn't this just smart retry?", it would be arm 4 wearing a label.
      const allowed = new Set<ActionKind>(['RETRY_NOW', 'STOP']);
      const classes: FailureClass[] = [
        'INSUFFICIENT_FUNDS', 'BANK_DOWNTIME', 'TECHNICAL_DECLINE', 'UNKNOWN', ...TERMINALS,
      ];
      for (const cls of classes) {
        for (let attempts = 1; attempts <= 5; attempts++) {
          for (const a of policy.decide(viewFor(cls, attempts)).actions) {
            assert.ok(allowed.has(a.kind), `${label} emitted ${a.kind} for ${cls}`);
          }
        }
      }
    });

    test(`${label}: respects the same retry budget as the control arm`, () => {
      const kinds = policy.decide(viewFor('TECHNICAL_DECLINE', 4)).actions.map((a) => a.kind);
      assert.deepEqual(kinds, ['STOP']);
    });
  }

  test('inflow-timed schedules a shortfall retry for payday, not for tomorrow', () => {
    const view = viewFor('INSUFFICIENT_FUNDS');
    const naive = new ClassAwareRetryPolicy().decide(view).actions[0]!;
    const timed = new InflowTimedRetryPolicy(world).decide(view).actions[0]!;

    assert.equal(naive.kind, 'RETRY_NOW');
    assert.ok(naive.delayHours <= 24 + 1, 'the naive arm retries within a day');

    if (timed.kind === 'RETRY_NOW') {
      assert.ok(
        timed.delayHours > 24,
        `inflow-timed waited only ${timed.delayHours}h, which is not a payday`,
      );
    } else {
      // Legitimate: the customer's next inflow can fall outside the case horizon.
      assert.equal(timed.kind, 'STOP');
    }
  });

  test('inflow-timed leaves NON-liquidity failures on the daily schedule', () => {
    const timed = new InflowTimedRetryPolicy(world).decide(viewFor('TECHNICAL_DECLINE'))
      .actions[0]!;
    assert.equal(timed.kind, 'RETRY_NOW');
    assert.ok(timed.delayHours <= 24 + 1, 'only liquidity failures should be time-shifted');
  });
});

// ---------------------------------------------------------------------------
// The claim the pitch now rests on
// ---------------------------------------------------------------------------

describe('the baseline is already smart retry', () => {
  test('the GATE refuses terminal and unclassified charges for the CONTROL arm', async () => {
    // This is the evidence for "our baseline is not a strawman". Asserted on the rule
    // NAMES, because "the gate protected it" without a rule name is an assertion.
    const population = buildAtRiskPopulation(SEED, CASES);
    const control = await runArm(population, new ControlT3Policy(), 12);
    const fired = control.metrics.policyRuleCounts;

    assert.ok(
      (fired.TERMINAL_CLASS_NO_CHARGE ?? 0) > 0,
      `the control arm must be gated on terminal classes; rules fired: ${JSON.stringify(fired)}`,
    );
    assert.ok(
      (fired.UNKNOWN_FAILURE_NOT_RETRYABLE ?? 0) > 0,
      'the control arm must be gated on unclassified failures too',
    );
  });

  test('a terminal case receives exactly ONE attempt under the control arm', async () => {
    // The opening charge that created the case. Nothing after it, because the gate
    // refuses every subsequent presentment.
    const population = buildAtRiskPopulation(SEED, CASES);
    const control = await runArm(population, new ControlT3Policy(), 12);

    const terminal = control.cases.filter((c) => isTerminal(c.trueOpeningClass));
    assert.ok(terminal.length > 0, 'the cohort must contain terminal cases at all');
    for (const c of terminal) {
      assert.equal(
        c.attempts.length,
        1,
        `terminal case ${c.id} (${c.trueOpeningClass}) took ${c.attempts.length} attempts`,
      );
    }
  });

  test('writing smart retry into the POLICY changes nothing, because the gate has it', async () => {
    // If this ever fails, the claim "the baseline already is smart retry" is no longer
    // true and must be removed from the README and the pitch rather than repeated.
    const population = buildAtRiskPopulation(SEED, CASES);
    const control = await runArm(population, new ControlT3Policy(), 12);
    const classAware = await runArm(population, new ClassAwareRetryPolicy(), 12);

    assert.equal(classAware.metrics.recoveryRatePct, control.metrics.recoveryRatePct);
    assert.equal(classAware.metrics.totalAttempts, control.metrics.totalAttempts);
    assert.equal(
      classAware.metrics.attemptsOnTerminalCases,
      control.metrics.attemptsOnTerminalCases,
    );
  });
});

describe('the ladder in the baseline world', () => {
  test('knowing WHEN the customer is paid beats knowing only WHY it failed', async () => {
    const population = buildAtRiskPopulation(SEED, CASES);
    const classAware = await runArm(population, new ClassAwareRetryPolicy(), 12);
    const timed = await runArm(
      population,
      new InflowTimedRetryPolicy(population.world),
      12,
    );
    assert.ok(
      timed.metrics.recoveryRatePct > classAware.metrics.recoveryRatePct,
      `inflow timing ${timed.metrics.recoveryRatePct}% did not beat ` +
        `${classAware.metrics.recoveryRatePct}% - the persistent-shortfall claim is what ` +
        'makes it win, so this failing means that claim stopped holding',
    );
  });

  test('the full action space beats every retry-only arm', async () => {
    const population = buildAtRiskPopulation(SEED, CASES);
    const timed = await runArm(
      population,
      new InflowTimedRetryPolicy(population.world),
      12,
    );
    const salvage = await runArm(
      population,
      new AgentPolicy({ world: population.world, seed: SEED, deterministicOnly: true }),
      12,
    );
    assert.ok(
      salvage.metrics.recoveryRatePct > timed.metrics.recoveryRatePct,
      `SALVAGE ${salvage.metrics.recoveryRatePct}% vs best retry-only ` +
        `${timed.metrics.recoveryRatePct}%`,
    );
  });
});
