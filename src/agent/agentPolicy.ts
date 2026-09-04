/**
 * The agent (spec section 8, Phase 3).
 *
 * WHAT THE MODEL DOES, AND WHAT IT IS NOT ALLOWED TO DO
 * ----------------------------------------------------
 * Spec rule 2: "Do not force LLMs where deterministic code is correct... The LLM does
 * diagnosis and message generation only."
 *
 * So the division here is strict, and it is the thing to defend in the pitch:
 *
 *   THE MODEL SUPPLIES     a diagnosis, a STRATEGY (one of nine named strategies),
 *                          whether to also notify, and a rationale.
 *
 *   CODE SUPPLIES          every number. When the next inflow date falls, how many hours
 *                          that is from now, what each action costs, the expected value
 *                          of each option, whether an action fits inside the horizon,
 *                          and the idempotency of everything downstream.
 *
 * The model is never asked "retry in how many hours?" - it is asked "should this wait
 * for the customer's money to arrive?" Calendar arithmetic and expected-value arithmetic
 * are things code does correctly every time and a model does approximately, so they stay
 * in code.
 *
 * THREE LAYERS OF COST DISCIPLINE
 * -------------------------------
 * Spec section 4: "the LLM never runs over the full ledger."
 *
 *   1. TRIAGE     a terminal failure class has exactly one correct response, and the
 *                 taxonomy already knows it. Those cases never reach the model.
 *   2. CACHE      two cases presenting identical decision-relevant context have the same
 *                 correct answer. The context signature is canonicalised and memoised, so
 *                 108 insufficient-funds cases do not become 108 identical API calls.
 *                 Cache hit rate is reported, not hidden.
 *   3. FALLBACK   if the model is unavailable, a deterministic policy takes over and the
 *                 case still resolves. A recovery system that stops working when an API
 *                 is congested is not a recovery system.
 */
import type { Action, ActionBundle, CaseView, RecoveryPolicy } from '../domain/types.ts';
import { isTerminal, FAILURE_CLASSES, type FailureClass } from '../domain/taxonomy.ts';
import type { World } from '../sim/population.ts';
import {
  believedChargeSuccess,
  believedCustomerAction,
  believedSelfHeal,
  bundleCost,
} from './costModel.ts';
import { LlmUnavailableError, type DecisionModel } from './model/decisionModel.ts';
import { buildModelChain } from './model/chain.ts';
import {
  escalate_to_human,
  get_bank_health,
  get_customer_payment_history,
  get_failure_context,
  get_mandate_details,
  propose_defer,
  propose_notification,
  propose_payment_link,
  propose_remandate,
  propose_retry,
  propose_time_shift,
  propose_wait,
  stop,
  type BankHealth,
  type FailureContext,
  type MandateDetails,
  type PaymentHistory,
} from './tools.ts';

export const STRATEGIES = [
  'RETRY_SHORT_BACKOFF',
  'DEFER_PAST_DEGRADATION',
  'TIME_SHIFT_TO_INFLOW',
  'REMANDATE',
  'PAYMENT_LINK',
  'NOTIFY_ONLY',
  'WAIT',
  'ESCALATE_HUMAN',
  'STOP',
] as const;
export type Strategy = (typeof STRATEGIES)[number];

interface ModelDecision {
  diagnosis: FailureClass;
  confidence: number;
  strategy: Strategy;
  alsoNotify: boolean;
  rationale: string;
  /**
   * Set only on the unmapped-code path, and only once the diagnosis has cleared the
   * confidence floor. Travels out on the bundle for the gate to accept or discard.
   */
  reclassifiedFromUnmapped?: FailureClass;
}

/**
 * Standard JSON Schema - the portable dialect every OpenAI-compatible provider accepts.
 *
 * `additionalProperties: false` plus every property listed in `required` is what Groq's
 * strict mode needs in order to use CONSTRAINED DECODING, which guarantees the response
 * matches this shape rather than merely attempting to. The Gemini client adapts this to
 * its own dialect on the way out.
 */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    diagnosis: { type: 'string', enum: [...FAILURE_CLASSES] },
    confidence: { type: 'number' },
    strategy: { type: 'string', enum: [...STRATEGIES] },
    alsoNotify: { type: 'boolean' },
    rationale: { type: 'string' },
  },
  required: ['diagnosis', 'confidence', 'strategy', 'alsoNotify', 'rationale'],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You decide how to recover a FAILED RECURRING PAYMENT for an Indian subscription business (UPI Autopay, eNACH, and card mandates).

