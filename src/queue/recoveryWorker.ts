/**
 * The recovery worker: the durable equivalent of Phase 1's in-memory case runner.
 *
 * One job = one charge attempt. After the attempt settles, the worker asks the policy
 * what to do next and either enqueues the next attempt (delayed) or closes the case.
 *
 * The worker holds no state between jobs. Everything it needs is in Postgres, which is
 * why killing it is survivable: a replacement picks up exactly where it left off.
 */
import type { Job } from 'bullmq';

import type { ActionBundle, CaseView, RecoveryPolicy, Timestamp } from '../domain/types.ts';
import { COST, SIM } from '../assumptions.ts';
import { DAY_MS, HOUR_MS } from '../sim/clock.ts';
import type { World } from '../sim/population.ts';
import { getPool, withTransaction } from '../db/pool.ts';
import { appendEvent, loadCase, transitionCase, VersionConflictError } from '../durable/caseStore.ts';
import { executeAttempt } from '../durable/executor.ts';
import { checkBreaker } from '../durable/circuitBreaker.ts';
import { SimulatedRailClient } from '../durable/railClient.ts';
import { selfHealsOn } from '../sim/paymentSimulator.ts';
import { respondToAsk } from '../sim/customerResponse.ts';
import { fromIst, istParts } from '../sim/clock.ts';
import { enqueueOutbox } from '../durable/outbox.ts';
import { evaluate as evaluatePolicy, type GateDecision } from '../policy/gate.ts';
import { loadWorld } from '../durable/repo.ts';
import { CONTACT_POLICY, RBI } from '../policy/compliance.ts';
import {
  createRecoveryQueue,
  jobIdFor,
  simHoursToRealMs,
  type ExecuteAttemptJob,
} from './queues.ts';
import type { Queue } from 'bullmq';

/** Upper bound on breaker deferrals per attempt, so a stuck rail cannot loop forever. */
const MAX_DEFERS = 50;

export interface RecoveryWorkerDeps {
  readonly world: World;
  readonly policy: RecoveryPolicy;
  readonly queue?: Queue<ExecuteAttemptJob>;
  /**
   * Circuit breakers on (default) or off.
   *
   * This flag exists so the durable spine can be cross-validated against the Phase 1
   * in-memory runner, which has no breakers. With breakers off the two engines must
   * agree case for case; with them on they differ exactly on the cases a breaker
   * deferred - which is a real behavioural difference, not a defect, and one we would
   * rather measure than assume. See test/engineEquivalence.test.ts.
   */
  readonly breakersEnabled?: boolean;
}

