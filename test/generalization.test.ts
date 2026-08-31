/**
 * THE GENERALIZATION PATH: reading rail codes the taxonomy has never mapped.
 *
 * This is the one route by which a language model's opinion can change what actually
 * executes against a customer's account, so the tests here are mostly about what it is
 * NOT allowed to do. The ordering is deliberate:
 *
 *   1. the dialect is genuinely unmapped, and genuinely changes nothing but the words
 *   2. the gate honours a reading in exactly one situation and refuses it everywhere else
 *   3. the agent's default behaviour is unchanged, and the confidence floor holds
 *   4. the cache cannot answer one code's question with another code's answer
 *
 * Every model here is a stub. The live model is exercised by `node src/generalization.ts`.
 */
import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import type { ActionBundle, CaseView, ChargeAttempt } from '../src/domain/types.ts';
import { classify, isTerminal, type FailureClass } from '../src/domain/taxonomy.ts';
import { AgentPolicy } from '../src/agent/agentPolicy.ts';
import type { DecisionModel, GenerateArgs, GenerateResult } from '../src/agent/geminiClient.ts';
import { evaluate, workingFailureClass, type GateInput } from '../src/policy/gate.ts';
import { RBI } from '../src/policy/compliance.ts';
import { allDialectResponses, dialectResponse, dialectCodes } from '../src/eval/railDialect.ts';
import { buildAtRiskPopulation } from '../src/sim/population.ts';
import type { RailDialect } from '../src/sim/paymentSimulator.ts';
import { DAY_MS, HOUR_MS, fromIst } from '../src/sim/clock.ts';

const SEED = 'generalization-test';

const dialect: RailDialect = {
  name: 'test-dialect',
  render: (cls, u) => {
    const r = dialectResponse(cls, u);
    return { code: r.code, desc: r.desc };
  },
};

// ---------------------------------------------------------------------------
// 1. The dialect itself
// ---------------------------------------------------------------------------

