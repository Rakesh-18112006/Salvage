/**
 * BullMQ queues and the simulated-time compression that makes them demonstrable.
 *
 * TIME COMPRESSION
 * ----------------
 * The domain runs on simulated time: a T+1 retry is 24 simulated hours away. Waiting 24
 * real hours in a demo is not an option, so one simulated hour is mapped to a small
 * number of real milliseconds (`SALVAGE_MS_PER_SIM_HOUR`, default 4ms - so a T+3 cycle
 * completes in under half a second of wall clock).
 *
 * This compresses only the DELAY. Every timestamp written to the database is the
 * simulated instant, not the wall clock, so the audit trail reads in real dates and the
 * metrics are unaffected. Nothing about the recovery logic knows this is happening.
 *
 * WHY A QUEUE AT ALL
 * ------------------
 * BullMQ earns its place for three things Phase 2 actually needs: delayed jobs, stalled-
 * job recovery when a worker dies holding a job, and per-job attempt limits feeding a
 * DLQ. It does NOT provide the never-double-charge guarantee - that comes from a UNIQUE
 * constraint in Postgres and a gateway that honours idempotency keys. The queue is
 * at-least-once by design, and the durable layer is what makes at-least-once safe.
 */
import { Queue, QueueEvents, Worker, type ConnectionOptions, type Job } from 'bullmq';

import { optionalEnv } from '../config.ts';

export const DEFAULT_RECOVERY_QUEUE = 'salvage.recovery';

/**
 * The queue name, overridable with SALVAGE_QUEUE_NAME.
 *
 * This exists because of a genuinely confusing failure: the chaos demo's worker
 * CONTAINERS stay running between demos, and they consume from the default queue. A test
 * suite that seeded the same queue had its jobs quietly stolen and processed by workers
 * configured differently - which surfaced as the engine-equivalence test failing with a
 * single mystery case, reproducibly, for reasons nothing in the test could explain.
 *
 * Anything that must not share a queue with an outside consumer sets its own name.
 */
export function recoveryQueueName(): string {
  return optionalEnv('SALVAGE_QUEUE_NAME', DEFAULT_RECOVERY_QUEUE);
}

export interface ExecuteAttemptJob {
  readonly caseId: string;
  readonly attemptNo: number;
  /** The SIMULATED instant this attempt represents. Not wall-clock time. */
  readonly simulatedAt: number;
  readonly subscriptionId: string;
  readonly cycleId: string;
  /** How many times the circuit breaker has pushed this attempt back. */
  readonly deferCount?: number;
}

export function redisConnection(): ConnectionOptions {
  const url = new URL(optionalEnv('REDIS_URL', 'redis://localhost:56379'));
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    // BullMQ requires this: a blocking connection that gives up mid-wait loses the job.
    maxRetriesPerRequest: null,
  };
}

/** Real milliseconds per simulated hour. See the time-compression note above. */
export function msPerSimHour(): number {
  return Number(optionalEnv('SALVAGE_MS_PER_SIM_HOUR', '4'));
}

export function simHoursToRealMs(hours: number): number {
  return Math.max(0, Math.round(hours * msPerSimHour()));
}

export function createRecoveryQueue(): Queue<ExecuteAttemptJob> {
  return new Queue<ExecuteAttemptJob>(recoveryQueueName(), {
    connection: redisConnection(),
    defaultJobOptions: {
      // Three tries then the DLQ. A job that fails four times has a cause that retrying
      // will not fix, and the DLQ preserves it for replay once the cause is addressed.
      attempts: 3,
      backoff: { type: 'exponential', delay: 50 },
      removeOnComplete: { count: 5000 },
      removeOnFail: false,
    },
  });
}

export function createRecoveryQueueEvents(): QueueEvents {
  return new QueueEvents(recoveryQueueName(), { connection: redisConnection() });
}

export interface WorkerOptions {
  readonly concurrency?: number;
  /** How often the stalled-job sweep runs. */
  readonly stalledIntervalMs?: number;
  /**
   * How long a worker's lock on a job survives without renewal.
   *
   * THIS is the knob that decides how fast a killed worker's job reaches a survivor -
   * not `stalledInterval`. The sweep can run every 500ms and still find nothing to
   * reclaim, because a job is only stealable once its lock has EXPIRED. BullMQ's default
   * lock is 30 seconds, so a dead worker's job sits untouched for half a minute.
   *
   * That is a sensible production default (it must comfortably exceed the longest
   * legitimate job) and a terrible demo default: `docker kill` followed by thirty
   * seconds of nothing does not show anyone that recovery works. Our jobs settle in
   * milliseconds, so the chaos demo and the tests set this low deliberately.
   *
   * Reclaiming a job that is actually still running is safe here - the executor's
   * idempotency key means the replay cannot double-charge - but it wastes work, which
   * is why this is a knob rather than a fixed small number.
   */
  readonly lockDurationMs?: number;
}

/** Fast reclaim for the chaos demo and the test suite. See lockDurationMs above. */
export const DEMO_LOCK_DURATION_MS = 1_000;

export function createRecoveryWorker(
  process_: (job: Job<ExecuteAttemptJob>) => Promise<void>,
  opts: WorkerOptions = {},
): Worker<ExecuteAttemptJob> {
  return new Worker<ExecuteAttemptJob>(recoveryQueueName(), process_, {
    connection: redisConnection(),
    concurrency: opts.concurrency ?? 4,
    stalledInterval: opts.stalledIntervalMs ?? 2_000,
    lockDuration: opts.lockDurationMs ?? 30_000,
    maxStalledCount: 3,
  });
}

/**
 * Deterministic job id, so the same attempt is never queued twice.
 *
 * `deferSeq` exists because of a bug worth remembering: when the circuit breaker defers
 * an attempt, the worker re-queues it - and re-queuing under the SAME id as the job it is
 * currently processing is silently ignored by BullMQ, because that id already exists.
 * The case is then stranded with no job and no error, forever. An open breaker would
 * have orphaned every case that touched it.
 *
 * Varying the id per deferral is safe: the never-double-charge guarantee comes from the
 * executor's sha256(caseId, attemptNo) idempotency key, which does NOT change here. The
 * job id only controls queue-level deduplication.
 */
export function jobIdFor(caseId: string, attemptNo: number, deferSeq = 0): string {
  return deferSeq === 0 ? `${caseId}#${attemptNo}` : `${caseId}#${attemptNo}#d${deferSeq}`;
}