Retry is one option among nine, not the default. Your job is to pick the STRATEGY. You never compute dates, delays, costs, or probabilities - the calling system does all arithmetic. Do not mention specific hours or dates in your rationale.

The strategies:
- RETRY_SHORT_BACKOFF   transient fault, the rail is healthy, try again shortly
- DEFER_PAST_DEGRADATION  the destination bank is degraded right now; wait for it to recover before spending an attempt
- TIME_SHIFT_TO_INFLOW  the customer has no money now but is paid on a known date; present the charge after that inflow instead of grinding daily retries
- REMANDATE             the mandate is revoked or expired; no retry can ever succeed, the customer must re-authorise
- PAYMENT_LINK          the mandate cannot carry this charge (dead or capped below the amount); collect this cycle with a one-off link
- NOTIFY_ONLY           the customer must act or be told, but no charge or link is warranted yet
- WAIT                  doing nothing has higher expected value than acting; some customers resolve it themselves and every intervention costs money and patience
- ESCALATE_HUMAN        account closed, frozen, or risk-declined; automation must not continue
- STOP                  the attempt budget or the case horizon is spent

Principles:
1. A TERMINAL failure (revoked or expired mandate, dead card, amount above the mandate cap, closed/frozen/risk-declined account) can NEVER be fixed by a retry. Retrying one is a guaranteed loss that still costs a fee.
2. INSUFFICIENT_FUNDS is about TIMING, not persistence. A balance shortfall persists until the customer's next inflow. Retrying tomorrow mostly meets the same empty account.
3. WAIT is a real answer. Acting is not free: every charge costs a fee, every message costs customer patience.
4. Long-tenured, reliable customers deserve patience and are likelier to complete a re-authorisation. Do not treat a customer of two years like a first-month defaulter.
5. Never propose contacting a customer more than the case warrants.

Answer only in the required JSON schema.`;

/**
 * The unmapped-code prompt.
 *
 * Appended to SYSTEM_PROMPT for the one case where the rail returned a code the taxonomy
 * has never seen. Kept SEPARATE rather than folded into the base prompt so that every
 * ordinary decision is made under byte-identical instructions to before this feature
 * existed - otherwise adding it would silently move the Phase 3 numbers and there would
 * be no way to say what had changed.
 *
 * The whole safety burden of this path sits in the last paragraph. A classifier that
 * reads legible text well is worthless if it also invents readings for illegible text,
 * because the consequence is a charge presented against a mandate that can never carry
 * it. UNKNOWN must be a comfortable answer, so it is stated as the expected one.
 */
const UNMAPPED_CODE_PROMPT = `

THIS FAILURE CARRIES A CODE THIS SYSTEM HAS NEVER SEEN.

Our lookup table has no row for it, so the failure is currently unclassified, and an
unclassified failure is never automatically retried - the case would go to a human and
recover nothing. You have the rail's own description of what happened. Read it.

Set "diagnosis" to the failure class the DESCRIPTION supports, and set "confidence" to
how far the description actually supports it.

Judge the text, not the situation. You are not guessing what probably went wrong with
this customer; you are reporting what this sentence says. If the description states a
cause, name the class. If it is generic - "transaction declined", "not processed",
"refer to issuer", "operation not permitted" - then it does not establish a cause, and
the correct answer is diagnosis UNKNOWN with strategy ESCALATE_HUMAN.

Answering UNKNOWN is a correct, expected answer, not a failure to try. A wrong confident
reading is worse than no reading: it authorises a charge that may be impossible, against
a real customer's account.`;

export interface AgentDecisionTrace {
  readonly caseId: string;
  readonly usedModel: boolean;
  readonly cacheHit: boolean;
  readonly triaged: boolean;
  readonly fellBack: boolean;
  readonly strategy: Strategy;
  readonly correctedFrom: Strategy | null;
  readonly expectedValuePaise: number;
  readonly evOfWaitPaise: number;
}

/**
 * One decision in which the model was shown a rail code the taxonomy could not map.
 *
 * Recorded whether or not the reading was adopted, because the two halves are scored
 * differently and both matter: adopting a wrong reading spends money, and declining a
 * legible one wastes a recovery. An eval that only saw the adopted half would report a
 * classifier that answers nothing as flawless.
 */
export interface UnmappedRead {
  readonly caseId: string;
  readonly rawErrorCode: string;
  readonly rawErrorDesc: string;
  /** What the model said the text meant, BEFORE the confidence floor was applied. */
  readonly modelDiagnosis: FailureClass;
  readonly confidence: number;
  /** Did it clear the floor and become the case's working class? */
  readonly adopted: boolean;
}

