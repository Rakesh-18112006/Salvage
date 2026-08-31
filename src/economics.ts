/**
 * THE TWO ECONOMIC QUESTIONS THE RESULT TABLES DO NOT ANSWER.
 *
 * 1. "YOUR SYSTEM COSTS MORE PER RUPEE"
 * ------------------------------------
 * On the all-in measure - the one that prices customer patience and friction alongside
 * cash - the agent is WORSE than the control arm. Phase 3 has always printed that row
 * rather than hiding it, which is right but not sufficient: a disclosed weakness with no
 * structure around it just hands the objection to whoever reads it.
 *
 * The row is worse for a reason that is not a defect. The control arm never messages
 * anybody, so it pays no patience cost at all; the agent recovers more money partly BY
 * messaging people. Whether that trade is worth making depends entirely on what a
 * customer contact is worth, and that is a number we invented
 * (`cost.contact_patience`, 1500 paise, "there is no invoice for customer annoyance").
 *
 * So the honest object is not a verdict, it is a CURVE. `breakEvenCurve` computes the
 * all-in cost of both arms across a range of prices for patience and friction, and finds
 * the crossover. Below it the agent wins on every measure; above it there is a genuine
 * trade-off to argue about. That converts "we are worse on this row" into "here is the
 * assumption the answer turns on, and here is where it flips".
 *
 * 2. "WOULD THIS SURVIVE OUR VOLUME?"
 * ----------------------------------
 * A live 300-case run takes about seven minutes, which invites the conclusion that the
 * architecture cannot scale. It is a free-tier rate limit (8,000 tokens per minute), not
 * an architectural property, and the distinction is easy to demonstrate: `modelCostAtScale`
 * projects from the OBSERVED call and token counts of a real run.
 *
 * PRICE DISCIPLINE. The per-token price is an INPUT with no default that pretends to be
 * a fact. This project's rule about the gateway fee applies here too: it is a stand-in
 * until someone substitutes a real published price and a date. What is measured here is
 * calls and tokens per thousand cases; the money is arithmetic on top of a number you
 * supply.
 */
import type { ArmMetrics } from './engine/metrics.ts';

// ---------------------------------------------------------------------------
// 1. Break-even on the all-in cost
// ---------------------------------------------------------------------------

export interface BreakEvenPoint {
  /** Multiplier applied to the modelled patience/friction prices. 1.0 = as assumed. */
  readonly k: number;
  readonly controlAllInPaise: number;
  readonly agentAllInPaise: number;
  readonly agentBetter: boolean;
}

export interface BreakEvenCurve {
  readonly points: ReadonlyArray<BreakEvenPoint>;
  /**
   * The multiplier at which the two arms cost the same per rupee recovered, or null when
   * they never cross in a meaningful range.
   *
   * Below this value the agent is cheaper on EVERY measure and the trade-off disappears.
   */
  readonly crossoverK: number | null;
  /** The patience price, in paise per contact, at the crossover. */
  readonly crossoverContactPaise: number | null;
}

/**
 * All-in cost per rupee recovered when the shadow (non-cash) costs are scaled by `k`.
 *
 * Cash costs - gateway fees, human handoff - are real outflows and are never scaled.
 * Only the modelled price of annoyance and friction moves, because that is the only part
 * of the number that is our invention rather than a payment.
 */
function allInAt(m: ArmMetrics, k: number): number {
  const shadow = m.totalCostPaise - m.cashCostPaise;
  const rupees = m.recoveredPaise / 100;
  if (rupees === 0) return Number.POSITIVE_INFINITY;
  return (m.cashCostPaise + k * shadow) / rupees;
}

