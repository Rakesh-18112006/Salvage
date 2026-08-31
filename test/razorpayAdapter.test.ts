/**
 * THE RAZORPAY SEAM.
 *
 * These fixtures are RECONSTRUCTIONS of the documented payload shape, not captured
 * traffic - nobody has run this against a real account. That limits what the suite can
 * prove and it is worth being exact about the difference:
 *
 *   IT PROVES     that a real documented Razorpay reason string, arriving in the
 *                 documented envelope, reaches `classify()` and lands on the right
 *                 failure class - and that a payload we do not understand is refused
 *                 loudly rather than parsed into a plausible-looking default.
 *
 *   IT DOES NOT   prove the envelope is byte-identical to what Razorpay sends. The
 *                 shape is sourced from their docs (see the adapter header) and one run
 *                 against test mode would settle it. Until then `reasonFieldUsed` is the
 *                 thing to look at on a first live payload.
 */
import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import {
  integrationWarnings,
  parsePaymentFailureWebhook,
  WebhookShapeError,
  PAYMENT_BEARING_EVENTS,
} from '../src/webhook/razorpayAdapter.ts';
import { RAIL_CODE_DETAIL } from '../src/domain/taxonomy.ts';

/**
 * The documented envelope, filled with a documented reason.
 *
 * Field names come from Razorpay Docs (subscription webhook payloads; e-mandate error
 * object), retrieved 2026-09-01. Values are ours.
 */
function payload(over: {
  event?: string;
  errorReason?: string | null;
  errorCode?: string | null;
  errorDescription?: string;
} = {}): string {
  const payment: Record<string, unknown> = {
    id: 'pay_SIMULATEDxxxxxxx',
    entity: 'payment',
    amount: 99_900,
    currency: 'INR',
    status: 'failed',
    order_id: null,
    invoice_id: 'inv_SIMULATEDxxxxxx',
    method: 'emandate',
    error_description: over.errorDescription ?? 'The payment could not be completed',
  };
  if (over.errorReason !== null) {
    payment.error_reason = over.errorReason ?? 'insufficient_funds';
  }
  if (over.errorCode !== null) {
    payment.error_code = over.errorCode ?? 'BAD_REQUEST_ERROR';
  }

  return JSON.stringify({
    entity: 'event',
    account_id: 'acc_SIMULATEDxxxxx',
    event: over.event ?? 'subscription.charged',
    contains: ['payment', 'subscription'],
    id: 'evt_SIMULATEDxxxxxxx',
    payload: {
      subscription: { entity: { id: 'sub_SIMULATEDxxxxxx', status: 'active' } },
      payment: { entity: payment },
    },
    created_at: 1_772_000_000,
  });
}

describe('parsing a Razorpay recurring-payment webhook', () => {
  test('reads the documented envelope', () => {
    const p = parsePaymentFailureWebhook(payload());
    assert.equal(p.eventId, 'evt_SIMULATEDxxxxxxx');
    assert.equal(p.eventType, 'subscription.charged');
    assert.equal(p.paymentId, 'pay_SIMULATEDxxxxxxx');
    assert.equal(p.subscriptionId, 'sub_SIMULATEDxxxxxx');
    assert.equal(p.invoiceId, 'inv_SIMULATEDxxxxxx');
    assert.equal(p.amountPaise, 99_900);
    assert.equal(p.currency, 'INR');
    assert.equal(p.createdAt, 1_772_000_000);
  });

  test('prefers error_reason, and says that it did', () => {
    const p = parsePaymentFailureWebhook(payload({ errorReason: 'insufficient_funds' }));
    assert.equal(p.reasonFieldUsed, 'error_reason');
    assert.equal(p.rawErrorCode, 'insufficient_funds');
  });

  test('falls back to error_code and FLAGS the fallback', () => {
    // The adapter must not depend on our inference about `error_reason` being right.
    const p = parsePaymentFailureWebhook(
      payload({ errorReason: null, errorCode: 'BANK_TECHNICAL_ERROR' }),
    );
    assert.equal(p.reasonFieldUsed, 'error_code');
    assert.equal(p.rawErrorCode, 'BANK_TECHNICAL_ERROR');
    assert.ok(
      integrationWarnings(p).some((w) => /re-checked against a real payload/.test(w)),
      'a fallback must warn, or a wrong inference would travel silently',
    );
  });

  test('a payload with no reason at all is flagged for a human', () => {
    const p = parsePaymentFailureWebhook(payload({ errorReason: null, errorCode: null }));
    assert.equal(p.reasonFieldUsed, 'none');
    assert.equal(p.classification.failureClass, 'UNKNOWN');
    assert.ok(integrationWarnings(p).some((w) => /must go to a person/.test(w)));
  });
});

