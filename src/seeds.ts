/**
 * SALVAGE - the multi-seed harness: is the lift real, or is it one lucky cohort?
 *
 *   node src/seeds.ts --seeds 50
 *   node src/seeds.ts --seeds 50 --cases 300 --json
 *
 * WHY THIS EXISTS
 * ---------------
 * Every headline this project has published so far comes from ONE cohort: seed
 * 20260101, 300 cases. Control 50.3%, agent 70.7%. Both numbers are exactly
 * reproducible, which is a real property and not the one being questioned here.
 * Reproducibility says the same seed gives the same answer. It says nothing about
 * whether a DIFFERENT seed would have given 70.7% or 61%.
 *
 * A single draw with no interval is the standard way a result that is mostly cohort luck
 * gets presented as an effect. So this runs the whole comparison across many independent
 * cohorts and reports what the spread actually is.
 *
 * WHY THIS ARM AND NOT THE MODEL-DRIVEN ONE
 * -----------------------------------------
 * Both arms here are DETERMINISTIC - the agent runs with the model off. That is a
 * deliberate limitation and worth stating plainly rather than hiding:
 *
 *   - It is the arm that carries essentially all of the lift. Phase 3 measured the
 *     model's own contribution as +1.4 ppt against a run-to-run spread of 68.0-72.0%,
 *     which is to say inside the noise. Putting an interval around the deterministic arm
 *     puts an interval around the part of the result that is actually load-bearing.
 *   - It needs no API key, costs nothing, and finishes in seconds rather than hours.
 *     Fifty live model runs at the free tier's 8,000 tokens per minute would take
 *     most of a day and would confound cohort variance with model variance.
 *
 * So: this establishes that the deterministic lift is not a cohort artefact. It does not
 * and cannot establish anything about the model. `node src/generalization.ts` is where
 * the model is measured.
 *
 * ALL DATA IS SIMULATED.
 */
import { AgentPolicy } from './agent/agentPolicy.ts';
import { renderTable } from './engine/metrics.ts';
import { runArm } from './engine/runner.ts';
import { ControlT3Policy } from './policy/controlT3.ts';
import { buildAtRiskPopulation } from './sim/population.ts';
import { pairedSummary, renderInterval, type PairedSummary } from './stats.ts';

interface Options {
  baseSeed: number;
  seeds: number;
  cases: number;
  concurrency: number;
  json: boolean;
}

