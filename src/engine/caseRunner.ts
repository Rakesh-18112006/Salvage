/**
 * Runs a single recovery case to closure under a given policy.
 *
 * The engine owns simulated time, executes the actions a policy proposes, and writes
 * the append-only decision log. It never makes a recovery choice of its own - that is
 * the policy's job - and it never lets a policy see simulator ground truth.
 *
 * Phase 3 completed the action space: the customer-facing actions (NOTIFY, REMANDATE,
 * PAYMENT_LINK) now resolve against the seeded customer-response model in
 * src/sim/customerResponse.ts, so asking a customer to re-authorise is a real lever with
 * a real completion rate rather than a button that does nothing.
 */
import type {
  Action,
  ActionBundle,
  CaseView,
  ChargeAttempt,
  DecisionRecord,
  RecoveryCase,
  RecoveryPolicy,
  Timestamp,
} from '../domain/types.ts';
import { classify, type FailureClass } from '../domain/taxonomy.ts';
import { COST, SIM } from '../assumptions.ts';
import { DAY_MS, HOUR_MS, fromIst, istParts } from '../sim/clock.ts';
import { attemptCharge, selfHealsOn } from '../sim/paymentSimulator.ts';
import { respondToAsk, selfHealMultiplierAfterNotify } from '../sim/customerResponse.ts';
import { evaluate as evaluatePolicy, type GateDecision } from '../policy/gate.ts';
import { RBI } from '../policy/compliance.ts';
import { CONTACT_POLICY } from '../policy/compliance.ts';
import type { AtRiskCase } from '../sim/population.ts';
import type { World } from '../sim/population.ts';

/** Hard stop on decision turns per case. A policy that loops is a bug, not a strategy. */
const MAX_TURNS = 50;

/** Self-heal is evaluated once per simulated day, at midday IST. */
function* selfHealCheckpoints(now: Timestamp, target: Timestamp): Generator<Timestamp> {
  const p = istParts(now);
  let t = fromIst(p.year, p.month, p.day, 12);
  while (t <= target) {
    if (t > now) yield t;
    t += DAY_MS; // IST has no DST, so +24h is exactly the next midday
  }
}

function idempotencyKey(caseId: string, attemptNo: number): string {
  // Phase 2 replaces this with sha256(case_id, attempt_no) computed in node:crypto and
  // persisted UNIQUE. The shape is fixed now so the executor contract never changes.
  return `idem_${caseId}_${attemptNo}`;
}

export interface RunCaseArgs {
  readonly world: World;
  readonly atRisk: AtRiskCase;
  readonly policy: RecoveryPolicy;
  readonly caseIdPrefix: string;
}

export function runCase({ world, atRisk, policy, caseIdPrefix }: RunCaseArgs): Promise<RecoveryCase> {
  return runCaseAsync({ world, atRisk, policy, caseIdPrefix });
}

