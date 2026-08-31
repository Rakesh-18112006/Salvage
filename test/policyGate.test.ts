/**
 * PHASE 4 ACCEPTANCE (spec section 8):
 *
 *   "no action reaches the executor without a logged policy verdict; adversarial test
 *    cases (agent proposes retry on a revoked mandate, contact at 2am, amount above cap)
 *    are all blocked with the correct rule named."
 *
 * The three named adversarial cases are here, plus one for every other rule in section 6.
 * Each asserts the rule NAME, not merely that something was refused - "blocked by policy"
 * without a rule name is an assertion, and a rule name is evidence.
 */
import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import type { Action, ActionBundle, CaseView, ChargeAttempt } from '../src/domain/types.ts';
import type { FailureClass } from '../src/domain/taxonomy.ts';
import {
  ATTEMPT_CAP_PER_CYCLE,
  ESCALATION_LADDER,
  evaluate,
  isPermittedContactTime,
  nextPermittedContactTime,
  type GateInput,
} from '../src/policy/gate.ts';
import { CONTACT_POLICY, RBI } from '../src/policy/compliance.ts';
import { classify } from '../src/domain/taxonomy.ts';
import { DAY_MS, HOUR_MS, fromIst, istParts } from '../src/sim/clock.ts';
import { buildAtRiskPopulation } from '../src/sim/population.ts';
import { runBatch } from '../src/engine/runner.ts';
import { ControlT3Policy } from '../src/policy/controlT3.ts';
import { AgentPolicy } from '../src/agent/agentPolicy.ts';

const SEED = 'gate-test';

function baseView(
  o: {
    failureClass?: FailureClass;
    attemptsUsed?: number;
    contactsUsed?: number;
    amountPaise?: number;
    maxAmountPaise?: number;
    mandateStatus?: 'active' | 'revoked' | 'expired';
    nowIstHour?: number;
    nowDay?: number;
  } = {},
): CaseView {
  const population = buildAtRiskPopulation(SEED, 1);
  const atRisk = population.cases[0]!;
  const openedAt = fromIst(2026, 3, o.nowDay ?? 12, o.nowIstHour ?? 10);
  const cls = o.failureClass ?? 'INSUFFICIENT_FUNDS';
  const attemptsUsed = o.attemptsUsed ?? 1;

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
    caseId: 'case_gate',
    arm: 'agent',
    now: openedAt,
    subscription: {
      ...atRisk.subscription,
      amountPaise: o.amountPaise ?? 99_900,
    },
    mandate: {
      ...atRisk.mandate,
      status: o.mandateStatus ?? 'active',
      maxAmountPaise: o.maxAmountPaise ?? 300_000,
    },
    customer: {
      id: atRisk.customer.id,
      tenureMonths: 12,
      preferredLanguage: 'english',
      bankCode: atRisk.mandate.bankCode,
    },
    openedAt,
    attempts,
    attemptsUsed,
    contactsUsed: o.contactsUsed ?? 0,
    lastFailureClass: cls,
    horizonEndsAt: openedAt + 13 * DAY_MS,
  };
}

function bundle(...actions: Action[]): ActionBundle {
  return { actions, diagnosis: 'INSUFFICIENT_FUNDS', confidence: 0.9, rationale: 'test' };
}

function input(view: CaseView, proposed: ActionBundle, over: Partial<GateInput> = {}): GateInput {
  return {
    view,
    proposed,
    breakerOpen: false,
    breakerRetryAfter: null,
    // The cycle's scheduled debit was itself notified 24h ahead; that is what made the
    // original charge lawful, and under the default per_cycle reading it covers retries.
    lastPreDebitNoticeAt: view.openedAt - RBI.preDebitNotificationHours.value * HOUR_MS,
    contactsInRollingWindow: 0,
    livePromise: null,
    aborted: false,
    escalationTiersUsed: 0,
    ...over,
  };
}

const retry: Action = { kind: 'RETRY_NOW', delayHours: 6, reason: 'try again' };
const notify = (templateId = 'gentle_reminder', delayHours = 0): Action => ({
  kind: 'NOTIFY',
  delayHours,
  reason: 'tell them',
  language: 'english',
  templateId,
});

