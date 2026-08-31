/**
 * THE ABLATION LADDER: where does the twenty points actually come from?
 *
 * "You beat a fixed T+3 retry" is a weak claim on its own, because T+3 is a default
 * rather than a competitor. Any serious reader's next question is the right one:
 *
 *     Isn't this just smart retry? A dunning tool that stops retrying dead mandates
 *     would get most of this, and it needs no agent, no cost model, and no LLM.
 *
 * That question deserves a number, not an argument. So instead of one baseline there are
 * four arms, each adding exactly ONE capability to the one before it:
 *
 *   1. FIXED T+3            uses nothing. Retries on a calendar, three times.
 *   2. CLASS-AWARE RETRY    + knows WHY it failed. Refuses to spend attempts on a cause
 *                             no retry can clear. Still retries on the same calendar.
 *   3. CLASS-AWARE + TIMING + knows WHEN the customer is paid. Presents after the inflow
 *                             instead of grinding daily into an empty account.
 *   4. SALVAGE              + the other six actions: re-mandate, payment link, notify,
 *                             defer, escalate, wait.
 *
 * Arms 2 and 3 are in this file. They are deliberately GOOD - a fair reading of what a
 * competent retry scheduler does, not a strawman built to lose.
 *
 * WHAT RUNNING ARM 2 ACTUALLY ESTABLISHED
 * --------------------------------------
 * Arm 2 was written expecting it to capture a chunk of the lift. It captures NONE - it
 * is bit-identical to fixed T+3 on recovery, on attempts, and on cost. That is not a bug
 * and it is the most useful thing in this file, because of WHY:
 *
 *     The policy gate already enforces it, for every arm, including the control.
 *
 * Run the control arm and read its rule counts: TERMINAL_CLASS_NO_CHARGE fires 99 times
 * and UNKNOWN_FAILURE_NOT_RETRYABLE 9 times on a 300-case cohort. The fixed T+3 policy
 * proposes those retries and the gate refuses them. Terminal cases receive exactly one
 * attempt each - the opening charge that created the case - in both arms.
 *
 * So the honest answer to "isn't this just smart retry?" is not that we beat smart
 * retry. It is that OUR BASELINE ALREADY IS SMART RETRY, because the gate applies to
 * both arms and we never disabled it to flatter ourselves. Arm 2 is the proof: writing
 * the same discipline into the policy instead of the gate changes nothing at all.
 *
 * It is kept, and kept passing, precisely so that claim is a measurement rather than an
 * assurance.
 *
 * WHAT THEY DELIBERATELY DO NOT DO
 * --------------------------------
 * Both are RETRY SCHEDULERS. Their entire action space is {retry, stop}. They never
 * re-mandate, never send a link, never notify, never escalate. That is not a handicap
 * invented for this comparison - it is the definition of the category. A tool that
 * re-authorises mandates and messages customers is not a retry scheduler, it is arm 4,
 * and lumping the two together is what makes "isn't this just smart retry?" unanswerable.
 *
 * Neither consults a cost model, an expected value, a customer's tenure, or a bank's
 * health. Those belong to arm 4 and their contribution is exactly what the ladder is
 * built to isolate.
 */
import type { ActionBundle, CaseView, RecoveryPolicy } from '../domain/types.ts';
import { isTerminal } from '../domain/taxonomy.ts';
import { DAY_MS, HOUR_MS, istParts, nextIstDayOfMonth } from '../sim/clock.ts';
import type { World } from '../sim/population.ts';
import { T3_RETRY_COUNT } from './controlT3.ts';

/** Attempts these arms will spend, matching the control arm's budget exactly. */
const RETRY_BUDGET = T3_RETRY_COUNT;

function stop(view: CaseView, reason: string, rationale: string): ActionBundle {
  return {
    actions: [{ kind: 'STOP', delayHours: 0, reason }],
    diagnosis: view.lastFailureClass,
    confidence: 1,
    rationale,
  };
}

/**
 * ARM 2 - class-aware retry.
 *
 * The single capability added over fixed T+3: it reads the failure class and declines to
 * present a charge that cannot succeed. Everything else - the schedule, the budget, the
 * absence of any other action - is identical to the control arm.
 *
 * MEASURED RESULT: identical to fixed T+3 on every metric. The policy gate already
 * refuses those retries for the control arm too (TERMINAL_CLASS_NO_CHARGE, 99 firings
 * per 300 cases), so moving the same rule into the policy changes nothing. This arm
 * exists to demonstrate that, not to win. See the file header.
 */
export class ClassAwareRetryPolicy implements RecoveryPolicy {
  readonly name = 'class-aware-retry';
  readonly arm = 'control' as const;

