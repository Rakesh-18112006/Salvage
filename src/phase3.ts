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
import { COST } from './assumptions.ts';
import { breakEvenCurve, modelCostAtScale, tokenPriceFromEnv } from './economics.ts';
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

  // --- the all-in row, and the assumption it turns on ---------------------------
  // Reporting "all-in cost is higher" as a finding would be misleading when the number
  // is dominated by a stand-in we chose. So report the CURVE and where it crosses.
  console.log();
  console.log(
    'Note on the escalation line: control never escalates a frozen or risk-declined\n' +
      'account to anyone. It looks cheaper on human cost by declining the obligation,\n' +
      'which is why that cost is broken out rather than folded into the headline.',
  );

  const curve = breakEvenCurve(c, a, {
    assumedContactPaise: COST.contactPatiencePaise.value,
  });

  console.log();
  console.log('ALL-IN COST vs THE PRICE OF CUSTOMER PATIENCE');
  console.log(
    renderTable([
      ['Patience/friction priced at', 'Per contact', 'Control', 'Agent', 'Agent better?'],
      ...curve.points.map((p) => [
        p.k === 1 ? '1.00x (as assumed)' : `${p.k.toFixed(2)}x`,
        `${((p.k * COST.contactPatiencePaise.value) / 100).toFixed(2)} INR`,
        `${p.controlAllInPaise.toFixed(3)}p`,
        `${p.agentAllInPaise.toFixed(3)}p`,
        p.agentBetter ? 'yes' : 'no',
      ]),
    ]),
  );
  console.log(
    curve.crossoverK === null
      ? 'The two arms do not cross within a meaningful range of the assumption.'
      : `CROSSOVER at ${curve.crossoverK.toFixed(2)}x, i.e. when one customer contact is\n` +
        `worth about INR ${((curve.crossoverContactPaise ?? 0) / 100).toFixed(2)}. Below that the agent is cheaper on EVERY\n` +
        'measure and there is no trade-off to argue about. Above it, it recovers more\n' +
        'money at a higher modelled human cost - a real trade-off, and the number the\n' +
        'argument should be about is the price of a contact, not the cost per rupee.',
  );

  // Say plainly which side of the crossover the assumed price sits on, rather than
  // leaving a reader to compare two numbers in different units.
  if (curve.crossoverK !== null) {
    console.log(
      curve.crossoverK >= 1
        ? 'At the price we assumed, the agent is on the WINNING side of that crossover.'
        : 'At the price we assumed (INR 15.00 per contact) the agent is on the LOSING\n' +
          'side of that crossover, and this table is the honest way to say so: the agent\n' +
          'wins on all-in cost only where a contact is cheap. We priced a contact at five\n' +
          'gateway fees precisely so that messaging could never be the cheap default, and\n' +
          'that choice is what puts us the wrong side of the line. A business that prices\n' +
          'its own customer patience lower than we did reaches a different answer, which\n' +
          'is why the price is the argument and not the ratio.',
    );
  }

  // --- what this would cost at volume ------------------------------------------
  // Only meaningful when a model actually ran. Printing "0 calls per 1,000 cases" after
  // a deterministic run would read as "the model is free" rather than "no model ran".
  const price = tokenPriceFromEnv();
  if (client !== null && s.modelCalls > 0) {
  const scale = modelCostAtScale(
    {
      cases: o.cases,
      decisions: s.decisions,
      triagedDeterministically: s.triagedDeterministically,
      cacheHits: s.cacheHits,
      modelCalls: s.modelCalls,
      promptTokens: client?.usage.promptTokens ?? 0,
      outputTokens: client?.usage.outputTokens ?? 0,
    },
    a.recoveredPaise,
    price,
  );

  console.log();
  console.log('MODEL COST AT VOLUME (projected from THIS run\'s observed usage)');
  console.log(
    renderTable([
      ['Measure', 'Value'],
      ['Decisions per case', scale.decisionsPerCase.toFixed(2)],
      ['Decisions settled without any model', `${scale.settledWithoutModelPct.toFixed(1)}%`],
      ['  of which served from the decision cache', `${scale.cacheHitPct.toFixed(1)}%`],
      ['Model calls per 1,000 cases', scale.modelCallsPer1000Cases.toFixed(1)],
      ['Prompt tokens per 1,000 cases', Math.round(scale.promptTokensPer1000Cases).toLocaleString('en-IN')],
      ['Output tokens per 1,000 cases', Math.round(scale.outputTokensPer1000Cases).toLocaleString('en-IN')],
      [
        'Model spend per 1,000,000 cases',
        scale.costPerMillionCasesRupees === null
          ? 'no price supplied - see below'
          : `INR ${scale.costPerMillionCasesRupees.toFixed(0)}`,
      ],
      [
        'As a share of the money recovered',
        scale.costAsShareOfRecoveredPct === null
          ? 'n/a'
          : `${scale.costAsShareOfRecoveredPct.toFixed(4)}%`,
      ],
    ]),
  );
  console.log(
    price === null
      ? 'No token price is supplied, and none is hardcoded on purpose: a per-token price\n' +
        'baked into this repo would be quoted back as a fact about a vendor long after it\n' +
        'stopped being true. Calls and tokens above are MEASUREMENTS. To price them, set\n' +
        'SALVAGE_MODEL_INPUT_RUPEES_PER_MTOK, SALVAGE_MODEL_OUTPUT_RUPEES_PER_MTOK and\n' +
        'SALVAGE_MODEL_PRICE_SOURCE, and the money appears with its source recorded.'
      : `Price basis: ${price.source}`,
  );
  console.log(
    'The seven-minute wall clock on this run is a FREE-TIER RATE LIMIT (8,000 tokens per\n' +
      'minute), not an architectural bound - the call count above is what scales. Note\n' +
      'also that the cache hit rate is an upper bound: a larger, more varied portfolio\n' +
      'presents more distinct decision contexts and would cache less well.',
  );
  }

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
