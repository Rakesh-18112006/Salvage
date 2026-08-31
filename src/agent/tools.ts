/**
 * The agent's tools (spec section 8).
 *
 * All twelve are here, split the way spec rule 2 demands:
 *
 *   READ tools   (get_*)      - deterministic lookups. These gather evidence.
 *   PROPOSE tools (propose_*) - these do NOT act. They construct a typed proposal that
 *                               the policy gate (Phase 4) may still reject.
 *
 * The important discipline: a propose_* tool takes only the STRATEGIC choice from the
 * agent and computes the arithmetic itself. `propose_time_shift` is told "shift to the
 * customer's next inflow", not "shift by 96 hours" - because working out when the next
 * inflow actually falls is calendar arithmetic, and calendar arithmetic is exactly what
 * rule 2 says must not be delegated to a language model.
 */
import type {
  Action,
  CaseView,
  Customer,
  Mandate,
  Subscription,
  Timestamp,
} from '../domain/types.ts';
import type { FailureClass } from '../domain/taxonomy.ts';
import { isTerminal } from '../domain/taxonomy.ts';
import { DAY_MS, HOUR_MS, daysSinceInflow, istParts, nextIstDayOfMonth } from '../sim/clock.ts';
import { bankHealth } from '../sim/banks.ts';
import type { World } from '../sim/population.ts';

// ---------------------------------------------------------------------------
// READ TOOLS - evidence gathering, all deterministic
// ---------------------------------------------------------------------------

export interface FailureContext {
  readonly caseId: string;
  readonly amountPaise: number;
  readonly rail: Mandate['rail'];
  readonly lastFailureClass: FailureClass;
  readonly lastRawErrorCode: string;
  /** The rail's own words for the last failure. Empty when the rail sent none. */
  readonly lastRawErrorDesc: string;
  /**
   * Did the taxonomy RECOGNISE the last raw code?
   *
   * This distinction is load-bearing, and it is the difference between two situations
   * that both surface as UNKNOWN:
   *
   *   matched = true   the code IS in our table and maps to UNKNOWN because the rail's
   *                    own documented description does not settle the cause. Nine of
   *                    Razorpay's eighteen recurring-payment reasons are like this.
   *                    Re-reading the text cannot help - we already read it, and it says
   *                    nothing. There is nothing here for a model to add.
   *
   *   matched = false  the code is one we have NEVER SEEN. The table has no opinion,
   *                    but the accompanying description may still be perfectly legible.
   *                    This is the only case where reading the text is new information.
   */
  readonly lastClassificationMatched: boolean;
  readonly isTerminalClass: boolean;
  readonly attemptsUsed: number;
  readonly contactsUsed: number;
  readonly hoursSinceOpen: number;
  readonly hoursLeftInHorizon: number;
  readonly attemptHistory: ReadonlyArray<{
    attemptNo: number;
    failureClass: FailureClass;
    hoursAfterOpen: number;
  }>;
}

export function get_failure_context(view: CaseView): FailureContext {
  return {
    caseId: view.caseId,
    amountPaise: view.subscription.amountPaise,
    rail: view.mandate.rail,
    lastFailureClass: view.lastFailureClass,
    lastRawErrorCode: view.attempts.at(-1)?.rawErrorCode ?? '',
    lastRawErrorDesc: view.attempts.at(-1)?.rawErrorDesc ?? '',
    // Absent attempts cannot be "unrecognised" - there is nothing to recognise - so the
    // safe default is `true`, which keeps the unmapped-code path closed.
    lastClassificationMatched: view.attempts.at(-1)?.classificationMatched ?? true,
    isTerminalClass: isTerminal(view.lastFailureClass),
    attemptsUsed: view.attemptsUsed,
    contactsUsed: view.contactsUsed,
    hoursSinceOpen: (view.now - view.openedAt) / HOUR_MS,
    hoursLeftInHorizon: Math.max(0, (view.horizonEndsAt - view.now) / HOUR_MS),
    attemptHistory: view.attempts.map((a) => ({
      attemptNo: a.attemptNo,
      failureClass: a.failureClass,
      hoursAfterOpen: (a.executedAt - view.openedAt) / HOUR_MS,
    })),
  };
}

export interface PaymentHistory {
  readonly tenureMonths: number;
  readonly reliabilityBand: 'strong' | 'mixed' | 'weak';
  readonly preferredLanguage: Customer['preferredLanguage'];
  readonly inflowDayOfMonth: number;
  readonly daysSinceLastInflow: number;
  readonly daysUntilNextInflow: number;
}

/**
 * Customer history.
 *
 * `reliability` is deliberately exposed as a BAND, not the raw simulator number. The
 * raw value is a property of the simulated world; handing it to the agent would let it
 * read the answer key rather than reason from evidence a real system would hold.
 */
