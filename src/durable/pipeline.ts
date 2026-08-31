/**
 * The durable pipeline: Phase 1's batch, run through the Phase 2 spine.
 *
 * Same seeded population, same control policy, same simulated environment - but every
 * case now lives in Postgres, every attempt goes through the idempotent executor, and
 * every schedule is a real delayed job on a real queue.
 *
 * Running the identical scenario through both engines is the point: if the durable
 * pipeline produced different recovery numbers than the in-memory runner, one of them
 * would be wrong, and we would not know which.
 */
import type { Queue } from 'bullmq';

import type { RecoveryPolicy } from '../domain/types.ts';
import { HOUR_MS } from '../sim/clock.ts';
import { buildAtRiskPopulation, type Population } from '../sim/population.ts';
import { getPool } from '../db/pool.ts';
import { loadCase, openCase } from './caseStore.ts';
import { executeAttempt } from './executor.ts';
import { SimulatedRailClient } from './railClient.ts';
import { persistPopulation } from './repo.ts';
import { createRecoveryQueue, type ExecuteAttemptJob } from '../queue/queues.ts';
import { decideNext } from '../queue/recoveryWorker.ts';

export interface SeedResult {
  readonly population: Population;
  readonly caseIds: ReadonlyArray<string>;
  readonly queue: Queue<ExecuteAttemptJob>;
}

/**
 * Persist a seeded cohort, open a case per subscription, replay the opening charge
 * through the durable executor, and enqueue whatever the policy decides next.
 */
export async function seedAndOpenCases(
  seed: string,
  targetCases: number,
  policy: RecoveryPolicy,
  queue?: Queue<ExecuteAttemptJob>,
  breakersEnabled = true,
): Promise<SeedResult> {
  const population = buildAtRiskPopulation(seed, targetCases);
  await persistPopulation(population);

  const q = queue ?? createRecoveryQueue();
  const rail = new SimulatedRailClient(population.world);
  const caseIds: string[] = [];

  for (const atRisk of population.cases) {
    const caseId = `case_${policy.arm}_${atRisk.subscription.id}`;
    await openCase({
      id: caseId,
      subscriptionId: atRisk.subscription.id,
      cycleId: atRisk.cycleId,
      arm: policy.arm,
      diagnosis: 'UNKNOWN',
      openedAt: atRisk.scheduledAt,
      trueOpeningClass: atRisk.openingResult.trueClass ?? 'UNKNOWN',
    });
    caseIds.push(caseId);

    // The opening charge already happened when the cohort was built; run it through the
    // executor so it is recorded the same way every other attempt is. The simulator is
    // deterministic, so this reproduces the identical decline.
    await executeAttempt({
      caseId,
      attemptNo: 1,
      subscription: atRisk.subscription,
      mandate: atRisk.mandate,
      customer: atRisk.customer,
      cycleId: atRisk.cycleId,
      scheduledAt: atRisk.scheduledAt,
      rail,
    });

    const row = await loadCase(caseId);
    if (row === null) throw new Error(`case ${caseId} vanished after opening`);
    if (row.closed_at !== null) continue; // the opening charge succeeded outright

    // The first scheduling decision goes through the SAME policy + gate path as every
    // later one. It used to be hardcoded here as "retry at T+1", which meant one charge
    // per case reached the executor with no policy verdict attached - including charges
    // against mandates the gate would have refused.
    await decideNext({
      deps: { world: population.world, policy, queue: q, breakersEnabled },
      queue: q,
      caseRow: row,
      now: atRisk.scheduledAt,
      jobData: {
        caseId,
        attemptNo: 1,
        simulatedAt: atRisk.scheduledAt,
        subscriptionId: atRisk.subscription.id,
        cycleId: atRisk.cycleId,
      },
    });
  }

  return { population, caseIds, queue: q };
}

