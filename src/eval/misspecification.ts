/**
 * MISSPECIFIED WORLDS: what survives when our beliefs about the world are wrong?
 *
 * THE OBJECTION THIS ANSWERS
 * --------------------------
 * We wrote the simulator and we wrote the policy. If the policy's beliefs and the
 * world's behaviour come from the same constants, then the policy is right about the
 * world by construction and its performance is a tautology dressed as a result. This is
 * not a hypothetical criticism of this codebase - it is literally true of one function:
 * `believedSelfHeal` in src/agent/costModel.ts reads `SIM.dailySelfHealRate.value`, the
 * same variable the simulator reads.
 *
 * Every real deployment is permanently in the opposite situation. Its beliefs are
 * approximations, fitted once and then drifting. So the useful question is not "does the
 * policy win in the world it was written for" but "how wrong can the world be before the
 * policy stops helping".
 *
 * HOW THE SPLIT WORKS
 * -------------------
 * `src/sim/worldParams.ts` gives the SIMULATOR its own copy of the behavioural numbers.
 * The AGENT still reads `src/assumptions.ts`. Perturbing a scenario below therefore
 * changes the world and leaves the agent's beliefs stale - which is the point. The agent
 * is not told, and cannot be told; it has no access to these values.
 *
 * WHY THESE SCENARIOS AND NOT OTHERS
 * ----------------------------------
 * Each one falsifies a specific belief the system leans on, and the most important is
 * `shortfall-transient`. The assumptions file says of the persistence of balance
 * shortfalls: "If balances were independent day to day, the fixed T+3 policy would
 * already be near-optimal and this whole project would have no thesis." That sentence is
 * an invitation to test it. `shortfall-transient` is that test, and the result is
 * reported whichever way it comes out.
 *
 * The perturbation SIZES are deliberate: each is large enough to matter and small enough
 * to be a world someone could plausibly be operating in. They are not tuned to produce a
 * survivable answer, and `all-adverse` exists precisely so nobody has to take that on
 * trust - it moves every dial against us at once.
 */
import { DEFAULT_WORLD_PARAMS, type WorldParams } from '../sim/worldParams.ts';

export interface Scenario {
  readonly name: string;
  /** The belief this scenario falsifies, in one line. Printed beside every result. */
  readonly falsifies: string;
  readonly params: WorldParams;
}

const D = DEFAULT_WORLD_PARAMS;
const of = (over: Partial<WorldParams>): WorldParams => ({ ...D, ...over });

/** Balance shortfalls that clear on their own, day to day. */
const TRANSIENT_SHORTFALL = 0.35;
/** Accounts that run down far sooner after payday than we model. */
const EARLY_DEPLETION = { depletionBaseDays: 0, depletionReliabilityScale: 30 };

export const SCENARIOS: ReadonlyArray<Scenario> = [
  {
    name: 'baseline',
    falsifies: 'nothing - the world exactly as assumptions.ts describes it',
    params: D,
  },
  {
    name: 'shortfall-transient',
    falsifies:
      'THE CENTRAL CLAIM. Shortfalls persist until the next inflow. Here they mostly ' +
      'clear on their own, so retrying tomorrow often works and T+3 should catch up',
    params: of({ shortfallDailyFailureRate: TRANSIENT_SHORTFALL }),
  },
  {
    name: 'payday-earlier',
    falsifies:
      "the payday model. Accounts run down almost immediately, so the agent's " +
      'time-shift target is systematically the wrong date',
    params: of(EARLY_DEPLETION),
  },
  {
    name: 'payday-later',
    falsifies:
      'the payday model in the other direction. Accounts stay funded far longer, so ' +
      'shortfalls are rarer and time-shifting is mostly unnecessary',
    params: of({ depletionReliabilityScale: 90 }),
  },
  {
    name: 'self-heal-doubled',
    falsifies:
      'the self-heal rate the agent reads directly. Customers fix things themselves ' +
      'twice as often as it believes, so WAIT is worth more than it thinks',
    params: of({ dailySelfHealRate: D.dailySelfHealRate * 2 }),
  },
  {
    name: 'self-heal-halved',
    falsifies:
      'the same number the other way. WAIT and NOTIFY are worth half what the agent ' +
      'believes, so patience is punished',
    params: of({ dailySelfHealRate: D.dailySelfHealRate / 2 }),
  },
  {
    name: 'remandate-half',
    falsifies:
      "the agent's distinctive actions. Half as many customers complete a " +
      're-authorisation or pay a link as it believes; the retry-only arms are unaffected',
    params: of({
      remandateCompletionBase: D.remandateCompletionBase / 2,
      paymentLinkCompletionBase: D.paymentLinkCompletionBase / 2,
    }),
  },
  {
    name: 'slow-customers',
    // First written as 72h and measured as a no-op: against a 14-day (336h) horizon a
    // 72h median still lands almost every completion inside the case, 90 of 300 against
    // a baseline of 93. Ten days is the perturbation that actually bites - 41 of 300 -
    // and a scenario that does not move the number is not a test of anything.
    falsifies:
      'how fast customers act. A median of TEN DAYS rather than one, so most links and ' +
      're-mandates land after the case has already been abandoned',
    params: of({ customerActionMedianHours: 240 }),
  },
  {
    name: 'notify-useless',
    falsifies:
      'the benefit of telling a customer. Here a notification changes nothing at all, ' +
      'so its patience cost buys precisely zero. NOTE: no effect on the DETERMINISTIC ' +
      'arm, which never sends a bare notification - its strategy mix contains no ' +
      'NOTIFY_ONLY at all. Kept because that is worth knowing and worth printing',
    params: of({ notifyUpliftOnSelfHeal: 1.0 }),
  },
  {
    name: 'noisy-rails',
    falsifies:
      'rail reliability. Four times the transient decline rate, so charges fail for ' +
      'reasons no policy can diagnose or avoid',
    params: of({ baseTechnicalDeclineRate: D.baseTechnicalDeclineRate * 4 }),
  },
  {
    name: 'all-adverse',
    // Note carefully what "adverse" means here. Every dial is moved against OUR THESIS,
    // which is not the same as making recovery harder. A world of transient shortfalls
    // and immediate depletion is a world where blind daily retry works well - so the
    // fixed T+3 arm gets BETTER here, not worse, and that is exactly why it is the
    // hardest test. The danger to this project was never a hostile world; it was a world
    // in which the problem we set out to solve does not exist.
    falsifies:
      'EVERY assumption at once, each in the direction that hurts our thesis. This is ' +
      'not a harder world - it is a world where daily retry WORKS, so T+3 improves and ' +
      'the case for doing anything cleverer weakens. The hardest test there is',
    params: of({
      shortfallDailyFailureRate: TRANSIENT_SHORTFALL,
      ...EARLY_DEPLETION,
      dailySelfHealRate: D.dailySelfHealRate / 2,
      remandateCompletionBase: D.remandateCompletionBase / 2,
      paymentLinkCompletionBase: D.paymentLinkCompletionBase / 2,
      customerActionMedianHours: 240,
      notifyUpliftOnSelfHeal: 1.0,
      baseTechnicalDeclineRate: D.baseTechnicalDeclineRate * 4,
    }),
  },
];

export const scenarioByName = (name: string): Scenario => {
  const s = SCENARIOS.find((x) => x.name === name);
  if (s === undefined) {
    throw new Error(
      `unknown scenario "${name}". Known: ${SCENARIOS.map((x) => x.name).join(', ')}`,
    );
  }
  return s;
};
