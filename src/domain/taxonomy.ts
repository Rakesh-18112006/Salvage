/**
 * THE FAILURE TAXONOMY (spec section 5).
 *
 * The single place where inconsistent raw decline strings are contained. Every other
 * layer speaks FailureClass and nothing else.
 *
 * ============================ REGULATORY / VENDOR HONESTY ============================
 * Spec rule 1: "Do not invent regulatory facts. Any RBI e-mandate rule, NPCI eNACH
 * return code, or Razorpay error code must come from the official source."
 *
 * Accordingly, `RAIL_CODE_MAP` below is DELIBERATELY EMPTY. We have not yet sourced the
 * real NPCI ACH return codes, UPI decline codes, or Razorpay error codes, so we assert
 * none of them. Guessing them and shipping them as a lookup table would be exactly the
 * failure mode the rule forbids.
 *
 * What IS mapped is `SIMULATED_CODE_MAP`: codes our own simulator emits. Those are our
 * inventions and are named as such (`SIM_` prefix). They make no claim about any rail.
 * =====================================================================================
 */

export const FAILURE_CLASSES = [
  'INSUFFICIENT_FUNDS',
  'BANK_DOWNTIME',
  'TECHNICAL_DECLINE',
  'MANDATE_REVOKED',
  'MANDATE_EXPIRED',
  'MANDATE_NOT_ACTIVE',
  'AMOUNT_EXCEEDS_MANDATE',
  'CARD_EXPIRED',
  'ACCOUNT_CLOSED',
  'ACCOUNT_FROZEN',
  'RISK_DECLINE',
  'UNKNOWN',
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

/**
 * Terminal = no retry on the existing mandate can ever succeed. Retrying a terminal
 * class is not a low-probability bet, it is a guaranteed loss that still costs a fee.
 * The policy gate (Phase 4) enforces this against the agent.
 */
const TERMINAL: ReadonlySet<FailureClass> = new Set<FailureClass>([
  'MANDATE_REVOKED',
  'MANDATE_EXPIRED',
  'MANDATE_NOT_ACTIVE',
  'AMOUNT_EXCEEDS_MANDATE',
  'CARD_EXPIRED',
  'ACCOUNT_CLOSED',
  'ACCOUNT_FROZEN',
  'RISK_DECLINE',
]);

export const isTerminal = (c: FailureClass): boolean => TERMINAL.has(c);

/**
 * Terminal classes that need a PERSON, as opposed to terminal classes that need a
 * different automated action.
 *
 * The distinction matters to the policy gate: a revoked mandate is terminal but its
 * correct handling is REMANDATE, so a policy that cannot propose one should simply stop.
 * Sending every revoked mandate to a human instead would be both wrong and, at operator
 * time, ruinously expensive.
 */
const REQUIRES_HUMAN: ReadonlySet<FailureClass> = new Set<FailureClass>([
  'ACCOUNT_CLOSED',
  'ACCOUNT_FROZEN',
  'RISK_DECLINE',
]);

export const requiresHumanReview = (c: FailureClass): boolean => REQUIRES_HUMAN.has(c);

/** Spec section 5, column 3: the intervention the taxonomy says is correct. */
export const CORRECT_INTERVENTION: Readonly<Record<FailureClass, string>> = {
  INSUFFICIENT_FUNDS: 'TIME_SHIFT to inflow date, optionally + NOTIFY',
  BANK_DOWNTIME: 'DEFER past the maintenance window',
  TECHNICAL_DECLINE: 'RETRY_NOW with short backoff',
  MANDATE_REVOKED: 'REMANDATE',
  MANDATE_EXPIRED: 'REMANDATE',
  MANDATE_NOT_ACTIVE: 'REMANDATE',
  AMOUNT_EXCEEDS_MANDATE: 'PAYMENT_LINK or amend mandate',
  CARD_EXPIRED: 'NOTIFY with update-instrument link',
  ACCOUNT_CLOSED: 'ESCALATE_HUMAN',
  ACCOUNT_FROZEN: 'ESCALATE_HUMAN',
  RISK_DECLINE: 'ESCALATE_HUMAN',
  // Changed from "retry once, then escalate": an unrecognised failure is never
  // automatically retried. Nine of Razorpay's eighteen documented recurring-payment
  // reasons land here, and "we do not know why this failed" is not a licence to charge
  // the customer again.
  UNKNOWN: 'ESCALATE_HUMAN - never auto-retried',
};

/**
 * Codes emitted by OUR SIMULATOR. Prefixed SIM_ so no reader can mistake one of these
 * for a real NPCI / UPI / Razorpay code.
 */
export const SIMULATED_CODE_MAP: Readonly<Record<string, FailureClass>> = {
  SIM_INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  SIM_BANK_DOWNTIME: 'BANK_DOWNTIME',
  SIM_TECHNICAL_DECLINE: 'TECHNICAL_DECLINE',
  SIM_MANDATE_REVOKED: 'MANDATE_REVOKED',
  SIM_MANDATE_EXPIRED: 'MANDATE_EXPIRED',
  SIM_AMOUNT_EXCEEDS_MANDATE: 'AMOUNT_EXCEEDS_MANDATE',
  SIM_CARD_EXPIRED: 'CARD_EXPIRED',
  SIM_ACCOUNT_CLOSED: 'ACCOUNT_CLOSED',
  SIM_ACCOUNT_FROZEN: 'ACCOUNT_FROZEN',
  SIM_RISK_DECLINE: 'RISK_DECLINE',
};

/**
 * REAL RAZORPAY ERROR REASONS FOR RECURRING (SUBSEQUENT) PAYMENTS.
 *
 * Source: Razorpay Docs, "Handle Errors" for e-mandate recurring payments,
 * https://razorpay.com/docs/payments/recurring-payments/emandate/errors/
 * Retrieved 2026-08-31. The strings below are the exact `reason` values Razorpay
 * documents, copied verbatim including underscores. None was invented.
 *
 * Scope note: Razorpay documents TWO tables - "Emandate Registration" errors and
 * "Subsequent Payments" errors. This project is about FAILED RECURRING DEBITS, which is
 * the subsequent-payments lifecycle, so only that table is mapped. Registration-time
 * reasons (incorrect_otp, incorrect_cvv, and so on) cannot occur on the path we model,
 * and including them would suggest a coverage we do not have.
 *
 * MAPPING DISCIPLINE - the important part:
 *
 * A reason is mapped to a specific class ONLY where Razorpay's own description settles
 * the question. Where the description is genuinely ambiguous - "declined due to business
 * or technical reasons" could be almost anything - it maps to UNKNOWN rather than to a
 * guess that happens to suit us. Nine of the eighteen documented reasons are mapped that
 * way, and that is the honest outcome rather than a gap to be filled in later.
 *
 * UNKNOWN IS NOT RETRYABLE. The policy gate refuses to present a charge when the last
 * failure classified as UNKNOWN (rule UNKNOWN_FAILURE_NOT_RETRYABLE). An unrecognised
 * payment failure must never quietly become another attempt on a customer's account.
 */
export interface RailCodeMapping {
  readonly failureClass: FailureClass;
  /** Razorpay's own description, verbatim, so the mapping can be re-checked. */
  readonly documentedAs: string;
  /** Why this maps where it does - or why it is deliberately left UNKNOWN. */
  readonly rationale: string;
}

export const RAZORPAY_EMANDATE_SUBSEQUENT_SOURCE =
  'Razorpay Docs, e-mandate recurring payments "Handle Errors", Subsequent Payments ' +
  'table. https://razorpay.com/docs/payments/recurring-payments/emandate/errors/ ' +
  '(retrieved 2026-08-31)';

export const RAIL_CODE_DETAIL: Readonly<Record<string, RailCodeMapping>> = {
  // ---- confidently mapped: the documented description settles the class -------
  INSUFFICIENT_FUNDS: {
    failureClass: 'INSUFFICIENT_FUNDS',
    documentedAs:
      'The customer does not have sufficient funds in the account to complete the payment',
    rationale: 'States the cause explicitly.',
  },
  BANK_TECHNICAL_ERROR: {
    failureClass: 'BANK_DOWNTIME',
    documentedAs:
      'The destination bank was facing technical problems at the moment the payment was attempted',
    rationale: 'Destination bank unavailable at the moment of the attempt.',
  },
  GATEWAY_TECHNICAL_ERROR: {
    failureClass: 'TECHNICAL_DECLINE',
    documentedAs: 'Payment failed due to a technical error at the gateway',
    rationale: 'Transient fault at the gateway rather than at the bank or the account.',
  },
  SERVER_ERROR: {
    failureClass: 'TECHNICAL_DECLINE',
    documentedAs:
      "Technical error at Razorpay's server. This usually occurs when there is some server issue",
    rationale: 'Transient infrastructure fault.',
  },
  PAYMENT_TIMED_OUT: {
    failureClass: 'TECHNICAL_DECLINE',
    documentedAs:
      "The bank where the mandate is registered could not debit the customer's account in time",
    rationale: 'A timing failure, not a statement about funds or mandate validity.',
  },
  MANDATE_NOT_ACTIVE: {
    failureClass: 'MANDATE_NOT_ACTIVE',
    documentedAs: 'The registered mandate is no longer active',
    rationale:
      'Terminal, and no retry can clear it. Deliberately NOT mapped to MANDATE_REVOKED ' +
      'or MANDATE_EXPIRED: the description says the mandate is inactive, not why, and ' +
      'asserting a cause would be inventing one. Both routes need a re-mandate anyway.',
  },
  BANK_ACCOUNT_INVALID: {
    failureClass: 'ACCOUNT_CLOSED',
    documentedAs: "The customer's bank account is either closed or no longer valid",
    rationale: 'Names account closure; automation cannot resolve it.',
  },
  DEBIT_INSTRUMENT_BLOCKED: {
    failureClass: 'ACCOUNT_FROZEN',
    documentedAs: "Withdrawals on the customer's account are temprarily blocked by the bank",
    rationale:
      'Withdrawals blocked by the bank. (Razorpay\'s published text contains the ' +
      'typo "temprarily"; reproduced verbatim rather than silently corrected.)',
  },
  DEBIT_INSTRUMENT_INACTIVE: {
    failureClass: 'ACCOUNT_FROZEN',
    documentedAs: "Withdrawals on the customer's account are temprarily blocked by the bank",
    rationale: 'Razorpay documents the identical description as debit_instrument_blocked.',
  },

  // ---- deliberately UNKNOWN: mapping these would be guessing ------------------
  PAYMENT_DECLINED: {
    failureClass: 'UNKNOWN',
    documentedAs:
      'Destination Bank or Gateway has declined the payment due to business or technical reasons',
    rationale:
      '"Business or technical reasons" spans the entire taxonomy. Unmappable without ' +
      'the underlying bank code.',
  },
  PAYMENT_FAILED: {
    failureClass: 'UNKNOWN',
    documentedAs:
      'Destination Bank or Gateway has declined the payment due to business or technical reasons',
    rationale: 'Identical wording to payment_declined; equally unmappable.',
  },
  PAYMENT_CANCELLED: {
    failureClass: 'UNKNOWN',
    documentedAs: 'The customer has explicitly cancelled the payment',
    rationale:
      'Suggestive of a revoked mandate but does not say so. Treating a cancellation as ' +
      'a revocation would assert a mandate state the text does not establish.',
  },
  PAYMENT_MANDATE_NOT_ACTIVE: {
    failureClass: 'UNKNOWN',
    documentedAs: 'The registered mandate is not yet activated at the bank',
    rationale:
      'NOT the same as mandate_not_active: "not yet activated" is a pending state, which ' +
      'might resolve on its own. We have no class for it and will not guess whether it ' +
      'is terminal.',
  },
  INCORRECT_IFSC: {
    failureClass: 'UNKNOWN',
    documentedAs: 'The bank IFSC code is no longer valid',
    rationale: 'A stored-data problem needing correction; no taxonomy class fits.',
  },
  INVALID_AMOUNT: {
    failureClass: 'UNKNOWN',
    documentedAs: 'Amount or currency passed in the payment request is not supported or invalid',
    rationale:
      'Deliberately NOT mapped to AMOUNT_EXCEEDS_MANDATE. That class means the charge ' +
      'exceeded the MANDATE cap; this reason says the amount was unsupported or invalid, ' +
      'which is a different thing.',
  },
  TRANSACTION_LIMIT_EXCEEDED: {
    failureClass: 'UNKNOWN',
    documentedAs: 'The customers have exceeded the credit or debit limit set on their accounts',
    rationale:
      'An ACCOUNT-level limit set by the bank, not our mandate cap. Mapping it to ' +
      'AMOUNT_EXCEEDS_MANDATE would misattribute the constraint.',
  },
  BANK_ACCOUNT_VALIDATION_FAILED: {
    failureClass: 'UNKNOWN',
    documentedAs: 'The bank could not validate the customer registration for debiting the customer',
    rationale: 'Cause not established by the description.',
  },
  INPUT_VALIDATION_FAILED: {
    failureClass: 'UNKNOWN',
    documentedAs: 'Payment failed due to wrong request or input sent in the payment request',
    rationale: 'An integration defect on our side, not a customer or rail failure.',
  },
};

/**
 * The lookup the classifier uses. Derived from RAIL_CODE_DETAIL so the mapping and its
 * provenance cannot drift apart.
 *
 * NPCI NACH return codes are NOT included. NPCI publishes them only as PDF circulars
 * (Circular 274, Circular 240, NACH-006-FY-24-25) and npci.org.in returned HTTP 403 to
 * every automated fetch on 2026-08-31, so we could not read them from the primary source.
 * Rather than transcribe them from a blog or a third-party summary, they are left out and
 * recorded as an open item. Any NACH code therefore classifies as UNKNOWN, which the gate
 * treats as non-retryable - the safe direction to be wrong in.
 */
export const RAIL_CODE_MAP: Readonly<Record<string, FailureClass>> = Object.fromEntries(
  Object.entries(RAIL_CODE_DETAIL).map(([code, m]) => [code, m.failureClass]),
);

export interface Classification {
  readonly failureClass: FailureClass;
  /** false => the taxonomy did not recognise this code. Drives the coverage metric. */
  readonly matched: boolean;
  readonly source: 'simulator' | 'rail_map' | 'unmatched';
}

/**
 * Classify a raw decline code. Degrades to UNKNOWN rather than guessing - a falling
 * coverage rate is the early warning that a rail changed its codes (spec section 5).
 */
export function classify(rawErrorCode: string): Classification {
  const code = rawErrorCode.trim().toUpperCase();

  const railHit = RAIL_CODE_MAP[code];
  if (railHit !== undefined) return { failureClass: railHit, matched: true, source: 'rail_map' };

  const simHit = SIMULATED_CODE_MAP[code];
  if (simHit !== undefined) return { failureClass: simHit, matched: true, source: 'simulator' };

  return { failureClass: 'UNKNOWN', matched: false, source: 'unmatched' };
}
