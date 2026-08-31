/**
 * THE POLICY GATE (spec section 6).
 *
 * "Deterministic rules the LLM cannot argue past. This is enforcement code, not a prompt."
 *
 * Everything here is a pure function of the case and the clock. There is no model, no
 * probability, and no discretion. That is the whole point: a guard rail implemented as a
 * prompt instruction is a request, and a request is not a guard rail. The agent proposes;
 * this decides; the executor only ever sees what came out of here.
 *
 * Every rejection is recorded with the NAME of the rule that fired, because "blocked by
 * policy" with no rule name is an assertion, and a rule name is evidence.
 *
 * Ordering matters and is deliberate:
 *   1. abort        - a captured payment stops everything, before any other question
 *   2. possibility  - things that cannot work (terminal class, over cap)
 *   3. budget       - things we have run out of (attempts, contacts)
 *   4. compliance   - things we are not permitted to do yet (pre-debit notice, quiet hours)
 *   5. prudence     - things we should not do now (open breaker, live promise)
 *   6. ladder       - escalation tone may only advance one tier at a time
 */
import type {
  Action,
  ActionBundle,
  ActionKind,
  CaseView,
  NotifyAction,
  Timestamp,
} from '../domain/types.ts';
import { isTerminal, requiresHumanReview, type FailureClass } from '../domain/taxonomy.ts';
import { HOUR_MS, istParts } from '../sim/clock.ts';
import {
  CONTACT_POLICY,
  NATIONAL_HOLIDAYS_MMDD,
  PRE_DEBIT_APPLICABLE_RAILS,
  preDebitScope,
  RBI,
  type PreDebitScope,
} from './compliance.ts';

export type PolicyVerdict = 'APPROVE' | 'MODIFY' | 'DENY' | 'ESCALATE';

/** Attempts permitted per billing cycle, including the original failed charge. */
export const ATTEMPT_CAP_PER_CYCLE = 4;

/** The escalation ladder. Ordered. A tier may never be skipped. */
export const ESCALATION_LADDER = [
  'gentle_reminder',
  'firm_reminder',
  'owner_cc',
  'final_notice',
] as const;
export type EscalationTier = (typeof ESCALATION_LADDER)[number];

/**
 * Language the agent may never reach for on its own. Legal threats and collections
 * framing are a human decision with legal consequences, and no autonomous system should
 * be able to send one because a probability looked favourable.
 */
const FORBIDDEN_TEMPLATE_PATTERNS = [/legal/i, /collection/i, /recovery_agent/i, /lawsuit/i];

export interface RuleFiring {
  readonly rule: string;
  readonly actionKind: ActionKind;
  readonly effect: 'denied' | 'modified' | 'escalated';
  readonly detail: string;
}

export interface GateInput {
  readonly view: CaseView;
  readonly proposed: ActionBundle;
  /** Circuit breaker state for the destination bank. */
  readonly breakerOpen: boolean;
  readonly breakerRetryAfter: Timestamp | null;
  /**
   * An UNCONSUMED pre-debit notification, or null.
   *
   * Under the strict reading a notification authorises ONE debit and is then spent; the
   * caller clears this once a charge consumes it. Measuring only the age of the most
   * recent notice would let a single cycle-opening notification authorise an unlimited
   * number of retries, which is not what "at least 24 hours prior to the actual charge"
   * can mean if it means anything.
   */
  readonly lastPreDebitNoticeAt: Timestamp | null;
  /** Contacts sent to this customer inside the rolling window. */
  readonly contactsInRollingWindow: number;
  /** An open promise-to-pay, if any. */
  readonly livePromise: { promisedDate: Timestamp; graceHours: number } | null;
  /** True once a payment.captured webhook has been seen for this cycle. */
  readonly aborted: boolean;
  /** How many ladder tiers this case has already used. */
  readonly escalationTiersUsed: number;
  readonly scope?: PreDebitScope;
}

export interface GateDecision {
  readonly verdict: PolicyVerdict;
  readonly finalBundle: ActionBundle;
  readonly firings: ReadonlyArray<RuleFiring>;
  /** The single rule name recorded on the decision row. Null when nothing fired. */
  readonly primaryRule: string | null;
}