async function runCaseAsync(
  { world, atRisk, policy, caseIdPrefix }: RunCaseArgs,
): Promise<RecoveryCase> {
  const { subscription, mandate, customer, cycleId, scheduledAt, openingResult } = atRisk;
  const caseId = `${caseIdPrefix}_${subscription.id}`;
  const horizonEndsAt = scheduledAt + SIM.caseHorizonDays.value * DAY_MS;

  const openingClassification = classify(openingResult.rawErrorCode);
  const openingAttempt: ChargeAttempt = {
    id: `${caseId}_att_1`,
    subscriptionId: subscription.id,
    cycleId,
    attemptNo: 1,
    idempotencyKey: idempotencyKey(caseId, 1),
    rail: mandate.rail,
    scheduledAt,
    executedAt: scheduledAt,
    status: 'failed',
    rawErrorCode: openingResult.rawErrorCode,
    rawErrorDesc: openingResult.rawErrorDesc,
    failureClass: openingClassification.failureClass,
    classificationMatched: openingClassification.matched,
    feePaise: COST.gatewayFeePerAttemptPaise.value,
  };

  const rc: RecoveryCase = {
    id: caseId,
    subscriptionId: subscription.id,
    cycleId,
    arm: policy.arm,
    state: 'OPEN',
    version: 1,
    diagnosis: openingClassification.failureClass,
    attemptsUsed: 1,
    contactsUsed: 0,
    openedAt: scheduledAt,
    closedAt: null,
    outcome: null,
    recoveredPaise: 0,
    costPaise: COST.gatewayFeePerAttemptPaise.value,
    gatewayCostPaise: COST.gatewayFeePerAttemptPaise.value,
    humanCostPaise: 0,
    attempts: [openingAttempt],
    decisions: [],
    blockedByPolicy: 0,
    policyRuleCounts: {},
    // ground truth: what the environment actually applied, never exposed to the policy
    trueOpeningClass: openingResult.trueClass ?? 'UNKNOWN',
  };

  let now = scheduledAt;
  let blockedByPolicy = 0;
  const policyRuleCounts = new Map<string, number>();

  /** Close the case, charging float cost when money was recovered late. */
  const close = (
    at: Timestamp,
    state: RecoveryCase['state'],
    outcome: RecoveryCase['outcome'],
    recoveredPaise: number,
  ): void => {
    rc.state = state;
    rc.outcome = outcome;
    rc.closedAt = at;
    rc.recoveredPaise = recoveredPaise;
    rc.version += 1;
    if (recoveredPaise > 0) {
      const daysLate = (at - rc.openedAt) / DAY_MS;
      const floatPaise = Math.round(
        (recoveredPaise / 100) * COST.floatCostPerRupeePerDay.value * daysLate * 100,
      );
      rc.costPaise += floatPaise;
    }
  };

  /**
   * Advance simulated time to `target`, checking each intervening day for out-of-band
   * self-healing. Returns the instant the case healed, or null if it did not.
   */
  const advanceTo = (target: Timestamp): Timestamp | null => {
    for (const checkpoint of selfHealCheckpoints(now, target)) {
      // A customer who has been TOLD the payment failed is likelier to fix it themselves.
      // That uplift is the entire benefit of a bare NOTIFY, and it is what the agent
      // weighs against the patience cost of sending one.
      const uplift = selfHealMultiplierAfterNotify(rc.contactsUsed);
      if (selfHealsOn(world, subscription.id, customer, checkpoint, uplift)) {
        now = checkpoint;
        return checkpoint;
      }
      // A pending customer ask (re-mandate / payment link) may complete in this window.
      if (pendingAsk !== null && pendingAsk.completedAt !== null && pendingAsk.completedAt <= checkpoint) {
        now = pendingAsk.completedAt;
        return pendingAsk.completedAt;
      }
    }
    if (pendingAsk !== null && pendingAsk.completedAt !== null && pendingAsk.completedAt <= target) {
      now = pendingAsk.completedAt;
      return pendingAsk.completedAt;
    }
    now = target;
    return null;
  };

  // A customer ask that is outstanding: set by REMANDATE / PAYMENT_LINK, resolved by the
  // seeded response model. Null until one is sent.
  let pendingAsk: { completedAt: Timestamp | null } | null = null;
  let asksSent = 0;

  // ---- state the policy gate reads ------------------------------------------
  // The cycle's scheduled debit was itself preceded by a pre-transaction notification;
  // that is what made the original charge lawful. Under the default 'per_cycle' reading
  // it also covers this cycle's retries. See src/policy/compliance.ts.
  // An UNCONSUMED notice. Under the strict reading a notification authorises one debit
  // and is then spent, so executing a charge clears it and sending a message renews it.
  let lastPreDebitNoticeAt: Timestamp | null =
    scheduledAt - RBI.preDebitNotificationHours.value * HOUR_MS;
  const contactTimes: Timestamp[] = [];
  let escalationTiersUsed = 0;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    if (rc.state === 'RECOVERED' || rc.state === 'EXHAUSTED' || rc.state === 'HUMAN_QUEUE') break;

    const view: CaseView = {
      caseId,
      arm: policy.arm,
      now,
      subscription,
      mandate,
      customer: {
        id: customer.id,
        tenureMonths: customer.tenureMonths,
        preferredLanguage: customer.preferredLanguage,
        bankCode: customer.bankCode,
      },
      openedAt: rc.openedAt,
      attempts: rc.attempts,
      attemptsUsed: rc.attemptsUsed,
      contactsUsed: rc.contactsUsed,
      lastFailureClass: lastFailureClassOf(rc),
      horizonEndsAt,
    };

    const proposed = await policy.decide(view);

    // THE POLICY GATE. Nothing below this line executes an action the gate did not
    // return. The proposal and the verdict are both written to the audit trail, so a
    // reader can see what the agent wanted as well as what actually happened.
    const gate: GateDecision = evaluatePolicy({
      view,
      proposed,
      breakerOpen: false,
      breakerRetryAfter: null,
      lastPreDebitNoticeAt,
      contactsInRollingWindow: contactTimes.filter(
        (t) => now - t < CONTACT_POLICY.rollingWindowHours * HOUR_MS,
      ).length,
      livePromise: null,
      aborted: false,
      escalationTiersUsed,
    });
    const bundle = gate.finalBundle;
    recordDecision(rc, now, view, proposed, gate);
    blockedByPolicy += gate.firings.filter((f) => f.effect === 'denied').length;
    for (const f of gate.firings) {
      policyRuleCounts.set(f.rule, (policyRuleCounts.get(f.rule) ?? 0) + 1);
    }

    const actions = [...bundle.actions].sort((a, b) => a.delayHours - b.delayHours);
    if (actions.length === 0) {
      close(now, 'EXHAUSTED', 'exhausted', 0);
      break;
    }

    let closed = false;
    for (const action of actions) {
      const firesAt = now + action.delayHours * HOUR_MS;

      if (firesAt > horizonEndsAt) {
        const healed = advanceTo(horizonEndsAt);
        if (healed !== null) {
          close(healed, 'RECOVERED', 'recovered_self_heal', subscription.amountPaise);
        } else {
          close(horizonEndsAt, 'EXHAUSTED', 'exhausted', 0);
        }
        closed = true;
        break;
      }

      const healed = advanceTo(firesAt);
      if (healed !== null) {
        close(healed, 'RECOVERED', 'recovered_self_heal', subscription.amountPaise);
        closed = true;
        break;
      }

      if (action.kind === 'NOTIFY' || action.kind === 'REMANDATE' || action.kind === 'PAYMENT_LINK') {
        contactTimes.push(firesAt);
        lastPreDebitNoticeAt = firesAt; // a fresh notice authorises the next debit
        if (action.kind === 'NOTIFY') escalationTiersUsed++;
      }
      if (action.kind === 'RETRY_NOW' || action.kind === 'DEFER' || action.kind === 'TIME_SHIFT') {
        lastPreDebitNoticeAt = null; // this charge consumes the notice
      }

      const result = applyAction(action, {
        rc, world, atRisk, close, now: firesAt, caseId,
        horizonEndsAt,
        sendAsk: (kind) => {
          asksSent += 1;
          const response = respondToAsk(
            world, kind, customer, subscription.id, subscription.amountPaise,
            firesAt, asksSent, horizonEndsAt,
          );
          pendingAsk = { completedAt: response.completedAt };
          return response;
        },
      });
      if (result === 'closed') {
        closed = true;
        break;
      }
    }

    if (closed) break;
    rc.state = 'AWAITING_RETRY';
    rc.version += 1;
  }

  rc.blockedByPolicy = blockedByPolicy;
  rc.policyRuleCounts = Object.fromEntries(policyRuleCounts);

  if (rc.closedAt === null) {
    // Turn budget ran out without closure. Fail loudly rather than reporting a phantom.
    throw new Error(`case ${caseId} did not close within ${MAX_TURNS} decision turns`);
  }

  return rc;
}

