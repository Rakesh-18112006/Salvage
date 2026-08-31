/**
 * SALVAGE - Phase 2 entrypoint: the durable spine, running a batch end to end.
 *
 * Unlike Phase 1 this needs infrastructure:
 *
 *   docker compose up -d
 *   node src/db/migrate.ts
 *   node src/phase2.ts --cases 100
 *
 * What it demonstrates, in one run: cases opened in Postgres, attempts executed through
 * the idempotent executor, retries scheduled as real delayed jobs, circuit breakers
 * consulted before every charge, an append-only decision log, and - at the end - a
 * replay of the entire event log checked against stored state.
 */
import { loadEnv } from './config.ts';
import { formatINR } from './domain/money.ts';
import { ControlT3Policy } from './policy/controlT3.ts';
import { renderTable } from './engine/metrics.ts';
import { closePool } from './db/pool.ts';
import { migrate } from './db/migrate.ts';
import {
  humanQueue,
  policyRuleTally,
  seedAndOpenCases,
  summarise,
  verdictTally,
  waitForDrain,
} from './durable/pipeline.ts';
import { allBreakers } from './durable/circuitBreaker.ts';
import { deadLetterStats } from './durable/deadLetters.ts';
import { inboxStats } from './durable/inbox.ts';
import { outboxStats, publishBatch } from './durable/outbox.ts';
import { ledgerTotals } from './durable/railClient.ts';
import { truncateAll } from './durable/repo.ts';
import { verifyAllCases } from './durable/replay.ts';
import { createRecoveryQueue, createRecoveryWorker, DEMO_LOCK_DURATION_MS } from './queue/queues.ts';
import { makeJobProcessor } from './queue/recoveryWorker.ts';

loadEnv();

interface Options {
  seed: string;
  cases: number;
  workers: number;
  fresh: boolean;
}