export interface AgentStats {
  decisions: number;
  triagedDeterministically: number;
  modelCalls: number;
  cacheHits: number;
  fallbacks: number;
  corrections: number;
  /** Decisions where the rail code was unrecognised and the model was asked to read it. */
  unmappedCodesRead: number;
  /** Of those, the ones where it produced a usable class above the confidence floor. */
  unmappedCodesClassified: number;
  /** Of those, the ones where it declined - answered UNKNOWN, or below the floor. */
  unmappedCodesDeclined: number;
}

/** Everything the model is allowed to condition on. */
interface DecisionContext {
  readonly failure: FailureContext;
  readonly history: PaymentHistory;
  readonly bank: BankHealth;
  readonly mandate: MandateDetails;
}

export interface AgentPolicyOptions {
  readonly world: World;
  readonly seed: string;
  readonly client?: DecisionModel | null;
  /** Disable the model entirely and run the deterministic fallback. For tests. */
  readonly deterministicOnly?: boolean;
  /**
   * Let the model read rail codes the taxonomy does not recognise, instead of sending
   * them straight to a human.
   *
   * OFF by default, and deliberately so. Every number this project has published was
   * measured with it off, and a capability that changes the headline the moment it is
   * added is a capability nobody can price. Turned on explicitly by
   * `node src/generalization.ts`, which exists to measure what it is worth and what it
   * costs when the model reads wrong.
   */
  readonly readUnmappedCodes?: boolean;
  /**
   * Confidence at or above which a reading of an unmapped code is allowed to become the
   * case's working class. Below it, the case escalates as it would have anyway.
   *
   * This is the operating point of the whole feature: raise it to buy safety with
   * recovery, lower it to buy recovery with wasted charges. `--sweep` walks it.
   */
  readonly reclassifyMinConfidence?: number;
}

/** Default confidence floor for adopting a model's reading of an unmapped rail code. */
export const DEFAULT_RECLASSIFY_MIN_CONFIDENCE = 0.7;

export class AgentPolicy implements RecoveryPolicy {
  readonly name = 'agent-gemini';
  readonly arm = 'agent' as const;

  private readonly world: World;
  private readonly seed: string;
  private readonly client: DecisionModel | null;
  private readonly readUnmappedCodes: boolean;
  private readonly reclassifyMinConfidence: number;
  /**
   * Memoised decisions, keyed by context signature.
   *
   * Stores a PROMISE, not a value, and that is the point. With cases running
   * concurrently, a plain value cache lets a dozen cases with the identical signature
   * all miss, all call the model, and all write the same answer - a thundering herd that
   * burns a dozen API calls answering one question. Storing the in-flight promise means
   * the first case makes the call and the rest await it.
   */
  private readonly cache = new Map<string, Promise<ModelDecision>>();
  readonly stats: AgentStats = {
    decisions: 0,
    triagedDeterministically: 0,
    modelCalls: 0,
    cacheHits: 0,
    fallbacks: 0,
    corrections: 0,
    unmappedCodesRead: 0,
    unmappedCodesClassified: 0,
    unmappedCodesDeclined: 0,
  };
  readonly traces: AgentDecisionTrace[] = [];
  /** Every unmapped code the model was asked to read. Scored by src/generalization.ts. */
  readonly unmappedReads: UnmappedRead[] = [];

  constructor(opts: AgentPolicyOptions) {
    this.world = opts.world;
    this.seed = opts.seed;
    // Default to the configured provider chain rather than any single vendor: the thing
    // that has repeatedly stopped this project is one provider's quota, not a bad model.
    this.client =
      opts.deterministicOnly === true ? null : (opts.client ?? buildModelChain());
    this.readUnmappedCodes = opts.readUnmappedCodes === true;
    this.reclassifyMinConfidence =
      opts.reclassifyMinConfidence ?? DEFAULT_RECLASSIFY_MIN_CONFIDENCE;
  }

