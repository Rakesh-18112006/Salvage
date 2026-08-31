import type { Paise } from './money.ts';
import type { FailureClass } from './taxonomy.ts';

/** Milliseconds since Unix epoch. All times are stored as UTC instants. */
export type Timestamp = number;

export type Rail = 'upi_autopay' | 'enach' | 'card';

export type MandateStatus = 'active' | 'revoked' | 'expired';

export type AccountState = 'normal' | 'closed' | 'frozen' | 'risk_flagged';

export interface Customer {
  readonly id: string;
  readonly bankCode: string;
  /** Day of month the customer's primary inflow lands (salary / receipts). */
  readonly inflowDay: number;
  /** 0.3 - 1.0. Higher = more consistently funded. */
  readonly reliability: number;
  /** Months of on-time history before this cycle. Feeds Phase 3 reasoning. */
  readonly tenureMonths: number;
  readonly accountState: AccountState;
  readonly preferredLanguage: 'english' | 'hinglish' | 'hindi';
}

export interface Mandate {
  readonly id: string;
  readonly customerId: string;
  readonly rail: Rail;
  readonly bankCode: string;
  readonly maxAmountPaise: Paise;
  readonly status: MandateStatus;
  readonly createdAt: Timestamp;
  /** Card rail only: instant after which the instrument is expired. */
  readonly cardExpiresAt?: Timestamp;
}

export interface Subscription {
  readonly id: string;
  readonly mandateId: string;
  readonly customerId: string;
  readonly amountPaise: Paise;
  /** Day of month the recurring charge is scheduled. */
  readonly billingDay: number;
  readonly status: 'active' | 'halted';
}

export type AttemptStatus = 'success' | 'failed';

export interface ChargeAttempt {
  readonly id: string;
  readonly subscriptionId: string;
  readonly cycleId: string;
  readonly attemptNo: number;
  /** sha256(caseId, attemptNo) in Phase 2. Present from Phase 1 so the shape is fixed. */
  readonly idempotencyKey: string;
  readonly rail: Rail;
  readonly scheduledAt: Timestamp;
  readonly executedAt: Timestamp;
  readonly status: AttemptStatus;
  readonly rawErrorCode: string;
  readonly rawErrorDesc: string;
  readonly failureClass: FailureClass;
  /** false => taxonomy did not recognise rawErrorCode. */
  readonly classificationMatched: boolean;
  readonly feePaise: Paise;
}

// ----------------------------------------------------------------------------
// Action space (spec section 2). Retry is one of eight actions, not the default.
// ----------------------------------------------------------------------------

export type ActionKind =
  | 'RETRY_NOW'
  | 'DEFER'
  | 'TIME_SHIFT'
  | 'REMANDATE'
  | 'PAYMENT_LINK'
  | 'NOTIFY'
  | 'WAIT'
  | 'ESCALATE_HUMAN'
  | 'STOP';

interface ActionBase {
  readonly kind: ActionKind;
  /** Hours from the decision instant until this action fires. */
  readonly delayHours: number;
  readonly reason: string;
}

export interface RetryNowAction extends ActionBase { readonly kind: 'RETRY_NOW'; }
export interface DeferAction extends ActionBase { readonly kind: 'DEFER'; }
export interface TimeShiftAction extends ActionBase { readonly kind: 'TIME_SHIFT'; }
export interface WaitAction extends ActionBase { readonly kind: 'WAIT'; }
export interface EscalateHumanAction extends ActionBase { readonly kind: 'ESCALATE_HUMAN'; }
export interface StopAction extends ActionBase { readonly kind: 'STOP'; }
export interface RemandateAction extends ActionBase { readonly kind: 'REMANDATE'; }
export interface PaymentLinkAction extends ActionBase { readonly kind: 'PAYMENT_LINK'; }
export interface NotifyAction extends ActionBase {
  readonly kind: 'NOTIFY';
  readonly language: Customer['preferredLanguage'];
  readonly templateId: string;
}

export type Action =
  | RetryNowAction | DeferAction | TimeShiftAction | WaitAction
  | EscalateHumanAction | StopAction | RemandateAction | PaymentLinkAction | NotifyAction;

/**
 * Actions compose. DEFER + NOTIFY is one decision, not two competing ones
 * (spec section 2). The decision layer emits a bundle, never a bare action.
 */