function parseArgs(argv: ReadonlyArray<string>): Options {
  const opts: Options = { seed: '20260101', cases: 100, workers: 4, fresh: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case '--seed': opts.seed = next(); break;
      case '--cases': opts.cases = Number.parseInt(next(), 10); break;
      case '--workers': opts.workers = Number.parseInt(next(), 10); break;
      case '--keep': opts.fresh = false; break;
      case '--help':
      case '-h':
        console.log('Usage: node src/phase2.ts [--seed <s>] [--cases <n>] [--workers <n>] [--keep]');
        process.exit(0);
        break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

const BANNER = `
===============================================================================
 SALVAGE - autonomous payment recovery         Phase 2: the durable spine
-------------------------------------------------------------------------------
 *** ALL DATA BELOW IS SIMULATED ***
 The payment gateway is a simulator (src/durable/railClient.ts). No money moves,
 no network call is made, and every decline code is our own invention (SIM_*).
 Postgres and Redis are real; what flows through them is not.
===============================================================================
`.trim();

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  console.log(BANNER);
  console.log();
  console.log(`Seed: ${opts.seed}   Cases: ${opts.cases}   Workers: ${opts.workers}`);
  console.log();

  await migrate({ quiet: true });
  if (opts.fresh) {
    await truncateAll();
    // Redis carries state too. Job ids are deterministic so an attempt can never be
    // queued twice - which also means a completed job id from a PREVIOUS run silently
    // swallows this run's `add`, stranding the case with no job and no error. Truncating
    // Postgres without clearing Redis leaves exactly that trap.
    const stale = createRecoveryQueue();
    await stale.obliterate({ force: true });
    await stale.close();
  }

  const policy = new ControlT3Policy();
  console.log('Seeding cohort and opening cases in Postgres...');
  const seeded = await seedAndOpenCases(opts.seed, opts.cases, policy);

  console.log(`Starting ${opts.workers} workers...`);
  const started = Date.now();
  const worker = createRecoveryWorker(
    makeJobProcessor({ world: seeded.population.world, policy, queue: seeded.queue }),
    { concurrency: opts.workers, stalledIntervalMs: 250, lockDurationMs: DEMO_LOCK_DURATION_MS },
  );

  try {
    const drained = await waitForDrain(seeded.queue, 180_000);
    const elapsed = Date.now() - started;
    if (!drained) console.warn('WARNING: queue did not drain within the timeout');

    // Drain the outbox. In production this is a separate long-running publisher; here
    // one sweep at the end is enough to show the pattern working.
    let publishedTotal = 0;
    for (;;) {
      const n = await publishBatch(async () => {});
      publishedTotal += n;
      if (n === 0) break;
    }

    const summary = await summarise('control');
    const ledger = await ledgerTotals();
    const inbox = await inboxStats();
    const outbox = await outboxStats();
    const dlq = await deadLetterStats();

    console.log();
    console.log('DURABLE RUN - control arm (fixed T+3), executed through the spine');
    console.log(
      renderTable([
        ['Metric', 'Value'],
        ['Cases opened', String(summary.cases)],
        ['Cases closed', String(summary.closed)],
        ['Cases still open', String(summary.open)],
        ['  recovered', String(summary.recovered)],
        ['  exhausted', String(summary.exhausted)],
        ['  handed to a human', String(summary.humanQueue)],
        ['Attempts executed', String(summary.attempts)],
        ['Recovered', formatINR(summary.recoveredPaise)],
        ['Modelled cost', formatINR(summary.costPaise)],
        ['Wall-clock time', `${(elapsed / 1000).toFixed(1)}s (simulated time is compressed)`],
      ]),
    );

    console.log();
    console.log('GUARANTEES');
    const guarantees: string[][] = [
      ['Check', 'Result'],
      [
        'Gateway charges vs idempotency keys',
        `${ledger.charges} charges / ${ledger.keys} keys` +
          (ledger.charges === ledger.keys ? '  OK: no double charge' : '  FAIL'),
      ],
      [
        'Gateway requests (replays are free)',
        `${ledger.requests} requests for ${ledger.charges} charges`,
      ],
      ['Cases left open', `${summary.open}${summary.open === 0 ? '  OK: no lost cases' : '  FAIL'}`],
      ['Inbox events / unprocessed', `${inbox.total} / ${inbox.unprocessed}`],
      [
        'Outbox events / unpublished',
        `${outbox.total} / ${outbox.unpublished}` +
          (outbox.unpublished === 0 ? `  OK: ${publishedTotal} published this sweep` : '  FAIL'),
      ],
      ['Dead letters pending', String(dlq.pending)],
    ];
    console.log(renderTable(guarantees));

    console.log();
    console.log('EVENT-LOG REPLAY (Phase 2 acceptance)');
    const { casesChecked, divergences } = await verifyAllCases();
    if (divergences.length === 0) {
      console.log(
        renderTable([
          ['Check', 'Result'],
          ['Cases replayed from case_events', String(casesChecked)],
          ['Divergences from stored state', '0  OK: the log reconstructs state exactly'],
        ]),
      );
    } else {
      console.log(`FAIL: ${divergences.length} divergences`);
      console.log(JSON.stringify(divergences.slice(0, 20), null, 2));
      process.exitCode = 1;
    }

    // --- Phase 4: the policy gate, in the durable path -----------------------
    const verdicts = await verdictTally();
    const rules = await policyRuleTally();
    const queue = await humanQueue();

    console.log();
    console.log('POLICY GATE (spec section 6)');
    console.log(
      renderTable([
        ['Verdict', 'Decisions'],
        ...verdicts.map((v) => [v.verdict, String(v.count)]),
      ]),
    );
    const unadjudicated = verdicts.find((v) => v.verdict === 'NOT_YET_IMPLEMENTED');
    console.log(
      unadjudicated === undefined
        ? 'OK: every decision carries a policy verdict; none reached the executor unadjudicated.'
        : `FAIL: ${unadjudicated.count} decisions reached the executor without a verdict.`,
    );
    if (rules.length > 0) {
      console.log(
        renderTable([['Rule fired', 'Times'], ...rules.map((r) => [r.rule, String(r.count)])]),
      );
    }

    if (queue.length > 0) {
      console.log();
      console.log(`HUMAN HANDOFF QUEUE (${queue.length} cases)`);
      console.log(
        renderTable([
          ['Case', 'Diagnosis', 'Amount', 'Rule'],
          ...queue.slice(0, 10).map((q) => [
            q.caseId.replace('case_control_', ''),
            q.diagnosis,
            formatINR(q.amountPaise),
            q.lastRuleFired ?? '-',
          ]),
        ]),
      );
    }

    const breakers = await allBreakers();
    if (breakers.length > 0) {
      console.log();
      console.log('CIRCUIT BREAKERS (persisted, so a restart does not forget)');
      console.log(
        renderTable([
          ['Bank', 'State', 'Consecutive failures'],
          ...breakers.map((b) => [b.bank_code, b.state, String(b.consecutive_failures)]),
        ]),
      );
    }

    console.log();
    console.log(
      'Inspect a case end to end:\n' +
        `  docker exec -it salvage-postgres psql -U salvage -d salvage -c \\\n` +
        `    "SELECT seq, event_type, occurred_at FROM case_events ` +
        `WHERE case_id = '${seeded.caseIds[0] ?? ''}' ORDER BY seq;"`,
    );
  } finally {
    await worker.close();
    await seeded.queue.close();
    await closePool();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