  async decide(view: CaseView): Promise<ActionBundle> {
    this.stats.decisions++;
    const ctx = this.buildContext(view);

    // Is this the one case the model can do something a lookup table cannot - a rail
    // code we have never seen, whose description may still be legible? Requires the
    // feature to be on AND a live model: with no model there is nobody to read the text,
    // and pretending otherwise would route the case away from the human it needs.
    const unmapped =
      this.readUnmappedCodes &&
      this.client !== null &&
      ctx.failure.lastFailureClass === 'UNKNOWN' &&
      !ctx.failure.lastClassificationMatched;
    if (unmapped) this.stats.unmappedCodesRead++;

    // ---- LAYER 1: deterministic triage. Never bother the model with a settled question.
    const triaged = triage(ctx, view, unmapped);
    if (triaged !== null) {
      this.stats.triagedDeterministically++;
      return this.finish(view, ctx, triaged, {
        usedModel: false, cacheHit: false, triaged: true, fellBack: false, correctedFrom: null,
      });
    }

    // ---- LAYER 2: the model, memoised on the canonical context signature.
    let decision: ModelDecision;
    let cacheHit = false;
    let fellBack = false;

    const key = signature(ctx, unmapped);
    const inFlight = this.cache.get(key);

    if (this.client === null) {
      decision = fallbackDecision(ctx);
      fellBack = true;
      this.stats.fallbacks++;
    } else if (inFlight !== undefined) {
      // Either a completed decision or one still on the wire. Either way, join it rather
      // than asking the same question again.
      //
      // The try matters: a shared promise that REJECTS reaches every joiner, not just
      // the case that created it. Without this, one quota rejection took down every
      // concurrent case waiting on the same signature - which is exactly what happened
      // the first time this cache was introduced.
      try {
        decision = await inFlight;
        cacheHit = true;
        this.stats.cacheHits++;
      } catch (err) {
        if (!(err instanceof LlmUnavailableError)) throw err;
        decision = fallbackDecision(ctx);
        fellBack = true;
        this.stats.fallbacks++;
      }
    } else {
      const client = this.client;
      const pending = (async () => {
        const result = await client.generateJson<ModelDecision>({
          system: unmapped ? SYSTEM_PROMPT + UNMAPPED_CODE_PROMPT : SYSTEM_PROMPT,
          user: renderContext(ctx, unmapped),
          responseSchema: RESPONSE_SCHEMA,
          temperature: 0,
        });
        return sanitise(result.value, ctx);
      })();

      // Published BEFORE awaiting, so concurrent cases with this signature join it.
      // A rejection must not leave an unhandled promise behind for whoever never joins.
      pending.catch(() => {});
      this.cache.set(key, pending);

      try {
        decision = await pending;
        this.stats.modelCalls++;
      } catch (err) {
        // A failed call must not poison the cache for every later case.
        this.cache.delete(key);
        if (!(err instanceof LlmUnavailableError)) throw err;
        decision = fallbackDecision(ctx);
        fellBack = true;
        this.stats.fallbacks++;
      }
    }

    // ---- The confidence floor. Only a reading the model is actually sure of becomes
    // the case's working class; everything else escalates exactly as it would have.
    if (unmapped) {
      decision = this.applyConfidenceFloor(decision, ctx, view.caseId);
    }

    // ---- LAYER 3: the taxonomy is authoritative about what is POSSIBLE.
    const corrected = correctImpossible(decision, ctx);
    if (corrected.strategy !== decision.strategy) this.stats.corrections++;

    return this.finish(view, ctx, corrected, {
      usedModel: !cacheHit && !fellBack,
      cacheHit,
      triaged: false,
      fellBack,
      correctedFrom: corrected.strategy === decision.strategy ? null : decision.strategy,
    });
  }

  /**
   * Decide whether a reading of an unmapped code is confident enough to act on.
   *
   * Below the floor - or where the model itself answered UNKNOWN - nothing is adopted and
   * the case escalates to a person, which is precisely where it would have gone without
   * this feature. The downside of the floor is therefore bounded at "no change"; the
   * upside is every case above it.
   */
  private applyConfidenceFloor(
    decision: ModelDecision,
    ctx: DecisionContext,
    caseId: string,
  ): ModelDecision {
    const usable =
      decision.diagnosis !== 'UNKNOWN' && decision.confidence >= this.reclassifyMinConfidence;

    this.unmappedReads.push({
      caseId,
      rawErrorCode: ctx.failure.lastRawErrorCode,
      rawErrorDesc: ctx.failure.lastRawErrorDesc,
      modelDiagnosis: decision.diagnosis,
      confidence: decision.confidence,
      adopted: usable,
    });

    if (!usable) {
      this.stats.unmappedCodesDeclined++;
      return {
        ...decision,
        diagnosis: 'UNKNOWN',
        strategy: 'ESCALATE_HUMAN',
        alsoNotify: false,
        rationale:
          `${decision.rationale} [not adopted: the rail's description did not establish ` +
          `a cause at the required confidence (${decision.confidence.toFixed(2)} < ` +
          `${this.reclassifyMinConfidence.toFixed(2)}); routed to a person]`,
      };
    }

    this.stats.unmappedCodesClassified++;
    return { ...decision, reclassifiedFromUnmapped: decision.diagnosis };
  }