function lastFailureClassOf(rc: RecoveryCase): FailureClass {
  for (let i = rc.attempts.length - 1; i >= 0; i--) {
    const a = rc.attempts[i]!;
    if (a.status === 'failed') return a.failureClass;
  }
  return 'UNKNOWN';
}

function recordDecision(
  rc: RecoveryCase,
  at: Timestamp,
  view: CaseView,
  proposed: ActionBundle,
  gate: GateDecision,
): void {
  const record: DecisionRecord = {
    seq: rc.decisions.length + 1,
    at,
    agentInputSnapshot: {
      attemptsUsed: view.attemptsUsed,
      contactsUsed: view.contactsUsed,
      lastFailureClass: view.lastFailureClass,
      hoursSinceOpen: (at - view.openedAt) / HOUR_MS,
      policyFirings: gate.firings.map((f) => `${f.rule}:${f.effect}`),
    },
    agentReasoning: proposed.rationale,
    // What the agent WANTED, kept verbatim even when it was refused - an audit trail
    // that records only the approved action cannot show the gate doing anything.
    proposedBundle: proposed,
    policyVerdict: gate.verdict,
    policyRuleFired: gate.primaryRule,
    finalBundle: gate.finalBundle,
  };
  rc.decisions.push(record);
}

interface ApplyCtx {
  rc: RecoveryCase;
  world: World;
  atRisk: AtRiskCase;
  close: (
    at: Timestamp,
    state: RecoveryCase['state'],
    outcome: RecoveryCase['outcome'],
    recoveredPaise: number,
  ) => void;
  now: Timestamp;
  caseId: string;
  horizonEndsAt: Timestamp;
  sendAsk: (kind: 'REMANDATE' | 'PAYMENT_LINK') => { completed: boolean; completedAt: Timestamp | null };
}

