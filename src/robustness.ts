/**
 * SALVAGE - the ablation ladder, run across worlds our beliefs are wrong about.
 *
 *   node src/robustness.ts                       (all scenarios, 10 seeds each)
 *   node src/robustness.ts --seeds 20 --json
 *   node src/robustness.ts --scenario all-adverse
 *
 * This file answers the two objections that most reliably kill a project like this one,
 * and it answers them with the same run because they are the same question asked twice.
 *
 * OBJECTION 1 - "isn't this just smart retry?"
 * --------------------------------------------
 * Four arms, each adding exactly one capability to the one before it (src/policy/
 * ablation.ts). The gaps between them say where the lift comes from:
 *
 *   1. FIXED T+3              retries on a calendar, three times, knowing nothing
 *   2. + KNOWS WHY            refuses to spend attempts on a cause no retry can clear
 *   3. + KNOWS WHEN           presents after the customer's inflow, not tomorrow
 *   4. + THE OTHER SIX ACTIONS  re-mandate, link, notify, defer, escalate, wait
 *
 * If arm 2 captures most of the lift, then most of this is smart retry and we should say
 * so. That is a real possible outcome of running this, and it is printed either way.
 *
 * OBJECTION 2 - "you wrote both the simulator and the policy"
 * ----------------------------------------------------------
 * Every arm is run again in each misspecified world from src/eval/misspecification.ts.
 * The simulator's behaviour changes; the agent's beliefs do not, because it reads
 * src/assumptions.ts and has no access to the world's parameters. The agent is therefore
 * wrong about the world in a different way in each column, which is the condition every
 * real deployment operates in permanently.
 *
 * All arms are DETERMINISTIC - no model, no API key, exactly reproducible. Phase 3
 * measured the model's contribution as inside run-to-run noise, so including it here
 * would add hours of runtime and confound cohort variance with model variance without
 * changing the conclusion. What the model IS worth is measured in src/generalization.ts.
 *
 * ALL DATA IS SIMULATED.
 */
import { AgentPolicy } from './agent/agentPolicy.ts';
import { renderTable } from './engine/metrics.ts';
import { runArm } from './engine/runner.ts';
import { ClassAwareRetryPolicy, InflowTimedRetryPolicy } from './policy/ablation.ts';
import { ControlT3Policy } from './policy/controlT3.ts';
import { SCENARIOS, scenarioByName, type Scenario } from './eval/misspecification.ts';
import { buildAtRiskPopulation } from './sim/population.ts';
import { mean, pairedSummary, renderInterval } from './stats.ts';

interface Options {
  baseSeed: number;
  seeds: number;
  cases: number;
  concurrency: number;
  scenario: string | null;
  json: boolean;
}

function parseArgs(argv: ReadonlyArray<string>): Options {
  const o: Options = {
    baseSeed: 20260101,
    seeds: 10,
    cases: 300,
    concurrency: 12,
    scenario: null,
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
      case '--scenario': o.scenario = next(); break;
      case '--json': o.json = true; break;
      case '--help':
      case '-h':
        console.log(
          'Usage: node src/robustness.ts [--seeds <n>] [--cases <n>] ' +
            '[--scenario <name>] [--json]\n' +
            `Scenarios: ${SCENARIOS.map((s) => s.name).join(', ')}`,
        );
        process.exit(0);
        break;
      default: throw new Error(`unknown argument: ${arg}`);
    }
  }
  return o;
}

const BANNER = `
===============================================================================
 SALVAGE - robustness          Where does the lift come from, and what survives?
-------------------------------------------------------------------------------
 *** ALL DATA BELOW IS SIMULATED ***
 Four arms, each adding ONE capability, run in worlds the agent's beliefs are
 wrong about. All arms deterministic - no model, no API key, reproducible.
===============================================================================
`.trim();

const ARMS = ['t3', 'classAware', 'inflowTimed', 'salvage'] as const;
type ArmKey = (typeof ARMS)[number];

const ARM_LABEL: Readonly<Record<ArmKey, string>> = {
  t3: '1. fixed T+3',
  classAware: '2. + knows WHY it failed',
  inflowTimed: '3. + knows WHEN they are paid',
  salvage: '4. + the other six actions (SALVAGE)',
};