const rulesFired = (d: ReturnType<typeof evaluate>) => d.firings.map((f) => f.rule);
const kinds = (d: ReturnType<typeof evaluate>) => d.finalBundle.actions.map((a) => a.kind);

describe('policy gate - the three named adversarial cases', () => {
  test('ADVERSARIAL 1: retry proposed on a revoked mandate is blocked by name', () => {
    const view = baseView({ failureClass: 'MANDATE_REVOKED', mandateStatus: 'revoked' });
    const d = evaluate(input(view, bundle(retry)));

    assert.ok(
      rulesFired(d).includes('TERMINAL_CLASS_NO_CHARGE'),
      `expected TERMINAL_CLASS_NO_CHARGE, got ${rulesFired(d).join(', ')}`,
    );
    assert.ok(!kinds(d).includes('RETRY_NOW'), 'the retry must not survive');
    assert.notEqual(d.verdict, 'APPROVE');
    assert.equal(d.primaryRule, 'TERMINAL_CLASS_NO_CHARGE');
  });

  test('ADVERSARIAL 2: a customer contact at 2am is moved out of quiet hours', () => {
    // 02:00 IST is inside the quiet window; the contact must be rescheduled, not sent.
    const view = baseView({ nowIstHour: 2 });
    const d = evaluate(input(view, bundle(notify('gentle_reminder', 0))));

    assert.ok(
      rulesFired(d).includes('QUIET_HOURS'),
      `expected QUIET_HOURS, got ${rulesFired(d).join(', ')}`,
    );
    const moved = d.finalBundle.actions[0]!;
    const firesAt = view.now + moved.delayHours * HOUR_MS;
    assert.ok(
      isPermittedContactTime(firesAt),
      `contact still lands at ${istParts(firesAt).hour}:00 IST`,
    );
    assert.equal(istParts(firesAt).hour, CONTACT_POLICY.quietHoursEndIst);
  });

  test('ADVERSARIAL 3: a charge above the mandate cap is blocked by name', () => {
    const view = baseView({ amountPaise: 500_000, maxAmountPaise: 100_000 });
    const d = evaluate(input(view, bundle(retry)));

    assert.ok(
      rulesFired(d).includes('AMOUNT_EXCEEDS_MANDATE_CAP'),
      `expected AMOUNT_EXCEEDS_MANDATE_CAP, got ${rulesFired(d).join(', ')}`,
    );
    assert.ok(!kinds(d).includes('RETRY_NOW'));
  });
});

