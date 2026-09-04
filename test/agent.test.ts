/**
 * PHASE 3: the agent's guard rails and cost discipline.
 *
 * Every test here runs against a STUB model, never the live API. That is deliberate:
 * these assert properties of OUR code - that a terminal class never reaches the model,
 * that an impossible proposal is corrected, that a dead API does not strand a case - and
 * a real model would make them slow, quota-limited, and non-deterministic without
 * testing anything extra. The live model is exercised separately in agentEval.test.ts.
 */
import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import type { ActionBundle, CaseView, ChargeAttempt } from '../src/domain/types.ts';
import type { FailureClass } from '../src/domain/taxonomy.ts';
import { AgentPolicy, type Strategy } from '../src/agent/agentPolicy.ts';
import {
  LlmUnavailableError,
  type DecisionModel,
  type GenerateArgs,
  type GenerateResult,
} from '../src/agent/model/decisionModel.ts';
import { believedSelfHeal, actionCost } from '../src/agent/costModel.ts';
import { buildAtRiskPopulation } from '../src/sim/population.ts';
import { DAY_MS, HOUR_MS, fromIst } from '../src/sim/clock.ts';
import { World } from '../src/sim/population.ts';

const SEED = 'agent-test';

/** A model that always returns the same decision, and counts how often it was asked. */
class StubModel implements DecisionModel {
  calls = 0;
  readonly prompts: string[] = [];
  private readonly reply: Record<string, unknown>;
  constructor(reply: Record<string, unknown>) {
    this.reply = reply;
  }
  async generateJson<T>(args: GenerateArgs): Promise<GenerateResult<T>> {
    this.calls++;
    this.prompts.push(args.user);
    return {
      value: this.reply as T,
      model: 'stub',
      latencyMs: 0,
      promptTokens: 0,
      outputTokens: 0,
      attempts: 1,
    };
  }
}

/** A model that is always down. */
class DeadModel implements DecisionModel {
  calls = 0;
  async generateJson<T>(): Promise<GenerateResult<T>> {
    this.calls++;
    throw new LlmUnavailableError('stub: everything is on fire', 503);
  }
}

/** Build a CaseView against a real seeded world so the tools have something to read. */
function makeView(
  overrides: {
    failureClass?: FailureClass;
    attemptsUsed?: number;
    contactsUsed?: number;
    hoursLeft?: number;
    amountPaise?: number;
    maxAmountPaise?: number;
  } = {},
): { view: CaseView; world: World } {
  const population = buildAtRiskPopulation(SEED, 1);
  const atRisk = population.cases[0]!;
  const openedAt = fromIst(2026, 3, 15, 6);
  const hoursLeft = overrides.hoursLeft ?? 13 * 24;
  const attemptsUsed = overrides.attemptsUsed ?? 1;
  const cls = overrides.failureClass ?? 'INSUFFICIENT_FUNDS';

  const attempts: ChargeAttempt[] = Array.from({ length: attemptsUsed }, (_, i) => ({
    id: `a${i}`,
    subscriptionId: atRisk.subscription.id,
    cycleId: atRisk.cycleId,
    attemptNo: i + 1,
    idempotencyKey: `k${i}`,
    rail: atRisk.mandate.rail,
    scheduledAt: openedAt + i * DAY_MS,
    executedAt: openedAt + i * DAY_MS,
    status: 'failed',
    rawErrorCode: `SIM_${cls}`,
    rawErrorDesc: 'x',
    failureClass: cls,
    classificationMatched: true,
    feePaise: 300,
  }));

  const view: CaseView = {
    caseId: 'case_test',
    arm: 'agent',
    now: openedAt,
    subscription: {
      ...atRisk.subscription,
      ...(overrides.amountPaise === undefined ? {} : { amountPaise: overrides.amountPaise }),
    },
    mandate: {
      ...atRisk.mandate,
      ...(overrides.maxAmountPaise === undefined
        ? {}
        : { maxAmountPaise: overrides.maxAmountPaise }),
    },
    customer: {
      id: atRisk.customer.id,
      tenureMonths: atRisk.customer.tenureMonths,
      preferredLanguage: atRisk.customer.preferredLanguage,
      bankCode: atRisk.customer.bankCode,
    },
    openedAt,
    attempts,
    attemptsUsed,
    contactsUsed: overrides.contactsUsed ?? 0,
    lastFailureClass: cls,
    horizonEndsAt: openedAt + hoursLeft * HOUR_MS,
  };
  return { view, world: population.world };
}

