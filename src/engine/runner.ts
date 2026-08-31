/**
 * Batch runner. Builds one seeded at-risk cohort and runs one or more arms against it.
 *
 * Every arm receives the SAME `Population` object. Combined with the order-independent
 * environment draws in src/sim/rng.ts, that is what makes the comparison meaningful:
 * the control arm and the agent arm face an identical world and differ only in what
 * they decide to do (spec rule 5).
 */
import type { RecoveryCase, RecoveryPolicy } from '../domain/types.ts';
import { buildAtRiskPopulation, type Population } from '../sim/population.ts';
import { runCase } from './caseRunner.ts';
import { computeMetrics, type ArmMetrics } from './metrics.ts';

export interface ArmResult {
  readonly metrics: ArmMetrics;
  readonly cases: ReadonlyArray<RecoveryCase>;
}

export async function runArm(
  population: Population,
  policy: RecoveryPolicy,
  concurrency = 1,
): Promise<ArmResult> {
  // Cases are independent and every environment draw is order-independent, so running
  // them concurrently cannot change any outcome - it only stops a policy that makes
  // network calls from taking an hour. Results are written back by index so the case
  // ORDER is identical regardless of completion order, which keeps metrics reproducible.
  const cases: RecoveryCase[] = new Array<RecoveryCase>(population.cases.length);
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= population.cases.length) return;
      cases[i] = await runCase({
        world: population.world,
        atRisk: population.cases[i]!,
        policy,
        caseIdPrefix: `case_${policy.arm}`,
      });
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, population.cases.length)) }, worker),
  );
  const metrics = computeMetrics(
    policy.arm,
    policy.name,
    cases,
    (id) => population.world.subscription(id),
  );
  return { metrics, cases };
}

export interface BatchResult {
  readonly population: Population;
  readonly arms: ReadonlyArray<ArmResult>;
}

export async function runBatch(
  seed: string,
  targetCases: number,
  policies: ReadonlyArray<RecoveryPolicy>,
  concurrency = 1,
): Promise<BatchResult> {
  const population = buildAtRiskPopulation(seed, targetCases);
  const arms: ArmResult[] = [];
  for (const policy of policies) {
    arms.push(await runArm(population, policy, concurrency));
  }
  return { population, arms };
}

/** Incremental lift of `treatment` over `control`. Never report gross (spec section 9). */
export interface Lift {
  readonly recoveryRatePpt: number;
  readonly recoveredPaiseDelta: number;
  readonly attemptsDeltaPct: number;
  readonly contactsDelta: number;
  readonly costPerRupeeDeltaPct: number;
  readonly allInCostPerRupeeDeltaPct: number;
}

export function computeLift(control: ArmMetrics, treatment: ArmMetrics): Lift {
  return {
    recoveryRatePpt: treatment.recoveryRatePct - control.recoveryRatePct,
    recoveredPaiseDelta: treatment.recoveredPaise - control.recoveredPaise,
    attemptsDeltaPct:
      control.totalAttempts === 0
        ? 0
        : ((treatment.totalAttempts - control.totalAttempts) / control.totalAttempts) * 100,
    contactsDelta: treatment.totalContacts - control.totalContacts,
    costPerRupeeDeltaPct:
      control.costPerRupeeRecovered === 0
        ? 0
        : ((treatment.costPerRupeeRecovered - control.costPerRupeeRecovered) /
            control.costPerRupeeRecovered) *
          100,
    allInCostPerRupeeDeltaPct:
      control.allInCostPerRupeeRecovered === 0
        ? 0
        : ((treatment.allInCostPerRupeeRecovered - control.allInCostPerRupeeRecovered) /
            control.allInCostPerRupeeRecovered) *
          100,
  };
}