describe('policy gate - every other section 6 rule', () => {
  test('the attempt cap is enforced regardless of what the agent prefers', () => {
    const view = baseView({ attemptsUsed: ATTEMPT_CAP_PER_CYCLE });
    const d = evaluate(input(view, bundle(retry)));
    assert.ok(rulesFired(d).includes('ATTEMPT_CAP_PER_CYCLE'));
    assert.ok(!kinds(d).includes('RETRY_NOW'));
  });

  test('under the strict pre-debit reading, a charge without 24h notice is blocked', () => {
    const view = baseView();
    const d = evaluate(
      input(view, bundle(retry), { lastPreDebitNoticeAt: null, scope: 'per_debit' }),
    );
    assert.ok(rulesFired(d).includes('PRE_DEBIT_NOTIFICATION_REQUIRED'));
    assert.ok(
      d.firings.some((f) => /RBI E-mandate Framework 2026/.test(f.detail)),
      'the rejection must cite the instrument it enforces',
    );
  });

  test('under the strict reading, a notice younger than 24h is still not enough', () => {
    const view = baseView();
    const d = evaluate(
      input(view, bundle(retry), {
        lastPreDebitNoticeAt: view.now - 6 * HOUR_MS, // only 12h before a +6h charge
        scope: 'per_debit',
      }),
    );
    assert.ok(rulesFired(d).includes('PRE_DEBIT_NOTIFICATION_REQUIRED'));
  });

  test('under the strict reading, a properly aged notice permits the charge', () => {
    const view = baseView();
    const d = evaluate(
      input(view, bundle(retry), {
        lastPreDebitNoticeAt: view.now - 24 * HOUR_MS,
        scope: 'per_debit',
      }),
    );
    assert.deepEqual(rulesFired(d), []);
    assert.equal(d.verdict, 'APPROVE');
  });

  test('the default per-cycle reading permits a retry the strict reading would block', () => {
    // This is the ambiguity the project flags rather than resolves: the strict textual
    // reading would make the incumbent's own documented T+3 cycle non-compliant.
    const view = baseView();
    const strict = evaluate(
      input(view, bundle(retry), { lastPreDebitNoticeAt: null, scope: 'per_debit' }),
    );
    const lenient = evaluate(
      input(view, bundle(retry), { lastPreDebitNoticeAt: null, scope: 'per_cycle' }),
    );
    assert.ok(rulesFired(strict).includes('PRE_DEBIT_NOTIFICATION_REQUIRED'));
    assert.deepEqual(rulesFired(lenient), []);
  });

  test('an open circuit breaker defers the charge instead of burning an attempt', () => {
    const view = baseView();
    const retryAfter = view.now + 30 * 60_000;
    const d = evaluate(
      input(view, bundle(retry), { breakerOpen: true, breakerRetryAfter: retryAfter }),
    );
    assert.ok(rulesFired(d).includes('CIRCUIT_BREAKER_OPEN'));
    assert.deepEqual(kinds(d), ['DEFER'], 'the attempt is deferred, not spent');
    const firesAt = view.now + d.finalBundle.actions[0]!.delayHours * HOUR_MS;
    assert.ok(firesAt >= retryAfter, 'the deferral must clear the cooldown');
  });

  test('a live promise-to-pay stops both charging and chasing', () => {
    const view = baseView();
    const promise = { promisedDate: view.now + 24 * HOUR_MS, graceHours: 24 };
    const d = evaluate(input(view, bundle(retry, notify()), { livePromise: promise }));
    const fired = rulesFired(d);
    assert.ok(fired.includes('LIVE_PROMISE_TO_PAY'));
    assert.ok(!kinds(d).includes('RETRY_NOW'), 'no charging inside the grace window');
    assert.ok(!kinds(d).includes('NOTIFY'), 'no chasing inside the grace window');
  });

  test('the contact frequency cap is enforced per case and per rolling window', () => {
    const lifetime = evaluate(
      input(baseView({ contactsUsed: CONTACT_POLICY.maxContactsPerCase }), bundle(notify())),
    );
    assert.ok(rulesFired(lifetime).includes('CONTACT_FREQUENCY_CAP'));

    const rolling = evaluate(
      input(baseView(), bundle(notify()), {
        contactsInRollingWindow: CONTACT_POLICY.maxContactsPerRollingWindow,
      }),
    );
    assert.ok(rulesFired(rolling).includes('CONTACT_FREQUENCY_CAP'));
  });

  test('two contacts in one bundle cannot both slip past the rolling cap', () => {
    const d = evaluate(
      input(baseView(), bundle(notify('gentle_reminder', 0), notify('gentle_reminder', 2)), {
        contactsInRollingWindow: CONTACT_POLICY.maxContactsPerRollingWindow - 1,
      }),
    );
    const contacts = d.finalBundle.actions.filter((a) => a.kind === 'NOTIFY');
    assert.equal(contacts.length, 1, 'only one contact may pass the remaining budget');
    assert.ok(rulesFired(d).includes('CONTACT_FREQUENCY_CAP'));
  });

  test('the escalation ladder cannot be skipped', () => {
    // The agent asks for a final notice on the first contact. It gets tier one.
    const d = evaluate(input(baseView(), bundle(notify('final_notice')), {
      escalationTiersUsed: 0,
    }));
    assert.ok(rulesFired(d).includes('ESCALATION_LADDER_ORDER'));
    const sent = d.finalBundle.actions[0]! as { templateId: string };
    assert.equal(sent.templateId, ESCALATION_LADDER[0]);
  });

  test('the ladder advances one tier at a time', () => {
    for (let used = 0; used < ESCALATION_LADDER.length; used++) {
      const d = evaluate(
        input(baseView(), bundle(notify('gentle_reminder')), { escalationTiersUsed: used }),
      );
      const sent = d.finalBundle.actions[0]! as { templateId: string };
      assert.equal(sent.templateId, ESCALATION_LADDER[used], `tier ${used}`);
    }
  });

  test('automation may never send legal or collections language', () => {
    for (const forbidden of ['legal_notice', 'collections_final', 'recovery_agent_visit']) {
      const d = evaluate(input(baseView(), bundle(notify(forbidden))));
      assert.ok(
        rulesFired(d).includes('ESCALATION_LADDER_ORDER'),
        `${forbidden} must be refused`,
      );
      assert.ok(
        !d.finalBundle.actions.some((a) => a.kind === 'NOTIFY'),
        `${forbidden} must not be sent`,
      );
    }
  });

  test('a captured payment halts every pending action on the case', () => {
    const d = evaluate(input(baseView(), bundle(retry, notify()), { aborted: true }));
    assert.equal(d.primaryRule, 'GLOBAL_ABORT_ON_CAPTURE');
    assert.deepEqual(kinds(d), ['STOP']);
    assert.equal(d.verdict, 'DENY');
  });

  test('a mandate that is not active cannot be charged even on a retryable class', () => {
    const view = baseView({ failureClass: 'INSUFFICIENT_FUNDS', mandateStatus: 'expired' });
    const d = evaluate(input(view, bundle(retry)));
    assert.ok(rulesFired(d).includes('MANDATE_NOT_ACTIVE'));
  });

  test('a blocked case never ends up with nothing to do', () => {
    // An empty bundle is how a "blocked" case silently becomes a stranded one.
    const view = baseView({ failureClass: 'MANDATE_REVOKED', mandateStatus: 'revoked' });
    const d = evaluate(input(view, bundle(retry)));
    assert.ok(d.finalBundle.actions.length > 0, 'the gate must substitute a safe action');
    assert.deepEqual(kinds(d), ['STOP']);
  });

  test('an account state needing a person escalates rather than stopping silently', () => {
    const view = baseView({ failureClass: 'ACCOUNT_FROZEN' });
    const d = evaluate(input(view, bundle(retry)));
    assert.deepEqual(kinds(d), ['ESCALATE_HUMAN']);
    assert.equal(d.verdict, 'ESCALATE');
  });

  test('a clean proposal passes untouched', () => {
    const d = evaluate(input(baseView(), bundle(retry)));
    assert.equal(d.verdict, 'APPROVE');
    assert.deepEqual(rulesFired(d), []);
    assert.equal(d.primaryRule, null);
    assert.deepEqual(kinds(d), ['RETRY_NOW']);
  });
});

