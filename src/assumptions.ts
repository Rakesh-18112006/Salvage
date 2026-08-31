/**
 * SALVAGE - central register of MODELLED ASSUMPTIONS.
 *
 * Spec rule 3: "Every assumption gets stated. Fees, costs, and probabilities that
 * are stand-ins must be named as assumptions in the README, not buried in constants."
 *
 * Every stand-in value in the system lives here, carries a `basis` string, and is
 * printed by `main.ts` on every run. Nothing in this file is a measured figure and
 * nothing in this file is a regulatory fact.
 */

export interface Assumption<T> {
  readonly id: string;
  readonly value: T;
  readonly unit: string;
  readonly basis: string;
}

function a<T>(id: string, value: T, unit: string, basis: string): Assumption<T> {
  return { id, value, unit, basis };
}

/** Cost assumptions. All monetary values in paise. */
export const COST = {
  /**
   * Charged per charge ATTEMPT regardless of outcome. Modelled as a flat fee rather
   * than percentage MDR so that "cost per rupee recovered" isolates attempt volume,
   * which is the behaviour we are trying to change.
   */
  gatewayFeePerAttemptPaise: a(
    'cost.gateway_fee_per_attempt',
    300,
    'paise per ATTEMPT (Rs 3.00)',
    'SYNTHETIC MODELLING PARAMETER. NOT a Razorpay price, not quoted from any published ' +
      'fee schedule, and it must never be presented as one. ' +
      'WHAT IT MODELS: the cost to the business of PRESENTING one recurring charge, ' +
      'charged per ATTEMPT regardless of outcome - a failed presentment is modelled as ' +
      'costing the same as a successful one. ' +
      'WHY PER ATTEMPT: the behaviour this project is trying to change is attempt ' +
      'VOLUME, so the cost metric has to move with attempt count. A percentage MDR ' +
      'charged only on success would make a policy that burns four doomed attempts look ' +
      'free, which is the exact failure mode being measured. ' +
      'TAXES: excluded. No GST or any other tax is modelled. ' +
      'RAIL: a single flat figure across UPI Autopay, eNACH and card. Real pricing ' +
      'differs by instrument; modelling one number keeps the comparison about POLICY ' +
      'rather than about instrument mix, since both arms face the identical mix. ' +
      'WHY IT IS FINE FOR A PROTOTYPE: the metric it feeds (gateway cost per rupee ' +
      'recovered) is a RATIO between two arms that share this constant, so the ' +
      'comparison is invariant to its exact value - halving it halves both arms and ' +
      'leaves the -47.8% difference unchanged. Only the absolute paise figure depends ' +
      'on it, and that figure is never presented as a real cost. ' +
      'To use a real price: replace this value, cite the Razorpay pricing page and the ' +
      'date accessed, and re-run. Nothing else changes.',
  ),

  /**
   * Modelled cost of consuming one unit of customer patience (one outbound contact).
   * Not a cash cost - it is the price we put on annoyance so the agent cannot spam.
   */
  contactPatiencePaise: a(
    'cost.contact_patience',
    1500,
    'paise',
    'STAND-IN. There is no invoice for customer annoyance. Priced at 5x a gateway ' +
      'fee so that messaging is never the cheap default. Sensitivity to this value ' +
      'should be reported, not hidden.',
  ),

  /**
   * Cost of asking the customer to complete a flow themselves (re-mandate,
   * payment link, instrument update). Higher than a notification: it can fail silently.
   */
  customerFrictionPaise: a(
    'cost.customer_friction',
    4000,
    'paise',
    'STAND-IN. Priced above a contact because these paths ask for effort and have ' +
      'a real abandonment rate.',
  ),

  /**
   * Opportunity cost of money arriving late, per rupee per day. Applied to the
   * amount recovered, over the delay from the original charge date.
   */
  floatCostPerRupeePerDay: a(
    'cost.float_per_rupee_per_day',
    0.0004,
    'rupees per rupee per day',
    'STAND-IN. Approximately 14.6% annualised, used only to make DEFER and ' +
      'TIME_SHIFT carry a non-zero price so the agent cannot delay for free.',
  ),

  /** Modelled cost of routing a case to a human operator. */
  humanHandoffPaise: a(
    'cost.human_handoff',
    25000,
    'paise',
    'STAND-IN for a few minutes of an operations agent. Set high so ESCALATE_HUMAN ' +
      'is reserved for genuinely terminal, non-automatable cases.',
  ),
} as const;