export function makeJobProcessor(deps: RecoveryWorkerDeps) {
  const queue = deps.queue ?? createRecoveryQueue();

  /**
   * Reference data, refreshable.
   *
   * A long-lived worker CANNOT snapshot the world at boot. New subscriptions appear
   * continuously in any real system, and a worker that loaded its customers once will
   * fail every job for a customer created after it started - which is exactly what
   * happened the first time the chaos demo ran against containers that had been up
   * since the previous batch: 37 cases failed with "unknown subscription" and were
   * stranded. The lookup misses, so the worker reloads rather than throwing.
   */
  let world = deps.world;
  let refreshing: Promise<void> | null = null;

  const ensureKnown = async (subscriptionId: string): Promise<void> => {
    if (world.hasSubscription(subscriptionId)) return;
    // Collapse concurrent refreshes: a batch of unknown ids should cost one reload.
    refreshing ??= loadWorld(world.seed)
      .then((fresh) => {
        world = fresh;
      })
      .finally(() => {
        refreshing = null;
      });
    await refreshing;
    if (!world.hasSubscription(subscriptionId)) {
      throw new Error(`unknown subscription after refresh: ${subscriptionId}`);
    }
  };

  // The rail reads through to whatever world is current, so a refresh is picked up
  // without rebuilding the client.
  const rail = new SimulatedRailClient({
    get seed() {
      return world.seed;
    },
    customer: (id) => world.customer(id),
    mandate: (id) => world.mandate(id),
    subscription: (id) => world.subscription(id),
  });

  return async function processJob(job: Job<ExecuteAttemptJob>): Promise<void> {
    const { caseId, attemptNo, simulatedAt } = job.data;

    const caseRow = await loadCase(caseId);
    if (caseRow === null) throw new Error(`job references unknown case ${caseId}`);
    if (caseRow.closed_at !== null) return; // already resolved; nothing to do

    await ensureKnown(caseRow.subscription_id);

    const subscription = world.subscription(caseRow.subscription_id);
    const mandate = world.mandate(subscription.mandateId);
    const customer = world.customer(subscription.customerId);

    // Did the customer resolve this out-of-band while we were waiting? Checked over the
    // interval we skipped, exactly as the in-memory runner does, so both engines see the
    // same self-heal events and neither can take credit for one.
    const since = await lastActivityAt(caseRow.id, caseRow.opened_at.getTime());
    const healedAt = firstSelfHealBetween(deps, subscription.id, customer, since, simulatedAt);
    if (healedAt !== null) {
      await closeCase(
        caseId, healedAt, 'RECOVERED', 'recovered_self_heal', subscription.amountPaise,
      );
      return;
    }

    // Circuit breaker: an open breaker means DEFER, not "attempt and hope". Burning an
    // attempt into a rail we already know is down costs a fee and buys nothing.
    const breaker =
      deps.breakersEnabled === false
        ? { allowed: true, state: 'closed' as const, retryAfter: null, reason: 'breakers disabled' }
        : await checkBreaker(mandate.bankCode, simulatedAt);
    if (!breaker.allowed) {
      const deferUntil = breaker.retryAfter ?? simulatedAt + HOUR_MS;
      const horizonEndsAt = caseRow.opened_at.getTime() + SIM.caseHorizonDays.value * DAY_MS;
      const deferCount = (job.data.deferCount ?? 0) + 1;

      // A rail that is still down past the case horizon is not going to be waited out.
      // Close the case rather than deferring in a loop that never terminates.
      if (deferUntil > horizonEndsAt || deferCount > MAX_DEFERS) {
        await closeCase(caseId, Math.min(deferUntil, horizonEndsAt), 'EXHAUSTED', 'exhausted', 0);
        return;
      }

      await withTransaction(async (client) => {
        await appendEvent(client, caseId, 'ATTEMPT_DEFERRED_BY_BREAKER', simulatedAt, {
          attemptNo,
          bankCode: mandate.bankCode,
          reason: breaker.reason,
          deferUntil,
          deferCount,
        });
      });
      await queue.add(
        'execute-attempt',
        { ...job.data, simulatedAt: deferUntil, deferCount },
        {
          // A NEW job id per deferral. Re-queuing under the id of the job we are
          // currently processing is silently dropped by BullMQ, which strands the case.
          jobId: jobIdFor(caseId, attemptNo, deferCount),
          delay: simHoursToRealMs((deferUntil - simulatedAt) / HOUR_MS),
        },
      );
      return;
    }

    const result = await executeAttempt({
      caseId,
      attemptNo,
      subscription,
      mandate,
      customer,
      cycleId: caseRow.cycle_id,
      scheduledAt: simulatedAt,
      rail,
    });

    if (result.status === 'success') {
      await closeCase(caseId, simulatedAt, 'RECOVERED', 'recovered', subscription.amountPaise);
      return;
    }

    // Re-read: executeAttempt bumped attempts_used and cost, so our copy is stale.
    const afterAttempt = await loadCase(caseId);
    if (afterAttempt === null || afterAttempt.closed_at !== null) return;

    await decideNext({
      deps: { ...deps, world },
      queue,
      caseRow: afterAttempt,
      now: simulatedAt,
      jobData: job.data,
    });
  };
}

export interface DecideNextArgs {
  readonly deps: RecoveryWorkerDeps;
  readonly queue: Queue<ExecuteAttemptJob>;
  readonly caseRow: NonNullable<Awaited<ReturnType<typeof loadCase>>>;
  readonly now: Timestamp;
  readonly jobData: ExecuteAttemptJob;
}

