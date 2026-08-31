/**
 * Standalone recovery worker.
 *
 * This is the process the chaos demo kills. It exists as its own entrypoint precisely so
 * that killing it is a realistic failure: a container disappearing mid-charge, not a
 * function throwing inside a test harness.
 *
 * It holds no state between jobs. Everything it needs is in Postgres, which is why a
 * replacement can pick up exactly where this one died.
 *
 *   node src/worker.ts --seed 20260101 --concurrency 4
 */
import { loadEnv } from './config.ts';
import { ControlT3Policy } from './policy/controlT3.ts';
import { closePool } from './db/pool.ts';
import { loadWorld } from './durable/repo.ts';
import { createRecoveryWorker, DEMO_LOCK_DURATION_MS } from './queue/queues.ts';
import { makeJobProcessor } from './queue/recoveryWorker.ts';

loadEnv();

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const seed = arg('seed', '20260101');
const concurrency = Number(arg('concurrency', '4'));
const label = arg('label', process.env.HOSTNAME ?? 'worker');

const world = await loadWorld(seed);
const policy = new ControlT3Policy();

const worker = createRecoveryWorker(makeJobProcessor({ world, policy }), {
  concurrency,
  stalledIntervalMs: 250,
  lockDurationMs: DEMO_LOCK_DURATION_MS,
});

worker.on('failed', (job, err) => {
  console.error(`[${label}] job ${job?.id ?? '?'} failed: ${err.message}`);
});

console.log(`[${label}] ready: concurrency=${concurrency} seed=${seed}`);

// A graceful shutdown finishes in-flight jobs. The chaos demo deliberately does NOT use
// this path - it sends SIGKILL, which no handler can intercept.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`[${label}] ${signal}: draining`);
    void worker.close().then(() => closePool()).then(() => process.exit(0));
  });
}