export function breakEvenCurve(
  control: ArmMetrics,
  agent: ArmMetrics,
  opts: { readonly assumedContactPaise: number; readonly steps?: ReadonlyArray<number> } ,
): BreakEvenCurve {
  const steps =
    opts.steps ?? [0, 0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

  const points = steps.map((k) => {
    const c = allInAt(control, k);
    const a = allInAt(agent, k);
    return { k, controlAllInPaise: c, agentAllInPaise: a, agentBetter: a < c };
  });

  // Both curves are straight lines in k, so the crossover is exact arithmetic rather
  // than a search: solve cashC + k*shadowC = cashA + k*shadowA, each per rupee.
  const perRupee = (m: ArmMetrics) => {
    const rupees = m.recoveredPaise / 100;
    return {
      cash: rupees === 0 ? Number.POSITIVE_INFINITY : m.cashCostPaise / rupees,
      shadow: rupees === 0 ? Number.POSITIVE_INFINITY : (m.totalCostPaise - m.cashCostPaise) / rupees,
    };
  };
  const c = perRupee(control);
  const a = perRupee(agent);
  const denom = a.shadow - c.shadow;
  const crossoverK = denom === 0 ? null : (c.cash - a.cash) / denom;

  const usable = crossoverK !== null && Number.isFinite(crossoverK) && crossoverK > 0;
  return {
    points,
    crossoverK: usable ? crossoverK : null,
    crossoverContactPaise: usable ? crossoverK * opts.assumedContactPaise : null,
  };
}

// ---------------------------------------------------------------------------
// 2. Model cost at volume
// ---------------------------------------------------------------------------

export interface ObservedModelUsage {
  readonly cases: number;
  readonly decisions: number;
  readonly triagedDeterministically: number;
  readonly cacheHits: number;
  readonly modelCalls: number;
  readonly promptTokens: number;
  readonly outputTokens: number;
}

export interface ScaleProjection {
  readonly decisionsPerCase: number;
  /** Share of decisions that never reached a model, for any reason. */
  readonly settledWithoutModelPct: number;
  readonly cacheHitPct: number;
  readonly modelCallsPer1000Cases: number;
  readonly promptTokensPer1000Cases: number;
  readonly outputTokensPer1000Cases: number;
  /** Null when no price was supplied - which is the honest default. */
  readonly costPerMillionCasesRupees: number | null;
  /**
   * Model spend as a share of the money recovered, or null without a price. The only
   * ratio that actually decides whether the model is affordable.
   */
  readonly costAsShareOfRecoveredPct: number | null;
}

export interface TokenPrice {
  readonly inputRupeesPerMillionTokens: number;
  readonly outputRupeesPerMillionTokens: number;
  /** Where the price came from. Required, so an invented number cannot travel silently. */
  readonly source: string;
}

/**
 * Project a real run's model usage to volume.
 *
 * The cache is what makes this projection favourable, and it is also what makes it
 * UNCERTAIN at scale: hit rate depends on how many distinct decision contexts a cohort
 * contains, and a larger, more varied portfolio will produce more of them. Treat the
 * observed rate as an upper bound on what a bigger cohort would achieve, and say so when
 * quoting the number.
 */
export function modelCostAtScale(
  observed: ObservedModelUsage,
  recoveredPaise: number,
  price: TokenPrice | null,
): ScaleProjection {
  const { cases, decisions, modelCalls, cacheHits, triagedDeterministically } = observed;
  const per1000 = cases === 0 ? 0 : 1000 / cases;

  const settledWithoutModel = triagedDeterministically + cacheHits;
  const promptPer1000 = observed.promptTokens * per1000;
  const outputPer1000 = observed.outputTokens * per1000;

  let costPerMillionCasesRupees: number | null = null;
  let costAsShareOfRecoveredPct: number | null = null;

  if (price !== null) {
    const promptPerMillionCases = promptPer1000 * 1000;
    const outputPerMillionCases = outputPer1000 * 1000;
    costPerMillionCasesRupees =
      (promptPerMillionCases / 1_000_000) * price.inputRupeesPerMillionTokens +
      (outputPerMillionCases / 1_000_000) * price.outputRupeesPerMillionTokens;

    // Recovered rupees scaled to the same million cases.
    const recoveredRupeesPerMillionCases =
      cases === 0 ? 0 : (recoveredPaise / 100) * (1_000_000 / cases);
    costAsShareOfRecoveredPct =
      recoveredRupeesPerMillionCases === 0
        ? null
        : (costPerMillionCasesRupees / recoveredRupeesPerMillionCases) * 100;
  }

  return {
    decisionsPerCase: cases === 0 ? 0 : decisions / cases,
    settledWithoutModelPct: decisions === 0 ? 0 : (settledWithoutModel / decisions) * 100,
    cacheHitPct: decisions === 0 ? 0 : (cacheHits / decisions) * 100,
    modelCallsPer1000Cases: modelCalls * per1000,
    promptTokensPer1000Cases: promptPer1000,
    outputTokensPer1000Cases: outputPer1000,
    costPerMillionCasesRupees,
    costAsShareOfRecoveredPct,
  };
}

/**
 * Read a token price from the environment, or return null.
 *
 * Deliberately NOT defaulted to a number. Every published provider price changes, and a
 * hardcoded one would be quoted back as a fact about a vendor by someone reading a table
 * six months later. Absent a price the projection reports calls and tokens, which are
 * measurements, and stays silent about money, which would be a claim.
 *
 *   SALVAGE_MODEL_INPUT_RUPEES_PER_MTOK=...
 *   SALVAGE_MODEL_OUTPUT_RUPEES_PER_MTOK=...
 *   SALVAGE_MODEL_PRICE_SOURCE="provider pricing page, retrieved YYYY-MM-DD"
 */
export function tokenPriceFromEnv(): TokenPrice | null {
  const inp = process.env.SALVAGE_MODEL_INPUT_RUPEES_PER_MTOK;
  const out = process.env.SALVAGE_MODEL_OUTPUT_RUPEES_PER_MTOK;
  if (inp === undefined || out === undefined) return null;

  const i = Number.parseFloat(inp);
  const o = Number.parseFloat(out);
  if (!Number.isFinite(i) || !Number.isFinite(o)) return null;

  return {
    inputRupeesPerMillionTokens: i,
    outputRupeesPerMillionTokens: o,
    source:
      process.env.SALVAGE_MODEL_PRICE_SOURCE ??
      'UNSOURCED - set SALVAGE_MODEL_PRICE_SOURCE to record where this price came from',
  };
}