  decide(view: CaseView): ActionBundle {
    const cls = view.lastFailureClass;
    const retriesUsed = view.attempts.length - 1;

    // The whole point of the arm. A revoked mandate, a dead card, a closed account: no
    // retry on this mandate can ever clear them, so every attempt spent there is a
    // guaranteed loss that still costs a fee.
    if (isTerminal(cls)) {
      return stop(
        view,
        `${cls} is terminal; no retry can clear it`,
        `Class-aware retry: diagnosed ${cls}, which no retry can clear. Stopping instead ` +
          'of spending the remaining budget. This arm cannot re-authorise or send a ' +
          'link, so stopping is the whole of what it can do about it.',
      );
    }

    // The same discipline the rest of the system applies: we do not know why this
    // failed, so we do not charge the customer again on the strength of a guess.
    if (cls === 'UNKNOWN') {
      return stop(
        view,
        'unclassified failure is never automatically retried',
        'Class-aware retry: the rail response did not map to a known class, and an ' +
          'unrecognised failure is never automatically retried.',
      );
    }

    if (retriesUsed >= RETRY_BUDGET) {
      return stop(
        view,
        `retry budget of ${RETRY_BUDGET} spent`,
        `Class-aware retry: budget spent after ${RETRY_BUDGET} retries.`,
      );
    }

    const nextRetryNo = retriesUsed + 1;
    const scheduledAt = view.openedAt + nextRetryNo * DAY_MS;
    return {
      actions: [
        {
          kind: 'RETRY_NOW',
          delayHours: Math.max(0, (scheduledAt - view.now) / HOUR_MS),
          reason: `class-aware: ${cls} is retryable; retry ${nextRetryNo} of ${RETRY_BUDGET}`,
        },
      ],
      diagnosis: cls,
      confidence: 1,
      rationale:
        `Class-aware retry: ${cls} is not terminal, so a retry can in principle succeed. ` +
        `Scheduled on the same daily calendar as the control arm - this arm knows WHY ` +
        'the charge failed but nothing about WHEN the customer has money.',
    };
  }
}

/**
 * ARM 3 - class-aware retry, timed to the customer's inflow.
 *
 * One capability added over arm 2: for a balance shortfall it presents the charge after
 * the customer's next inflow instead of the next morning. Everything else is unchanged.
 *
 * This is the arm that tests the project's central modelling claim on its own. A balance
 * shortfall PERSISTS until money arrives (src/assumptions.ts,
 * `sim.shortfall_daily_failure_rate`), so retrying tomorrow mostly meets the same empty
 * account. If that claim is doing the work, arm 3 should be well clear of arm 2, and the
 * gap between them is the price of not knowing when payday is.
 *
 * It still cannot re-mandate, link, notify, or escalate. The terminal third of the cohort
 * remains unwinnable for it, exactly as for arm 2.
 */
export class InflowTimedRetryPolicy implements RecoveryPolicy {
  readonly name = 'class-aware-retry+inflow-timing';
  readonly arm = 'control' as const;

  private readonly world: World;

  constructor(world: World) {
    this.world = world;
  }

  decide(view: CaseView): ActionBundle {
    const cls = view.lastFailureClass;
    const retriesUsed = view.attempts.length - 1;

    if (isTerminal(cls)) {
      return stop(
        view,
        `${cls} is terminal; no retry can clear it`,
        `Inflow-timed retry: diagnosed ${cls}, which no retry can clear.`,
      );
    }
    if (cls === 'UNKNOWN') {
      return stop(
        view,
        'unclassified failure is never automatically retried',
        'Inflow-timed retry: unrecognised rail response; never auto-retried.',
      );
    }
    if (retriesUsed >= RETRY_BUDGET) {
      return stop(
        view,
        `retry budget of ${RETRY_BUDGET} spent`,
        `Inflow-timed retry: budget spent after ${RETRY_BUDGET} retries.`,
      );
    }

    const nextRetryNo = retriesUsed + 1;
    const hoursLeft = Math.max(0, (view.horizonEndsAt - view.now) / HOUR_MS - 1);

    // The one new capability. Calendar arithmetic stays in code here for the same reason
    // it does in the agent: working out when a payday falls is something code does
    // correctly every time.
    let delayHours: number;
    let why: string;
    if (cls === 'INSUFFICIENT_FUNDS') {
      const customer = this.world.customer(view.subscription.customerId);
      const nextInflow = nextIstDayOfMonth(view.now, customer.inflowDay, istParts(view.now).hour);
      // +2h so the debit lands after the credit posts, not at midnight alongside it.
      const untilInflow = (nextInflow - view.now) / HOUR_MS + 2;
      delayHours = Math.max(1, untilInflow);
      why = "timed to the customer's next inflow rather than to tomorrow morning";
    } else {
      delayHours = Math.max(0, (view.openedAt + nextRetryNo * DAY_MS - view.now) / HOUR_MS);
      why = 'not a liquidity failure, so the daily schedule stands';
    }

    // A retry scheduled past the horizon is a retry that never happens. Clamping it here
    // rather than letting it be silently dropped keeps this arm honestly comparable.
    if (delayHours > hoursLeft) {
      return stop(
        view,
        'the next sensible presentment falls outside the case horizon',
        `Inflow-timed retry: the customer's next inflow lands after this case is ` +
          'abandoned, and presenting before it would meet the same empty account.',
      );
    }

    return {
      actions: [
        {
          kind: 'RETRY_NOW',
          delayHours,
          reason: `inflow-timed: retry ${nextRetryNo} of ${RETRY_BUDGET}, ${why}`,
        },
      ],
      diagnosis: cls,
      confidence: 1,
      rationale:
        `Inflow-timed retry: ${cls}; ${why}. This arm knows why the charge failed and ` +
        'when the customer is paid, and has no action available except retrying.',
    };
  }
}
