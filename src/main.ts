/**
 * SALVAGE - Phase 1 entrypoint.
 *
 * Establishes the ground truth: a seeded at-risk cohort and the fixed T+3 control
 * baseline we have to beat. No LLM, no network, no dependencies.
 *
 *   node src/main.ts --cases 300 --seed 20260101
 */
import { ALL_ASSUMPTIONS } from './assumptions.ts';
import { formatINR } from './domain/money.ts';
import { ControlT3Policy } from './policy/controlT3.ts';
import { renderArmMetrics, renderOpeningClassMix, renderTable } from './engine/metrics.ts';
import { runBatch } from './engine/runner.ts';
import { formatIst } from './sim/clock.ts';

interface Options {
  seed: string;
  cases: number;
  json: boolean;
  showCase: string | null;
}

function parseArgs(argv: ReadonlyArray<string>): Options {
  const opts: Options = { seed: '20260101', cases: 300, json: false, showCase: null };
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
      case '--json': opts.json = true; break;
      case '--show-case': opts.showCase = next(); break;
      case '--help':
      case '-h':
        console.log(
          'Usage: node src/main.ts [--seed <string>] [--cases <n>] [--json] [--show-case <subscriptionId>]',
        );
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(opts.cases) || opts.cases <= 0) {
    throw new Error('--cases must be a positive integer');
  }
  return opts;
}

const BANNER = `
===============================================================================
 SALVAGE - autonomous payment recovery            Phase 1: ground truth
-------------------------------------------------------------------------------
 *** ALL DATA BELOW IS SIMULATED ***
 Customers, banks, mandates, decline codes, outages and outcomes are generated
 by a seeded model in src/sim/. Nothing here comes from live traffic, from
 Razorpay, or from any bank. Bank codes are fictional (SIMBANK_*) and decline
 codes are our own inventions (SIM_*).
===============================================================================
`.trim();

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const control = new ControlT3Policy();
  const { population, arms } = await runBatch(opts.seed, opts.cases, [control]);
  const controlArm = arms[0]!;

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          simulated: true,
          seed: opts.seed,
          population: population.stats,
          arms: arms.map((a) => a.metrics),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(BANNER);
  console.log();
  console.log(`Seed: ${opts.seed}    Target at-risk cases: ${opts.cases}`);
  console.log();

  // --- assumptions -----------------------------------------------------------
  console.log('MODELLED ASSUMPTIONS (spec rule 3 - every stand-in is named, not buried)');
  console.log(
    renderTable([
      ['Assumption', 'Value', 'Unit'],
      ...ALL_ASSUMPTIONS.map((a) => [a.id, String(a.value), a.unit]),
    ]),
  );
  console.log('Basis for each value: src/assumptions.ts and README.md.');
  console.log();

  // --- cohort construction ---------------------------------------------------
  console.log('COHORT CONSTRUCTION');
  const s = population.stats;
  console.log(
    renderTable([
      ['Step', 'Count'],
      ['Candidate subscriptions charged', s.candidatesGenerated.toLocaleString('en-IN')],
      ['Opening charge succeeded - discarded', s.openingChargesSucceeded.toLocaleString('en-IN')],
      ['Opening charge genuinely failed - kept', s.atRiskCases.toLocaleString('en-IN')],
      ['Opening failure rate', `${(s.openingFailureRate * 100).toFixed(1)}%`],
    ]),
  );
  console.log(
    'Every case in the cohort opens on a real decline code. The Phase 1 defect that\n' +
      'logged successful opening charges as empty-coded UNKNOWN failures cannot recur:\n' +
      'successes are discarded here, before a case is ever opened.',
  );
  console.log();

  // --- what actually went wrong ---------------------------------------------
  console.log('WHY THE OPENING CHARGE FAILED');
  console.log(renderOpeningClassMix(controlArm.metrics));
  console.log(
    'Terminal classes cannot be fixed by any retry on the existing mandate. The fixed\n' +
      'T+3 policy does not know that, and spends its whole attempt budget on them anyway.',
  );
  console.log();

  // --- baseline --------------------------------------------------------------
  console.log('CONTROL ARM - fixed T+3 retry cycle (the documented default we must beat)');
  console.log(renderArmMetrics(controlArm.metrics));
  console.log();

  if (opts.showCase !== null) {
    printCaseTrail(controlArm, opts.showCase);
  }

  console.log('NEXT (spec section 8)');
  console.log(
    '  Phase 2  durable spine: Postgres, inbox/outbox, idempotent executor, breakers\n' +
      '  Phase 3  the agent: diagnosis + action bundles, measured against this baseline\n' +
      '  Phase 4  policy gate: deterministic rules the agent cannot argue past\n' +
      '  Phase 5  evidence: dashboard, audit viewer, chaos demo\n',
  );
  console.log(
    'Reminder: the numbers above are a SIMULATED baseline, not a measurement of any\n' +
      'production system. See README.md sections "Simulator" and "Open items".',
  );
}

function printCaseTrail(arm: { cases: ReadonlyArray<import('./domain/types.ts').RecoveryCase> }, subId: string): void {
  const c = arm.cases.find((x) => x.subscriptionId === subId || x.id === subId);
  if (c === undefined) {
    console.log(`No case found for "${subId}".`);
    console.log();
    return;
  }
  console.log(`AUDIT TRAIL - ${c.id}`);
  console.log(
    renderTable([
      ['Field', 'Value'],
      ['Arm', c.arm],
      ['Opened at', formatIst(c.openedAt)],
      ['Closed at', c.closedAt === null ? '-' : formatIst(c.closedAt)],
      ['Outcome', c.outcome ?? '-'],
      ['Recovered', formatINR(c.recoveredPaise)],
      ['Modelled cost', formatINR(c.costPaise)],
      ['Simulator ground-truth cause', c.trueOpeningClass],
    ]),
  );
  const rows: string[][] = [['#', 'When (IST)', 'Kind', 'Result / class', 'Reason']];
  let attemptIdx = 0;
  for (const d of c.decisions) {
    for (const a of d.finalBundle.actions) {
      rows.push([String(d.seq), formatIst(d.at), a.kind, '', a.reason]);
    }
  }
  for (const a of c.attempts) {
    rows.push([
      `a${++attemptIdx}`,
      formatIst(a.executedAt),
      'CHARGE',
      a.status === 'success' ? 'SUCCESS' : `${a.failureClass} (${a.rawErrorCode})`,
      a.rawErrorDesc,
    ]);
  }
  console.log(renderTable(rows));
  console.log();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
