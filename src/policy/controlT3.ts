/**
 * THE CONTROL ARM: the fixed T+3 retry cycle.
 *
 * Spec section 1: Razorpay's documented default for subscription auto-charge failures
 * is described as "retry the next day, once a day, three times, excluding the charge
 * date". This is the baseline we must beat, so we implement it faithfully and we do not
 * quietly weaken it.
 *
 * VERIFIED 2026-08-31 against Razorpay Docs, "Payment Retries",
 * https://razorpay.com/docs/payments/subscriptions/payment-retries/
 *
 * Verbatim: "In a T+3 days cycle, we will retry the payment thrice. That is, once every
 * day for 3 days, excluding the date of the charge." And: "Let T=0 be the charge day...
 * we automatically reattempt the charge on T+1 day. If the charge fails again, we
 * automatically reattempt the charge two more times on T+2 and T+3 days, respectively."
 *
 * RAIL CAVEAT, recorded because it limits what this control arm represents:
 * the T+1/T+2/T+3 schedule is what Razorpay documents for CARDS and UPI. For eMandate
 * they document different behaviour - "we attempt to retry only when we get the
 * confirmation or rejection of the last payment, as it may take more than 24 hours",
 * with adjustments for bank holidays. Our cohort is ~28% eNACH, so this control arm is
 * faithful for the card and UPI rails and is an APPROXIMATION for the eNACH slice.
 * Modelling the eNACH schedule separately is future work; the approximation is stated
 * rather than hidden because it slightly flatters neither arm in particular - both arms
 * face the identical rail mix.
 *
 * The point of this policy is not that it is bad engineering - it is a reasonable
 * default. The point is that it is CONTEXT-FREE: it does not look at why the charge
 * failed, when the customer has money, or whether the rail is healthy. It spends the
 * same three attempts on a revoked mandate as on a temporary balance shortfall.
 */
import type { ActionBundle, CaseView, RecoveryPolicy } from '../domain/types.ts';
import { DAY_MS, HOUR_MS } from '../sim/clock.ts';

/** Number of retries after the failed charge date. */
export const T3_RETRY_COUNT = 3;

/** Spacing between retries. */
export const T3_RETRY_INTERVAL_MS = DAY_MS;

export class ControlT3Policy implements RecoveryPolicy {
  readonly name = 'control-t3-fixed';
  readonly arm = 'control' as const;

  decide(view: CaseView): ActionBundle {
    // attempts[0] is the failed opening charge; everything after it is a retry.
    const retriesUsed = view.attempts.length - 1;

    if (retriesUsed >= T3_RETRY_COUNT) {
      return {
        actions: [
          {
            kind: 'STOP',
            delayHours: 0,
            reason: `fixed policy exhausted after ${T3_RETRY_COUNT} retries`,
          },
        ],
        diagnosis: view.lastFailureClass,
        confidence: 1,
        rationale:
          'Fixed T+3 policy: retry budget spent. The failure class is recorded but ' +
          'never consulted - this policy stops on a counter, not on a diagnosis.',
      };
    }

    const nextRetryNo = retriesUsed + 1;
    const scheduledAt = view.openedAt + nextRetryNo * T3_RETRY_INTERVAL_MS;
    const delayHours = Math.max(0, (scheduledAt - view.now) / HOUR_MS);

    return {
      actions: [
        {
          kind: 'RETRY_NOW',
          delayHours,
          reason: `fixed schedule: retry ${nextRetryNo} of ${T3_RETRY_COUNT}, T+${nextRetryNo}`,
        },
      ],
      diagnosis: view.lastFailureClass,
      confidence: 1,
      rationale:
        `Fixed T+3 policy: retry ${nextRetryNo} of ${T3_RETRY_COUNT}, one day after the ` +
        'previous presentment. Chosen without reference to the failure class, the ' +
        "customer's inflow date, or the health of the destination bank.",
    };
  }
}