/**
 * Ask the policy what to do next, put it through the gate, log the verdict, and apply
 * whatever survived.
 *
 * Exported because the FIRST scheduling decision of a case has to go through exactly the
 * same path as every later one. It did not, originally: cohort seeding hardcoded "retry
 * at T+1" and enqueued it directly, so one charge per case reached the executor with no
 * policy verdict attached - including charges against already-revoked mandates that the
 * gate would have refused. That is precisely the hole Phase 4's acceptance criterion is
 * written to catch, and it is why this lives in one function rather than two.
 */
export async function decideNext(args: DecideNextArgs): Promise<void> {
  const { deps, queue, caseRow, now, jobData } = args;
  const caseId = caseRow.id;

  const subscription = deps.world.subscription(caseRow.subscription_id);
  const mandate = deps.world.mandate(subscription.mandateId);

  const view = await buildCaseView(caseRow, deps, now);
  const proposed = await deps.policy.decide(view);

  // THE POLICY GATE. Nothing past this line executes an action the gate did not return,
  // and the verdict is written to the append-only decisions table with the rule that
  // fired - which is what makes `policy_verdict` in the schema real rather than a
  // placeholder.
  const breaker =
    deps.breakersEnabled === false
      ? { allowed: true, retryAfter: null as Timestamp | null }
      : await checkBreaker(mandate.bankCode, now);
  const gateState = await loadGateState(caseId, caseRow.opened_at.getTime(), now);
  const gate: GateDecision = evaluatePolicy({
    view,
    proposed,
    breakerOpen: !breaker.allowed,
    breakerRetryAfter: breaker.retryAfter,
    livePromise: null,
    ...gateState,
  });

  await recordDecision(caseId, now, view, proposed, gate);

  await applyBundle({
    caseId,
    caseVersion: caseRow.version,
    bundle: gate.finalBundle,
    now,
    job: { data: jobData } as Job<ExecuteAttemptJob>,
    queue,
    amountPaise: subscription.amountPaise,
    world: deps.world,
    openedAt: caseRow.opened_at.getTime(),
  });
}