describe('conservative handling of unclassified failures', () => {
  test('an UNKNOWN failure is never charged again', () => {
    // Nine of Razorpay's eighteen documented recurring-payment reasons map to UNKNOWN
    // because their descriptions do not settle a cause. "We do not know why this failed"
    // must never become another debit on a customer's account.
    const view = baseView({ failureClass: 'UNKNOWN' });
    const d = evaluate(input(view, bundle(retry)));
    assert.ok(
      rulesFired(d).includes('UNKNOWN_FAILURE_NOT_RETRYABLE'),
      `expected UNKNOWN_FAILURE_NOT_RETRYABLE, got ${rulesFired(d).join(', ')}`,
    );
    assert.ok(!kinds(d).includes('RETRY_NOW'));
  });

  test('an unmapped real rail code reaches the gate as UNKNOWN and is refused', () => {
    // End to end: an undocumented vendor string must not become a retry.
    const cls = classify('some_reason_not_in_razorpay_docs');
    assert.equal(cls.failureClass, 'UNKNOWN');
    const view = baseView({ failureClass: cls.failureClass });
    const d = evaluate(input(view, bundle(retry)));
    assert.ok(rulesFired(d).includes('UNKNOWN_FAILURE_NOT_RETRYABLE'));
  });

  test('the deterministic fallback never proposes a retry for UNKNOWN', async () => {
    const population = buildAtRiskPopulation(SEED, 1);
    const agent = new AgentPolicy({
      world: population.world,
      seed: SEED,
      deterministicOnly: true,
    });
    const bundleOut = await agent.decide(baseView({ failureClass: 'UNKNOWN' }));
    const proposed = bundleOut.actions.map((a) => a.kind);
    assert.ok(
      !proposed.includes('RETRY_NOW') && !proposed.includes('DEFER') && !proposed.includes('TIME_SHIFT'),
      `fallback proposed a charge for UNKNOWN: ${proposed.join(', ')}`,
    );
  });
});

