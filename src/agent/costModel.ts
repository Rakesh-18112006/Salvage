/**
 * The cost model (spec section 7).
 *
 *     EV(bundle) = P(success | bundle, context) x amount - sum(cost(actions))
 *     compared against EV(WAIT) = P(self-heal) x amount - 0
 *
 * ALL OF THIS IS DETERMINISTIC CODE, and that is the point. Spec rule 2 forbids putting
 * arithmetic in a language model, and expected-value arithmetic is the clearest possible
 * case: a model asked to multiply a probability by an amount and subtract a fee will
 * sometimes get it wrong, will not be reproducible, and cannot be audited. The model's
 * job is to supply the DIAGNOSIS and the STRATEGY; the comparison of strategies happens
 * here, in code anyone can read and step through.
 *
 * The success probabilities below are the agent's BELIEFS about the world, not the
 * simulator's internals. They are deliberately written from what an operator could
 * plausibly know, and they are approximations - if they were the simulator's true
 * parameters the agent would be reading the answer key.
 */
import type { Action, ActionBundle, CaseView } from '../domain/types.ts';
import { isTerminal, type FailureClass } from '../domain/taxonomy.ts';
import { COST, SIM } from '../assumptions.ts';
import { HOUR_MS } from '../sim/clock.ts';
import type { PaymentHistory } from './tools.ts';

/** Modelled cost of a single action, in paise. */
export function actionCost(action: Action, amountPaise: number): number {
  const delayDays = action.delayHours / 24;
  const floatCost = Math.round(
    (amountPaise / 100) * COST.floatCostPerRupeePerDay.value * delayDays * 100,
  );

  switch (action.kind) {
    case 'RETRY_NOW':
    case 'DEFER':
    case 'TIME_SHIFT':
      return COST.gatewayFeePerAttemptPaise.value + floatCost;
    case 'NOTIFY':
      return COST.contactPatiencePaise.value;
    case 'REMANDATE':
    case 'PAYMENT_LINK':
      // A customer-action path costs friction AND a contact to tell them about it.
      return COST.customerFrictionPaise.value + COST.contactPatiencePaise.value;
    case 'ESCALATE_HUMAN':
      return COST.humanHandoffPaise.value;
    case 'WAIT':
      return floatCost;
    case 'STOP':
      return 0;
  }
}

export function bundleCost(actions: ReadonlyArray<Action>, amountPaise: number): number {
  return actions.reduce((sum, a) => sum + actionCost(a, amountPaise), 0);
}

/**
 * Believed probability that a charge presented `delayHours` from now succeeds.
 *
 * The shape encodes the operator-visible logic the whole project rests on: a liquidity
 * failure retried tomorrow is mostly the same failure, while the same charge presented
 * after the customer's inflow is a different proposition.
 */
export function believedChargeSuccess(
  failureClass: FailureClass,
  history: PaymentHistory,
  delayHours: number,
  bankDegraded: boolean,
): number {
  if (isTerminal(failureClass)) return 0; // by definition; the taxonomy is authoritative

  const daysOut = delayHours / 24;
  let p: number;

  switch (failureClass) {
    case 'INSUFFICIENT_FUNDS': {
      // Crossing the inflow date is what matters, not the number of days waited.
      const crossesInflow = daysOut >= history.daysUntilNextInflow;
      p = crossesInflow ? 0.78 : 0.16;
      if (history.reliabilityBand === 'strong') p += 0.08;
      if (history.reliabilityBand === 'weak') p -= 0.06;
      break;
    }
    case 'BANK_DOWNTIME':
      // Maintenance windows end. Waiting past one is usually enough.
      p = delayHours >= 6 ? 0.82 : 0.35;
      break;
    case 'TECHNICAL_DECLINE':
      p = 0.74;
      break;
    case 'UNKNOWN':
      // Unclassified failures are not charged at all (the gate refuses them), so the
      // believed success of charging one is zero rather than a guess.
      p = 0;
      break;
    default:
      p = 0.4;
  }

  if (bankDegraded && delayHours < 6) p *= 0.45;
  return Math.min(0.95, Math.max(0.01, p));
}

/** Believed probability the customer completes a re-mandate or payment link in time. */
export function believedCustomerAction(
  kind: 'REMANDATE' | 'PAYMENT_LINK',
  history: PaymentHistory,
  hoursLeftInHorizon: number,
): number {
  let p = kind === 'REMANDATE' ? 0.30 : 0.36;
  if (history.reliabilityBand === 'strong') p += 0.12;
  if (history.reliabilityBand === 'weak') p -= 0.08;
  if (history.tenureMonths >= 12) p += 0.08;
  if (history.tenureMonths <= 3) p -= 0.05;
  // Asking someone to act with six hours left in the case is not really asking.
  const timeFactor = Math.min(1, hoursLeftInHorizon / 72);
  return Math.min(0.9, Math.max(0.01, p * timeFactor));
}

/**
 * Believed probability the case resolves itself with no intervention at all.
 * This is the number WAIT has to beat, and the reason WAIT can win.
 */
export function believedSelfHeal(
  view: CaseView,
  history: PaymentHistory,
  hoursAhead: number,
): number {
  // Both operands of the min must be HOURS. An earlier version compared `hoursAhead`
  // against `horizonEndsAt - now` in MILLISECONDS and then divided the winner by
  // HOUR_MS: the millisecond figure was always the larger, so the min always returned
  // hoursAhead, which was then treated as milliseconds. The function returned about
  // 3e-8 for every case in the cohort - EV(WAIT) was structurally zero everywhere it
  // appeared in the audit trail. No decision depended on it (strategies are chosen by
  // the model or by fallbackDecision, never by comparing EVs), so no published recovery
  // figure moves; what was wrong was the number shown to anyone reading a case.
  const hoursLeftInHorizon = (view.horizonEndsAt - view.now) / HOUR_MS;
  const days = Math.max(0, Math.min(hoursAhead, hoursLeftInHorizon) / 24);
  let daily = SIM.dailySelfHealRate.value;
  if (history.reliabilityBand === 'strong') daily *= 1.4;
  if (history.reliabilityBand === 'weak') daily *= 0.6;
  if (view.contactsUsed > 0) daily *= 1.5; // they have been told
  return 1 - Math.pow(1 - daily, days);
}

export interface EvaluatedBundle {
  readonly bundle: ActionBundle;
  readonly successProbability: number;
  readonly costPaise: number;
  readonly expectedValuePaise: number;
}

/** EV of a bundle: probability-weighted recovery, net of every action's cost. */
export function evaluateBundle(
  bundle: ActionBundle,
  amountPaise: number,
  successProbability: number,
): EvaluatedBundle {
  const costPaise = bundleCost(bundle.actions, amountPaise);
  return {
    bundle,
    successProbability,
    costPaise,
    expectedValuePaise: Math.round(successProbability * amountPaise - costPaise),
  };
}

/** Pick the highest-EV bundle. Ties break toward the cheaper option. */
export function bestByExpectedValue(
  candidates: ReadonlyArray<EvaluatedBundle>,
): EvaluatedBundle {
  if (candidates.length === 0) throw new Error('no candidate bundles to choose between');
  return candidates.reduce((best, c) => {
    if (c.expectedValuePaise !== best.expectedValuePaise) {
      return c.expectedValuePaise > best.expectedValuePaise ? c : best;
    }
    return c.costPaise < best.costPaise ? c : best;
  });
}