export interface ActionBundle {
  readonly actions: ReadonlyArray<Action>;
  readonly diagnosis: FailureClass;
  readonly confidence: number;
  readonly rationale: string;
  /**
   * A class the decision layer read out of a rail response the TAXONOMY COULD NOT MAP.
   *
   * This is a request, not a fact, and the policy gate is what decides whether to honour
   * it (`workingFailureClass` in src/policy/gate.ts). The gate honours it in exactly one
   * situation - the taxonomy returned UNKNOWN *and* did not recognise the raw code - so
   * this field can never be used to talk past a class the taxonomy DID recognise. A
   * proposal claiming INSUFFICIENT_FUNDS on a documented MANDATE_REVOKED is ignored.
   *
   * Undefined on every deterministic path, and on every decision where the taxonomy had
   * an opinion. Set only when a model was given an unrecognised code to read.
   */
  readonly reclassifiedFromUnmapped?: FailureClass;
}

// ----------------------------------------------------------------------------
// Recovery case
// ----------------------------------------------------------------------------

export type Arm = 'control' | 'agent';

export type CaseState =
  | 'OPEN'
  | 'AWAITING_RETRY'
  | 'AWAITING_CUSTOMER'
  | 'RECOVERED'
  | 'EXHAUSTED'
  | 'HUMAN_QUEUE';

export type CaseOutcome = 'recovered' | 'recovered_self_heal' | 'exhausted' | 'handed_to_human';

/** One row of the append-only decision log (spec section 4). The audit trail. */
export interface DecisionRecord {
  readonly seq: number;
  readonly at: Timestamp;
  readonly agentInputSnapshot: Record<string, unknown>;
  readonly agentReasoning: string;
  readonly proposedBundle: ActionBundle;
  /** Phase 4 fills these. Present from Phase 1 so the audit shape never changes. */
  readonly policyVerdict: 'APPROVE' | 'MODIFY' | 'DENY' | 'ESCALATE' | 'NOT_YET_IMPLEMENTED';
  /** The name of the rule that decided this. Null only when nothing fired. */
  readonly policyRuleFired: string | null;
  readonly finalBundle: ActionBundle;
}

export interface RecoveryCase {
  readonly id: string;
  readonly subscriptionId: string;
  readonly cycleId: string;
  readonly arm: Arm;
  state: CaseState;
  version: number;
  diagnosis: FailureClass;
  attemptsUsed: number;
  contactsUsed: number;
  readonly openedAt: Timestamp;
  closedAt: Timestamp | null;
  outcome: CaseOutcome | null;
  recoveredPaise: Paise;
  /**
   * All-in modelled cost: cash plus shadow.
   *
   * The two are tracked separately because they are not the same kind of thing and
   * summing them into one "cost per rupee recovered" quietly turns a financial metric
   * into a moral one. A gateway fee is money leaving the business. Customer patience is
   * a price WE put on annoyance so the agent cannot spam - real, worth optimising, but
   * not an outflow. Reporting only the sum would let a policy that harasses customers
   * look identical to one that pays more fees.
   */
  costPaise: Paise;
  /**
   * Cash cost split into its two very different kinds:
   *
   *   gateway  - the price of TRYING TO COLLECT. This is the number a collection policy
   *              is genuinely responsible for, and the honest efficiency headline.
   *   human    - the price of a COMPLIANCE OBLIGATION. A frozen or risk-declined account
   *              goes to a person because someone must look at it, not because we expect
   *              to collect. A policy that never escalates looks cheaper here purely by
   *              ignoring the duty, so folding it into "cost per rupee recovered" would
   *              reward exactly the wrong behaviour.
   */
  gatewayCostPaise: Paise;
  humanCostPaise: Paise;
  readonly attempts: ChargeAttempt[];
  readonly decisions: DecisionRecord[];
  /** How many proposed actions the policy gate refused outright. */
  blockedByPolicy: number;
  /** Which gate rules fired, and how often. Compliance evidence. */
  policyRuleCounts: Record<string, number>;
  /**
   * SIMULATOR-ONLY ground truth: the class the environment considers the real cause
   * at case open. Used for the "attempts burned on terminal cases" metric. Never
   * visible to a policy or to the agent.
   */
  readonly trueOpeningClass: FailureClass;
}

/** The read-only view a policy/agent is given. Deliberately excludes ground truth. */
export interface CaseView {
  readonly caseId: string;
  readonly arm: Arm;
  readonly now: Timestamp;
  readonly subscription: Subscription;
  readonly mandate: Mandate;
  readonly customer: Pick<Customer, 'id' | 'tenureMonths' | 'preferredLanguage' | 'bankCode'>;
  readonly openedAt: Timestamp;
  readonly attempts: ReadonlyArray<ChargeAttempt>;
  readonly attemptsUsed: number;
  readonly contactsUsed: number;
  readonly lastFailureClass: FailureClass;
  readonly horizonEndsAt: Timestamp;
}

/** Anything that decides what to do next with a case. Control policy and, in Phase 3, the agent. */
export interface RecoveryPolicy {
  readonly name: string;
  readonly arm: Arm;
  decide(view: CaseView): ActionBundle | Promise<ActionBundle>;
}