describe('sourced AFA threshold', () => {
  test('a charge above the Rs 15,000 AFA-exempt ceiling cannot be presented unattended', () => {
    const view = baseView({ amountPaise: 20_000_00, maxAmountPaise: 60_000_00 });
    const d = evaluate(input(view, bundle(retry)));
    assert.ok(
      rulesFired(d).includes('AFA_THRESHOLD_EXCEEDED'),
      `expected AFA_THRESHOLD_EXCEEDED, got ${rulesFired(d).join(', ')}`,
    );
    assert.ok(
      d.firings.some((f) => /E-mandate Framework/.test(f.detail)),
      'the rejection must cite the instrument it enforces',
    );
  });

  test('a charge at or below the ceiling is unaffected by that rule', () => {
    const view = baseView({ amountPaise: RBI.afaThresholdPaise.value, maxAmountPaise: 60_000_00 });
    const d = evaluate(input(view, bundle(retry)));
    assert.ok(!rulesFired(d).includes('AFA_THRESHOLD_EXCEEDED'));
  });

  test('the whole simulated cohort sits below the AFA ceiling, so the rule never fires on it', () => {
    // Stated rather than assumed: our price points top out well under Rs 15,000, so this
    // rule is implemented and tested but does not shape the headline numbers.
    const population = buildAtRiskPopulation(SEED, 300);
    const max = Math.max(...population.cases.map((c) => c.subscription.amountPaise));
    assert.ok(
      max <= RBI.afaThresholdPaise.value,
      `cohort max ${max} exceeds the AFA ceiling ${RBI.afaThresholdPaise.value}`,
    );
  });
});

describe('pre-debit rule is applied only to the rails the framework names', () => {
  test('eNACH is out of the framework\'s stated scope, so the rule does not apply to it', () => {
    // Section 2 applies the direction to "cards / PPI / UPI". NACH is an NPCI system and
    // is not named. Extending the rule to it would be applying a regulation past its own
    // stated scope, which is its own kind of invention.
    const view = baseView();
    const enach: CaseView = { ...view, mandate: { ...view.mandate, rail: 'enach' } };
    const d = evaluate(
      input(enach, bundle(retry), { lastPreDebitNoticeAt: null, scope: 'per_debit' }),
    );
    assert.ok(
      !rulesFired(d).includes('PRE_DEBIT_NOTIFICATION_REQUIRED'),
      'the framework does not name NACH; the rule must not be extended to it',
    );
  });

  test('UPI and card ARE in scope under the conservative reading', () => {
    for (const rail of ['upi_autopay', 'card'] as const) {
      const view = baseView();
      const scoped: CaseView = { ...view, mandate: { ...view.mandate, rail } };
      const d = evaluate(
        input(scoped, bundle(retry), { lastPreDebitNoticeAt: null, scope: 'per_debit' }),
      );
      assert.ok(
        rulesFired(d).includes('PRE_DEBIT_NOTIFICATION_REQUIRED'),
        `${rail} is named in Section 2 and must be covered`,
      );
    }
  });
});

describe('quiet hours and holidays', () => {
  test('the quiet window is respected at its edges', () => {
    const at = (h: number) => fromIst(2026, 3, 12, h);
    assert.equal(isPermittedContactTime(at(8)), false, '08:00 is too early');
    assert.equal(isPermittedContactTime(at(9)), true, '09:00 is permitted');
    assert.equal(isPermittedContactTime(at(20)), true, '20:00 is permitted');
    assert.equal(isPermittedContactTime(at(21)), false, '21:00 is too late');
    assert.equal(isPermittedContactTime(at(2)), false, '02:00 is the middle of the night');
  });

  test('national holidays are not contact days', () => {
    assert.equal(isPermittedContactTime(fromIst(2026, 8, 15, 11)), false, 'Independence Day');
    assert.equal(isPermittedContactTime(fromIst(2026, 1, 26, 11)), false, 'Republic Day');
    assert.equal(isPermittedContactTime(fromIst(2026, 10, 2, 11)), false, 'Gandhi Jayanti');
    assert.equal(isPermittedContactTime(fromIst(2026, 8, 16, 11)), true, 'the day after');
  });

  test('a contact on a holiday night rolls forward to the next permitted morning', () => {
    const next = nextPermittedContactTime(fromIst(2026, 8, 15, 23));
    const p = istParts(next);
    assert.equal(p.month, 8);
    assert.equal(p.day, 16);
    assert.equal(p.hour, CONTACT_POLICY.quietHoursEndIst);
  });
});