describe('the unmapped rail dialect', () => {
  test('no dialect code is one the taxonomy already knows', () => {
    // If a single one collided, the "unmapped" cohort would quietly contain mapped codes
    // and the eval would be measuring the lookup table while claiming to measure a model.
    for (const code of dialectCodes()) {
      const c = classify(code);
      assert.equal(
        c.matched,
        false,
        `dialect code ${code} is already mapped by the taxonomy (as ${c.failureClass})`,
      );
      assert.equal(c.failureClass, 'UNKNOWN');
    }
  });

  test('every dialect code is distinct', () => {
    const codes = dialectCodes();
    assert.equal(new Set(codes).size, codes.length, 'duplicate code in the dialect corpus');
  });

  test('the corpus contains both legible and illegible responses', () => {
    // The eval measures refusal as well as comprehension, and it can only do that if
    // there is text to refuse. A corpus that drifted to all-legible would silently turn
    // the safety half of the eval into a no-op that always passes.
    const all = allDialectResponses();
    const opaque = all.filter((r) => r.readable === null);
    const legible = all.filter((r) => r.readable !== null);
    assert.ok(opaque.length >= 5, `expected several illegible responses, got ${opaque.length}`);
    assert.ok(legible.length >= 20, `expected many legible responses, got ${legible.length}`);
  });

  test('a readable label never contradicts the cause it is emitted for on terminality', () => {
    // A legible string for a terminal cause must not read as a fundable one, or the
    // corpus itself would be teaching the model to unlock impossible charges.
    for (const r of allDialectResponses()) {
      if (r.readable === null) continue;
      assert.equal(
        isTerminal(r.readable),
        isTerminal(r.cause),
        `${r.code} is emitted for ${r.cause} but its text reads as ${r.readable}, ` +
          'which sits on the other side of "can a charge ever work?"',
      );
    }
  });

  test('the dialect changes the words on the wire and nothing else', () => {
    // The entire comparison in src/generalization.ts rests on this. If swapping the
    // vocabulary also changed WHICH cases fail, the mapped and unmapped arms would be
    // two different experiments and the difference between them would mean nothing.
    const mapped = buildAtRiskPopulation(SEED, 40);
    const unmapped = buildAtRiskPopulation(SEED, 40, { dialect });

    assert.equal(mapped.cases.length, unmapped.cases.length);
    for (let i = 0; i < mapped.cases.length; i++) {
      const a = mapped.cases[i]!;
      const b = unmapped.cases[i]!;
      assert.equal(a.subscription.id, b.subscription.id, `case ${i}: different subscription`);
      assert.equal(
        a.openingResult.trueClass,
        b.openingResult.trueClass,
        `case ${i}: the dialect changed WHY the charge failed`,
      );
      assert.notEqual(
        a.openingResult.rawErrorCode,
        b.openingResult.rawErrorCode,
        `case ${i}: the dialect did not change the code at all`,
      );
    }
  });

  test('an unmapped cohort has near-zero taxonomy coverage by construction', () => {
    const unmapped = buildAtRiskPopulation(SEED, 40, { dialect });
    for (const c of unmapped.cases) {
      assert.equal(classify(c.openingResult.rawErrorCode).matched, false);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The gate: when a reading is honoured, and when it is refused
// ---------------------------------------------------------------------------

function viewWith(o: {
  taxonomyClass: FailureClass;
  rawErrorCode: string;
  classificationMatched: boolean;
  mandateStatus?: 'active' | 'revoked' | 'expired';
}): CaseView {
  const population = buildAtRiskPopulation(SEED, 1);
  const atRisk = population.cases[0]!;
  const openedAt = fromIst(2026, 3, 12, 10);

  const attempt: ChargeAttempt = {
    id: 'a0',
    subscriptionId: atRisk.subscription.id,
    cycleId: atRisk.cycleId,
    attemptNo: 1,
    idempotencyKey: 'k0',
    rail: atRisk.mandate.rail,
    scheduledAt: openedAt,
    executedAt: openedAt,
    status: 'failed',
    rawErrorCode: o.rawErrorCode,
    rawErrorDesc: 'whatever the rail said',
    failureClass: o.taxonomyClass,
    classificationMatched: o.classificationMatched,
    feePaise: 300,
  };

  return {
    caseId: 'case_gen',
    arm: 'agent',
    now: openedAt,
    subscription: { ...atRisk.subscription, amountPaise: 99_900 },
    mandate: {
      ...atRisk.mandate,
      status: o.mandateStatus ?? 'active',
      maxAmountPaise: 300_000,
    },
    customer: {
      id: atRisk.customer.id,
      tenureMonths: 12,
      preferredLanguage: 'english',
      bankCode: atRisk.mandate.bankCode,
    },
    openedAt,
    attempts: [attempt],
    attemptsUsed: 1,
    contactsUsed: 0,
    lastFailureClass: o.taxonomyClass,
    horizonEndsAt: openedAt + 13 * DAY_MS,
  };
}

function proposal(reclassifiedFromUnmapped?: FailureClass): ActionBundle {
  return {
    actions: [{ kind: 'RETRY_NOW', delayHours: 6, reason: 'try again' }],
    diagnosis: reclassifiedFromUnmapped ?? 'INSUFFICIENT_FUNDS',
    confidence: 0.95,
    rationale: 'test',
    ...(reclassifiedFromUnmapped === undefined ? {} : { reclassifiedFromUnmapped }),
  };
}

function gateInput(view: CaseView, proposed: ActionBundle): GateInput {
  return {
    view,
    proposed,
    breakerOpen: false,
    breakerRetryAfter: null,
    lastPreDebitNoticeAt: view.openedAt - RBI.preDebitNotificationHours.value * HOUR_MS,
    contactsInRollingWindow: 0,
    livePromise: null,
    aborted: false,
    escalationTiersUsed: 0,
  };
}

const rules = (d: ReturnType<typeof evaluate>) => d.firings.map((f) => f.rule);
const kinds = (d: ReturnType<typeof evaluate>) => d.finalBundle.actions.map((a) => a.kind);

describe('the gate and a proposed reclassification', () => {
  test('an unrecognised code CAN be reclassified, and that unlocks the charge', () => {
    const view = viewWith({
      taxonomyClass: 'UNKNOWN',
      rawErrorCode: 'ACQ-201',
      classificationMatched: false,
    });
    const d = evaluate(gateInput(view, proposal('INSUFFICIENT_FUNDS')));

    assert.ok(rules(d).includes('MODEL_READ_UNMAPPED_CODE'), 'the promotion must be recorded');
    assert.ok(
      !rules(d).includes('UNKNOWN_FAILURE_NOT_RETRYABLE'),
      'the case is no longer unclassified, so that rule must not fire',
    );
    assert.ok(kinds(d).includes('RETRY_NOW'), 'the charge should have survived');
  });

  test('a reading is NOT honoured when the taxonomy already has an opinion', () => {
    // The load-bearing test. A model must never be able to talk its way out of a
    // documented terminal class by claiming to have read something else.
    const view = viewWith({
      taxonomyClass: 'MANDATE_REVOKED',
      rawErrorCode: 'SIM_MANDATE_REVOKED',
      classificationMatched: true,
      mandateStatus: 'revoked',
    });
    const d = evaluate(gateInput(view, proposal('INSUFFICIENT_FUNDS')));

    assert.ok(!rules(d).includes('MODEL_READ_UNMAPPED_CODE'), 'must not be honoured');
    assert.ok(
      rules(d).includes('TERMINAL_CLASS_NO_CHARGE'),
      `expected TERMINAL_CLASS_NO_CHARGE, got ${rules(d).join(', ')}`,
    );
    assert.ok(!kinds(d).includes('RETRY_NOW'), 'the retry must not survive');
  });

  test('a reading is NOT honoured for a DOCUMENTED reason that maps to UNKNOWN', () => {
    // Razorpay's `payment_declined` is in our table and lands on UNKNOWN because its own
    // description settles nothing. We have already read that text. Re-reading it cannot
    // produce information that is not there, so this path stays shut.
    const documented = classify('PAYMENT_DECLINED');
    assert.equal(documented.matched, true);
    assert.equal(documented.failureClass, 'UNKNOWN');

    const view = viewWith({
      taxonomyClass: 'UNKNOWN',
      rawErrorCode: 'PAYMENT_DECLINED',
      classificationMatched: true,
    });
    const d = evaluate(gateInput(view, proposal('INSUFFICIENT_FUNDS')));

    assert.ok(!rules(d).includes('MODEL_READ_UNMAPPED_CODE'), 'must not be honoured');
    assert.ok(
      rules(d).includes('UNKNOWN_FAILURE_NOT_RETRYABLE'),
      `expected UNKNOWN_FAILURE_NOT_RETRYABLE, got ${rules(d).join(', ')}`,
    );
    assert.ok(!kinds(d).includes('RETRY_NOW'));
  });

  test('a reading that names a TERMINAL class makes the gate stricter, not looser', () => {
    const view = viewWith({
      taxonomyClass: 'UNKNOWN',
      rawErrorCode: 'ACQ-401',
      classificationMatched: false,
    });
    const d = evaluate(gateInput(view, proposal('MANDATE_REVOKED')));

    assert.ok(rules(d).includes('MODEL_READ_UNMAPPED_CODE'));
    assert.ok(
      rules(d).includes('TERMINAL_CLASS_NO_CHARGE'),
      'reading a dead mandate must block the charge, not authorise it',
    );
    assert.ok(!kinds(d).includes('RETRY_NOW'));
  });

  test('a reclassification to UNKNOWN is a no-op', () => {
    const view = viewWith({
      taxonomyClass: 'UNKNOWN',
      rawErrorCode: 'ACQ-105',
      classificationMatched: false,
    });
    const w = workingFailureClass(view, proposal('UNKNOWN'));
    assert.equal(w.promoted, false);
    assert.equal(w.cls, 'UNKNOWN');
  });

  test('with no reclassification offered, nothing about the gate changes', () => {
    const view = viewWith({
      taxonomyClass: 'UNKNOWN',
      rawErrorCode: 'ACQ-105',
      classificationMatched: false,
    });
    const d = evaluate(gateInput(view, proposal()));

    assert.ok(!rules(d).includes('MODEL_READ_UNMAPPED_CODE'));
    assert.ok(rules(d).includes('UNKNOWN_FAILURE_NOT_RETRYABLE'));
  });
});

// ---------------------------------------------------------------------------
// 3. The agent: default behaviour, and the confidence floor
// ---------------------------------------------------------------------------

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

/** A model that answers according to the raw code in the prompt it was given. */
class PerCodeModel implements DecisionModel {
  calls = 0;
  private readonly byCode: Record<string, FailureClass>;
  constructor(byCode: Record<string, FailureClass>) {
    this.byCode = byCode;
  }
  async generateJson<T>(args: GenerateArgs): Promise<GenerateResult<T>> {
    this.calls++;
    const hit = Object.keys(this.byCode).find((c) => args.user.includes(c));
    return {
      value: {
        diagnosis: hit === undefined ? 'UNKNOWN' : this.byCode[hit]!,
        confidence: 0.95,
        strategy: 'TIME_SHIFT_TO_INFLOW',
        alsoNotify: false,
        rationale: `read ${hit ?? 'nothing'}`,
      } as T,
      model: 'stub',
      latencyMs: 0,
      promptTokens: 0,
      outputTokens: 0,
      attempts: 1,
    };
  }
}

function unmappedView(rawErrorCode: string): CaseView {
  return viewWith({ taxonomyClass: 'UNKNOWN', rawErrorCode, classificationMatched: false });
}

const world = () => buildAtRiskPopulation(SEED, 1).world;

describe('the agent and unmapped rail codes', () => {
  test('DEFAULT: the feature is off, and an unmapped code never reaches the model', () => {
    // Every published number in this project was measured with this off. A capability
    // that switches itself on is one nobody can price.
    const model = new StubModel({
      diagnosis: 'INSUFFICIENT_FUNDS',
      confidence: 0.99,
      strategy: 'TIME_SHIFT_TO_INFLOW',
      alsoNotify: false,
      rationale: 'should never be asked',
    });
    const agent = new AgentPolicy({ world: world(), seed: SEED, client: model });

    const bundle = agent.decide(unmappedView('ACQ-201'));
    return Promise.resolve(bundle).then((b) => {
      assert.equal(model.calls, 0, 'the model must not have been consulted');
      assert.equal(b.actions[0]!.kind, 'ESCALATE_HUMAN');
      assert.equal(b.reclassifiedFromUnmapped, undefined);
      assert.equal(agent.stats.unmappedCodesRead, 0);
    });
  });

  test('ENABLED: a confident reading is adopted and travels on the bundle', async () => {
    const model = new StubModel({
      diagnosis: 'INSUFFICIENT_FUNDS',
      confidence: 0.95,
      strategy: 'TIME_SHIFT_TO_INFLOW',
      alsoNotify: false,
      rationale: 'balance was short',
    });
    const agent = new AgentPolicy({
      world: world(), seed: SEED, client: model, readUnmappedCodes: true,
    });

    const b = await agent.decide(unmappedView('ACQ-201'));
    assert.equal(model.calls, 1);
    assert.equal(b.reclassifiedFromUnmapped, 'INSUFFICIENT_FUNDS');
    assert.equal(agent.stats.unmappedCodesRead, 1);
    assert.equal(agent.stats.unmappedCodesClassified, 1);
    assert.equal(agent.stats.unmappedCodesDeclined, 0);
  });

  test('the model is shown the rail text, and NOT our own UNKNOWN verdict', () => {
    const model = new StubModel({
      diagnosis: 'INSUFFICIENT_FUNDS',
      confidence: 0.95,
      strategy: 'TIME_SHIFT_TO_INFLOW',
      alsoNotify: false,
      rationale: 'x',
    });
    const agent = new AgentPolicy({
      world: world(), seed: SEED, client: model, readUnmappedCodes: true,
    });

    return agent.decide(unmappedView('ACQ-201')).then(() => {
      const prompt = model.prompts[0]!;
      assert.match(prompt, /ACQ-201/, 'the raw code must be in the prompt');
      assert.match(prompt, /whatever the rail said/, "the rail's description must be shown");
      assert.doesNotMatch(
        prompt,
        /last failure class: UNKNOWN/,
        'our own non-verdict must not be presented to the model as evidence',
      );
    });
  });

  test('BELOW THE FLOOR: a hesitant reading is refused and the case escalates', async () => {
    const model = new StubModel({
      diagnosis: 'INSUFFICIENT_FUNDS',
      confidence: 0.4,
      strategy: 'TIME_SHIFT_TO_INFLOW',
      alsoNotify: false,
      rationale: 'not sure at all',
    });
    const agent = new AgentPolicy({
      world: world(),
      seed: SEED,
      client: model,
      readUnmappedCodes: true,
      reclassifyMinConfidence: 0.7,
    });

    const b = await agent.decide(unmappedView('ACQ-205'));
    assert.equal(b.reclassifiedFromUnmapped, undefined, 'nothing may be adopted below the floor');
    assert.equal(b.actions[0]!.kind, 'ESCALATE_HUMAN');
    assert.equal(agent.stats.unmappedCodesDeclined, 1);
    assert.equal(agent.stats.unmappedCodesClassified, 0);
  });

  test('A MODEL ANSWERING UNKNOWN is refused however confident it is', async () => {
    const model = new StubModel({
      diagnosis: 'UNKNOWN',
      confidence: 1,
      strategy: 'ESCALATE_HUMAN',
      alsoNotify: false,
      rationale: 'this text says nothing',
    });
    const agent = new AgentPolicy({
      world: world(), seed: SEED, client: model, readUnmappedCodes: true,
    });

    const b = await agent.decide(unmappedView('ACQ-105'));
    assert.equal(b.reclassifiedFromUnmapped, undefined);
    assert.equal(agent.stats.unmappedCodesDeclined, 1);
  });

  test('a reading of a TERMINAL class never leaves a charge on the bundle', async () => {
    // Belt and braces with the gate: the agent should not even PROPOSE the impossible.
    const model = new StubModel({
      diagnosis: 'MANDATE_REVOKED',
      confidence: 0.95,
      strategy: 'TIME_SHIFT_TO_INFLOW', // incoherent with its own diagnosis
      alsoNotify: false,
      rationale: 'mandate is gone but let us charge anyway',
    });
    const agent = new AgentPolicy({
      world: world(), seed: SEED, client: model, readUnmappedCodes: true,
    });

    const b = await agent.decide(unmappedView('ACQ-401'));
    const chargeKinds = b.actions.filter(
      (a) => a.kind === 'RETRY_NOW' || a.kind === 'DEFER' || a.kind === 'TIME_SHIFT',
    );
    assert.equal(chargeKinds.length, 0, 'a charge against a class it just called dead');
    assert.equal(agent.stats.corrections, 1, 'the correction must be counted, not silent');
  });

  test('with no model configured, the feature cannot switch itself on', async () => {
    // Nobody is there to read the text, and routing the case away from the human it needs
    // on the strength of a feature flag would be the worst of both worlds.
    const agent = new AgentPolicy({
      world: world(), seed: SEED, deterministicOnly: true, readUnmappedCodes: true,
    });
    const b = await agent.decide(unmappedView('ACQ-201'));
    assert.equal(agent.stats.unmappedCodesRead, 0);
    assert.equal(b.reclassifiedFromUnmapped, undefined);
    assert.equal(b.actions[0]!.kind, 'ESCALATE_HUMAN');
  });

  test('the cache never answers one code with another code\'s reading', async () => {
    // The failure this guards against is severe and quiet: the generic cache key would
    // collapse every unrecognised code onto `UNKNOWN|first|ample|...`, so the first code
    // read would classify the entire cohort. That is a cache fabricating diagnoses.
    const model = new PerCodeModel({
      'ACQ-201': 'INSUFFICIENT_FUNDS',
      'ACQ-301': 'BANK_DOWNTIME',
    });
    const agent = new AgentPolicy({
      world: world(), seed: SEED, client: model, readUnmappedCodes: true,
    });

    const a = await agent.decide(unmappedView('ACQ-201'));
    const b = await agent.decide(unmappedView('ACQ-301'));

    assert.equal(a.reclassifiedFromUnmapped, 'INSUFFICIENT_FUNDS');
    assert.equal(b.reclassifiedFromUnmapped, 'BANK_DOWNTIME');
    assert.equal(model.calls, 2, 'two different questions must be two calls');
  });

  test('the same code asked twice IS served from the cache', async () => {
    const model = new PerCodeModel({ 'ACQ-201': 'INSUFFICIENT_FUNDS' });
    const agent = new AgentPolicy({
      world: world(), seed: SEED, client: model, readUnmappedCodes: true,
    });

    await agent.decide(unmappedView('ACQ-201'));
    await agent.decide(unmappedView('ACQ-201'));
    assert.equal(model.calls, 1, 'one question, one call');
    assert.equal(agent.stats.cacheHits, 1);
  });

  test('every read is recorded for scoring, adopted or not', async () => {
    const model = new StubModel({
      diagnosis: 'INSUFFICIENT_FUNDS',
      confidence: 0.3,
      strategy: 'TIME_SHIFT_TO_INFLOW',
      alsoNotify: false,
      rationale: 'hesitant',
    });
    const agent = new AgentPolicy({
      world: world(), seed: SEED, client: model, readUnmappedCodes: true,
    });

    await agent.decide(unmappedView('ACQ-205'));
    assert.equal(agent.unmappedReads.length, 1);
    const r = agent.unmappedReads[0]!;
    assert.equal(r.rawErrorCode, 'ACQ-205');
    assert.equal(r.modelDiagnosis, 'INSUFFICIENT_FUNDS');
    assert.equal(r.adopted, false, 'a declined read must still be visible to the eval');
  });
});
