/** Unit tests for the deterministic pieces: taxonomy, clock, money, control policy. */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  classify,
  CORRECT_INTERVENTION,
  FAILURE_CLASSES,
  isTerminal,
  RAIL_CODE_DETAIL,
  RAZORPAY_EMANDATE_SUBSEQUENT_SOURCE,
} from '../src/domain/taxonomy.ts';
import { formatINR, toPaise } from '../src/domain/money.ts';
import {
  daysInMonth,
  daysSinceInflow,
  fromIst,
  istParts,
  nextIstDayOfMonth,
} from '../src/sim/clock.ts';
import { ControlT3Policy, T3_RETRY_COUNT } from '../src/policy/controlT3.ts';
import type { CaseView, ChargeAttempt } from '../src/domain/types.ts';

// --- taxonomy --------------------------------------------------------------------

test('classification degrades to UNKNOWN instead of guessing', () => {
  const r = classify('SOME_CODE_WE_HAVE_NEVER_SEEN');
  assert.equal(r.failureClass, 'UNKNOWN');
  assert.equal(r.matched, false);
});

test('an empty code is UNKNOWN and unmatched, never a silent success', () => {
  const r = classify('');
  assert.equal(r.failureClass, 'UNKNOWN');
  assert.equal(r.matched, false);
});

test('simulated codes classify, and terminal classes are marked terminal', () => {
  assert.equal(classify('SIM_MANDATE_REVOKED').failureClass, 'MANDATE_REVOKED');
  assert.equal(classify('sim_insufficient_funds').failureClass, 'INSUFFICIENT_FUNDS');
  assert.ok(isTerminal('MANDATE_REVOKED'));
  assert.ok(isTerminal('ACCOUNT_FROZEN'));
  assert.ok(!isTerminal('INSUFFICIENT_FUNDS'));
  assert.ok(!isTerminal('BANK_DOWNTIME'));
});

test('every real rail code carries provenance and a rationale', () => {
  // This replaces the earlier commitment-device test, which asserted RAIL_CODE_MAP was
  // EMPTY and failed the moment anyone populated it - deliberately, so that whoever
  // added codes had to add their citations at the same time. That has now happened:
  // the map holds Razorpay's documented recurring-payment reasons. The obligation
  // carries over in a stronger form.
  const entries = Object.entries(RAIL_CODE_DETAIL);
  assert.ok(entries.length > 0, 'the map should be populated now');

  for (const [code, m] of entries) {
    assert.match(code, /^[A-Z0-9_]+$/, `${code} should be a normalised code key`);
    assert.ok(
      m.documentedAs.length > 15,
      `${code} must record the vendor's own description verbatim`,
    );
    assert.ok(m.rationale.length > 15, `${code} must explain why it maps where it does`);
    assert.ok(
      (FAILURE_CLASSES as ReadonlyArray<string>).includes(m.failureClass),
      `${code} maps to a class outside the taxonomy`,
    );
  }
  assert.match(RAZORPAY_EMANDATE_SUBSEQUENT_SOURCE, /razorpay\.com\/docs/);
  assert.match(RAZORPAY_EMANDATE_SUBSEQUENT_SOURCE, /retrieved/);
});

test('ambiguous vendor reasons are UNKNOWN rather than guessed into a class', () => {
  // Razorpay documents payment_declined and payment_failed with identical text:
  // "declined due to business or technical reasons". That spans the whole taxonomy.
  // Mapping either to a specific class would be inventing a cause.
  for (const code of ['PAYMENT_DECLINED', 'PAYMENT_FAILED', 'PAYMENT_CANCELLED']) {
    assert.equal(RAIL_CODE_DETAIL[code]?.failureClass, 'UNKNOWN', `${code} must stay UNKNOWN`);
  }
  // An account-level limit is not our mandate cap, and an invalid amount is not an
  // over-cap amount. Neither may be folded into AMOUNT_EXCEEDS_MANDATE.
  assert.equal(RAIL_CODE_DETAIL.TRANSACTION_LIMIT_EXCEEDED?.failureClass, 'UNKNOWN');
  assert.equal(RAIL_CODE_DETAIL.INVALID_AMOUNT?.failureClass, 'UNKNOWN');
});

test('confidently mapped reasons resolve through classify()', () => {
  assert.equal(classify('insufficient_funds').failureClass, 'INSUFFICIENT_FUNDS');
  assert.equal(classify('bank_technical_error').failureClass, 'BANK_DOWNTIME');
  assert.equal(classify('gateway_technical_error').failureClass, 'TECHNICAL_DECLINE');
  assert.equal(classify('mandate_not_active').failureClass, 'MANDATE_NOT_ACTIVE');
  assert.equal(classify('bank_account_invalid').failureClass, 'ACCOUNT_CLOSED');
  assert.equal(classify('debit_instrument_blocked').failureClass, 'ACCOUNT_FROZEN');
  // Real codes must resolve as matched, so taxonomy coverage reflects reality.
  assert.equal(classify('insufficient_funds').matched, true);
  assert.equal(classify('insufficient_funds').source, 'rail_map');
});