describe('the pre-debit scope flag actually bites', () => {
  test('a notice authorises ONE debit and is then spent', () => {
    // The bug this pins: the rule originally checked only the AGE of the most recent
    // notice, so a single cycle-opening notification authorised an unlimited number of
    // retries and the strict flag was silently a no-op. A consumed notice is null.
    const view = baseView();
    const withNotice = evaluate(
      input(view, bundle(retry), {
        lastPreDebitNoticeAt: view.now - 48 * HOUR_MS,
        scope: 'per_debit',
      }),
    );
    assert.deepEqual(rulesFired(withNotice), [], 'an unspent, aged notice permits the charge');

    const consumed = evaluate(
      input(view, bundle(retry), { lastPreDebitNoticeAt: null, scope: 'per_debit' }),
    );
    assert.ok(
      rulesFired(consumed).includes('PRE_DEBIT_NOTIFICATION_REQUIRED'),
      'once spent, the same notice must not authorise a second debit',
    );
  });

  test('the two readings produce materially different behaviour across a batch', async () => {
    // If these ever converge, the flag has become decorative again.
    const lenient = await runBatch(SEED, 80, [new ControlT3Policy()]);
    const before = process.env.SALVAGE_PREDEBIT_SCOPE;
    process.env.SALVAGE_PREDEBIT_SCOPE = 'per_debit';
    try {
      const strict = await runBatch(SEED, 80, [new ControlT3Policy()]);
      const l = lenient.arms[0]!.metrics;
      const s2 = strict.arms[0]!.metrics;
      assert.ok(
        s2.totalAttempts < l.totalAttempts,
        `strict compliance must permit fewer charges (${s2.totalAttempts} vs ${l.totalAttempts})`,
      );
      assert.ok(
        (s2.policyRuleCounts.PRE_DEBIT_NOTIFICATION_REQUIRED ?? 0) > 0,
        'the strict reading must actually fire its rule',
      );
      assert.equal(
        l.policyRuleCounts.PRE_DEBIT_NOTIFICATION_REQUIRED ?? 0,
        0,
        'the lenient reading must not fire it',
      );
    } finally {
      if (before === undefined) delete process.env.SALVAGE_PREDEBIT_SCOPE;
      else process.env.SALVAGE_PREDEBIT_SCOPE = before;
    }
  });
});

describe('phase 4 acceptance: every action carries a logged verdict', () => {
  test('no decision in a full control run is left unadjudicated', async () => {
    const { arms } = await runBatch(SEED, 60, [new ControlT3Policy()]);
    let decisions = 0;
    for (const c of arms[0]!.cases) {
      for (const d of c.decisions) {
        decisions++;
        assert.notEqual(
          d.policyVerdict,
          'NOT_YET_IMPLEMENTED',
          `${c.id} decision ${d.seq} reached the executor without a verdict`,
        );
        assert.ok(['APPROVE', 'MODIFY', 'DENY', 'ESCALATE'].includes(d.policyVerdict));
        if (d.policyVerdict !== 'APPROVE') {
          assert.notEqual(d.policyRuleFired, null, 'a non-approval must name its rule');
        }
      }
    }
    assert.ok(decisions > 0, 'the run must actually have made decisions');
  });

  test('the audit trail keeps what the agent WANTED, not just what was allowed', async () => {
    const population = buildAtRiskPopulation(SEED, 40);
    const agent = new AgentPolicy({
      world: population.world,
      seed: SEED,
      deterministicOnly: true,
    });
    const { runArm } = await import('../src/engine/runner.ts');
    const arm = await runArm(population, agent, 4);

    const refused = arm.cases
      .flatMap((c) => c.decisions)
      .filter((d) => d.policyVerdict === 'DENY' || d.policyVerdict === 'ESCALATE');

    for (const d of refused) {
      // A trail that records only the approved action cannot show the gate doing anything.
      assert.ok(d.proposedBundle.actions.length > 0, 'the original proposal must survive');
      assert.notDeepEqual(
        d.proposedBundle.actions.map((a) => a.kind),
        d.finalBundle.actions.map((a) => a.kind),
        'a refusal must be visible as a difference between proposed and final',
      );
    }
  });
});
