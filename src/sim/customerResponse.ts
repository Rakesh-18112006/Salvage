/**
 * ############################  SIMULATOR  ############################
 * Models how a customer responds to being asked to do something: complete a fresh
 * mandate, pay a one-off link, or simply be told the payment failed.
 * SIMULATED. No real customer behaviour is measured here.
 * #####################################################################
 *
 * This module is what gives the agent a lever the fixed T+3 policy does not have.
 * A revoked mandate cannot be recovered by any retry - it can only be recovered by
 * asking the customer to re-authorise. Without a response model, REMANDATE would be a
 * button that does nothing and the terminal third of the cohort would be unwinnable by
 * construction, which would rig the comparison in our favour by making the agent's
 * distinctive actions free and ineffective.
 *
 * Every draw is order-independent (see src/sim/rng.ts) so the control arm and the agent
 * arm face the same customers behaving the same way.
 */
import type { Customer, Timestamp } from '../domain/types.ts';
import { HOUR_MS } from './clock.ts';
import { uniform } from './rng.ts';
import { DEFAULT_WORLD_PARAMS, type WorldParams } from './worldParams.ts';

export type CustomerAskKind = 'REMANDATE' | 'PAYMENT_LINK';

export interface CustomerResponse {
  /** Did the customer complete the requested action at all? */
  readonly completed: boolean;
  /** When they completed it. Null when they never did. */
  readonly completedAt: Timestamp | null;
}

/**
 * Probability the customer completes the ask.
 *
 * Reliability and tenure both raise it: a customer of two years who has always paid is
 * likelier to re-authorise than one of two months who has not. This is the relationship
 * the agent is expected to reason about - "failed twice this cycle but paid on time for
 * fourteen months" is one of the spec's named judgment scenarios.
 */
export function completionProbability(
  kind: CustomerAskKind,
  customer: Customer,
  amountPaise: number,
  params: WorldParams = DEFAULT_WORLD_PARAMS,
): number {
  const base =
    kind === 'REMANDATE' ? params.remandateCompletionBase : params.paymentLinkCompletionBase;

  const reliabilityLift = 0.26 * customer.reliability;
  const tenureLift = Math.min(0.12, Math.log1p(customer.tenureMonths) / 18);
  // A larger ask is completed less often.
  const amountDrag = Math.min(0.15, (amountPaise / 100_000) * 0.02);

  return Math.min(0.60, Math.max(0.02, base + reliabilityLift + tenureLift - amountDrag));
}

/**
 * Simulate the customer's response to an ask sent at `sentAt`.
 *
 * `sequence` distinguishes a second ask from the first, so re-sending a link is not
 * simply a fresh independent coin flip - a customer who ignored the first one is drawn
 * from the same underlying disposition.
 */
export function respondToAsk(
  ctx: { readonly seed: string; readonly params?: WorldParams | null },
  kind: CustomerAskKind,
  customer: Customer,
  subscriptionId: string,
  amountPaise: number,
  sentAt: Timestamp,
  sequence: number,
  deadline: Timestamp,
): CustomerResponse {
  const { seed } = ctx;
  const params = ctx.params ?? DEFAULT_WORLD_PARAMS;

  if (customer.accountState !== 'normal') {
    // A closed, frozen, or risk-flagged account cannot complete an authorisation.
    return { completed: false, completedAt: null };
  }

  const p = completionProbability(kind, customer, amountPaise, params);

  // The disposition draw is keyed WITHOUT the sequence number: a customer who was never
  // going to act does not become willing because we asked again. Only the timing is
  // re-drawn, which is why a second ask still has some value - it can land inside the
  // horizon when the first one's delay did not.
  const willAct = uniform('ask_disposition', seed, kind, subscriptionId) < p;
  if (!willAct) return { completed: false, completedAt: null };

  // Delay: exponential-ish around the median, re-drawn per ask.
  const u = uniform('ask_delay', seed, kind, subscriptionId, sequence);
  const delayHours = -Math.log(1 - Math.min(0.999, u)) * params.customerActionMedianHours * 1.4427;
  const completedAt = sentAt + Math.round(delayHours) * HOUR_MS;

  if (completedAt > deadline) return { completed: false, completedAt: null };
  return { completed: true, completedAt };
}

/**
 * Multiplier applied to the daily self-heal probability once the customer has been
 * told the payment failed. This is the entire benefit of a bare NOTIFY, and it is what
 * the agent has to weigh against the patience cost of sending one.
 */
export function selfHealMultiplierAfterNotify(
  contactsSent: number,
  params: WorldParams = DEFAULT_WORLD_PARAMS,
): number {
  if (contactsSent <= 0) return 1;
  // Diminishing returns: the second message is worth much less than the first. Without
  // this, spamming would be a winning strategy and the patience cost would be the only
  // thing holding it back.
  const uplift = params.notifyUpliftOnSelfHeal - 1;
  return 1 + uplift / (1 + 0.9 * (contactsSent - 1));
}