test('a mandate documented only as "no longer active" is terminal without inventing a cause', () => {
  // Razorpay says the mandate is inactive. It does not say revoked or expired, so we do
  // not claim to know which; both need a re-mandate regardless.
  assert.ok(isTerminal('MANDATE_NOT_ACTIVE'));
  assert.equal(CORRECT_INTERVENTION.MANDATE_NOT_ACTIVE, 'REMANDATE');
});

test('an unrecognised rail code is never presented as retryable', () => {
  const r = classify('some_reason_razorpay_has_not_documented');
  assert.equal(r.failureClass, 'UNKNOWN');
  assert.equal(r.matched, false);
  // The taxonomy's stated intervention must not tell anyone to retry it.
  assert.doesNotMatch(CORRECT_INTERVENTION.UNKNOWN, /retry/i);
});

// --- money -----------------------------------------------------------------------

test('INR formatting uses Indian digit grouping', () => {
  assert.equal(formatINR(73_38_40_00), '₹7,33,840.00');
  assert.equal(formatINR(99_900), '₹999.00');
  assert.equal(formatINR(100), '₹1.00');
  assert.equal(formatINR(0), '₹0.00');
  assert.equal(formatINR(toPaise(1234.5)), '₹1,234.50');
});

// --- clock -----------------------------------------------------------------------

test('month lengths handle February and leap years', () => {
  assert.equal(daysInMonth(2026, 2), 28);
  assert.equal(daysInMonth(2028, 2), 29);
  assert.equal(daysInMonth(2026, 4), 30);
});

test('a billing day past the end of the month clamps rather than rolling over', () => {
  const feb = fromIst(2026, 2, 10, 6);
  const next = nextIstDayOfMonth(feb, 31, 6);
  const p = istParts(next);
  assert.equal(p.month, 2);
  assert.equal(p.day, 28);
});

test('days since inflow crosses the month boundary correctly', () => {
  assert.equal(daysSinceInflow(fromIst(2026, 3, 15, 6), 1), 14);
  assert.equal(daysSinceInflow(fromIst(2026, 3, 1, 6), 1), 0);
  // Inflow on the 10th, now the 3rd: 21 days since the 10th of February (28-day month).
  assert.equal(daysSinceInflow(fromIst(2026, 3, 3, 6), 10), 21);
});

// --- control policy ---------------------------------------------------------------

function viewWith(attemptCount: number, openedAt: number, now: number): CaseView {
  const attempts: ChargeAttempt[] = Array.from({ length: attemptCount }, (_, i) => ({
    id: `a${i}`,
    subscriptionId: 'sub_x',
    cycleId: '2026-03',
    attemptNo: i + 1,
    idempotencyKey: `k${i}`,
    rail: 'upi_autopay',
    scheduledAt: openedAt + i * 86_400_000,
    executedAt: openedAt + i * 86_400_000,
    status: 'failed',
    rawErrorCode: 'SIM_INSUFFICIENT_FUNDS',
    rawErrorDesc: 'x',
    failureClass: 'INSUFFICIENT_FUNDS',
    classificationMatched: true,
    feePaise: 300,
  }));
  return {
    caseId: 'case_x',
    arm: 'control',
    now,
    subscription: {
      id: 'sub_x', mandateId: 'm', customerId: 'c',
      amountPaise: 49_900, billingDay: 15, status: 'active',
    },
    mandate: {
      id: 'm', customerId: 'c', rail: 'upi_autopay', bankCode: 'SIMBANK_A',
      maxAmountPaise: 100_000, status: 'active', createdAt: 0,
    },
    customer: { id: 'c', tenureMonths: 12, preferredLanguage: 'english', bankCode: 'SIMBANK_A' },
    openedAt,
    attempts,
    attemptsUsed: attemptCount,
    contactsUsed: 0,
    lastFailureClass: 'INSUFFICIENT_FUNDS',
    horizonEndsAt: openedAt + 14 * 86_400_000,
  };
}

test('T+3 control schedules exactly one retry per day for three days, then stops', () => {
  const policy = new ControlT3Policy();
  const openedAt = fromIst(2026, 3, 15, 6);
  const DAY = 86_400_000;

  for (let retriesDone = 0; retriesDone < T3_RETRY_COUNT; retriesDone++) {
    const now = openedAt + retriesDone * DAY;
    const bundle = policy.decide(viewWith(retriesDone + 1, openedAt, now));
    assert.equal(bundle.actions.length, 1);
    const action = bundle.actions[0]!;
    assert.equal(action.kind, 'RETRY_NOW');
    // Retry n fires at exactly T+n, i.e. 24h after the previous presentment.
    assert.equal(action.delayHours, 24);
  }

  const done = policy.decide(viewWith(T3_RETRY_COUNT + 1, openedAt, openedAt + 3 * DAY));
  assert.equal(done.actions[0]!.kind, 'STOP');
});

test('T+3 control never proposes anything other than RETRY_NOW or STOP', () => {
  const policy = new ControlT3Policy();
  const openedAt = fromIst(2026, 3, 15, 6);
  for (let n = 1; n <= 6; n++) {
    const bundle = policy.decide(viewWith(n, openedAt, openedAt + (n - 1) * 86_400_000));
    for (const action of bundle.actions) {
      assert.ok(
        action.kind === 'RETRY_NOW' || action.kind === 'STOP',
        `control arm proposed ${action.kind}, which is not the documented default`,
      );
    }
  }
});