export function get_customer_payment_history(
  view: CaseView,
  world: World,
): PaymentHistory {
  const customer = world.customer(view.subscription.customerId);
  const since = daysSinceInflow(view.now, customer.inflowDay);
  const nextInflow = nextIstDayOfMonth(view.now, customer.inflowDay, istParts(view.now).hour);

  return {
    tenureMonths: customer.tenureMonths,
    reliabilityBand:
      customer.reliability >= 0.72 ? 'strong' : customer.reliability >= 0.48 ? 'mixed' : 'weak',
    preferredLanguage: customer.preferredLanguage,
    inflowDayOfMonth: customer.inflowDay,
    daysSinceLastInflow: since,
    daysUntilNextInflow: Math.round((nextInflow - view.now) / DAY_MS),
  };
}

export interface BankHealth {
  readonly bankCode: string;
  readonly recentUptimePct: number;
  readonly degraded: boolean;
}

export function get_bank_health(view: CaseView, seed: string): BankHealth {
  const uptime = bankHealth(seed, view.mandate.bankCode, view.now, 6);
  return {
    bankCode: view.mandate.bankCode,
    recentUptimePct: Math.round(uptime * 100),
    // The spec's third judgment scenario: a bank whose success rate just dropped.
    degraded: uptime < 0.7,
  };
}

export interface MandateDetails {
  readonly rail: Mandate['rail'];
  readonly status: Mandate['status'];
  readonly maxAmountPaise: number;
  readonly amountPaise: number;
  readonly amountWithinCap: boolean;
  readonly ageMonths: number;
}

export function get_mandate_details(view: CaseView): MandateDetails {
  return {
    rail: view.mandate.rail,
    status: view.mandate.status,
    maxAmountPaise: view.mandate.maxAmountPaise,
    amountPaise: view.subscription.amountPaise,
    amountWithinCap: view.subscription.amountPaise <= view.mandate.maxAmountPaise,
    ageMonths: Math.max(0, Math.round((view.now - view.mandate.createdAt) / (30 * DAY_MS))),
  };
}

// ---------------------------------------------------------------------------
// PROPOSE TOOLS - construct typed actions; the arithmetic stays here
// ---------------------------------------------------------------------------

/** Retry as soon as the short technical backoff has elapsed. */
export function propose_retry(reason: string, backoffHours = 6): Action {
  return { kind: 'RETRY_NOW', delayHours: backoffHours, reason };
}

/** Hold until a named instant - used when a rail is degraded. */
export function propose_defer(view: CaseView, untilHours: number, reason: string): Action {
  return { kind: 'DEFER', delayHours: clampToHorizon(view, untilHours), reason };
}

/**
 * Shift the charge to the customer's next inflow date.
 *
 * The agent chooses the STRATEGY; this function does the calendar work. The `+2h` lands
 * the presentment shortly after the inflow rather than at midnight on the same date,
 * because a debit presented before the credit posts is just another failure.
 */
export function propose_time_shift(
  view: CaseView,
  world: World,
  reason: string,
): Action {
  const customer = world.customer(view.subscription.customerId);
  const hour = istParts(view.now).hour;
  const nextInflow = nextIstDayOfMonth(view.now, customer.inflowDay, hour);
  const delayHours = (nextInflow - view.now) / HOUR_MS + 2;
  return {
    kind: 'TIME_SHIFT',
    delayHours: clampToHorizon(view, Math.max(1, delayHours)),
    reason,
  };
}

export function propose_remandate(reason: string, delayHours = 0): Action {
  return { kind: 'REMANDATE', delayHours, reason };
}

export function propose_payment_link(reason: string, delayHours = 0): Action {
  return { kind: 'PAYMENT_LINK', delayHours, reason };
}

export function propose_notification(
  view: CaseView,
  templateId: string,
  reason: string,
  delayHours = 0,
): Action {
  return {
    kind: 'NOTIFY',
    delayHours,
    language: view.customer.preferredLanguage,
    templateId,
    reason,
  };
}

/** Do nothing, on purpose, for a stated period. A first-class action, not a no-op. */
export function propose_wait(hours: number, reason: string): Action {
  return { kind: 'WAIT', delayHours: hours, reason };
}

export function escalate_to_human(reason: string): Action {
  return { kind: 'ESCALATE_HUMAN', delayHours: 0, reason };
}

export function stop(reason: string): Action {
  return { kind: 'STOP', delayHours: 0, reason };
}

/**
 * No action may be scheduled past the case horizon: a retry that fires after the case
 * is abandoned is a retry that never happens, and an agent allowed to schedule one
 * would look like it was acting while doing nothing.
 */
function clampToHorizon(view: CaseView, delayHours: number): number {
  const maxHours = Math.max(0, (view.horizonEndsAt - view.now) / HOUR_MS - 1);
  return Math.max(0, Math.min(delayHours, maxHours));
}

export type ToolTimestamp = Timestamp;
export type ToolSubscription = Subscription;