function parseArgs(argv: ReadonlyArray<string>): Options {
  const o: Options = {
    baseSeed: 20260101,
    seeds: 50,
    cases: 300,
    concurrency: 12,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${arg}`);
      return v;
    };
    switch (arg) {
      case '--base-seed': o.baseSeed = Number.parseInt(next(), 10); break;
      case '--seeds': o.seeds = Number.parseInt(next(), 10); break;
      case '--cases': o.cases = Number.parseInt(next(), 10); break;
      case '--concurrency': o.concurrency = Number.parseInt(next(), 10); break;
      case '--json': o.json = true; break;
      case '--help':
      case '-h':
        console.log(
          'Usage: node src/seeds.ts [--base-seed <n>] [--seeds <n>] [--cases <n>] ' +
            '[--concurrency <n>] [--json]',
        );
        process.exit(0);
        break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (o.seeds < 2) throw new Error('--seeds must be at least 2; an interval needs a spread');
  return o;
}

const BANNER = `
===============================================================================
 SALVAGE - multi-seed harness              Is the lift real, or one lucky draw?
-------------------------------------------------------------------------------
 *** ALL DATA BELOW IS SIMULATED ***
 Both arms are DETERMINISTIC (agent model OFF). This measures cohort variance,
 not model variance. See src/generalization.ts for what the model is worth.
===============================================================================
`.trim();

interface SeedRow {
  readonly seed: string;
  readonly controlRecovery: number;
  readonly agentRecovery: number;
  readonly controlCost: number;
  readonly agentCost: number;
  readonly controlAttempts: number;
  readonly agentAttempts: number;
}

async function runSeed(seed: string, cases: number, concurrency: number): Promise<SeedRow> {
  // One population, both arms - the same discipline Phase 3 uses. Without it the paired
  // comparison below would be comparing two different worlds and the pairing would be a
  // lie rather than a variance reduction.
  const population = buildAtRiskPopulation(seed, cases);

  const control = await runArm(population, new ControlT3Policy(), concurrency);
  const agent = await runArm(
    population,
    new AgentPolicy({ world: population.world, seed, deterministicOnly: true }),
    concurrency,
  );

  return {
    seed,
    controlRecovery: control.metrics.recoveryRatePct,
    agentRecovery: agent.metrics.recoveryRatePct,
    controlCost: control.metrics.costPerRupeeRecovered,
    agentCost: agent.metrics.costPerRupeeRecovered,
    controlAttempts: control.metrics.totalAttempts,
    agentAttempts: agent.metrics.totalAttempts,
  };
}

function summaryRows(label: string, s: PairedSummary, digits: number, unit: string) {
  return [
    [label, '', '', ''],
    ['  control (fixed T+3)', renderInterval(s.control, digits, unit), '', ''],
    ['  agent (deterministic)', renderInterval(s.treatment, digits, unit), '', ''],
    [
      '  PAIRED DIFFERENCE  <- the statistic',
      renderInterval(s.difference, digits, unit),
      `${s.treatmentWins}/${s.seeds} seeds`,
      s.difference.lo > 0 ? 'excludes zero' : s.difference.hi < 0 ? 'excludes zero' : 'SPANS ZERO',
    ],
  ];
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));

  if (!o.json) {
    console.log(BANNER);
    console.log();
    console.log(
      `Seeds: ${o.seeds} (${o.baseSeed}..${o.baseSeed + o.seeds - 1})   ` +
        `Cases per seed: ${o.cases}   Total cases: ${(o.seeds * o.cases).toLocaleString('en-IN')}`,
    );
    console.log();
  }

  const rows: SeedRow[] = [];
  for (let i = 0; i < o.seeds; i++) {
    const seed = String(o.baseSeed + i);
    // Only when a human is watching. Carriage returns in a redirected log turn the
    // progress line into one unreadable smear across the top of the captured output.
    if (!o.json && process.stdout.isTTY) {
      process.stdout.write(`\r  running seed ${i + 1}/${o.seeds} (${seed})...   `);
    }
    rows.push(await runSeed(seed, o.cases, o.concurrency));
  }
  if (!o.json && process.stdout.isTTY) console.log('\r' + ' '.repeat(50) + '\r');

  // The resampling stream is named after the experiment so a quoted interval can be
  // reproduced exactly, resampling included.
  const resampleSeed = `salvage|seeds|${o.baseSeed}|${o.seeds}|${o.cases}`;

  const recovery = pairedSummary(
    rows.map((r) => r.controlRecovery),
    rows.map((r) => r.agentRecovery),
    resampleSeed,
  );
  const cost = pairedSummary(
    rows.map((r) => r.controlCost),
    rows.map((r) => r.agentCost),
    resampleSeed,
  );
  const attempts = pairedSummary(
    rows.map((r) => r.controlAttempts),
    rows.map((r) => r.agentAttempts),
    resampleSeed,
  );

  if (o.json) {
    console.log(
      JSON.stringify(
        {
          simulated: true,
          deterministic: true,
          baseSeed: o.baseSeed,
          seeds: o.seeds,
          casesPerSeed: o.cases,
          resampleSeed,
          perSeed: rows,
          recoveryRatePct: recovery,
          gatewayCostPerRupee: cost,
          totalAttempts: attempts,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log('ACROSS INDEPENDENT COHORTS (mean [95% bootstrap interval])');
  console.log(
    renderTable([
      ['Metric', 'Value', 'Direction', 'Interval'],
      ...summaryRows('Recovery rate', recovery, 1, '%'),
      ...summaryRows('Gateway cost per rupee recovered', cost, 3, 'p'),
      ...summaryRows('Total attempts', attempts, 0, ''),
    ]),
  );
  console.log(
    'Intervals are percentile bootstrap over the seeds themselves, 10,000 resamples, no\n' +
      'distributional assumption. The PAIRED row is the one to read: both arms run on the\n' +
      'same cohort, so a seed that draws many dead mandates depresses both together, and\n' +
      'the difference cancels that shared effect. Two separate intervals would overstate\n' +
      'the uncertainty this experiment actually has.',
  );

  // Where the seed we have been quoting all along actually sits. A headline drawn from
  // the tail of its own distribution is a different claim from one drawn near the middle,
  // and the reader should not have to take our word for which it was.
  const headline = rows.find((r) => r.seed === String(o.baseSeed));
  if (headline !== undefined) {
    const deltas = rows.map((r) => r.agentRecovery - r.controlRecovery).sort((a, b) => a - b);
    const headlineDelta = headline.agentRecovery - headline.controlRecovery;
    const rank = deltas.filter((d) => d < headlineDelta).length + 1;
    console.log();
    console.log('WHERE THE PUBLISHED SEED SITS IN ITS OWN DISTRIBUTION');
    console.log(
      renderTable([
        ['Question', 'Answer'],
        [`Seed ${o.baseSeed} control -> agent`, `${headline.controlRecovery.toFixed(1)}% -> ${headline.agentRecovery.toFixed(1)}%`],
        ['Its lift', `${headlineDelta >= 0 ? '+' : ''}${headlineDelta.toFixed(1)} ppt`],
        ['Rank among all seeds by lift', `${rank} of ${rows.length} (1 = smallest lift)`],
        ['Smallest / largest lift observed', `${deltas[0]!.toFixed(1)} / ${deltas.at(-1)!.toFixed(1)} ppt`],
      ]),
    );
  }

  console.log();
  console.log('PER-SEED DETAIL');
  console.log(
    renderTable([
      ['Seed', 'Control', 'Agent', 'Lift (ppt)'],
      ...rows.map((r) => [
        r.seed,
        `${r.controlRecovery.toFixed(1)}%`,
        `${r.agentRecovery.toFixed(1)}%`,
        `${r.agentRecovery - r.controlRecovery >= 0 ? '+' : ''}${(r.agentRecovery - r.controlRecovery).toFixed(1)}`,
      ]),
    ]),
  );

  console.log();
  console.log(
    'Reminder: a SIMULATED comparison, and a deterministic one. Nothing here is evidence\n' +
      'about the language model - see `node src/generalization.ts` for that.',
  );

  // A lift whose interval spans zero is not a lift, and this must fail loudly rather
  // than be read past in a table.
  if (recovery.difference.lo <= 0) {
    console.log();
    console.log('*** The recovery interval SPANS ZERO. The lift is not established.');
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