async function loadGateState(
  caseId: string,
  openedAt: Timestamp,
  now: Timestamp,
): Promise<{
  lastPreDebitNoticeAt: Timestamp | null;
  contactsInRollingWindow: number;
  escalationTiersUsed: number;
  aborted: boolean;
}> {
  const notices = await getPool().query<{ occurred_at: Date; payload: Record<string, unknown> }>(
    `SELECT occurred_at, payload FROM case_events
      WHERE case_id = $1 AND event_type = 'NOTIFICATION_SENT'
      ORDER BY occurred_at`,
    [caseId],
  );
  const aborted = await getPool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM case_events
      WHERE case_id = $1 AND event_type = 'PAYMENT_CAPTURED'`,
    [caseId],
  );

  const settledCharges = await getPool().query<{ latest: Date | null }>(
    `SELECT max(scheduled_at) AS latest FROM charge_attempts
      WHERE case_id = $1 AND status <> 'in_flight'`,
    [caseId],
  );

  const times = notices.rows.map((r) => r.occurred_at.getTime());
  const windowMs = CONTACT_POLICY.rollingWindowHours * HOUR_MS;

  // The cycle's scheduled debit was itself preceded by a pre-transaction notification;
  // that is what made the original charge lawful. See src/policy/compliance.ts.
  const cycleNotice = openedAt - RBI.preDebitNotificationHours.value * HOUR_MS;
  const newestNotice = times.at(-1) ?? cycleNotice;
  const lastChargeAt = settledCharges.rows[0]?.latest?.getTime() ?? null;
  // A notice is spent once a charge has been presented after it.
  const consumed = lastChargeAt !== null && lastChargeAt >= newestNotice;

  return {
    lastPreDebitNoticeAt: consumed ? null : newestNotice,
    contactsInRollingWindow: times.filter((t) => now - t < windowMs).length,
    escalationTiersUsed: notices.rows.filter((r) => r.payload.templateId !== undefined).length,
    aborted: Number(aborted.rows[0]?.n ?? 0) > 0,
  };
}

/** The instant of the most recent settled attempt, or the case open time. */
async function lastActivityAt(caseId: string, openedAt: Timestamp): Promise<Timestamp> {
  const res = await getPool().query<{ latest: Date | null }>(
    `SELECT max(scheduled_at) AS latest FROM charge_attempts
      WHERE case_id = $1 AND status <> 'in_flight'`,
    [caseId],
  );
  const latest = res.rows[0]?.latest ?? null;
  return latest === null ? openedAt : Math.max(openedAt, latest.getTime());
}

/**
 * Self-heal is evaluated once per simulated day at midday IST - the same checkpoints the
 * in-memory runner uses, so the two engines cannot disagree about when a case healed.
 */
function firstSelfHealBetween(
  deps: RecoveryWorkerDeps,
  subscriptionId: string,
  customer: Parameters<typeof selfHealsOn>[2],
  after: Timestamp,
  until: Timestamp,
): Timestamp | null {
  const p = istParts(after);
  let t = fromIst(p.year, p.month, p.day, 12);
  while (t <= until) {
    if (t > after && selfHealsOn(deps.world, subscriptionId, customer, t)) return t;
    t += DAY_MS;
  }
  return null;
}

async function buildCaseView(
  caseRow: Awaited<ReturnType<typeof loadCase>> & object,
  deps: RecoveryWorkerDeps,
  now: Timestamp,
): Promise<CaseView> {
  const subscription = deps.world.subscription(caseRow.subscription_id);
  const mandate = deps.world.mandate(subscription.mandateId);
  const customer = deps.world.customer(subscription.customerId);

  const attempts = await getPool().query<{
    id: string;
    attempt_no: number;
    idempotency_key: string;
    scheduled_at: Date;
    executed_at: Date | null;
    status: 'in_flight' | 'success' | 'failed';
    raw_error_code: string;
    raw_error_desc: string;
    failure_class: string;
    classification_matched: boolean;
    fee_paise: string;
  }>(
    `SELECT * FROM charge_attempts WHERE case_id = $1 AND status <> 'in_flight'
      ORDER BY attempt_no`,
    [caseRow.id],
  );

  return {
    caseId: caseRow.id,
    arm: caseRow.arm,
    now,
    subscription,
    mandate,
    customer: {
      id: customer.id,
      tenureMonths: customer.tenureMonths,
      preferredLanguage: customer.preferredLanguage,
      bankCode: customer.bankCode,
    },
    openedAt: caseRow.opened_at.getTime(),
    attempts: attempts.rows.map((a) => ({
      id: a.id,
      subscriptionId: subscription.id,
      cycleId: caseRow.cycle_id,
      attemptNo: a.attempt_no,
      idempotencyKey: a.idempotency_key,
      rail: mandate.rail,
      scheduledAt: a.scheduled_at.getTime(),
      executedAt: a.executed_at?.getTime() ?? a.scheduled_at.getTime(),
      status: a.status === 'success' ? ('success' as const) : ('failed' as const),
      rawErrorCode: a.raw_error_code,
      rawErrorDesc: a.raw_error_desc,
      failureClass: a.failure_class as CaseView['lastFailureClass'],
      classificationMatched: a.classification_matched,
      feePaise: Number(a.fee_paise),
    })),
    attemptsUsed: caseRow.attempts_used,
    contactsUsed: caseRow.contacts_used,
    lastFailureClass: caseRow.diagnosis,
    horizonEndsAt: caseRow.opened_at.getTime() + SIM.caseHorizonDays.value * DAY_MS,
  };
}

async function recordDecision(
  caseId: string,
  at: Timestamp,
  view: CaseView,
  proposed: ActionBundle,
  gate: GateDecision,
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO decisions
         (case_id, seq, agent_input_snapshot, agent_reasoning, proposed_bundle,
          policy_verdict, policy_rule_fired, final_bundle)
       VALUES ($1,
               (SELECT coalesce(max(seq), 0) + 1 FROM decisions WHERE case_id = $1),
               $2, $3, $4, $5, $6, $7)`,
      [
        caseId,
        JSON.stringify({
          attemptsUsed: view.attemptsUsed,
          contactsUsed: view.contactsUsed,
          lastFailureClass: view.lastFailureClass,
          hoursSinceOpen: (at - view.openedAt) / HOUR_MS,
          policyFirings: gate.firings.map((f) => `${f.rule}:${f.effect}`),
        }),
        proposed.rationale,
        // What the agent WANTED, kept verbatim even when refused. An audit trail that
        // records only the approved action cannot show the gate doing anything.
        JSON.stringify(proposed),
        gate.verdict,
        gate.primaryRule,
        JSON.stringify(gate.finalBundle),
      ],
    );
    await enqueueOutbox(client, caseId, 'decision.recorded', {
      caseId,
      diagnosis: gate.finalBundle.diagnosis,
      proposed: proposed.actions.map((a) => a.kind),
      approved: gate.finalBundle.actions.map((a) => a.kind),
      policyVerdict: gate.verdict,
      policyRuleFired: gate.primaryRule,
    });
  });
}