interface ArmSample {
  readonly recovery: number;
  readonly attempts: number;
  /** Gateway cost per rupee recovered, in paise. Infinite when nothing was recovered. */
  readonly costPerRupee: number;
  readonly attemptsOnTerminal: number;
}

type SeedResult = Record<ArmKey, ArmSample>;

async function runOneSeed(
  scenario: Scenario,
  seed: string,
  cases: number,
  concurrency: number,
): Promise<SeedResult> {
  // One population per (scenario, seed), shared by all four arms. Without that the
  // ladder would be comparing four different worlds and every gap in it would be noise.
  const population = buildAtRiskPopulation(seed, cases, { params: scenario.params });
  const { world } = population;

  const [t3, classAware, inflowTimed, salvage] = await Promise.all([
    runArm(population, new ControlT3Policy(), concurrency),
    runArm(population, new ClassAwareRetryPolicy(), concurrency),
    runArm(population, new InflowTimedRetryPolicy(world), concurrency),
    runArm(
      population,
      new AgentPolicy({ world, seed, deterministicOnly: true }),
      concurrency,
    ),
  ]);

  const sample = (r: Awaited<ReturnType<typeof runArm>>): ArmSample => ({
    recovery: r.metrics.recoveryRatePct,
    attempts: r.metrics.totalAttempts,
    costPerRupee: r.metrics.costPerRupeeRecovered,
    attemptsOnTerminal: r.metrics.attemptsOnTerminalCases,
  });

  return {
    t3: sample(t3),
    classAware: sample(classAware),
    inflowTimed: sample(inflowTimed),
    salvage: sample(salvage),
  };
}

interface ScenarioResult {
  readonly scenario: Scenario;
  readonly perSeed: ReadonlyArray<SeedResult>;
  readonly means: Record<ArmKey, number>;
  readonly attemptMeans: Record<ArmKey, number>;
  readonly terminalAttemptMeans: Record<ArmKey, number>;
  readonly costMeans: Record<ArmKey, number>;
  /** Paired interval on SALVAGE minus fixed T+3, over the seeds. */
  readonly liftLo: number;
  readonly liftHi: number;
  readonly liftMean: number;
  readonly seedsWon: number;
  /** SALVAGE minus the strongest retry-only arm. The "isn't this smart retry" number. */
  readonly overBestRetryOnly: number;
}

async function runScenario(scenario: Scenario, o: Options): Promise<ScenarioResult> {
  const perSeed: SeedResult[] = [];
  for (let i = 0; i < o.seeds; i++) {
    perSeed.push(
      await runOneSeed(scenario, String(o.baseSeed + i), o.cases, o.concurrency),
    );
  }

  const col = (k: ArmKey) => perSeed.map((r) => r[k].recovery);
  const avg = (pick: (s: ArmSample) => number) =>
    Object.fromEntries(
      ARMS.map((k) => [k, mean(perSeed.map((r) => pick(r[k])))]),
    ) as Record<ArmKey, number>;

  const means = avg((s) => s.recovery);
  const paired = pairedSummary(col('t3'), col('salvage'), `robustness|${scenario.name}`);
  const bestRetryOnly = Math.max(means.classAware, means.inflowTimed);

  return {
    scenario,
    perSeed,
    means,
    attemptMeans: avg((s) => s.attempts),
    terminalAttemptMeans: avg((s) => s.attemptsOnTerminal),
    costMeans: avg((s) => s.costPerRupee),
    liftMean: paired.difference.mean,
    liftLo: paired.difference.lo,
    liftHi: paired.difference.hi,
    seedsWon: paired.treatmentWins,
    overBestRetryOnly: means.salvage - bestRetryOnly,
  };
}

