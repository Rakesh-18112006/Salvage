/**
 * RAZORPAY WEBHOOK -> OUR DOMAIN.
 *
 * The seam between Razorpay's payload shape and this project's failure taxonomy. Its
 * whole job is to answer one question honestly: when a real recurring debit fails, does
 * the string Razorpay sends us actually reach `classify()`, and does `classify()` know
 * what to do with it?
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS
 * ----------------------------------
 * Everything else in this repository runs against a simulator. That is stated everywhere
 * and it is fine, but it leaves one claim resting on nothing: that the taxonomy is keyed
 * on REAL Razorpay error reasons rather than on strings we typed. `RAIL_CODE_DETAIL`
 * quotes eighteen documented reasons, and until something parses an actual payload shape
 * and feeds it through, "we mapped Razorpay's real error reasons" is a claim about a
 * comment rather than about code.
 *
 * ============================ WHAT IS SOURCED, AND WHAT IS NOT ========================
 * Spec rule 1 forbids inventing vendor facts, and a payload shape is a vendor fact. So
 * the provenance of every field below is recorded, and they are not all the same:
 *
 * SOURCED - Razorpay Docs, "Subscription Webhooks" payload page, retrieved 2026-09-01
 *   The envelope: `entity` ("event"), `account_id`, `event`, `contains`, `payload`,
 *   `created_at`. Subscription events carry `payload.subscription.entity` and
 *   `payload.payment.entity`. The payment entity carries `id`, `entity`, `amount`,
 *   `currency`, `status`, `order_id`, `invoice_id`, `method`, `error_code`,
 *   `error_description`.
 *
 * SOURCED - Razorpay Docs, e-mandate "Handle Errors", retrieved 2026-09-01
 *   The error object is `{ code, description, reason, source, step }`, and of `reason`
 *   the docs say: "The exact error reason. It can be handled programmatically." That is
 *   precisely the field our taxonomy is keyed on, and it is the reason it is keyed on it.
 *
 * INFERRED - NOT verified against a sample payload, and flagged as such at runtime
 *   That the error object's `reason` appears on the PAYMENT ENTITY under the flattened
 *   name `error_reason`. Razorpay flattens the error object onto the payment entity this
 *   way for `error_code` and `error_description`, which the webhook page does show, so
 *   `error_reason` following the same convention is a reasonable inference. It is an
 *   inference nonetheless. The samples we could read do not display it.
 *
 * The adapter therefore does NOT depend on the inference being right. It reads
 * `error_reason` when present, falls back to `error_code`, and REPORTS WHICH ONE IT
 * USED in `reasonFieldUsed`, so a first run against a real sandbox settles the question
 * instead of hiding it. Anything else and a wrong guess would quietly degrade every
 * failure to UNKNOWN while looking like it worked.
 * =====================================================================================
 *
 * NOT YET DONE, and it is the honest gap: nothing here has been run against Razorpay's
 * test mode. That needs an account and API keys, which are the merchant's to create.
 * `docs/RAZORPAY-INTEGRATION.md` sets out exactly what a first live test would settle.
 */
import { classify, type Classification } from '../domain/taxonomy.ts';

/** Where the failure reason was read from. Recorded, never assumed. */
export type ReasonField = 'error_reason' | 'error_code' | 'none';

export interface ParsedPaymentFailure {
  /** Razorpay's event id. The inbox dedupes on this. */
  readonly eventId: string;
  readonly eventType: string;
  readonly paymentId: string;
  readonly subscriptionId: string | null;
  readonly invoiceId: string | null;
  /** Razorpay reports amounts in paise, which is also this project's unit. */
  readonly amountPaise: number;
  readonly currency: string;
  readonly status: string;
  readonly rawErrorCode: string;
  readonly rawErrorDesc: string;
  /**
   * Which field the reason came from. `error_code` means the inference above did not
   * hold for this payload and the mapping should be re-checked against a real sample.
   */
  readonly reasonFieldUsed: ReasonField;
  readonly classification: Classification;
  readonly createdAt: number;
}

