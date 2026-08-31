/**
 * SALVAGE - Phase 3 entrypoint: the agent, measured against the control arm.
 *
 * Acceptance (spec section 8): "agent arm beats control on recovery rate AND on cost per
 * rupee recovered, on identical seeded population."
 *
 *   node src/phase3.ts --cases 300
 *   node src/phase3.ts --cases 300 --deterministic-only   (no API calls)
 *
 * Both arms run against the SAME `Population` object, and every environment draw is
 * order-independent, so the two arms face a bit-identical world and differ only in what
 * they decide to do.
 */
import { loadEnv } from './config.ts';
import { formatINR } from './domain/money.ts';
import { ControlT3Policy } from './policy/controlT3.ts';
import { AgentPolicy } from './agent/agentPolicy.ts';
import { buildModelChain } from './agent/modelChain.ts';
import { provenanceOf } from './agent/provenance.ts';
import { renderArmMetrics, renderTable } from './engine/metrics.ts';
import { buildAtRiskPopulation } from './sim/population.ts';
import { computeLift, runArm } from './engine/runner.ts';

loadEnv();

interface Options {
  seed: string;
  cases: number;
  concurrency: number;
  deterministicOnly: boolean;
  json: boolean;
}

function parseArgs(argv: ReadonlyArray<string>): Options {
  const o: Options = {
    seed: '20260101',
    cases: 300,
    concurrency: 12,
    deterministicOnly: false,
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
      case '--seed': o.seed = next(); break;
      case '--cases': o.cases = Number.parseInt(next(), 10); break;
      case '--concurrency': o.concurrency = Number.parseInt(next(), 10); break;
      case '--deterministic-only': o.deterministicOnly = true; break;
      case '--json': o.json = true; break;
      case '--help':
      case '-h':
        console.log(
          'Usage: node src/phase3.ts [--seed <s>] [--cases <n>] [--concurrency <n>] ' +
            '[--deterministic-only] [--json]',
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
 SALVAGE - autonomous payment recovery              Phase 3: the agent
-------------------------------------------------------------------------------
 *** ALL DATA BELOW IS SIMULATED ***
 Customers, banks, mandates, decline codes and outcomes come from a seeded model
 in src/sim/. No money moves and no real PAYMENT api is called. The only outbound
 network calls are to the model provider, for diagnosis and strategy selection.
===============================================================================
`.trim();

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));

  if (!o.json) {
    console.log(BANNER);
    console.log();
    console.log(`Seed: ${o.seed}   Cases: ${o.cases}`);
  }

  // ONE population, handed to both arms. This is the whole basis of the comparison.
  const population = buildAtRiskPopulation(o.seed, o.cases);

  const control = new ControlT3Policy();
  const client = o.deterministicOnly ? null : buildModelChain();
  if (!o.deterministicOnly && client === null) {
    throw new Error(
      'a live run was requested but no model provider is configured.\n' +
        '  Set GROQ_API_KEY in .env (free, no card: https://console.groq.com -> API Keys)\n' +
        '  or run with --deterministic-only to make the absence of the model explicit.',
    );
  }

  if (!o.json) {
    console.log(
      `Requested mode: ${
        client === null
          ? 'deterministic only (no API calls)'
          : `providers [${client.providerNames.join(' -> ')}] (provenance verified after the run)`
      }`,
    );
    console.log();
  }
  const agent = new AgentPolicy({
    world: population.world,
    seed: o.seed,
    client,
    deterministicOnly: o.deterministicOnly,
  });

  if (!o.json) console.log('Running control arm (fixed T+3)...');
  const controlArm = await runArm(population, control, o.concurrency);

  if (!o.json) console.log('Running agent arm...');
  const startedAt = Date.now();
  const agentArm = await runArm(population, agent, o.concurrency);
  const agentElapsedMs = Date.now() - startedAt;

  const lift = computeLift(controlArm.metrics, agentArm.metrics);

  if (o.json) {
    console.log(
      JSON.stringify(
        {
          simulated: true,
          seed: o.seed,
          control: controlArm.metrics,
          agent: agentArm.metrics,
          lift,
          agentStats: agent.stats,
          llmUsage: client?.usage ?? null,
          provenance: provenanceOf({
            modelEnabled: !o.deterministicOnly,
            stats: agent.stats,
            usage: client?.usage ?? null,
          }),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log();
  console.log('CONTROL ARM');
  console.log(renderArmMetrics(controlArm.metrics));
  console.log();
  console.log('AGENT ARM');
  console.log(renderArmMetrics(agentArm.metrics));

  // --- the headline ---------------------------------------------------------
  const c = controlArm.metrics;
  const a = agentArm.metrics;
  const beatsRecovery = a.recoveryRatePct > c.recoveryRatePct;
  const beatsCost = a.costPerRupeeRecovered < c.costPerRupeeRecovered;

  console.log();
  console.log('INCREMENTAL LIFT vs CONTROL (never reported gross - spec section 9)');
  console.log(
    renderTable([
      ['Metric', 'Control', 'Agent', 'Delta'],
      [
        'Recovery rate',
        `${c.recoveryRatePct.toFixed(1)}%`,
        `${a.recoveryRatePct.toFixed(1)}%`,
        `${lift.recoveryRatePpt >= 0 ? '+' : ''}${lift.recoveryRatePpt.toFixed(1)} ppt`,
      ],
      [
        'Recovered',
        formatINR(c.recoveredPaise),
        formatINR(a.recoveredPaise),
        `${lift.recoveredPaiseDelta >= 0 ? '+' : ''}${formatINR(lift.recoveredPaiseDelta)}`,
      ],
      [
        'GATEWAY cost per rupee recovered  <- headline',
        `${c.costPerRupeeRecovered.toFixed(3)}p`,
        `${a.costPerRupeeRecovered.toFixed(3)}p`,
        `${lift.costPerRupeeDeltaPct >= 0 ? '+' : ''}${lift.costPerRupeeDeltaPct.toFixed(1)}%`,
      ],
      [
        '+ human escalation, per rupee',
        `${c.cashCostPerRupeeRecovered.toFixed(3)}p`,
        `${a.cashCostPerRupeeRecovered.toFixed(3)}p`,
        '',
      ],
      [
        'All-in per rupee (incl. patience/friction)',
        `${c.allInCostPerRupeeRecovered.toFixed(3)}p`,
        `${a.allInCostPerRupeeRecovered.toFixed(3)}p`,
        `${lift.allInCostPerRupeeDeltaPct >= 0 ? '+' : ''}${lift.allInCostPerRupeeDeltaPct.toFixed(1)}%`,
      ],
      [
        'Cases escalated to a human',
        String(c.humanQueueCases),
        String(a.humanQueueCases),
        `${a.humanQueueCases - c.humanQueueCases}`,
      ],
      [
        'Total attempts',
        String(c.totalAttempts),
        String(a.totalAttempts),
        `${lift.attemptsDeltaPct >= 0 ? '+' : ''}${lift.attemptsDeltaPct.toFixed(1)}%`,
      ],
      [
        'Customer contacts',
        String(c.totalContacts),
        String(a.totalContacts),
        `${lift.contactsDelta >= 0 ? '+' : ''}${lift.contactsDelta}`,
      ],
      [
        'Attempts burned on terminal cases',
        `${c.attemptsOnTerminalCases} (${c.attemptsOnTerminalPct.toFixed(1)}%)`,
        `${a.attemptsOnTerminalCases} (${a.attemptsOnTerminalPct.toFixed(1)}%)`,
        String(a.attemptsOnTerminalCases - c.attemptsOnTerminalCases),
      ],
      [
        'Median hours to recovery',
        c.medianHoursToRecover?.toFixed(1) ?? 'n/a',
        a.medianHoursToRecover?.toFixed(1) ?? 'n/a',
        '',
      ],
    ]),
  );

  console.log();
  console.log('PHASE 3 ACCEPTANCE');
  console.log(
    renderTable([
      ['Criterion', 'Result'],
      ['Agent beats control on recovery rate', beatsRecovery ? 'PASS' : 'FAIL'],
      ['Agent beats control on GATEWAY cost per rupee recovered', beatsCost ? 'PASS' : 'FAIL'],
      [
        'All-in cost per rupee (reported, not a pass/fail bar)',
        `${a.allInCostPerRupeeRecovered < c.allInCostPerRupeeRecovered ? 'lower' : 'HIGHER'} than control`,
      ],
      ['Identical seeded population', 'PASS (one Population object, both arms)'],
    ]),
  );
  if (!beatsRecovery || !beatsCost) process.exitCode = 1;

  // --- cost discipline ------------------------------------------------------
  const s = agent.stats;
  console.log();
  console.log('AGENT COST DISCIPLINE (spec section 4: the LLM never runs over the full ledger)');
  console.log(
    renderTable([
      ['Layer', 'Count', 'Share of decisions'],
      ['Decisions taken', String(s.decisions), '100%'],
      [
        'Settled by deterministic triage',
        String(s.triagedDeterministically),
        pct(s.triagedDeterministically, s.decisions),
      ],
      ['Served from the decision cache', String(s.cacheHits), pct(s.cacheHits, s.decisions)],
      ['Actual model calls', String(s.modelCalls), pct(s.modelCalls, s.decisions)],
      [
        'Deterministic fallback (model unavailable)',
        String(s.fallbacks),
        pct(s.fallbacks, s.decisions),
      ],
      [
        'Model proposals corrected as impossible',
        String(s.corrections),
        pct(s.corrections, s.decisions),
      ],
    ]),
  );

  if (client !== null) {
    const u = client.usage;
    console.log(
      renderTable([
        ['LLM usage', 'Value'],
        ['Successful calls', String(u.calls)],
        ['Failed calls (retried or fell back)', String(u.failedCalls)],
        ['Prompt / output tokens', `${u.promptTokens} / ${u.outputTokens}`],
        [
          'Mean latency per call',
          u.calls === 0 ? 'n/a' : `${Math.round(u.totalLatencyMs / u.calls)}ms`,
        ],
        ['Models used', Object.entries(u.byModel).map(([m, n]) => `${m}x${n}`).join(', ') || 'none'],
        ['Agent arm wall-clock', `${(agentElapsedMs / 1000).toFixed(1)}s`],
      ]),
    );
  }

  // --- sensitivity: the all-in figure is driven by an invented constant ---------
  // Reporting "all-in cost is higher" as a finding would be misleading when that number
  // is dominated by a stand-in we chose. So report where it turns over instead.
  const cShadow = c.totalCostPaise - c.cashCostPaise;
  const aShadow = a.totalCostPaise - a.cashCostPaise;
  console.log();
  console.log(
    'Note on the escalation line: control never escalates a frozen or risk-declined\n' +
      'account to anyone. It looks cheaper on human cost by declining the obligation,\n' +
      'which is why that cost is broken out rather than folded into the headline.',
  );
  const allIn = (cash: number, shadow: number, k: number, recoveredPaise: number) =>
    (cash + k * shadow) / (recoveredPaise / 100);
  // Multiplier k on the patience/friction assumptions at which the two arms are equal.
  const denom = aShadow / (a.recoveredPaise / 100) - cShadow / (c.recoveredPaise / 100);
  const breakEven =
    denom === 0
      ? null
      : (c.cashCostPaise / (c.recoveredPaise / 100) - a.cashCostPaise / (a.recoveredPaise / 100)) /
        denom;

  console.log();
  console.log('SENSITIVITY OF THE ALL-IN FIGURE');
  console.log(
    renderTable([
      ['Patience/friction assumption', 'Control all-in', 'Agent all-in', 'Agent better?'],
      ...[0, 0.25, 0.5, 1, 2].map((k) => {
        const cv = allIn(c.cashCostPaise, cShadow, k, c.recoveredPaise);
        const av = allIn(a.cashCostPaise, aShadow, k, a.recoveredPaise);
        return [
          k === 1 ? '1.0x (as assumed)' : `${k.toFixed(2)}x`,
          `${cv.toFixed(3)}p`,
          `${av.toFixed(3)}p`,
          av < cv ? 'yes' : 'no',
        ];
      }),
    ]),
  );
  console.log(
    breakEven === null || breakEven <= 0
      ? 'The two arms do not cross within a meaningful range of the assumption.'
      : `Break-even: the agent wins on all-in cost when customer patience and friction are\n` +
        `priced below ${breakEven.toFixed(2)}x our assumed values. Above that, it recovers more\n` +
        `money at a higher modelled human cost - a real trade-off, not a hidden one.`,
  );

  // PROVENANCE. Derived from what was observed, never from the flags. This is the one
  // claim the project must not get wrong, so it is computed in one place and printed
  // whether it flatters the run or not.
  const prov = provenanceOf({
    modelEnabled: !o.deterministicOnly,
    stats: agent.stats,
    usage: client?.usage ?? null,
  });

  console.log();
  console.log('RESULT PROVENANCE');
  console.log(renderTable([['Question', 'Answer'], ['Who decided?', prov.label]]));
  console.log(prov.detail);
  if (!prov.isModelDriven && !o.deterministicOnly) {
    // The model was asked for and did not deliver. Fail the run rather than let the
    // output be quoted as an AI result.
    console.log();
    console.log(
      '*** These numbers are NOT a model-driven result. Do not present them as one.\n' +
        '*** Re-run when the API is available, or use --deterministic-only to make the\n' +
        '*** absence of the model explicit and intentional.',
    );
    process.exitCode = 1;
  }

  console.log();
  console.log('STRATEGY MIX');
  const mix = new Map<string, number>();
  for (const t of agent.traces) mix.set(t.strategy, (mix.get(t.strategy) ?? 0) + 1);
  console.log(
    renderTable([
      ['Strategy', 'Times chosen', 'Share'],
      ...[...mix.entries()]
        .sort((x, y) => y[1] - x[1])
        .map(([k, n]) => [k, String(n), pct(n, agent.traces.length)]),
    ]),
  );

  console.log();
  console.log(
    'Reminder: a SIMULATED comparison against a control arm, not a measurement of any\n' +
      'production system. Every cost and probability assumption is listed in README.md.',
  );
}

const pct = (n: number, d: number) => (d === 0 ? '0%' : `${((n / d) * 100).toFixed(1)}%`);

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
