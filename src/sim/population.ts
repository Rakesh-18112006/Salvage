/**
 * ############################  SIMULATOR  ############################
 * Builds the seeded population of subscriptions and the at-risk cohort the arms run
 * against. SIMULATED DATA. Customers, banks, and mandates are fictional.
 * #####################################################################
 *
 * PHASE 1 DEFECT FIX (spec section 8):
 *   The previous build recorded the opening attempt as a failure unconditionally. When
 *   the simulated opening charge actually succeeded it was logged with an empty error
 *   code and classified as UNKNOWN, polluting the cohort with subscriptions that were
 *   never at risk and inflating the baseline recovery rate.
 *
 *   Here the cohort is "subscriptions whose opening charge genuinely failed" BY
 *   CONSTRUCTION: candidates are generated and charged, successes are discarded, and
 *   generation continues until the target cohort size is reached. Every case therefore
 *   opens with a real decline code and a real failure class. The discard count is
 *   reported so the selection is visible rather than hidden.
 */
import type {
  Customer,
  Mandate,
  Rail,
  Subscription,
  Timestamp,
} from '../domain/types.ts';
import { SIMULATED_BANKS } from './banks.ts';
import { atIstDayOfMonth, fromIst } from './clock.ts';
import { Rng, seedTag } from './rng.ts';
import {
  attemptCharge,
  type RailDialect,
  type SimAttemptResult,
  type SimContext,
} from './paymentSimulator.ts';

/** The IST month the simulated billing cycle runs in. */
export const SIM_CYCLE_YEAR = 2026;
export const SIM_CYCLE_MONTH = 3; // March 2026

export class World implements SimContext {
  readonly seed: string;
  /**
   * The decline vocabulary this world's rails speak. Null (the default) means this
   * build's own SIM_ codes, which the taxonomy maps. The generalization eval supplies a
   * dialect the taxonomy has never seen; nothing else does.
   */
  readonly dialect: RailDialect | null;
  private readonly customers = new Map<string, Customer>();
  private readonly mandates = new Map<string, Mandate>();
  private readonly subscriptions = new Map<string, Subscription>();

  constructor(seed: string, dialect: RailDialect | null = null) {
    this.seed = seed;
    this.dialect = dialect;
  }

  add(customer: Customer, mandate: Mandate, subscription: Subscription): void {
    this.customers.set(customer.id, customer);
    this.mandates.set(mandate.id, mandate);
    this.subscriptions.set(subscription.id, subscription);
  }

  customer(id: string): Customer {
    const c = this.customers.get(id);
    if (c === undefined) throw new Error(`unknown customer: ${id}`);
    return c;
  }

  mandate(id: string): Mandate {
    const m = this.mandates.get(id);
    if (m === undefined) throw new Error(`unknown mandate: ${id}`);
    return m;
  }

  subscription(id: string): Subscription {
    const s = this.subscriptions.get(id);
    if (s === undefined) throw new Error(`unknown subscription: ${id}`);
    return s;
  }

  get size(): number {
    return this.subscriptions.size;
  }

  /** Does this world know the subscription? Lets a caller refresh instead of throwing. */
  hasSubscription(id: string): boolean {
    return this.subscriptions.has(id);
  }
}

export interface AtRiskCase {
  readonly subscription: Subscription;
  readonly mandate: Mandate;
  readonly customer: Customer;
  readonly cycleId: string;
  readonly scheduledAt: Timestamp;
  readonly openingResult: SimAttemptResult;
}

export interface PopulationStats {
  readonly candidatesGenerated: number;
  readonly openingChargesSucceeded: number;
  readonly atRiskCases: number;
  /** Share of generated candidates whose opening charge failed. */
  readonly openingFailureRate: number;
}

export interface Population {
  readonly world: World;
  readonly cases: ReadonlyArray<AtRiskCase>;
  readonly stats: PopulationStats;
}

const RAIL_WEIGHTS: ReadonlyArray<readonly [Rail, number]> = [
  ['upi_autopay', 0.50],
  ['enach', 0.28],
  ['card', 0.22],
];