function applyAction(action: Action, ctx: ApplyCtx): 'continue' | 'closed' {
  const { rc, world, atRisk, close, now, caseId } = ctx;
  const { subscription, mandate, customer, cycleId } = atRisk;

  switch (action.kind) {
    // All three are the same executor operation: present a charge at an instant.
    // They differ only in the reasoning that chose the instant, which is why the
    // decision log records the kind separately from the effect.
    case 'RETRY_NOW':
    case 'DEFER':
    case 'TIME_SHIFT': {
      const attemptNo = rc.attempts.length + 1;
      const result = attemptCharge(world, {
        subscription, mandate, customer, attemptNo, at: now,
      });
      const cls = classify(result.rawErrorCode);
      const attempt: ChargeAttempt = {
        id: `${caseId}_att_${attemptNo}`,
        subscriptionId: subscription.id,
        cycleId,
        attemptNo,
        idempotencyKey: idempotencyKey(caseId, attemptNo),
        rail: mandate.rail,
        scheduledAt: now,
        executedAt: now,
        status: result.status,
        rawErrorCode: result.rawErrorCode,
        rawErrorDesc: result.rawErrorDesc,
        failureClass: result.status === 'success' ? 'UNKNOWN' : cls.failureClass,
        classificationMatched: result.status === 'success' ? true : cls.matched,
        feePaise: COST.gatewayFeePerAttemptPaise.value,
      };
      rc.attempts.push(attempt);
      rc.attemptsUsed += 1;
      rc.costPaise += attempt.feePaise;
      rc.gatewayCostPaise += attempt.feePaise; // a gateway fee is real money

      if (result.status === 'success') {
        close(now, 'RECOVERED', 'recovered', subscription.amountPaise);
        return 'closed';
      }
      rc.diagnosis = cls.failureClass;
      return 'continue';
    }

    case 'WAIT':
      // Time has already been advanced to firesAt by the caller.
      return 'continue';

    case 'ESCALATE_HUMAN':
      rc.costPaise += COST.humanHandoffPaise.value;
      rc.humanCostPaise += COST.humanHandoffPaise.value; // operator time is real money
      close(now, 'HUMAN_QUEUE', 'handed_to_human', 0);
      return 'closed';

    case 'STOP':
      close(now, 'EXHAUSTED', 'exhausted', 0);
      return 'closed';

    case 'NOTIFY':
      // A notification costs patience and buys a higher chance the customer resolves it
      // themselves. It never recovers money directly.
      rc.contactsUsed += 1;
      rc.costPaise += COST.contactPatiencePaise.value;
      return 'continue';

    case 'REMANDATE':
    case 'PAYMENT_LINK': {
      // The only route by which a terminal failure can ever be recovered. Costs friction
      // plus a contact whether or not the customer completes it.
      rc.contactsUsed += 1;
      rc.costPaise += COST.customerFrictionPaise.value + COST.contactPatiencePaise.value;
      const response = ctx.sendAsk(action.kind);
      if (response.completed && response.completedAt !== null) {
        close(response.completedAt, 'RECOVERED', 'recovered', subscription.amountPaise);
        return 'closed';
      }
      // Not completed (or not in time). The case stays open; the policy decides again.
      return 'continue';
    }

    default: {
      const exhaustive: never = action;
      throw new Error(`unhandled action: ${JSON.stringify(exhaustive)}`);
    }
  }
}
