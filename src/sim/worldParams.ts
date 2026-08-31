/**
 * ############################  SIMULATOR  ############################
 * The numbers that describe HOW THE WORLD BEHAVES, gathered into one injectable bag.
 * SIMULATED. Nothing here is measured from live traffic.
 * #####################################################################
 *
 * WHY THESE ARE INJECTED RATHER THAN READ FROM `assumptions.ts` DIRECTLY
 * ---------------------------------------------------------------------
 * The sharpest objection to this whole project is circularity: we wrote the simulator
 * AND we wrote the policy, so the policy's beliefs about the world and the world's
 * actual behaviour come from the same constants. `believedSelfHeal` in
 * src/agent/costModel.ts literally reads `SIM.dailySelfHealRate.value` - the agent
 * knows the true self-heal rate because it is the same variable. An agent that is
 * right about the world by construction is not evidence of anything.
 *
 * Splitting the world's parameters out into this bag is what makes the answer
 * measurable rather than rhetorical. The SIMULATOR reads these; the AGENT still reads
 * `assumptions.ts`. Perturb the bag and the agent's beliefs become WRONG - which is the
 * situation any real deployment is permanently in - and `node src/robustness.ts` reports
 * how much of the lift survives that.
 *
 * DEFAULT_WORLD_PARAMS reproduces `assumptions.ts` exactly, so every existing number in
 * this project is unchanged by the existence of this file.
 */
import { SIM } from '../assumptions.ts';

export interface WorldParams {
  /** Chance a debit fails for want of funds on a day INSIDE a shortfall window. */
  readonly shortfallDailyFailureRate: number;
  /** Chance a normally-funded account is nonetheless short on a given day. */
  readonly fundedDailyFailureRate: number;
  readonly baseTechnicalDeclineRate: number;
  readonly unmappedCodeRate: number;
  readonly dailySelfHealRate: number;
  /**
   * The payday model, as `depletionBaseDays + depletionReliabilityScale * reliability^1.2`
   * days after the inflow before a balance runs down.
   *
   * Broken out because TIME_SHIFT_TO_INFLOW is the agent's signature move and this is
   * the assumption it rests on. If the world's paydays do not work the way the agent
   * believes, time-shifting is worth much less, and that should show up as a number
   * rather than as a footnote.
   */
  readonly depletionBaseDays: number;
  readonly depletionReliabilityScale: number;
  readonly remandateCompletionBase: number;
  readonly paymentLinkCompletionBase: number;
  readonly customerActionMedianHours: number;
  readonly notifyUpliftOnSelfHeal: number;
}

/**
 * The world as `assumptions.ts` describes it. Every entrypoint other than
 * `src/robustness.ts` uses exactly this, so no published figure moves.
 */
export const DEFAULT_WORLD_PARAMS: WorldParams = {
  shortfallDailyFailureRate: SIM.shortfallDailyFailureRate.value,
  fundedDailyFailureRate: SIM.fundedDailyFailureRate.value,
  baseTechnicalDeclineRate: SIM.baseTechnicalDeclineRate.value,
  unmappedCodeRate: SIM.unmappedCodeRate.value,
  dailySelfHealRate: SIM.dailySelfHealRate.value,
  // The literals the depletion formula carried before it was parameterised.
  depletionBaseDays: 5,
  depletionReliabilityScale: 60,
  remandateCompletionBase: SIM.remandateCompletionBase.value,
  paymentLinkCompletionBase: SIM.paymentLinkCompletionBase.value,
  customerActionMedianHours: SIM.customerActionMedianHours.value,
  notifyUpliftOnSelfHeal: SIM.notifyUpliftOnSelfHeal.value,
};

/** Resolve the params for a context that may not carry any. */
export const paramsOf = (ctx: { readonly params?: WorldParams | null }): WorldParams =>
  ctx.params ?? DEFAULT_WORLD_PARAMS;