/** Simulator behaviour assumptions. See src/sim/ - all of this is SIMULATED. */
export const SIM = {
  caseHorizonDays: a(
    'sim.case_horizon_days',
    14,
    'days',
    'A recovery case is abandoned as EXHAUSTED 14 days after the opening failure. ' +
      'Chosen to comfortably contain the T+3 control policy while leaving room for ' +
      'time-shifting to the next salary inflow.',
  ),
  baseTechnicalDeclineRate: a(
    'sim.base_technical_decline_rate',
    0.015,
    'probability per attempt',
    'STAND-IN. Transient gateway/issuer noise, independent of funds or mandate state. ' +
      'Per-bank surcharges are added on top - see src/sim/banks.ts.',
  ),
  shortfallDailyFailureRate: a(
    'sim.shortfall_daily_failure_rate',
    0.85,
    'probability per day while in a shortfall window',
    'A balance shortfall PERSISTS - it is not re-rolled independently each day. This ' +
      'is the single most consequential modelling choice in the simulator: it is why ' +
      'retrying tomorrow mostly fails and time-shifting to the inflow date mostly ' +
      'works. If balances were independent day to day, the fixed T+3 policy would ' +
      'already be near-optimal and this whole project would have no thesis. Stated ' +
      'openly so the choice can be challenged.',
  ),
  fundedDailyFailureRate: a(
    'sim.funded_daily_failure_rate',
    0.012,
    'probability per day outside a shortfall window',
    'Residual chance a normally-funded account is short on a given day (an unexpected ' +
      'debit landed first).',
  ),
  unmappedCodeRate: a(
    'sim.unmapped_code_rate',
    0.02,
    'probability per failed attempt',
    'The simulator deliberately emits a code the taxonomy does not know, so the ' +
      'UNKNOWN degradation path and the taxonomy-coverage metric are actually exercised.',
  ),
  remandateCompletionBase: a(
    'sim.remandate_completion_base',
    0.10,
    'probability a re-mandate link is completed',
    'STAND-IN, and the one that most flatters the agent, so it is set conservatively. ' +
      'Scaled up by reliability and tenure, it yields completion of roughly 23% for a ' +
      'weak two-month customer to 46% for a strong four-year one. An earlier draft ' +
      'produced 48-91%, which made re-authorisation nearly free money and inflated the ' +
      "agent's win; that was a calibration error, not a result. This is the ONLY route " +
      'by which a revoked or expired mandate can be recovered, so it alone decides how ' +
      'much of the terminal third is winnable at all - it deserves challenge.',
  ),
  paymentLinkCompletionBase: a(
    'sim.payment_link_completion_base',
    0.16,
    'probability a one-off payment link is paid',
    'STAND-IN. Slightly higher than re-mandate: paying once is a smaller ask than ' +
      're-authorising a standing instruction.',
  ),
  customerActionMedianHours: a(
    'sim.customer_action_median_hours',
    26,
    'hours',
    'STAND-IN. Median delay between sending a link and the customer acting on it. ' +
      'Customers who act at all mostly do so within a day or two.',
  ),
  notifyUpliftOnSelfHeal: a(
    'sim.notify_uplift_on_self_heal',
    1.9,
    'multiplier on daily self-heal probability',
    'STAND-IN. A customer who has been TOLD the payment failed is likelier to fix it ' +
      'themselves than one who has not. Modelled as a multiplier so NOTIFY has a real ' +
      'benefit to weigh against its patience cost, rather than being free or useless.',
  ),
  dailySelfHealRate: a(
    'sim.daily_self_heal_probability',
    0.035,
    'probability per day',
    'STAND-IN. Chance a customer resolves the bill out-of-band on a given day with ' +
      'no intervention from us. This is what makes WAIT a real option in Phase 3. ' +
      'Applied identically to both arms.',
  ),
} as const;

export const ALL_ASSUMPTIONS: ReadonlyArray<Assumption<unknown>> = [
  ...Object.values(COST),
  ...Object.values(SIM),
];