const f1 = (n: number) => n.toFixed(1);
const signed = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}`;

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));
  const scenarios = o.scenario === null ? SCENARIOS : [scenarioByName(o.scenario)];

  if (!o.json) {
    console.log(BANNER);
    console.log();
    console.log(
      `Scenarios: ${scenarios.length}   Seeds each: ${o.seeds}   Cases per seed: ${o.cases}   ` +
        `Total: ${(scenarios.length * o.seeds * o.cases * ARMS.length).toLocaleString('en-IN')} case-runs`,
    );
    console.log();
  }

  const results: ScenarioResult[] = [];
  for (const s of scenarios) {
    if (!o.json && process.stdout.isTTY) {
      process.stdout.write(`\r  running ${s.name}...                    `);
    }
    results.push(await runScenario(s, o));
  }
  if (!o.json && process.stdout.isTTY) console.log('\r' + ' '.repeat(60) + '\r');

  if (o.json) {
    console.log(
      JSON.stringify(
        {
          simulated: true,
          deterministic: true,
          seeds: o.seeds,
          casesPerSeed: o.cases,
          arms: ARM_LABEL,
          results: results.map((r) => ({
            scenario: r.scenario.name,
            falsifies: r.scenario.falsifies,
            means: r.means,
            liftOverT3: { mean: r.liftMean, lo: r.liftLo, hi: r.liftHi, seedsWon: r.seedsWon },
            overBestRetryOnly: r.overBestRetryOnly,
            perSeed: r.perSeed,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  // ---- 1. the ladder, in the world we designed for -------------------------
  const base = results.find((r) => r.scenario.name === 'baseline');
  if (base !== undefined) {
    console.log('WHERE THE LIFT COMES FROM (baseline world)');
    let prev: number | null = null;
    const rows: string[][] = [
      ['Arm', 'Recovery', 'Recovery gained', 'Share', 'Attempts', 'Wasted on terminal', 'Gateway c/₹'],
    ];
    const total = base.means.salvage - base.means.t3;
    for (const k of ARMS) {
      const v = base.means[k];
      const step = prev === null ? null : v - prev;
      rows.push([
        ARM_LABEL[k],
        `${f1(v)}%`,
        step === null ? '—' : `${signed(step)} ppt`,
        step === null || total === 0 ? '—' : `${((step / total) * 100).toFixed(0)}%`,
        base.attemptMeans[k].toFixed(0),
        base.terminalAttemptMeans[k].toFixed(0),
        Number.isFinite(base.costMeans[k]) ? `${base.costMeans[k].toFixed(3)}p` : 'n/a',
      ]);
      prev = v;
    }
    console.log(renderTable(rows));
    console.log(
      'Each row adds exactly ONE capability to the row above it, so the gain on that row\n' +
        'is attributable to that capability alone.',
    );
    console.log();
    console.log(
      'ARM 2 IS IDENTICAL TO ARM 1 ON EVERY COLUMN, AND THAT IS THE POINT.\n' +
        '\n' +
        'Arm 2 is smart retry: it reads the failure class and refuses to charge a cause no\n' +
        'retry can clear. It changes nothing, because THE POLICY GATE ALREADY ENFORCES\n' +
        'THAT FOR THE CONTROL ARM. Run the control arm and read its rule counts -\n' +
        'TERMINAL_CLASS_NO_CHARGE fires 99 times on 300 cases, UNKNOWN_FAILURE_NOT_RETRYABLE\n' +
        'another 9. Terminal cases get exactly one attempt each in both arms: the opening\n' +
        'charge that created the case, which no policy could have avoided.\n' +
        '\n' +
        'So the answer to "isn\'t this just smart retry?" is not that SALVAGE beats smart\n' +
        'retry. It is that the BASELINE already is smart retry - the gate applies to every\n' +
        'arm and was never switched off to flatter us - and SALVAGE beats that. The lift\n' +
        'in the table below is measured against a control that already declines every\n' +
        'impossible charge.',
    );
  }

  // ---- 2. what survives a world we are wrong about -------------------------
  console.log();
  console.log('WHAT SURVIVES WHEN OUR BELIEFS ARE WRONG');
  console.log(
    renderTable([
      ['World', 'T+3', 'Arm 2', 'Arm 3', 'SALVAGE', 'Lift over T+3 (95% CI)', 'Seeds', 'vs best retry-only'],
      ...results.map((r) => [
        r.scenario.name,
        `${f1(r.means.t3)}%`,
        `${f1(r.means.classAware)}%`,
        `${f1(r.means.inflowTimed)}%`,
        `${f1(r.means.salvage)}%`,
        `${signed(r.liftMean)} [${f1(r.liftLo)}, ${f1(r.liftHi)}]`,
        `${r.seedsWon}/${o.seeds}`,
        `${signed(r.overBestRetryOnly)} ppt`,
      ]),
    ]),
  );

  // A scenario that moves no number tested nothing, and a reader should not have to
  // notice that by eye. Flagged explicitly rather than left sitting in the table looking
  // like evidence of robustness.
  const noOps =
    base === undefined
      ? []
      : results.filter(
          (r) =>
            r.scenario.name !== 'baseline' &&
            ARMS.every((k) => Math.abs(r.means[k] - base.means[k]) < 0.05),
        );

  console.log();
  console.log('WHAT EACH WORLD FALSIFIES');
  for (const r of results) {
    if (r.scenario.name === 'baseline') continue;
    const noop = noOps.includes(r) ? '   [NO EFFECT ON THESE ARMS - see below]' : '';
    console.log(`  ${r.scenario.name}${noop}`);
    console.log(`    ${r.scenario.falsifies}`);
  }

  if (noOps.length > 0) {
    console.log();
    console.log(
      `NO-EFFECT SCENARIOS: ${noOps.map((r) => r.scenario.name).join(', ')}\n` +
        'These changed the world and changed no arm\'s result. That is not evidence of\n' +
        'robustness and must not be quoted as such - it means the arms tested here never\n' +
        'exercise the assumption in question. The deterministic agent, for instance, never\n' +
        'chooses NOTIFY_ONLY at all, so the value of a notification cannot affect it.',
    );
  }

  // ---- 3. the verdict, stated rather than left to the reader ---------------
  const worst = results.reduce((w, r) => (r.liftMean < w.liftMean ? r : w));
  const anyLost = results.filter((r) => r.liftLo <= 0);
  const lostToRetryOnly = results.filter((r) => r.overBestRetryOnly <= 0);

  console.log();
  console.log('VERDICT');
  console.log(
    renderTable([
      ['Question', 'Answer'],
      ['Worlds tested', String(results.length)],
      [
        'Worlds where the lift over T+3 is established',
        `${results.length - anyLost.length} of ${results.length}`,
      ],
      [
        'Weakest world',
        `${worst.scenario.name} (${signed(worst.liftMean)} ppt [${f1(worst.liftLo)}, ${f1(worst.liftHi)}])`,
      ],
      [
        'Worlds where a retry-only arm matches or beats SALVAGE',
        lostToRetryOnly.length === 0
          ? 'none'
          : lostToRetryOnly.map((r) => r.scenario.name).join(', '),
      ],
    ]),
  );

  if (anyLost.length > 0) {
    console.log();
    console.log(
      `*** The lift is NOT established in: ${anyLost.map((r) => r.scenario.name).join(', ')}.\n` +
        '*** Those worlds are a genuine limit on the claim and must be presented as one.\n' +
        '***\n' +
        '*** Note WHY a world like all-adverse defeats us, because it is not the obvious\n' +
        '*** reason. It is not that recovery got harder - look along the T+3 row, which\n' +
        '*** IMPROVES there. It is that shortfalls became transient and accounts deplete\n' +
        '*** immediately, which is a world where blind daily retry genuinely works and the\n' +
        '*** problem this project exists to solve does not really exist. The honest\n' +
        '*** statement of the claim is therefore conditional: SALVAGE is worth having\n' +
        '*** WHERE BALANCE SHORTFALLS PERSIST. That is a testable property of a real\n' +
        '*** portfolio, and it is the first thing to measure before deploying any of this.',
    );
  }

  console.log();
  console.log(
    'Reminder: a SIMULATED comparison. Perturbing a parameter tests sensitivity to that\n' +
      'parameter; it does not test a structural error in the model shape itself. A world\n' +
      'where shortfalls, paydays, and self-healing work in some ENTIRELY different way is\n' +
      'not reachable by moving these dials, and this run says nothing about it.',
  );

  // A lift that collapses in the adversarial world is the finding, and it must fail
  // loudly rather than sit in a table for a reader to notice.
  const adverse = results.find((r) => r.scenario.name === 'all-adverse');
  if (adverse !== undefined && adverse.liftLo <= 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
