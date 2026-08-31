/**
 * ############################  SIMULATOR  ############################
 * Models what happens when a recurring charge is presented to a rail.
 * This is a SIMULATOR. No number here comes from live traffic, from Razorpay, or
 * from any bank. Error codes emitted here are our own inventions, prefixed SIM_ so
 * they cannot be confused with real NPCI / UPI / Razorpay codes (spec rules 1 and 4).
 * #####################################################################
 */
import type {
  Customer,
  Mandate,
  Subscription,
  Timestamp,
} from '../domain/types.ts';
import type { FailureClass } from '../domain/taxonomy.ts';
import { daysSinceInflow, istParts } from './clock.ts';
import { bank, isBankDown } from './banks.ts';
import { chanceAt, uniform } from './rng.ts';
import {
  DEFAULT_WORLD_PARAMS as DEFAULT_PARAMS,
  paramsOf,
  type WorldParams,
} from './worldParams.ts';

/**
 * A rail's decline vocabulary.
 *
 * Injected rather than imported so this file stays the only place that decides WHY a
 * charge failed, while remaining agnostic about the words the rail uses to say so. The
 * generalization eval supplies a dialect whose codes the taxonomy has never mapped
 * (src/eval/railDialect.ts); every other caller supplies none and gets the SIM_ codes
 * below, unchanged.
 */
export interface RailDialect {
  readonly name: string;
  /** `u` is a uniform draw in [0, 1) supplied by the caller, so selection stays seeded. */
  render(cls: FailureClass, u: number): { readonly code: string; readonly desc: string };
}

export interface SimContext {
  readonly seed: string;
  customer(id: string): Customer;
  mandate(id: string): Mandate;
  subscription(id: string): Subscription;
  /** Absent or null => this build's own SIM_ codes. */
  readonly dialect?: RailDialect | null;
  /**
   * How the world behaves. Absent => exactly `assumptions.ts`.
   *
   * The agent does NOT read this; it reads `assumptions.ts` directly. Perturbing this
   * bag therefore makes the agent's beliefs wrong about the world it is acting in, which
   * is what `node src/robustness.ts` measures.
   */
  readonly params?: WorldParams | null;
}

export interface SimAttemptResult {
  readonly status: 'success' | 'failed';
  readonly rawErrorCode: string;
  readonly rawErrorDesc: string;
  /**
   * SIMULATOR GROUND TRUTH: the cause the environment actually applied. Never shown to
   * a policy or to the agent - it exists so metrics can measure how often a policy
   * spent attempts on causes that could never succeed.
   */
  readonly trueClass: FailureClass | null;
}

const SUCCESS: SimAttemptResult = {
  status: 'success',
  rawErrorCode: '',
  rawErrorDesc: '',
  trueClass: null,
};

/** Day-granularity key. Balance is modelled as a per-day fact, not a per-second one. */
function dayKey(ts: Timestamp): string {
  const p = istParts(ts);
  return `${p.year}-${p.month}-${p.day}`;
}

/**
 * Days after the customer's inflow date at which their balance runs down, given the
 * size of the charge. Reliable customers never get there within a cycle; a large
 * recurring charge brings the date forward.
 */
export function depletionOffsetDays(
  customer: Customer,
  amountPaise: number,
  params: WorldParams = DEFAULT_PARAMS,
): number {
  const base =
    params.depletionBaseDays + params.depletionReliabilityScale * Math.pow(customer.reliability, 1.2);
  const amountPressure = Math.min(0.35, (amountPaise / 100_000) * 0.06);
  return base * (1 - amountPressure);
}

/**
 * Is the customer inside a balance-shortfall window on the day of `ts`?
 *
 * Shortfall is modelled as a PERSISTENT STATE that opens partway through the billing
 * cycle and closes at the next inflow - not as an independent coin flip per day. That
 * is the whole reason a fixed daily retry underperforms: T+1 and T+2 land inside the
 * same window that T+0 failed in.
 */
export function inShortfallWindow(
  customer: Customer,
  amountPaise: number,
  ts: Timestamp,
  params: WorldParams = DEFAULT_PARAMS,
): boolean {
  return (
    daysSinceInflow(ts, customer.inflowDay) >= depletionOffsetDays(customer, amountPaise, params)
  );
}

/** Modelled probability the debit fails for want of funds on the day of `ts`. */
export function shortfallProbability(
  customer: Customer,
  amountPaise: number,
  ts: Timestamp,
  params: WorldParams = DEFAULT_PARAMS,
): number {
  return inShortfallWindow(customer, amountPaise, ts, params)
    ? params.shortfallDailyFailureRate
    : params.fundedDailyFailureRate;
}

/** Failure descriptions, kept alongside the codes so the audit trail reads naturally. */
const DESCRIPTIONS: Readonly<Record<FailureClass, string>> = {
  INSUFFICIENT_FUNDS: 'simulated: balance below debit amount',
  BANK_DOWNTIME: 'simulated: destination bank unavailable',
  TECHNICAL_DECLINE: 'simulated: transient processing error',
  MANDATE_REVOKED: 'simulated: mandate revoked by customer',
  MANDATE_EXPIRED: 'simulated: mandate validity ended',
  MANDATE_NOT_ACTIVE: 'simulated: mandate no longer active',
  AMOUNT_EXCEEDS_MANDATE: 'simulated: debit amount above mandate cap',
  CARD_EXPIRED: 'simulated: card past expiry',
  ACCOUNT_CLOSED: 'simulated: account closed',
  ACCOUNT_FROZEN: 'simulated: account frozen',
  RISK_DECLINE: 'simulated: declined by risk engine',
  UNKNOWN: 'simulated: unrecognised rail response',
};