  private buildContext(view: CaseView): DecisionContext {
    return {
      failure: get_failure_context(view),
      history: get_customer_payment_history(view, this.world),
      bank: get_bank_health(view, this.seed),
      mandate: get_mandate_details(view),
    };
  }

  /** Turn a strategy into a concrete, costed, horizon-clamped bundle. All arithmetic. */
  private finish(
    view: CaseView,
    ctx: DecisionContext,
    decision: ModelDecision,
    flags: Omit<AgentDecisionTrace, 'caseId' | 'strategy' | 'expectedValuePaise' | 'evOfWaitPaise'>,
  ): ActionBundle {
    const actions = this.buildActions(view, ctx, decision);
    const amount = view.subscription.amountPaise;

    const successP = this.believedSuccess(view, ctx, decision, actions);
    const cost = bundleCost(actions, amount);
    const ev = Math.round(successP * amount - cost);

    // EV(WAIT) is computed for EVERY decision, even when we are not waiting, because the
    // comparison is the point: an agent that cannot say what doing nothing was worth is
    // not reasoning about cost.
    const waitHours = Math.min(72, ctx.failure.hoursLeftInHorizon);
    const evWait = Math.round(believedSelfHeal(view, ctx.history, waitHours) * amount);

    this.traces.push({
      caseId: view.caseId,
      strategy: decision.strategy,
      expectedValuePaise: ev,
      evOfWaitPaise: evWait,
      ...flags,
    });

    return {
      actions,
      diagnosis: decision.diagnosis,
      confidence: decision.confidence,
      ...(decision.reclassifiedFromUnmapped === undefined
        ? {}
        : { reclassifiedFromUnmapped: decision.reclassifiedFromUnmapped }),
      rationale:
        `[${decision.strategy}] ${decision.rationale} ` +
        `(EV ${(ev / 100).toFixed(0)} vs EV(WAIT) ${(evWait / 100).toFixed(0)}; ` +
        `cost ${(cost / 100).toFixed(0)}; ` +
        `${flags.triaged ? 'deterministic triage' : flags.fellBack ? 'deterministic fallback' : flags.cacheHit ? 'cached model decision' : 'model decision'}` +
        `${flags.correctedFrom === null ? '' : `; corrected from ${flags.correctedFrom}`})`,
    };
  }

  private buildActions(
    view: CaseView,
    ctx: DecisionContext,
    decision: ModelDecision,
  ): Action[] {
    const r = decision.rationale.slice(0, 160);
    const actions: Action[] = [];

    switch (decision.strategy) {
      case 'RETRY_SHORT_BACKOFF':
        actions.push(propose_retry(r, 6));
        break;
      case 'DEFER_PAST_DEGRADATION':
        actions.push(propose_defer(view, 12, r));
        break;
      case 'TIME_SHIFT_TO_INFLOW':
        actions.push(propose_time_shift(view, this.world, r));
        break;
      case 'REMANDATE':
        actions.push(propose_remandate(r));
        break;
      case 'PAYMENT_LINK':
        actions.push(propose_payment_link(r));
        break;
      case 'NOTIFY_ONLY':
        actions.push(propose_notification(view, 'payment_failed_generic', r));
        break;
      case 'WAIT':
        actions.push(propose_wait(Math.min(48, Math.max(6, ctx.failure.hoursLeftInHorizon / 2)), r));
        break;
      case 'ESCALATE_HUMAN':
        actions.push(escalate_to_human(r));
        break;
      case 'STOP':
        actions.push(stop(r));
        break;
    }

    // Bundles compose: DEFER + NOTIFY is one decision, not two competing ones (spec §2).
    // REMANDATE and PAYMENT_LINK already carry their own customer contact, and NOTIFY_ONLY
    // is a notification, so adding another would double-count the patience cost.
    const alreadyContacts =
      decision.strategy === 'REMANDATE' ||
      decision.strategy === 'PAYMENT_LINK' ||
      decision.strategy === 'NOTIFY_ONLY';
    const terminalStrategy =
      decision.strategy === 'STOP' || decision.strategy === 'ESCALATE_HUMAN';

    if (decision.alsoNotify && !alreadyContacts && !terminalStrategy && view.contactsUsed < 2) {
      actions.push(
        propose_notification(view, 'payment_failed_with_plan', 'tell the customer the plan', 1),
      );
    }
    return actions;
  }