describe('real documented reasons reach the taxonomy', () => {
  // The claim this whole file exists to make good: the taxonomy is keyed on Razorpay's
  // OWN documented reason values, and they survive the trip through a real payload shape.
  for (const [reason, mapping] of Object.entries(RAIL_CODE_DETAIL)) {
    test(`${reason.toLowerCase()} -> ${mapping.failureClass}`, () => {
      const p = parsePaymentFailureWebhook(
        payload({ errorReason: reason.toLowerCase(), errorDescription: mapping.documentedAs }),
      );
      assert.equal(p.reasonFieldUsed, 'error_reason');
      assert.equal(p.classification.matched, true, `${reason} did not match the taxonomy`);
      assert.equal(p.classification.source, 'rail_map');
      assert.equal(p.classification.failureClass, mapping.failureClass);
    });
  }

  test('every documented reason is covered by the loop above', () => {
    // Guards against the suite silently shrinking if the table is refactored.
    assert.ok(
      Object.keys(RAIL_CODE_DETAIL).length >= 18,
      `expected at least the 18 documented reasons, found ${Object.keys(RAIL_CODE_DETAIL).length}`,
    );
  });

  test('an unrecognised reason degrades to UNKNOWN and warns, rather than guessing', () => {
    const p = parsePaymentFailureWebhook(payload({ errorReason: 'some_new_reason_2027' }));
    assert.equal(p.classification.matched, false);
    assert.equal(p.classification.failureClass, 'UNKNOWN');
    assert.ok(integrationWarnings(p).some((w) => /not in the taxonomy/.test(w)));
  });
});

describe('a payload we do not understand is refused, not guessed', () => {
  const cases: ReadonlyArray<[string, string, RegExp]> = [
    ['not JSON at all', 'definitely not json', /not JSON/],
    ['a JSON array', '[]', /not an object/],
    ['no event id', JSON.stringify({ event: 'payment.failed' }), /"id"/],
    ['no event type', JSON.stringify({ id: 'evt_1' }), /"event"/],
    [
      'an event we never claimed to handle',
      JSON.stringify({ id: 'evt_1', event: 'refund.created', payload: {} }),
      /not an event this adapter claims to understand/,
    ],
    [
      'no payment entity',
      JSON.stringify({ id: 'evt_1', event: 'payment.failed', payload: {} }),
      /payload\.payment/,
    ],
    [
      'a payment with no amount',
      JSON.stringify({
        id: 'evt_1',
        event: 'payment.failed',
        payload: { payment: { entity: { id: 'pay_1' } } },
      }),
      /amount/,
    ],
  ];

  for (const [label, body, expected] of cases) {
    test(label, () => {
      assert.throws(
        () => parsePaymentFailureWebhook(body),
        (e: unknown) => e instanceof WebhookShapeError && expected.test((e as Error).message),
        `"${label}" should have been refused with a message matching ${expected}`,
      );
    });
  }

  test('the allow-list is an allow-list, not a heuristic', () => {
    // A webhook nobody has thought about must be rejected rather than optimistically
    // parsed into a charge attempt against somebody's account.
    assert.ok(PAYMENT_BEARING_EVENTS.has('subscription.charged'));
    assert.ok(!PAYMENT_BEARING_EVENTS.has('subscription.pending'));
    assert.ok(!PAYMENT_BEARING_EVENTS.has('payment.authorized'));
  });
});

describe('a clean, classifiable payload produces no warnings', () => {
  test('insufficient_funds is understood end to end with nothing to flag', () => {
    const p = parsePaymentFailureWebhook(payload({ errorReason: 'insufficient_funds' }));
    assert.equal(p.classification.failureClass, 'INSUFFICIENT_FUNDS');
    assert.deepEqual(integrationWarnings(p), []);
  });
});