const CHARGE_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>([
  'RETRY_NOW',
  'DEFER',
  'TIME_SHIFT',
]);
const CONTACT_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>([
  'NOTIFY',
  'REMANDATE',
  'PAYMENT_LINK',
]);

const isCharge = (a: Action): boolean => CHARGE_KINDS.has(a.kind);
const isContact = (a: Action): boolean => CONTACT_KINDS.has(a.kind);

export interface WorkingClassification {
  readonly cls: FailureClass;
  /** True when the gate accepted a class the decision layer read off an unmapped code. */
  readonly promoted: boolean;
  readonly detail: string;
}

/**
 * The class the gate reasons about.
 *
 * Normally this is simply the taxonomy's verdict, and the taxonomy's verdict is final.
 * There is exactly ONE exception, and it is narrow on purpose.
 *
 * When a rail returns a code we have never mapped, the taxonomy says UNKNOWN - not
 * because the failure is mysterious, but because our lookup table has no row for it. The
 * accompanying description may nevertheless say plainly what happened. A decision layer
 * that read that text may offer its reading here, and the gate will adopt it, so that the
 * case is handled as the class it appears to be rather than as an unclassifiable one.
 *
 * The three conditions below are what stop that from becoming a hole:
 *
 *   1. The taxonomy must have NO opinion. Wherever it returned a real class, that class
 *      stands, and a proposal that disagrees is discarded. A model cannot talk its way
 *      out of a documented MANDATE_REVOKED.
 *   2. The raw code must be genuinely UNRECOGNISED (`classificationMatched === false`).
 *      A code that IS in our table and maps to UNKNOWN maps there because the rail's own
 *      documented description settles nothing - we have already read the text, and it
 *      said nothing. Re-reading it cannot produce information that is not there, so this
 *      path stays shut for those.
 *   3. The offered class must not itself be UNKNOWN, which would be a no-op.
 *
 * Adoption is not an approval. The promoted class then faces every rule in this file,
 * including TERMINAL_CLASS_NO_CHARGE - so a reading of "the mandate was revoked" makes
 * the gate MORE restrictive, not less. The direction that costs money is the opposite
 * one: a wrong reading of a terminal failure as a fundable one buys a charge that can
 * never succeed. That failure mode is measured, not assumed away - see
 * `node src/generalization.ts`, which reports it as WRONGLY UNLOCKED CHARGES.
 */
export function workingFailureClass(
  view: CaseView,
  proposed: ActionBundle,
): WorkingClassification {
  const taxonomy = view.lastFailureClass;
  const keep = (detail: string): WorkingClassification => ({
    cls: taxonomy,
    promoted: false,
    detail,
  });

  const offered = proposed.reclassifiedFromUnmapped;
  if (offered === undefined || offered === 'UNKNOWN') return keep('taxonomy classification');
  if (taxonomy !== 'UNKNOWN') {
    return keep(`taxonomy classified this as ${taxonomy}; a proposed reclassification is ignored`);
  }

  const last = view.attempts.at(-1);
  if (last === undefined || last.classificationMatched) {
    return keep(
      'the rail reason IS documented and its description does not establish a cause; ' +
        'it stays UNKNOWN',
    );
  }

  return {
    cls: offered,
    promoted: true,
    detail:
      `raw code "${last.rawErrorCode}" is not in the taxonomy; the rail's description ` +
      `was read as ${offered}`,
  };
}