  private believedSuccess(
    view: CaseView,
    ctx: DecisionContext,
    decision: ModelDecision,
    actions: ReadonlyArray<Action>,
  ): number {
    const charge = actions.find(
      (a) => a.kind === 'RETRY_NOW' || a.kind === 'DEFER' || a.kind === 'TIME_SHIFT',
    );
    switch (decision.strategy) {
      case 'RETRY_SHORT_BACKOFF':
      case 'DEFER_PAST_DEGRADATION':
      case 'TIME_SHIFT_TO_INFLOW':
        return believedChargeSuccess(
          decision.diagnosis,
          ctx.history,
          charge?.delayHours ?? 0,
          ctx.bank.degraded,
        );
      case 'REMANDATE':
        return believedCustomerAction('REMANDATE', ctx.history, ctx.failure.hoursLeftInHorizon);
      case 'PAYMENT_LINK':
        return believedCustomerAction('PAYMENT_LINK', ctx.history, ctx.failure.hoursLeftInHorizon);
      case 'NOTIFY_ONLY':
      case 'WAIT':
        return believedSelfHeal(view, ctx.history, Math.min(72, ctx.failure.hoursLeftInHorizon));
      case 'ESCALATE_HUMAN':
      case 'STOP':
        return 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Layer 1: deterministic triage
// ---------------------------------------------------------------------------

/**
 * Cases whose correct handling is already settled by the taxonomy or by a budget rule.
 * Returning non-null here means the model is never called.
 */
function triage(
  ctx: DecisionContext,
  view: CaseView,
  readUnmapped: boolean,
): ModelDecision | null {
  const cls = ctx.failure.lastFailureClass;

  if (ctx.failure.hoursLeftInHorizon <= 2) {
    return det(cls, 'STOP', 'case horizon reached; further action cannot land in time');
  }

  switch (cls) {
    case 'ACCOUNT_CLOSED':
    case 'ACCOUNT_FROZEN':
    case 'RISK_DECLINE':
      return det(cls, 'ESCALATE_HUMAN', 'account state forbids automated collection');

    case 'MANDATE_REVOKED':
    case 'MANDATE_EXPIRED':
      // Exactly one route exists. Asking a model to confirm it wastes a call.
      return view.contactsUsed >= 2
        ? det(cls, 'STOP', 're-authorisation already requested and not completed')
        : det(cls, 'REMANDATE', 'mandate is dead; only re-authorisation can recover this');

    case 'AMOUNT_EXCEEDS_MANDATE':
      return view.contactsUsed >= 2
        ? det(cls, 'STOP', 'link already sent and not paid')
        : det(cls, 'PAYMENT_LINK', 'charge exceeds the mandate cap; collect this cycle by link');

    case 'CARD_EXPIRED':
      return view.contactsUsed >= 2
        ? det(cls, 'STOP', 'instrument update already requested')
        : det(cls, 'REMANDATE', 'instrument is expired; the customer must update it');

    case 'UNKNOWN':
      // Two different situations arrive here and they deserve different answers.
      //
      // A DOCUMENTED reason that maps to UNKNOWN is settled: the rail told us what it
      // could, and what it could tell us does not identify a cause. There is nothing
      // for a model to add, so this stays deterministic and goes to a person.
      //
      // An UNRECOGNISED code is not settled at all - our table simply has no row. The
      // description may say exactly what happened. When the feature is enabled, that one
      // is handed to the model to read.
      if (readUnmapped && !ctx.failure.lastClassificationMatched) return null;
      return det(cls, 'ESCALATE_HUMAN', 'unrecognised rail response; needs human triage');

    default:
      return null; // genuinely a judgment call - hand it to the model
  }
}

function det(diagnosis: FailureClass, strategy: Strategy, rationale: string): ModelDecision {
  return { diagnosis, confidence: 1, strategy, alsoNotify: false, rationale };
}

// ---------------------------------------------------------------------------
// Layer 2: caching
// ---------------------------------------------------------------------------

/**
 * Canonical signature of a decision context.
 *
 * Two cases with the same signature present the SAME evidence, so the same answer is
 * correct for both and memoising is sound rather than a shortcut. Continuous values are
 * bucketed because a customer 9 days from payday and one 10 days from payday are not a
 * different decision.
 *
 * The signature must contain everything the model is allowed to condition on. If a field
 * is added to the prompt and not to this signature, the cache starts returning answers
 * to a question that was not asked - so they are defined next to each other on purpose.
 */
const attemptPhaseOf = (ctx: DecisionContext): string =>
  ctx.failure.attemptsUsed <= 1 ? 'first' : ctx.failure.attemptsUsed === 2 ? 'second' : 'late';

const horizonOf = (ctx: DecisionContext): string =>
  ctx.failure.hoursLeftInHorizon > 168
    ? 'ample'
    : ctx.failure.hoursLeftInHorizon > 48
      ? 'limited'
      : 'closing';

function signature(ctx: DecisionContext, unmapped = false): string {
  const cls = ctx.failure.lastFailureClass;

  // An unmapped code is a QUESTION ABOUT A STRING, and two different strings are two
  // different questions. Falling through to the generic key below would collapse every
  // unrecognised code in the cohort onto one entry keyed `UNKNOWN|first|ample|...`, so
  // the first code read would answer for all of them - a cache that fabricates
  // classifications. The raw code is therefore part of the key, and the prompt variant
  // with it, since the two prompts ask different things.
  if (unmapped) {
    return ['RAW', ctx.failure.lastRawErrorCode, attemptPhaseOf(ctx), horizonOf(ctx)].join('|');
  }

  const attemptPhase = attemptPhaseOf(ctx);
  const horizon = horizonOf(ctx);
  const tenure =
    ctx.history.tenureMonths >= 24 ? 'loyal' : ctx.history.tenureMonths >= 6 ? 'established' : 'new';
  const inflow =
    ctx.history.daysUntilNextInflow <= 2
      ? 'imminent'
      : ctx.history.daysUntilNextInflow <= 7
        ? 'soon'
        : 'far';
  const contacted = ctx.failure.contactsUsed > 0 ? 'contacted' : 'uncontacted';
  const rail = ctx.bank.degraded ? 'degraded' : 'healthy';

  // The key is CLASS-CONDITIONAL: it names only the evidence that actually bears on the
  // decision for that class. When the customer's payday is irrelevant - a bank outage
  // does not care when anyone is paid - including it in the key would split one question
  // into a dozen identical ones and spend a dozen API calls answering them.
  switch (cls) {
    case 'INSUFFICIENT_FUNDS':
      return ['IF', attemptPhase, horizon, contacted, ctx.history.reliabilityBand, tenure, inflow].join('|');
    case 'BANK_DOWNTIME':
      return ['BD', attemptPhase, horizon, rail].join('|');
    case 'TECHNICAL_DECLINE':
      return ['TD', attemptPhase, horizon, rail, ctx.history.reliabilityBand].join('|');
    default:
      return [cls, attemptPhase, horizon, contacted].join('|');
  }
}

// ---------------------------------------------------------------------------
// Layer 3: guards
// ---------------------------------------------------------------------------

/** Keep a malformed or out-of-range model response inside the contract. */
function sanitise(raw: ModelDecision, ctx: DecisionContext): ModelDecision {
  const strategy = (STRATEGIES as ReadonlyArray<string>).includes(raw.strategy)
    ? raw.strategy
    : 'WAIT';
  const diagnosis = (FAILURE_CLASSES as ReadonlyArray<string>).includes(raw.diagnosis)
    ? raw.diagnosis
    : ctx.failure.lastFailureClass;
  const confidence = Number.isFinite(raw.confidence)
    ? Math.min(1, Math.max(0, raw.confidence))
    : 0.5;
  return {
    diagnosis,
    strategy,
    confidence,
    alsoNotify: raw.alsoNotify === true,
    rationale: typeof raw.rationale === 'string' ? raw.rationale.slice(0, 400) : '',
  };
}

/**
 * The taxonomy is authoritative about what is POSSIBLE, and it outranks the model.
 *
 * This is not the policy gate - that is Phase 4, it is deterministic, and it will block
 * on compliance grounds. This is narrower: a retry against a revoked mandate is not a
 * bad idea to be argued about, it is an impossibility, and no amount of confidence makes
 * it work. Corrections are counted and reported rather than applied silently.
 */
function correctImpossible(decision: ModelDecision, ctx: DecisionContext): ModelDecision {
  const chargeStrategies: ReadonlyArray<Strategy> = [
    'RETRY_SHORT_BACKOFF',
    'DEFER_PAST_DEGRADATION',
    'TIME_SHIFT_TO_INFLOW',
  ];
  const proposesCharge = chargeStrategies.includes(decision.strategy);

  // The class actually in play. On the unmapped-code path the taxonomy still says
  // UNKNOWN, so checking only its verdict would let "I read this as a revoked mandate,
  // therefore retry it" through as merely inconsistent rather than impossible.
  const effective = decision.reclassifiedFromUnmapped ?? ctx.failure.lastFailureClass;

  if (proposesCharge && isTerminal(effective)) {
    return {
      ...decision,
      strategy: ctx.mandate.amountWithinCap ? 'REMANDATE' : 'PAYMENT_LINK',
      rationale:
        `${decision.rationale} [corrected: ${effective} is terminal; ` +
        'no charge on this mandate can succeed]',
    };
  }

  if (proposesCharge && !ctx.mandate.amountWithinCap) {
    return {
      ...decision,
      strategy: 'PAYMENT_LINK',
      rationale: `${decision.rationale} [corrected: amount exceeds the mandate cap]`,
    };
  }

  return decision;
}

// ---------------------------------------------------------------------------
// Fallback: what happens when the model is unavailable
// ---------------------------------------------------------------------------

/**
 * Deterministic policy used when the model cannot be reached.
 *
 * It encodes the taxonomy's own recommended intervention. It is deliberately NOT as good
 * as the model - it has no view on tenure or on when acting is worse than waiting - but
 * it always resolves the case, which is the property that matters when an API is down.
 */
export function fallbackDecision(ctx: DecisionContext): ModelDecision {
  const cls = ctx.failure.lastFailureClass;
  const r = 'deterministic fallback: model unavailable';

  switch (cls) {
    case 'INSUFFICIENT_FUNDS':
      return ctx.history.daysUntilNextInflow * 24 < ctx.failure.hoursLeftInHorizon
        ? det(cls, 'TIME_SHIFT_TO_INFLOW', `${r}; wait for the customer's inflow`)
        : det(cls, 'WAIT', `${r}; no inflow lands inside the horizon`);
    case 'BANK_DOWNTIME':
      return det(cls, 'DEFER_PAST_DEGRADATION', `${r}; hold until the rail recovers`);
    case 'TECHNICAL_DECLINE':
      return ctx.bank.degraded
        ? det(cls, 'DEFER_PAST_DEGRADATION', `${r}; bank is degraded`)
        : det(cls, 'RETRY_SHORT_BACKOFF', `${r}; transient fault`);
    case 'UNKNOWN':
      // Never a retry. An unrecognised rail response means we cannot say whether a
      // charge could succeed, and the conservative answer to that is a person, not
      // another debit attempt on someone's account.
      return det(cls, 'ESCALATE_HUMAN', `${r}; unrecognised failure, not auto-retried`);
    default:
      return det(cls, 'STOP', r);
  }
}

// ---------------------------------------------------------------------------
// Prompt rendering
// ---------------------------------------------------------------------------

function renderContext(ctx: DecisionContext, unmapped = false): string {
  const f = ctx.failure;
  const h = ctx.history;

  // On the unmapped path the taxonomy's verdict is not evidence - "UNKNOWN" is our own
  // table admitting it has no row, and printing it as a finding would invite the model
  // to reason about a classification instead of about the rail's words. So the raw
  // response replaces it, and it is the only new thing the model is given.
  const failureLines = unmapped
    ? [
        `- rail response code: ${f.lastRawErrorCode || '(none)'}  <- NOT IN OUR TAXONOMY`,
        `- rail's own description: "${f.lastRawErrorDesc || '(none supplied)'}"`,
      ]
    : [
        `- last failure class: ${f.lastFailureClass}${f.isTerminalClass ? ' (TERMINAL - no retry can ever succeed)' : ''}`,
      ];

  return [
    'FAILED RECURRING PAYMENT',
    `- amount: INR ${(f.amountPaise / 100).toFixed(2)} on ${ctx.mandate.rail}`,
    ...failureLines,
    `- charge attempts already spent this cycle: ${f.attemptsUsed}`,
    `- messages already sent to this customer: ${f.contactsUsed}`,
    `- attempt history: ${f.attemptHistory.map((a) => `#${a.attemptNo} ${a.failureClass}`).join(', ') || 'none'}`,
    '',
    'CUSTOMER',
    `- relationship length: ${h.tenureMonths} months`,
    `- payment reliability: ${h.reliabilityBand}`,
    `- income arrives on day ${h.inflowDayOfMonth} of the month`,
    `- days since their last inflow: ${h.daysSinceLastInflow}`,
    `- their next inflow is ${h.daysUntilNextInflow} day(s) away`,
    '',
    'RAIL AND MANDATE',
    `- destination bank recent uptime: ${ctx.bank.recentUptimePct}%${ctx.bank.degraded ? ' (DEGRADED right now)' : ''}`,
    `- mandate status: ${ctx.mandate.status}, age ${ctx.mandate.ageMonths} months`,
    `- charge is ${ctx.mandate.amountWithinCap ? 'within' : 'ABOVE'} the mandate cap`,
    '',
    'BUDGET',
    `- time left before this case is abandoned: ${Math.round(f.hoursLeftInHorizon / 24)} day(s)`,
    '',
    'Choose the strategy with the best expected outcome, remembering that acting costs money and patience, and that doing nothing is sometimes correct.',
  ].join('\n');
}