const kinds = (b: ActionBundle) => b.actions.map((a) => a.kind);

describe('agent guard rails', () => {
  // --- triage: the model is never asked a settled question ------------------

  const terminalExpectations: Array<[FailureClass, string]> = [
    ['MANDATE_REVOKED', 'REMANDATE'],
    ['MANDATE_EXPIRED', 'REMANDATE'],
    ['CARD_EXPIRED', 'REMANDATE'],
    ['ACCOUNT_CLOSED', 'ESCALATE_HUMAN'],
    ['ACCOUNT_FROZEN', 'ESCALATE_HUMAN'],
    ['RISK_DECLINE', 'ESCALATE_HUMAN'],
  ];

  for (const [cls, expected] of terminalExpectations) {
    test(`${cls} is settled by deterministic triage without calling the model`, async () => {
      const { view, world } = makeView({ failureClass: cls });
      const model = new StubModel({});
      const agent = new AgentPolicy({ world, seed: SEED, client: model });

      const bundle = await agent.decide(view);
      assert.equal(model.calls, 0, 'a terminal class must never reach the model');
      assert.equal(agent.stats.triagedDeterministically, 1);
      assert.deepEqual(kinds(bundle), [expected]);
    });
  }

  test('a charge above the mandate cap is triaged to a payment link, not a retry', async () => {
    const { view, world } = makeView({
      failureClass: 'AMOUNT_EXCEEDS_MANDATE',
      amountPaise: 200_000,
      maxAmountPaise: 100_000,
    });
    const model = new StubModel({});
    const agent = new AgentPolicy({ world, seed: SEED, client: model });
    const bundle = await agent.decide(view);
    assert.equal(model.calls, 0);
    assert.deepEqual(kinds(bundle), ['PAYMENT_LINK']);
  });

  // --- the taxonomy outranks the model --------------------------------------

  test('a model that insists on retrying a revoked mandate is overruled', async () => {
    // Triage would normally catch MANDATE_REVOKED, so force the model path by giving a
    // non-terminal last failure class while the MANDATE itself is dead.
    const { view, world } = makeView({ failureClass: 'INSUFFICIENT_FUNDS' });
    const revoked: CaseView = {
      ...view,
      lastFailureClass: 'MANDATE_REVOKED',
      attempts: view.attempts.map((a) => ({ ...a, failureClass: 'MANDATE_REVOKED' as const })),
    };
    // Triage catches this, so assert the deterministic path is the one that fires.
    const model = new StubModel({
      diagnosis: 'MANDATE_REVOKED',
      confidence: 0.99,
      strategy: 'RETRY_SHORT_BACKOFF' satisfies Strategy,
      alsoNotify: false,
      rationale: 'I would like to retry this please',
    });
    const agent = new AgentPolicy({ world, seed: SEED, client: model });
    const bundle = await agent.decide(revoked);
    assert.ok(
      !kinds(bundle).includes('RETRY_NOW'),
      'no retry may be scheduled against a revoked mandate',
    );
  });

  test('a model proposing a charge on an over-cap mandate is corrected to a link', async () => {
    const { view, world } = makeView({
      failureClass: 'INSUFFICIENT_FUNDS',
      amountPaise: 200_000,
      maxAmountPaise: 100_000,
    });
    const model = new StubModel({
      diagnosis: 'INSUFFICIENT_FUNDS',
      confidence: 0.9,
      strategy: 'TIME_SHIFT_TO_INFLOW' satisfies Strategy,
      alsoNotify: false,
      rationale: 'wait for payday',
    });
    const agent = new AgentPolicy({ world, seed: SEED, client: model });
    const bundle = await agent.decide(view);
    assert.deepEqual(kinds(bundle), ['PAYMENT_LINK']);
    assert.equal(agent.stats.corrections, 1, 'the correction must be counted, not silent');
    assert.match(bundle.rationale, /corrected/);
  });

  // --- schema robustness -----------------------------------------------------

  test('a malformed model response is sanitised rather than propagated', async () => {
    const { view, world } = makeView({ failureClass: 'TECHNICAL_DECLINE' });
    const model = new StubModel({
      diagnosis: 'NOT_A_REAL_CLASS',
      confidence: 42,
      strategy: 'DO_SOMETHING_CLEVER',
      alsoNotify: 'yes please',
      rationale: 12345,
    });
    const agent = new AgentPolicy({ world, seed: SEED, client: model });
    const bundle = await agent.decide(view);

    assert.ok(bundle.confidence >= 0 && bundle.confidence <= 1, 'confidence must be clamped');
    assert.equal(bundle.diagnosis, 'TECHNICAL_DECLINE', 'unknown class falls back to observed');
    assert.equal(kinds(bundle).length, 1);
    assert.ok(kinds(bundle)[0] !== undefined);
  });

  // --- availability ----------------------------------------------------------

  test('a dead model does not strand the case: the deterministic fallback decides', async () => {
    const { view, world } = makeView({ failureClass: 'INSUFFICIENT_FUNDS' });
    const model = new DeadModel();
    const agent = new AgentPolicy({ world, seed: SEED, client: model });

    const bundle = await agent.decide(view);
    assert.ok(model.calls > 0, 'the model was attempted');
    assert.equal(agent.stats.fallbacks, 1);
    assert.ok(bundle.actions.length > 0, 'the case must still get an action');
    assert.match(bundle.rationale, /deterministic fallback/);
  });

  test('the deterministic fallback resolves every failure class', async () => {
    for (const cls of [
      'INSUFFICIENT_FUNDS',
      'BANK_DOWNTIME',
      'TECHNICAL_DECLINE',
      'UNKNOWN',
    ] as const) {
      const { view, world } = makeView({ failureClass: cls });
      const agent = new AgentPolicy({ world, seed: SEED, client: new DeadModel() });
      const bundle = await agent.decide(view);
      assert.ok(bundle.actions.length > 0, `${cls} produced no action`);
    }
  });

  // --- cost discipline -------------------------------------------------------

  test('identical decision contexts are answered once and then cached', async () => {
    const model = new StubModel({
      diagnosis: 'INSUFFICIENT_FUNDS',
      confidence: 0.8,
      strategy: 'TIME_SHIFT_TO_INFLOW' satisfies Strategy,
      alsoNotify: false,
      rationale: 'wait for the inflow',
    });
    const { view, world } = makeView({ failureClass: 'INSUFFICIENT_FUNDS' });
    const agent = new AgentPolicy({ world, seed: SEED, client: model });

    for (let i = 0; i < 8; i++) await agent.decide(view);

    assert.equal(model.calls, 1, 'eight identical contexts must cost one model call');
    assert.equal(agent.stats.cacheHits, 7);
  });

  test('the prompt never leaks simulator ground truth to the model', async () => {
    const model = new StubModel({
      diagnosis: 'INSUFFICIENT_FUNDS',
      confidence: 0.5,
      strategy: 'WAIT' satisfies Strategy,
      alsoNotify: false,
      rationale: 'x',
    });
    const { view, world } = makeView({ failureClass: 'INSUFFICIENT_FUNDS' });
    const agent = new AgentPolicy({ world, seed: SEED, client: model });
    await agent.decide(view);

    const prompt = model.prompts[0]!;
    // The raw reliability scalar and the shortfall window are simulator internals. If
    // either reached the prompt, the agent would be reading the answer key.
    assert.ok(!/reliability["']?\s*[:=]\s*0\.\d/.test(prompt), 'raw reliability leaked');
    assert.ok(!/shortfall/i.test(prompt), 'shortfall window leaked');
    assert.ok(!/trueClass|true_opening|ground.?truth/i.test(prompt), 'ground truth leaked');
    assert.ok(/reliability: (strong|mixed|weak)/.test(prompt), 'banded reliability is expected');
  });

  // --- scheduling stays inside the horizon -----------------------------------

  test('no proposed action is scheduled past the case horizon', async () => {
    const model = new StubModel({
      diagnosis: 'INSUFFICIENT_FUNDS',
      confidence: 0.9,
      strategy: 'TIME_SHIFT_TO_INFLOW' satisfies Strategy,
      alsoNotify: true,
      rationale: 'shift to payday',
    });
    // Only 12 hours left: a time-shift to the next payday would fire long after the case
    // is abandoned, so it must be clamped rather than scheduled into the void.
    const { view, world } = makeView({ failureClass: 'INSUFFICIENT_FUNDS', hoursLeft: 12 });
    const agent = new AgentPolicy({ world, seed: SEED, client: model });
    const bundle = await agent.decide(view);

    const horizonHours = (view.horizonEndsAt - view.now) / HOUR_MS;
    for (const action of bundle.actions) {
      assert.ok(
        action.delayHours <= horizonHours,
        `${action.kind} scheduled ${action.delayHours}h out, past a ${horizonHours}h horizon`,
      );
    }
  });

  test('a case with almost no horizon left is stopped, not acted on', async () => {
    const { view, world } = makeView({ failureClass: 'INSUFFICIENT_FUNDS', hoursLeft: 1 });
    const model = new StubModel({});
    const agent = new AgentPolicy({ world, seed: SEED, client: model });
    const bundle = await agent.decide(view);
    assert.equal(model.calls, 0);
    assert.deepEqual(kinds(bundle), ['STOP']);
  });

  // --- the cost model --------------------------------------------------------

  test('every decision records the expected value of doing nothing', async () => {
    const model = new StubModel({
      diagnosis: 'INSUFFICIENT_FUNDS',
      confidence: 0.7,
      strategy: 'TIME_SHIFT_TO_INFLOW' satisfies Strategy,
      alsoNotify: false,
      rationale: 'payday',
    });
    const { view, world } = makeView({ failureClass: 'INSUFFICIENT_FUNDS' });
    const agent = new AgentPolicy({ world, seed: SEED, client: model });
    const bundle = await agent.decide(view);

    // An agent that cannot say what waiting was worth is not reasoning about cost.
    assert.match(bundle.rationale, /EV\(WAIT\)/);
    const trace = agent.traces[0]!;
    assert.equal(typeof trace.evOfWaitPaise, 'number');
    assert.ok(Number.isFinite(trace.expectedValuePaise));
  });

  test('acting costs money: a charge is never free, and messaging is dearer', () => {
    const amount = 99_900;
    const retry = actionCost({ kind: 'RETRY_NOW', delayHours: 6, reason: '' }, amount);
    const notify = actionCost(
      { kind: 'NOTIFY', delayHours: 0, reason: '', language: 'english', templateId: 't' },
      amount,
    );
    const wait = actionCost({ kind: 'WAIT', delayHours: 24, reason: '' }, amount);

    assert.ok(retry > 0, 'a retry must cost a gateway fee');
    assert.ok(notify > retry, 'a message must cost more than a retry, or spam is optimal');
    assert.ok(wait < retry, 'waiting must be cheaper than acting, or WAIT can never win');
  });

  test('self-heal belief rises with time and with having told the customer', () => {
    const { view } = makeView({ failureClass: 'INSUFFICIENT_FUNDS' });
    const history = {
      tenureMonths: 12,
      reliabilityBand: 'mixed' as const,
      preferredLanguage: 'english' as const,
      inflowDayOfMonth: 1,
      daysSinceLastInflow: 14,
      daysUntilNextInflow: 16,
    };
    const short = believedSelfHeal(view, history, 24);
    const long = believedSelfHeal(view, history, 120);
    assert.ok(long > short, 'more time means more chance of self-healing');

    const contacted = believedSelfHeal({ ...view, contactsUsed: 1 }, history, 24);
    assert.ok(contacted > short, 'a customer who has been told is likelier to act');
  });
});