/** Wait until the queue has nothing waiting, delayed, or active. */
export async function waitForDrain(
  queue: Queue<ExecuteAttemptJob>,
  timeoutMs = 60_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let quietRounds = 0;
  while (Date.now() < deadline) {
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'waiting-children');
    const outstanding =
      (counts.waiting ?? 0) +
      (counts.active ?? 0) +
      (counts.delayed ?? 0) +
      (counts['waiting-children'] ?? 0);
    if (outstanding === 0) {
      // Two consecutive quiet reads: a worker may be between finishing one job and
      // enqueueing the next, which would briefly read as zero.
      quietRounds++;
      if (quietRounds >= 3) return true;
    } else {
      quietRounds = 0;
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

/** Per-case outcomes, for comparing the durable spine against the in-memory runner. */
export async function caseOutcomes(): Promise<
  Map<string, { outcome: string | null; attempts: number; closedAt: number | null }>
> {
  const res = await getPool().query<{
    subscription_id: string;
    outcome: string | null;
    attempts_used: number;
    closed_at: Date | null;
  }>('SELECT subscription_id, outcome, attempts_used, closed_at FROM recovery_cases');
  return new Map(
    res.rows.map((r) => [
      r.subscription_id,
      {
        outcome: r.outcome,
        attempts: r.attempts_used,
        closedAt: r.closed_at?.getTime() ?? null,
      },
    ]),
  );
}

/**
 * The human handoff queue (spec section 6 / Phase 4 deliverable).
 *
 * Not a separate table: a case in HUMAN_QUEUE state IS the queue entry, which means the
 * queue can never disagree with the case it refers to. Each row carries why it was
 * escalated and what the gate said, so an operator opens it with the context already
 * assembled rather than reconstructing it.
 */
export interface HumanQueueEntry {
  readonly caseId: string;
  readonly subscriptionId: string;
  readonly diagnosis: string;
  readonly amountPaise: number;
  readonly openedAt: Date;
  readonly escalatedAt: Date | null;
  readonly lastRuleFired: string | null;
  readonly lastReasoning: string | null;
}

export async function humanQueue(limit = 200): Promise<HumanQueueEntry[]> {
  const res = await getPool().query<{
    case_id: string;
    subscription_id: string;
    diagnosis: string;
    amount_paise: string;
    opened_at: Date;
    closed_at: Date | null;
    policy_rule_fired: string | null;
    agent_reasoning: string | null;
  }>(
    `SELECT c.id AS case_id, c.subscription_id, c.diagnosis, s.amount_paise,
            c.opened_at, c.closed_at,
            d.policy_rule_fired, d.agent_reasoning
       FROM recovery_cases c
       JOIN subscriptions s ON s.id = c.subscription_id
       LEFT JOIN LATERAL (
         SELECT policy_rule_fired, agent_reasoning
           FROM decisions WHERE case_id = c.id ORDER BY seq DESC LIMIT 1
       ) d ON TRUE
      WHERE c.state = 'HUMAN_QUEUE'
      ORDER BY c.opened_at
      LIMIT $1`,
    [limit],
  );
  return res.rows.map((r) => ({
    caseId: r.case_id,
    subscriptionId: r.subscription_id,
    diagnosis: r.diagnosis,
    amountPaise: Number(r.amount_paise),
    openedAt: r.opened_at,
    escalatedAt: r.closed_at,
    lastRuleFired: r.policy_rule_fired,
    lastReasoning: r.agent_reasoning,
  }));
}

/** How often each policy rule fired across the run. Compliance evidence. */
export async function policyRuleTally(): Promise<Array<{ rule: string; count: number }>> {
  const res = await getPool().query<{ rule: string; n: string }>(
    `SELECT policy_rule_fired AS rule, count(*)::text AS n
       FROM decisions WHERE policy_rule_fired IS NOT NULL
      GROUP BY policy_rule_fired ORDER BY count(*) DESC`,
  );
  return res.rows.map((r) => ({ rule: r.rule, count: Number(r.n) }));
}

/** Verdict distribution. Every decision must carry one. */
export async function verdictTally(): Promise<Array<{ verdict: string; count: number }>> {
  const res = await getPool().query<{ verdict: string; n: string }>(
    `SELECT policy_verdict AS verdict, count(*)::text AS n
       FROM decisions GROUP BY policy_verdict ORDER BY count(*) DESC`,
  );
  return res.rows.map((r) => ({ verdict: r.verdict, count: Number(r.n) }));
}

export interface PipelineSummary {
  readonly cases: number;
  readonly closed: number;
  readonly open: number;
  readonly recovered: number;
  readonly exhausted: number;
  readonly humanQueue: number;
  readonly attempts: number;
  readonly recoveredPaise: number;
  readonly costPaise: number;
}

export async function summarise(arm: string): Promise<PipelineSummary> {
  const res = await getPool().query<{
    cases: string;
    closed: string;
    recovered: string;
    exhausted: string;
    human_queue: string;
    attempts: string;
    recovered_paise: string;
    cost_paise: string;
  }>(
    `SELECT count(*)::text                                              AS cases,
            count(*) FILTER (WHERE closed_at IS NOT NULL)::text         AS closed,
            count(*) FILTER (WHERE state = 'RECOVERED')::text           AS recovered,
            count(*) FILTER (WHERE state = 'EXHAUSTED')::text           AS exhausted,
            count(*) FILTER (WHERE state = 'HUMAN_QUEUE')::text         AS human_queue,
            coalesce(sum(attempts_used), 0)::text                       AS attempts,
            coalesce(sum(recovered_paise), 0)::text                     AS recovered_paise,
            coalesce(sum(cost_paise), 0)::text                          AS cost_paise
       FROM recovery_cases WHERE arm = $1`,
    [arm],
  );
  const r = res.rows[0]!;
  return {
    cases: Number(r.cases),
    closed: Number(r.closed),
    open: Number(r.cases) - Number(r.closed),
    recovered: Number(r.recovered),
    exhausted: Number(r.exhausted),
    humanQueue: Number(r.human_queue),
    attempts: Number(r.attempts),
    recoveredPaise: Number(r.recovered_paise),
    costPaise: Number(r.cost_paise),
  };
}