interface ApplyBundleArgs {
  caseId: string;
  caseVersion: number;
  bundle: ActionBundle;
  now: Timestamp;
  job: Job<ExecuteAttemptJob>;
  queue: Queue<ExecuteAttemptJob>;
  amountPaise: number;
  world: World;
  openedAt: Timestamp;
}

/** How many customer asks this case has already sent. */
async function countAsks(caseId: string): Promise<number> {
  const res = await getPool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM case_events
      WHERE case_id = $1 AND event_type = 'NOTIFICATION_SENT'`,
    [caseId],
  );
  return Number(res.rows[0]?.n ?? 0);
}

async function applyBundle(args: ApplyBundleArgs): Promise<void> {
  const { caseId, bundle, now, job, queue } = args;
  const actions = [...bundle.actions].sort((a, b) => a.delayHours - b.delayHours);

  for (const action of actions) {
    const firesAt = now + action.delayHours * HOUR_MS;

    switch (action.kind) {
      case 'RETRY_NOW':
      case 'DEFER':
      case 'TIME_SHIFT': {
        const nextAttemptNo = job.data.attemptNo + 1;
        await transitionCase({
          caseId,
          expectedVersion: args.caseVersion,
          toState: 'AWAITING_RETRY',
          at: now,
          // diagnosis is deliberately NOT set here - the executor owns it. Two writers
          // for one field is how stored state and its event log drift apart.
          eventType: `SCHEDULED_${action.kind}`,
          eventPayload: { attemptNo: nextAttemptNo, firesAt, reason: action.reason },
        }).catch(swallowVersionConflict);

        await queue.add(
          'execute-attempt',
          { ...job.data, attemptNo: nextAttemptNo, simulatedAt: firesAt },
          {
            // Deterministic job id: the same attempt can never be enqueued twice, so a
            // redelivered or duplicated schedule collapses into one job.
            jobId: jobIdFor(caseId, nextAttemptNo),
            delay: simHoursToRealMs(action.delayHours),
          },
        );
        return;
      }

      case 'ESCALATE_HUMAN':
        await closeCase(caseId, firesAt, 'HUMAN_QUEUE', 'handed_to_human', 0, COST.humanHandoffPaise.value);
        return;

      case 'STOP':
        await closeCase(caseId, firesAt, 'EXHAUSTED', 'exhausted', 0);
        return;

      case 'WAIT':
        // Nothing to execute; the next scheduled job carries the case forward.
        return;

      case 'NOTIFY': {
        // Costs patience, buys a higher chance the customer resolves it themselves.
        // Never recovers money directly, so the case stays open for the next decision.
        await withTransaction(async (client) => {
          await client.query(
            `UPDATE recovery_cases
                SET contacts_used = contacts_used + 1, cost_paise = cost_paise + $2
              WHERE id = $1`,
            [caseId, COST.contactPatiencePaise.value],
          );
          await appendEvent(client, caseId, 'NOTIFICATION_SENT', firesAt, {
            templateId: action.templateId,
            language: action.language,
            reason: action.reason,
          });
        });
        break;
      }

      case 'REMANDATE':
      case 'PAYMENT_LINK': {
        // The only route by which a terminal failure can be recovered. Costs friction
        // plus a contact whether or not the customer ever completes it.
        const asks = await countAsks(caseId);
        await withTransaction(async (client) => {
          await client.query(
            `UPDATE recovery_cases
                SET contacts_used = contacts_used + 1, cost_paise = cost_paise + $2
              WHERE id = $1`,
            [caseId, COST.customerFrictionPaise.value + COST.contactPatiencePaise.value],
          );
          await appendEvent(client, caseId, 'NOTIFICATION_SENT', firesAt, {
            kind: action.kind,
            reason: action.reason,
          });
          void 0;
        });

        const world = args.world;
        const customer = world.customer(world.subscription(job.data.subscriptionId).customerId);
        const horizonEndsAt = args.openedAt + SIM.caseHorizonDays.value * DAY_MS;
        const response = respondToAsk(
          world, action.kind, customer, job.data.subscriptionId,
          args.amountPaise, firesAt, asks + 1, horizonEndsAt,
        );
        if (response.completed && response.completedAt !== null) {
          await closeCase(caseId, response.completedAt, 'RECOVERED', 'recovered', args.amountPaise);
          return;
        }
        // Not completed. Re-decide after giving the customer time to act.
        await queue.add(
          'execute-attempt',
          { ...job.data, simulatedAt: firesAt + 48 * HOUR_MS },
          {
            jobId: jobIdFor(caseId, job.data.attemptNo, (job.data.deferCount ?? 0) + 100),
            delay: simHoursToRealMs(48),
          },
        );
        return;
      }

      default: {
        const exhaustive: never = action;
        throw new Error(`unhandled action: ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  // Falling out of the loop means the bundle contained only non-scheduling actions -
  // a bare NOTIFY, for instance. Without this the case would sit open with no job and
  // no error attached to it, which is exactly how the circuit-breaker deferral stranded
  // cases before it was fixed. Schedule the next decision explicitly.
  await queue.add(
    'execute-attempt',
    { ...job.data, simulatedAt: now + 24 * HOUR_MS },
    {
      jobId: jobIdFor(caseId, job.data.attemptNo, (job.data.deferCount ?? 0) + 200),
      delay: simHoursToRealMs(24),
    },
  );
}

async function closeCase(
  caseId: string,
  at: Timestamp,
  state: 'RECOVERED' | 'EXHAUSTED' | 'HUMAN_QUEUE',
  outcome: 'recovered' | 'recovered_self_heal' | 'exhausted' | 'handed_to_human',
  recoveredPaise: number,
  addCostPaise = 0,
): Promise<void> {
  const row = await loadCase(caseId);
  if (row === null || row.closed_at !== null) return;

  const floatPaise =
    recoveredPaise > 0
      ? Math.round(
          (recoveredPaise / 100) *
            COST.floatCostPerRupeePerDay.value *
            ((at - row.opened_at.getTime()) / DAY_MS) *
            100,
        )
      : 0;

  await transitionCase({
    caseId,
    expectedVersion: row.version,
    toState: state,
    at,
    outcome,
    recoveredPaise,
    addCostPaise: addCostPaise + floatPaise,
  }).catch(swallowVersionConflict);
}

/**
 * A version conflict means another worker already advanced this case. That is the
 * optimistic-locking scheme working, not an error: we drop our stale write rather than
 * clobbering the winner's.
 */
function swallowVersionConflict(err: unknown): void {
  if (err instanceof VersionConflictError) return;
  throw err;
}