/**
 * Emit the raw code for a decided failure class. With a small probability the simulator
 * returns a code the taxonomy does not know, so the UNKNOWN degradation path and the
 * taxonomy-coverage metric are genuinely exercised rather than assumed.
 *
 * The CAUSE is decided before this function is called and is unaffected by which
 * vocabulary reports it. That separation is what makes the dialect a fair test: an
 * unmapped-dialect cohort and a SIM_-code cohort built on the same seed fail for exactly
 * the same reasons, in exactly the same cases, and differ only in the words on the wire.
 */
function emit(
  cls: FailureClass,
  ctx: SimContext,
  subscriptionId: string,
  attemptNo: number,
): SimAttemptResult {
  const { seed } = ctx;
  const params = paramsOf(ctx);

  const dialect = ctx.dialect ?? null;
  if (dialect !== null) {
    const r = dialect.render(cls, uniform('dialect', seed, subscriptionId, attemptNo));
    return {
      status: 'failed',
      rawErrorCode: r.code,
      rawErrorDesc: r.desc,
      trueClass: cls,
    };
  }

  const unmapped = chanceAt(
    params.unmappedCodeRate,
    'unmapped',
    seed,
    subscriptionId,
    attemptNo,
  );
  if (unmapped) {
    const n = Math.floor(uniform('unmapped_n', seed, subscriptionId, attemptNo) * 900) + 100;
    return {
      status: 'failed',
      rawErrorCode: `SIM_RAILCODE_${n}`,
      rawErrorDesc: 'simulated: rail returned a code this build has never seen',
      trueClass: cls,
    };
  }
  return {
    status: 'failed',
    rawErrorCode: `SIM_${cls}`,
    rawErrorDesc: DESCRIPTIONS[cls],
    trueClass: cls,
  };
}

/**
 * Present one charge to the simulated rail.
 *
 * Causes are checked in order of dominance: a revoked mandate fails regardless of
 * balance, a closed account fails regardless of the bank being up, and so on.
 */
export function attemptCharge(
  ctx: SimContext,
  args: {
    subscription: Subscription;
    mandate: Mandate;
    customer: Customer;
    attemptNo: number;
    at: Timestamp;
  },
): SimAttemptResult {
  const { subscription, mandate, customer, attemptNo, at } = args;
  const { seed } = ctx;
  const params = paramsOf(ctx);
  const sid = subscription.id;

  // --- terminal causes: no retry on this mandate can ever clear them -------------
  if (customer.accountState === 'closed') return emit('ACCOUNT_CLOSED', ctx, sid, attemptNo);
  if (customer.accountState === 'frozen') return emit('ACCOUNT_FROZEN', ctx, sid, attemptNo);
  if (customer.accountState === 'risk_flagged') return emit('RISK_DECLINE', ctx, sid, attemptNo);
  if (mandate.status === 'revoked') return emit('MANDATE_REVOKED', ctx, sid, attemptNo);
  if (mandate.status === 'expired') return emit('MANDATE_EXPIRED', ctx, sid, attemptNo);
  if (mandate.rail === 'card' && mandate.cardExpiresAt !== undefined && at >= mandate.cardExpiresAt) {
    return emit('CARD_EXPIRED', ctx, sid, attemptNo);
  }
  if (subscription.amountPaise > mandate.maxAmountPaise) {
    return emit('AMOUNT_EXCEEDS_MANDATE', ctx, sid, attemptNo);
  }

  // --- transient causes ----------------------------------------------------------
  if (isBankDown(seed, mandate.bankCode, at)) {
    return emit('BANK_DOWNTIME', ctx, sid, attemptNo);
  }

  const technicalRate =
    params.baseTechnicalDeclineRate + bank(mandate.bankCode).extraTechnicalDeclineRate;
  if (chanceAt(technicalRate, 'technical', seed, sid, attemptNo, at)) {
    return emit('TECHNICAL_DECLINE', ctx, sid, attemptNo);
  }

  // Balance is a per-day fact: two attempts on the same day see the same balance, and
  // a shortfall persists until the next inflow. This is why the T+3 policy's second and
  // third retries add so little on liquidity failures.
  const shortfall =
    uniform('funds', seed, customer.id, dayKey(at)) <
    shortfallProbability(customer, subscription.amountPaise, at, params);
  if (shortfall) return emit('INSUFFICIENT_FUNDS', ctx, sid, attemptNo);

  return SUCCESS;
}

/**
 * Did the customer resolve this bill out-of-band on the given day, with no action
 * from us? Deterministic on (seed, subscription, day), so both arms see the identical
 * self-heal event and neither can take credit for it.
 *
 * Not modelled for accounts that are closed, frozen, or risk-declined: there is no
 * plausible mechanism by which those pay themselves.
 */
export function selfHealsOn(
  ctx: SimContext,
  subscriptionId: string,
  customer: Customer,
  ts: Timestamp,
  upliftMultiplier = 1,
): boolean {
  if (customer.accountState !== 'normal') return false;
  const rate = paramsOf(ctx).dailySelfHealRate * customer.reliability * upliftMultiplier;
  // The uniform draw is keyed WITHOUT the multiplier, so notifying raises the threshold
  // against the same underlying draw rather than re-rolling the dice. Otherwise sending
  // a message would be a free extra chance rather than a genuine uplift.
  return uniform('self_heal', ctx.seed, subscriptionId, dayKey(ts)) < Math.min(0.6, rate);
}