/** Evaluate a proposed bundle. The returned bundle is the only thing that may execute. */
export function evaluate(input: GateInput): GateDecision {
  const { view, proposed } = input;
  const scope = input.scope ?? preDebitScope();
  const firings: RuleFiring[] = [];
  const now = view.now;

  // ---- 1. GLOBAL ABORT ------------------------------------------------------
  // A captured payment halts everything pending on the case. Checked first because no
  // later rule's opinion matters once the money is in.
  if (input.aborted) {
    firings.push({
      rule: 'GLOBAL_ABORT_ON_CAPTURE',
      actionKind: 'STOP',
      effect: 'denied',
      detail: 'payment.captured received; all pending actions on this case are halted',
    });
    return {
      verdict: 'DENY',
      finalBundle: replaceWith(proposed, {
        kind: 'STOP',
        delayHours: 0,
        reason: 'halted by GLOBAL_ABORT_ON_CAPTURE',
      }),
      firings,
      primaryRule: 'GLOBAL_ABORT_ON_CAPTURE',
    };
  }

  // ---- 0. WORKING CLASSIFICATION -------------------------------------------
  // Recorded as a firing rather than applied quietly: a case whose handling turned on a
  // class no lookup table produced must say so in its own audit trail.
  const working = workingFailureClass(view, proposed);
  if (working.promoted) {
    firings.push({
      rule: 'MODEL_READ_UNMAPPED_CODE',
      actionKind: 'STOP',
      effect: 'modified',
      detail: working.detail,
    });
  }

  const kept: Action[] = [];
  let contactsThisBundle = 0;
  let tiersUsed = input.escalationTiersUsed;

  for (const action of proposed.actions) {
    const deny = (rule: string, detail: string): void => {
      firings.push({ rule, actionKind: action.kind, effect: 'denied', detail });
    };

    // ---- 2. POSSIBILITY ------------------------------------------------------
    if (isCharge(action)) {
      if (isTerminal(working.cls)) {
        deny(
          'TERMINAL_CLASS_NO_CHARGE',
          `${working.cls} is terminal; no charge on this mandate can succeed`,
        );
        continue;
      }
      if (view.subscription.amountPaise > view.mandate.maxAmountPaise) {
        deny(
          'AMOUNT_EXCEEDS_MANDATE_CAP',
          `amount ${view.subscription.amountPaise} exceeds mandate cap ${view.mandate.maxAmountPaise}`,
        );
        continue;
      }
      if (view.mandate.status !== 'active') {
        deny('MANDATE_NOT_ACTIVE', `mandate status is ${view.mandate.status}`);
        continue;
      }

      // An UNRECOGNISED failure must never quietly become another attempt on a
      // customer's account. Our taxonomy maps a rail reason to UNKNOWN whenever the
      // documented description does not settle the cause - nine of Razorpay's eighteen
      // documented recurring-payment reasons land there - and the conservative response
      // to "we do not know why this failed" is not to charge again.
      if (working.cls === 'UNKNOWN') {
        deny(
          'UNKNOWN_FAILURE_NOT_RETRYABLE',
          'the last failure did not map to a known class; an unclassified failure is ' +
            'never automatically retried',
        );
        continue;
      }

      // Sourced: above the AFA threshold a recurring transaction cannot be authorised
      // without an additional factor of authentication, so it cannot be presented as an
      // unattended recurring debit at all.
      if (view.subscription.amountPaise > RBI.afaThresholdPaise.value) {
        deny(
          'AFA_THRESHOLD_EXCEEDED',
          `amount exceeds the Rs 15,000 AFA-exempt ceiling (RBI E-mandate Framework ` +
            `2026, ${RBI.afaThresholdPaise.section}); it requires an additional factor ` +
            'of authentication and cannot be charged unattended',
        );
        continue;
      }

      // ---- 3. BUDGET ---------------------------------------------------------
      if (view.attemptsUsed >= ATTEMPT_CAP_PER_CYCLE) {
        deny(
          'ATTEMPT_CAP_PER_CYCLE',
          `${view.attemptsUsed} attempts already used; cap is ${ATTEMPT_CAP_PER_CYCLE}`,
        );
        continue;
      }

      // ---- 4. COMPLIANCE -----------------------------------------------------
      // RBI E-mandate Framework 2026: a pre-transaction notification must precede the
      // debit by at least 24 hours. See src/policy/compliance.ts for the citation and
      // for why the SCOPE of this rule is a stated open question rather than a guess.
      const requiredHours = RBI.preDebitNotificationHours.value;
      const firesAt = now + action.delayHours * HOUR_MS;
      const noticeAt = input.lastPreDebitNoticeAt;
      const noticeAged =
        noticeAt !== null && firesAt - noticeAt >= requiredHours * HOUR_MS;

      // Section 2 of the framework applies it to "cards / PPI / UPI". eNACH is an NPCI
      // system and is not named, so the rule is not extended to that rail. Applying a
      // regulation past its own stated scope is its own kind of invention.
      const railInScope = PRE_DEBIT_APPLICABLE_RAILS.has(view.mandate.rail);

      if (scope === 'per_debit' && railInScope && !noticeAged) {
        deny(
          'PRE_DEBIT_NOTIFICATION_REQUIRED',
          noticeAt === null
            ? `no pre-debit notification on record; ${requiredHours}h notice required ` +
              '(RBI E-mandate Framework 2026)'
            : `notification only ${((firesAt - noticeAt) / HOUR_MS).toFixed(1)}h before ` +
              `the debit; ${requiredHours}h required (RBI E-mandate Framework 2026)`,
        );
        continue;
      }

      // ---- 5. PRUDENCE -------------------------------------------------------
      if (input.livePromise !== null) {
        const graceEnds =
          input.livePromise.promisedDate + input.livePromise.graceHours * HOUR_MS;
        if (firesAt <= graceEnds) {
          deny(
            'LIVE_PROMISE_TO_PAY',
            'a promise to pay is inside its grace window; do not chase',
          );
          continue;
        }
      }

      if (input.breakerOpen) {
        // Not a denial - the action is still right, the timing is not. Push it past the
        // breaker's cooldown rather than burning an attempt into a rail we know is down.
        const until = input.breakerRetryAfter ?? now + HOUR_MS;
        const newDelay = Math.max(action.delayHours, (until - now) / HOUR_MS);
        firings.push({
          rule: 'CIRCUIT_BREAKER_OPEN',
          actionKind: action.kind,
          effect: 'modified',
          detail: `breaker open for ${view.mandate.bankCode}; deferred to cooldown end`,
        });
        kept.push({ ...action, kind: 'DEFER', delayHours: newDelay });
        continue;
      }

      kept.push(action);
      continue;
    }

    // ---- contacts ------------------------------------------------------------
    if (isContact(action)) {
      if (view.contactsUsed >= CONTACT_POLICY.maxContactsPerCase) {
        deny(
          'CONTACT_FREQUENCY_CAP',
          `${view.contactsUsed} contacts already sent; lifetime cap is ` +
            `${CONTACT_POLICY.maxContactsPerCase}`,
        );
        continue;
      }
      if (
        input.contactsInRollingWindow + contactsThisBundle >=
        CONTACT_POLICY.maxContactsPerRollingWindow
      ) {
        deny(
          'CONTACT_FREQUENCY_CAP',
          `${input.contactsInRollingWindow} contacts in the last ` +
            `${CONTACT_POLICY.rollingWindowHours}h; cap is ` +
            `${CONTACT_POLICY.maxContactsPerRollingWindow}`,
        );
        continue;
      }
      if (input.livePromise !== null) {
        const graceEnds =
          input.livePromise.promisedDate + input.livePromise.graceHours * HOUR_MS;
        if (now + action.delayHours * HOUR_MS <= graceEnds) {
          deny('LIVE_PROMISE_TO_PAY', 'promise to pay is within grace; no chasing');
          continue;
        }
      }

      let next: Action = action;

      // ---- 6. LADDER ---------------------------------------------------------
      if (action.kind === 'NOTIFY') {
        const notify = action as NotifyAction;
        if (FORBIDDEN_TEMPLATE_PATTERNS.some((p) => p.test(notify.templateId))) {
          deny(
            'ESCALATION_LADDER_ORDER',
            `template "${notify.templateId}" uses legal or collections language, which ` +
              'automation may never send',
          );
          continue;
        }
        // The ladder advances by exactly one tier per contact. An agent cannot jump from
        // a gentle reminder to a final notice however confident it is.
        const tier = ESCALATION_LADDER[Math.min(tiersUsed, ESCALATION_LADDER.length - 1)]!;
        if (notify.templateId !== tier) {
          firings.push({
            rule: 'ESCALATION_LADDER_ORDER',
            actionKind: 'NOTIFY',
            effect: 'modified',
            detail: `template forced to tier ${tiersUsed + 1} (${tier}); tiers cannot be skipped`,
          });
          next = { ...notify, templateId: tier };
        }
        tiersUsed++;
      }

      // Quiet hours. An operational policy, not a regulation - see compliance.ts.
      const firesAt = now + next.delayHours * HOUR_MS;
      const permitted = nextPermittedContactTime(firesAt);
      if (permitted !== firesAt) {
        firings.push({
          rule: 'QUIET_HOURS',
          actionKind: next.kind,
          effect: 'modified',
          detail:
            `contact at ${describeIst(firesAt)} falls in quiet hours or on a national ` +
            `holiday; moved to ${describeIst(permitted)}`,
        });
        next = { ...next, delayHours: (permitted - now) / HOUR_MS };
      }

      contactsThisBundle++;
      kept.push(next);
      continue;
    }

    // WAIT / STOP / ESCALATE_HUMAN need no permission.
    kept.push(action);
  }

  // ---- nothing survived -----------------------------------------------------
  // A case must still reach a terminal state. If every proposal was rejected, substitute
  // the safe action rather than leaving the case with nothing to do - an empty bundle is
  // how a "blocked" case silently becomes a stranded one.
  if (kept.length === 0) {
    // Escalate only where the taxonomy says a PERSON is required. A revoked mandate is
    // terminal but wants a re-authorisation, not an operator; routing it to a human
    // because the proposing policy was too simple to ask for a re-mandate would burn
    // headcount on a case automation could have handled.
    const needsHuman = requiresHumanReview(working.cls);
    const substitute: Action = needsHuman
      ? {
          kind: 'ESCALATE_HUMAN',
          delayHours: 0,
          reason: 'every proposed action was blocked and this account state needs a person',
        }
      : { kind: 'STOP', delayHours: 0, reason: 'every proposed action was blocked by policy' };
    return {
      verdict: needsHuman ? 'ESCALATE' : 'DENY',
      finalBundle: replaceWith(proposed, substitute),
      firings,
      primaryRule: firings[0]?.rule ?? null,
    };
  }

  const denied = firings.filter((f) => f.effect === 'denied').length;
  const modified = firings.filter((f) => f.effect === 'modified').length;
  const verdict: PolicyVerdict =
    denied > 0 ? 'MODIFY' : modified > 0 ? 'MODIFY' : 'APPROVE';

  return {
    verdict: firings.length === 0 ? 'APPROVE' : verdict,
    finalBundle: { ...proposed, actions: kept },
    firings,
    primaryRule: firings[0]?.rule ?? null,
  };
}

function replaceWith(bundle: ActionBundle, action: Action): ActionBundle {
  return { ...bundle, actions: [action] };
}

/** Is this instant inside permitted contact hours, on a non-holiday? */
export function isPermittedContactTime(ts: Timestamp): boolean {
  const p = istParts(ts);
  const mmdd = `${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
  if (NATIONAL_HOLIDAYS_MMDD.has(mmdd)) return false;
  const { quietHoursStartIst: start, quietHoursEndIst: end } = CONTACT_POLICY;
  // Quiet window wraps midnight: [21:00, 09:00).
  return !(p.hour >= start || p.hour < end);
}

/** The earliest permitted contact instant at or after `ts`. */
export function nextPermittedContactTime(ts: Timestamp): Timestamp {
  let t = ts;
  // At most a couple of weeks of hourly steps; a holiday run cannot exceed that.
  for (let i = 0; i < 24 * 21; i++) {
    if (isPermittedContactTime(t)) return t;
    t += HOUR_MS;
  }
  return t;
}

function describeIst(ts: Timestamp): string {
  const p = istParts(ts);
  return `${String(p.day).padStart(2, '0')}/${String(p.month).padStart(2, '0')} ${String(p.hour).padStart(2, '0')}:00 IST`;
}
