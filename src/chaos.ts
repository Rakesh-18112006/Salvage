/**
 * SALVAGE - Phase 5 chaos demo.
 *
 * Spec section 8, demo steps 3 and 4:
 *   "docker kill an executor mid-flight -> jobs reclaim -> ZERO DUPLICATE CHARGES"
 *   "force a bank into simulated downtime -> breaker opens -> traffic defers"
 *
 * Prerequisites:
 *   docker compose up -d
 *   docker compose --profile chaos up -d --scale worker=2
 *   node src/chaos.ts
 *
 * The workers are real containers running src/worker.ts. This script kills one of them
 * with SIGKILL while it is holding charge jobs. That matters: a test that simulates a
 * crash by throwing an Error proves the catch block works. Nothing here catches anything
 * - the process stops existing, and the guarantees have to survive on their own.
 *
 * Every claim printed at the end is checked against the SIMULATED GATEWAY'S OWN LEDGER,
 * in its own table, not against our bookkeeping. Asserting that our charge_attempts table
 * has one row would be circular; asserting the counterparty only ever moved money once is
 * the actual finding.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { loadEnv } from './config.ts';
import { formatINR } from './domain/money.ts';
import { renderTable } from './engine/metrics.ts';
import { closePool, getPool } from './db/pool.ts';
import { migrate } from './db/migrate.ts';
import { ControlT3Policy } from './policy/controlT3.ts';
import {
  allBreakers,
  checkBreaker,
  COOLDOWN_MS,
  FAILURE_THRESHOLD,
  recordFailure,
} from './durable/circuitBreaker.ts';
import { seedAndOpenCases, summarise, waitForDrain } from './durable/pipeline.ts';
import { ledgerTotals } from './durable/railClient.ts';
import { truncateAll } from './durable/repo.ts';
import { verifyAllCases } from './durable/replay.ts';
import { createRecoveryQueue } from './queue/queues.ts';
import { SIMULATED_BANKS } from './sim/banks.ts';

loadEnv();

const execFileAsync = promisify(execFile);

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const SEED = arg('seed', '20260101');
const CASES = Number(arg('cases', '250'));

const BANNER = `
===============================================================================
 SALVAGE - chaos demo                    Phase 5: the guarantees, under fire
-------------------------------------------------------------------------------
 *** ALL PAYMENT DATA IS SIMULATED ***
 The gateway is a simulator. No money moves. Postgres, Redis and the worker
 containers are real, and the worker really is killed with SIGKILL.
===============================================================================
`.trim();

interface WorkerContainer {
  readonly name: string;
  readonly state: string;
}

async function workers(): Promise<WorkerContainer[]> {
  try {
    const { stdout } = await execFileAsync('docker', [
      'ps',
      '--filter',
      'name=worker',
      '--format',
      '{{.Names}}\t{{.State}}',
    ]);
    return stdout
      .trim()
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => {
        const [name, state] = l.split('\t');
        return { name: name ?? '', state: state ?? '' };
      })
      .filter((w) => w.name.includes('worker'));
  } catch {
    return [];
  }
}

async function reset(): Promise<void> {
  await migrate({ quiet: true });
  await truncateAll();
  const q = createRecoveryQueue();
  await q.obliterate({ force: true });
  await q.close();
}

async function inFlightAttempts(): Promise<number> {
  const r = await getPool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM charge_attempts WHERE status = 'in_flight'`,
  );
  return Number(r.rows[0]?.n ?? 0);
}

async function settledAttempts(): Promise<number> {
  const r = await getPool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM charge_attempts WHERE status <> 'in_flight'`,
  );
  return Number(r.rows[0]?.n ?? 0);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// STEP 3: kill an executor mid-flight
// ---------------------------------------------------------------------------

interface KillResult {
  readonly killed: string | null;
  readonly survivors: number;
  readonly inFlightAtKill: number;
  readonly casesOpen: number;
  readonly settled: number;
  readonly ledgerCharges: number;
  readonly ledgerKeys: number;
  readonly ledgerRequests: number;
  readonly stranded: number;
  readonly divergences: number;
  readonly drained: boolean;
}

async function killMidFlight(): Promise<KillResult> {
  console.log('STEP 3 - kill an executor mid-flight');
  console.log('-------------------------------------------------------------------------------');

  await reset();

  const running = await workers();
  if (running.length < 2) {
    throw new Error(
      `need at least 2 worker containers, found ${running.length}. Run:\n` +
        '  docker compose --profile chaos up -d --scale worker=2',
    );
  }
  console.log(`workers up: ${running.map((w) => w.name).join(', ')}`);

  const policy = new ControlT3Policy();
  console.log(`seeding ${CASES} cases (workers are already consuming)...`);
  const seeded = await seedAndOpenCases(SEED, CASES, policy);
  const queue = seeded.queue;

  // Wait until a worker is genuinely holding charges, so the kill lands mid-flight
  // rather than during a quiet moment.
  let inFlightAtKill = 0;
  for (let i = 0; i < 400; i++) {
    inFlightAtKill = await inFlightAttempts();
    if (inFlightAtKill > 0) break;
    await sleep(25);
  }

  const victim = running[0]!.name;
  console.log(
    `killing ${victim} with SIGKILL while ${inFlightAtKill} charge(s) are in flight...`,
  );
  await execFileAsync('docker', ['kill', '--signal=KILL', victim]);
  console.log(`${victim} is gone. No handler ran. Survivors must finish the batch.`);

  const drained = await waitForDrain(queue, 180_000);
  await queue.close();

  const summary = await summarise('control');
  const ledger = await ledgerTotals();
  const { divergences } = await verifyAllCases();

  return {
    killed: victim,
    survivors: (await workers()).length,
    inFlightAtKill,
    casesOpen: summary.open,
    settled: await settledAttempts(),
    ledgerCharges: ledger.charges,
    ledgerKeys: ledger.keys,
    ledgerRequests: ledger.requests,
    stranded: await inFlightAttempts(),
    divergences: divergences.length,
    drained,
  };
}

// ---------------------------------------------------------------------------
// STEP 4: force a bank down and watch the breaker divert traffic
// ---------------------------------------------------------------------------

interface BreakerResult {
  readonly bank: string;
  readonly stateAfterFailures: string;
  /** Inside the cooldown the breaker must REFUSE. This is the claim. */
  readonly blockedInsideCooldown: boolean;
  /** After the cooldown it must allow exactly one probe. */
  readonly probeAllowedAfterCooldown: boolean;
  readonly deferrals: number;
  readonly downtimeResponses: number;
  readonly casesOpen: number;
}