/** Generate candidate number `i`. Pure function of (seed, i). */
function generateCandidate(seed: string, i: number): {
  customer: Customer;
  mandate: Mandate;
  subscription: Subscription;
  scheduledAt: Timestamp;
} {
  const rng = new Rng(`${seed}|candidate|${i}`);

  const bankCode = rng.weighted(SIMULATED_BANKS.map((b) => [b.code, b.share] as const));
  const rail = rng.weighted(RAIL_WEIGHTS);

  // Inflow lands early in the month for most; some are irregular earners.
  const inflowDay = rng.weighted([
    [1, 0.44],
    [2, 0.16],
    [5, 0.12],
    [7, 0.12],
    [10, 0.09],
    [15, 0.07],
  ] as const);

  const reliability = Number(rng.float(0.30, 1.00).toFixed(4));
  const tenureMonths = rng.weighted([
    [1, 0.16], [3, 0.20], [6, 0.20], [12, 0.20], [24, 0.16], [40, 0.08],
  ] as const);

  // Prevalences are calibrated so that terminal causes make up roughly a quarter to a
  // third of FAILURES, which is the proportion the problem statement describes.
  const accountState = rng.weighted([
    ['normal', 0.9935],
    ['frozen', 0.0025],
    ['risk_flagged', 0.0030],
    ['closed', 0.0010],
  ] as const) as Customer['accountState'];

  const preferredLanguage = rng.weighted([
    ['hinglish', 0.50], ['english', 0.35], ['hindi', 0.15],
  ] as const) as Customer['preferredLanguage'];

  const mandateStatus = rng.weighted([
    ['active', 0.965],
    ['revoked', 0.023],
    ['expired', 0.012],
  ] as const) as Mandate['status'];

  // Subscription price points, in paise.
  const amountPaise = rng.weighted([
    [19_900, 0.20],
    [49_900, 0.26],
    [99_900, 0.22],
    [149_900, 0.14],
    [299_900, 0.11],
    [999_900, 0.07],
  ] as const);

  // Billing day spread across the month. Later billing days are more exposed to the
  // liquidity trough - that asymmetry is the point of the model, not a bug.
  const billingDay = rng.int(1, 28);

  // Mandate cap. Usually comfortably above the charge; sometimes the price rose after
  // the mandate was signed, which is a terminal AMOUNT_EXCEEDS_MANDATE failure.
  const capUndersized = rng.chance(0.007);
  const maxAmountPaise = capUndersized
    ? Math.floor(amountPaise * rng.float(0.50, 0.95))
    : Math.floor(amountPaise * rng.float(1.2, 3.0));

  const cycleAnchor = fromIst(SIM_CYCLE_YEAR, SIM_CYCLE_MONTH, 1, 0, 0);
  const createdAt = cycleAnchor - tenureMonths * 30 * 86_400_000;

  // Card instruments expire; a slice of them have already lapsed by the cycle date.
  const cardExpired = rail === 'card' && rng.chance(0.025);
  const cardExpiresAt =
    rail === 'card'
      ? cardExpired
        ? cycleAnchor - rng.int(1, 90) * 86_400_000
        : cycleAnchor + rng.int(60, 900) * 86_400_000
      : undefined;

  // Ids are SEED-SCOPED. Candidate 8 of seed A and candidate 8 of seed B are entirely
  // different customers, and giving them the same id lets one silently overwrite - or,
  // with ON CONFLICT DO NOTHING, silently impersonate - the other in shared storage.
  const tag = seedTag(seed);
  const n = i.toString().padStart(6, '0');
  const customerId = `cus_${tag}_${n}`;
  const mandateId = `mnd_${tag}_${n}`;
  const subscriptionId = `sub_${tag}_${n}`;

  const customer: Customer = {
    id: customerId,
    bankCode,
    inflowDay,
    reliability,
    tenureMonths,
    accountState,
    preferredLanguage,
  };

  const mandate: Mandate = {
    id: mandateId,
    customerId,
    rail,
    bankCode,
    maxAmountPaise,
    status: mandateStatus,
    createdAt,
    ...(cardExpiresAt !== undefined ? { cardExpiresAt } : {}),
  };

  const subscription: Subscription = {
    id: subscriptionId,
    mandateId,
    customerId,
    amountPaise,
    billingDay,
    status: 'active',
  };

  // Rails present recurring debits early in the day, in batches. The hour matters: it
  // decides whether the charge lands inside a bank's overnight maintenance window.
  const presentmentHour = rng.weighted([
    [0, 0.03], [1, 0.05], [2, 0.07], [3, 0.09], [4, 0.10], [5, 0.11],
    [6, 0.12], [7, 0.12], [8, 0.10], [9, 0.08], [10, 0.07], [11, 0.06],
  ] as const);
  const scheduledAt = atIstDayOfMonth(cycleAnchor, billingDay, presentmentHour, 0);

  return { customer, mandate, subscription, scheduledAt };
}

/**
 * Build a cohort of exactly `targetCases` subscriptions whose opening charge genuinely
 * failed. Deterministic in `seed`.
 */
export interface PopulationOptions {
  /**
   * Rail decline vocabulary. Omit for this build's mapped SIM_ codes.
   *
   * Changing the dialect does NOT change which cases fail or why: causes are decided
   * before any code is rendered (src/sim/paymentSimulator.ts). A cohort built on the
   * same seed with and without a dialect is the same cohort, described differently.
   */
  readonly dialect?: RailDialect | null;
}

export function buildAtRiskPopulation(
  seed: string,
  targetCases: number,
  opts: PopulationOptions = {},
): Population {
  const world = new World(seed, opts.dialect ?? null);
  const cases: AtRiskCase[] = [];

  let generated = 0;
  let succeeded = 0;
  const maxCandidates = targetCases * 200 + 1000; // generous; guards against a bad model

  while (cases.length < targetCases) {
    if (generated >= maxCandidates) {
      throw new Error(
        `population model produced too few failures: ${cases.length}/${targetCases} ` +
          `after ${generated} candidates`,
      );
    }
    const cand = generateCandidate(seed, generated);
    generated++;
    world.add(cand.customer, cand.mandate, cand.subscription);

    const result = attemptCharge(world, {
      subscription: cand.subscription,
      mandate: cand.mandate,
      customer: cand.customer,
      attemptNo: 1,
      at: cand.scheduledAt,
    });

    if (result.status === 'success') {
      succeeded++;
      continue; // never at risk - excluded from the cohort by construction
    }

    cases.push({
      subscription: cand.subscription,
      mandate: cand.mandate,
      customer: cand.customer,
      cycleId: `${SIM_CYCLE_YEAR}-${String(SIM_CYCLE_MONTH).padStart(2, '0')}`,
      scheduledAt: cand.scheduledAt,
      openingResult: result,
    });
  }

  return {
    world,
    cases,
    stats: {
      candidatesGenerated: generated,
      openingChargesSucceeded: succeeded,
      atRiskCases: cases.length,
      openingFailureRate: cases.length / generated,
    },
  };
}