export class WebhookShapeError extends Error {
  readonly field: string;
  constructor(field: string, detail: string) {
    super(`unexpected Razorpay webhook shape at "${field}": ${detail}`);
    this.name = 'WebhookShapeError';
    this.field = field;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/**
 * Payment-bearing subscription events. Only these carry a `payload.payment.entity`, and
 * only a failed one is a recovery case.
 *
 * Deliberately a allow-list rather than a "contains 'payment'" heuristic: a webhook we
 * have not thought about should be REJECTED loudly, not parsed optimistically into a
 * charge attempt against somebody's account.
 */
export const PAYMENT_BEARING_EVENTS: ReadonlySet<string> = new Set([
  'subscription.charged',
  'payment.failed',
  'payment.captured',
]);

/**
 * Parse a verified Razorpay webhook body into a failure this project understands.
 *
 * `raw` must be the body whose HMAC has already been checked (src/webhook/verify.ts).
 * Parsing before verifying would be reading an unauthenticated stranger's JSON.
 *
 * Throws `WebhookShapeError` rather than returning a partial result. A payload we cannot
 * read is an operational alarm - the vendor changed something - and the one thing it
 * must never do is degrade quietly into a well-formed object full of defaults.
 */
export function parsePaymentFailureWebhook(raw: string): ParsedPaymentFailure {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch (e) {
    throw new WebhookShapeError('<root>', `body is not JSON: ${(e as Error).message}`);
  }
  if (!isRecord(body)) throw new WebhookShapeError('<root>', 'body is not an object');

  const eventId = str(body.id);
  const eventType = str(body.event);
  if (eventId === null) throw new WebhookShapeError('id', 'missing or not a string');
  if (eventType === null) throw new WebhookShapeError('event', 'missing or not a string');

  if (!PAYMENT_BEARING_EVENTS.has(eventType)) {
    throw new WebhookShapeError(
      'event',
      `"${eventType}" is not an event this adapter claims to understand. Known: ` +
        `${[...PAYMENT_BEARING_EVENTS].join(', ')}`,
    );
  }

  const payload = body.payload;
  if (!isRecord(payload)) throw new WebhookShapeError('payload', 'missing or not an object');

  const paymentWrapper = payload.payment;
  if (!isRecord(paymentWrapper)) {
    throw new WebhookShapeError('payload.payment', 'missing or not an object');
  }
  const payment = paymentWrapper.entity;
  if (!isRecord(payment)) {
    throw new WebhookShapeError('payload.payment.entity', 'missing or not an object');
  }

  const paymentId = str(payment.id);
  if (paymentId === null) {
    throw new WebhookShapeError('payload.payment.entity.id', 'missing or not a string');
  }

  const amount = payment.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    throw new WebhookShapeError('payload.payment.entity.amount', 'missing or not a number');
  }

  // ---- the field the whole taxonomy hangs on ------------------------------
  // `error_reason` first because the docs describe `reason` as the one meant to be
  // "handled programmatically"; `error_code` second because it is the field the webhook
  // samples definitely show. Which one answered is reported, not swallowed.
  const errorReason = str(payment.error_reason);
  const errorCode = str(payment.error_code);

  let rawErrorCode: string;
  let reasonFieldUsed: ReasonField;
  if (errorReason !== null && errorReason.length > 0) {
    rawErrorCode = errorReason;
    reasonFieldUsed = 'error_reason';
  } else if (errorCode !== null && errorCode.length > 0) {
    rawErrorCode = errorCode;
    reasonFieldUsed = 'error_code';
  } else {
    rawErrorCode = '';
    reasonFieldUsed = 'none';
  }

  const subscriptionEntity = isRecord(payload.subscription)
    ? payload.subscription.entity
    : undefined;

  return {
    eventId,
    eventType,
    paymentId,
    subscriptionId: isRecord(subscriptionEntity) ? str(subscriptionEntity.id) : null,
    invoiceId: str(payment.invoice_id),
    amountPaise: amount,
    currency: str(payment.currency) ?? 'INR',
    status: str(payment.status) ?? 'unknown',
    rawErrorCode,
    rawErrorDesc: str(payment.error_description) ?? '',
    reasonFieldUsed,
    // The single line this whole file exists to make possible: a real Razorpay reason
    // string, taken off a real payload shape, going through the same classifier the
    // simulator's codes go through. Same function, same table, no special case.
    classification: classify(rawErrorCode),
    createdAt: typeof body.created_at === 'number' ? body.created_at : 0,
  };
}

/**
 * Is this parse trustworthy enough to act on?
 *
 * Kept separate from parsing because they are different questions. Parsing asks "did the
 * shape hold"; this asks "did we actually learn why the charge failed". A payload that
 * parses cleanly and carries no reason at all is a case for a human, and the honest
 * thing is to say so at the boundary rather than let an empty string become UNKNOWN
 * three layers down and look like a taxonomy miss.
 */
export function integrationWarnings(p: ParsedPaymentFailure): ReadonlyArray<string> {
  const w: string[] = [];
  if (p.reasonFieldUsed === 'none') {
    w.push(
      'the payload carried neither error_reason nor error_code; this failure cannot be ' +
        'classified from it and must go to a person',
    );
  }
  if (p.reasonFieldUsed === 'error_code') {
    w.push(
      'no error_reason field was present, so error_code was used instead. The taxonomy ' +
        'is keyed on the documented REASON values, so this mapping should be re-checked ' +
        'against a real payload before anyone relies on it',
    );
  }
  if (!p.classification.matched && p.rawErrorCode.length > 0) {
    w.push(
      `"${p.rawErrorCode}" is not in the taxonomy. Either Razorpay has added a reason ` +
        'since 2026-08-31 or this is a rail we have not mapped. It classifies as ' +
        'UNKNOWN, which is never auto-retried - the safe direction to be wrong in',
    );
  }
  return w;
}