async function breakerDemo(): Promise<BreakerResult> {
  console.log();
  console.log('STEP 4 - force a bank into downtime; the breaker must stop feeding it');
  console.log('-------------------------------------------------------------------------------');

  await reset();

  const bank = [...SIMULATED_BANKS].sort((a, b) => b.share - a.share)[0]!.code;

  // Part A: a focused, observable demonstration.
  //
  // An earlier version of this opened the breaker at a simulated instant weeks before
  // the traffic it was meant to block. The 30-minute cooldown had expired long before
  // any case was processed, so the breaker dutifully half-opened and let everything
  // through - and the demo reported 0 deferrals while claiming success. The breaker was
  // right; the demonstration was meaningless. Timing is now checked explicitly.
  const t0 = Date.UTC(2026, 2, 15, 6, 0, 0);
  console.log(`recording ${FAILURE_THRESHOLD} consecutive downtime responses for ${bank}...`);
  for (let i = 0; i < FAILURE_THRESHOLD; i++) await recordFailure(bank, t0);

  const state = (await allBreakers()).find((b) => b.bank_code === bank)?.state ?? 'unknown';
  console.log(`breaker for ${bank} is now: ${state}`);

  const insideCooldown = await checkBreaker(bank, t0 + 60_000);
  console.log(
    `  one minute later:  allowed=${insideCooldown.allowed}  (${insideCooldown.reason})`,
  );
  const afterCooldown = await checkBreaker(bank, t0 + COOLDOWN_MS + 60_000);
  console.log(
    `  after cooldown:    allowed=${afterCooldown.allowed}  (${afterCooldown.reason})`,
  );

  // Part B: how often the breaker fired against real batch traffic, from the simulator's
  // own downtime windows rather than a forced state.
  const policy = new ControlT3Policy();
  const seeded = await seedAndOpenCases(SEED, CASES, policy);
  const drained = await waitForDrain(seeded.queue, 180_000);
  await seeded.queue.close();
  if (!drained) console.warn('WARNING: queue did not drain within the timeout');

  const deferrals = await getPool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM case_events
      WHERE event_type = 'ATTEMPT_DEFERRED_BY_BREAKER'`,
  );
  const downtimeSeen = await getPool().query<{ n: string }>(
    `SELECT count(*)::text AS n FROM charge_attempts
      WHERE failure_class = 'BANK_DOWNTIME'`,
  );

  return {
    bank,
    stateAfterFailures: state,
    blockedInsideCooldown: !insideCooldown.allowed,
    probeAllowedAfterCooldown: afterCooldown.allowed,
    deferrals: Number(deferrals.rows[0]?.n ?? 0),
    downtimeResponses: Number(downtimeSeen.rows[0]?.n ?? 0),
    casesOpen: (await summarise('control')).open,
  };
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(BANNER);
  console.log();
  console.log(`Seed: ${SEED}   Cases: ${CASES}`);
  console.log();

  const kill = await killMidFlight();
  const breaker = await breakerDemo();

  const pass = (ok: boolean) => (ok ? 'PASS' : 'FAIL');
  const noDoubleCharge = kill.ledgerCharges === kill.settled && kill.ledgerCharges === kill.ledgerKeys;
  const noLostCases = kill.casesOpen === 0 && kill.stranded === 0;
  const logIntact = kill.divergences === 0;
  const breakerHeld =
    breaker.stateAfterFailures === 'open' &&
    breaker.blockedInsideCooldown &&
    breaker.probeAllowedAfterCooldown &&
    breaker.casesOpen === 0;

  console.log();
  console.log('===============================================================================');
  console.log(' CHAOS RESULTS');
  console.log('===============================================================================');
  console.log(
    renderTable([
      ['Observation', 'Value'],
      ['Executor killed (SIGKILL)', kill.killed ?? '-'],
      ['Charges in flight at the moment of the kill', String(kill.inFlightAtKill)],
      ['Surviving workers', String(kill.survivors)],
      ['Queue drained', kill.drained ? 'yes' : 'NO - timed out'],
      ['Settled charge attempts', String(kill.settled)],
      ['Gateway ledger: money-moving charges', String(kill.ledgerCharges)],
      ['Gateway ledger: distinct idempotency keys', String(kill.ledgerKeys)],
      ['Gateway ledger: requests received', String(kill.ledgerRequests)],
      ['Attempts left stranded in flight', String(kill.stranded)],
      ['Cases left open', String(kill.casesOpen)],
      ['Event-log replay divergences', String(kill.divergences)],
    ]),
  );

  console.log();
  console.log(
    renderTable([
      ['Guarantee', 'Result', 'Evidence'],
      [
        'ZERO DUPLICATE CHARGES',
        pass(noDoubleCharge),
        `${kill.ledgerCharges} charges for ${kill.ledgerKeys} keys and ${kill.settled} attempts`,
      ],
      [
        'ZERO LOST CASES',
        pass(noLostCases),
        `${kill.casesOpen} open, ${kill.stranded} stranded after the kill`,
      ],
      [
        'EVENT LOG RECONSTRUCTS STATE',
        pass(logIntact),
        `${kill.divergences} divergences`,
      ],
      [
        'BREAKER STOPS FEEDING A DEAD RAIL',
        pass(breakerHeld),
        `${breaker.bank} open; refused inside cooldown=${breaker.blockedInsideCooldown}, ` +
          `probe after=${breaker.probeAllowedAfterCooldown}`,
      ],
    ]),
  );

  if (kill.ledgerRequests > kill.ledgerCharges) {
    console.log();
    console.log(
      `The gateway received ${kill.ledgerRequests} requests but moved money ${kill.ledgerCharges}\n` +
        `times. The difference is the reclaimed work: ${kill.ledgerRequests - kill.ledgerCharges} ` +
        're-presentations of an\nidempotency key it had already settled. That gap IS the crash recovery.',
    );
  }

  console.log();
  console.log('STEP 4 detail - traffic on the degraded rail');
  console.log(
    renderTable([
      ['Metric', 'Value'],
      ['Bank forced down', breaker.bank],
      [`Breaker state after ${FAILURE_THRESHOLD} downtime responses`, breaker.stateAfterFailures],
      ['Charge refused while inside cooldown', breaker.blockedInsideCooldown ? 'yes' : 'NO'],
      ['One probe allowed after cooldown', breaker.probeAllowedAfterCooldown ? 'yes' : 'NO'],
      ['Batch traffic deferred by a breaker', String(breaker.deferrals)],
      ['BANK_DOWNTIME responses seen in the batch', String(breaker.downtimeResponses)],
      ['Cases left open', String(breaker.casesOpen)],
    ]),
  );
  if (breaker.deferrals === 0 && breaker.downtimeResponses > 0) {
    console.log(
      `Note: ${breaker.downtimeResponses} downtime responses occurred in the batch but none\n` +
        `tripped a breaker. That is correct, not a miss: the breaker opens on ` +
        `${FAILURE_THRESHOLD} CONSECUTIVE\nfailures for one bank, and the simulator's outages ` +
        'are short and interleaved with\nsuccesses. It is built for a sustained outage, and ' +
        'the check above proves it fires\nwhen one actually happens.',
    );
  }

  const allPass = noDoubleCharge && noLostCases && logIntact && breakerHeld;
  console.log();
  console.log(allPass ? 'ALL GUARANTEES HELD.' : 'ONE OR MORE GUARANTEES FAILED - see above.');
  if (!allPass) process.exitCode = 1;

  console.log();
  console.log(
    'Restart the killed worker with:\n' +
      '  docker compose --profile chaos up -d --scale worker=2',
  );
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  })
  .finally(() => closePool());
