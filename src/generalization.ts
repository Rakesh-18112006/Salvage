/**
 * SALVAGE - the generalization eval: what is the language model actually for?
 *
 *   node src/generalization.ts --cases 150
 *   node src/generalization.ts --cases 150 --deterministic-only   (the floor, no API)
 *
 * WHY THIS EXISTS
 * ---------------
 * `node src/phase3.ts` measures the model as a STRATEGIST, competing against our own
 * hand-written rules on the failure classes those rules were built for. Its answer is a
 * null result and the project reports it as one: model off reaches 70.7% exactly, model
 * on gave 72.0%, 70.0% and 68.0% across three runs. The model's effect is inside its own
 * run-to-run noise, and essentially all of the ~+20 ppt lift belongs to the deterministic
 * machinery.
 *
 * That is an honest finding, and it is also an incomplete one. It measures the model on
 * the taxonomy's home ground, where the taxonomy already has a row for every code and a
 * lookup beats a language model on every axis that matters - cost, latency, determinism.
 * Of course it does. The interesting question is what happens where the lookup table has
 * NO row.
 *
 * THE SCENARIO
 * ------------
 * A rail changes its decline vocabulary, or a new acquirer is onboarded, and suddenly
 * every response is a code this build has never seen. This is not hypothetical: the
 * taxonomy's own comment calls a falling coverage rate "the early warning that a rail
 * changed its codes", and NPCI's NACH return codes are unmapped in this build today
 * because npci.org.in refused automated access.
 *
 * When that happens, every failure classifies as UNKNOWN. An unclassified failure is
 * never auto-retried - the policy gate enforces it - so the entire cohort escalates to a
 * human and recovers almost nothing. The deterministic system cannot do better, and not
 * because it is badly written: it structurally cannot, because reading unfamiliar prose
 * is not something a lookup table does.
 *
 * A language model can read it. That is the claim this file tests.
 *
 * WHAT IS MEASURED, AND WHY IT IS SEVERAL NUMBERS AND NOT ONE
 * ----------------------------------------------------------
 * A classifier that reads legible text well is worthless if it also invents readings for
 * illegible text, because the consequence is a charge presented against a mandate that
 * can never carry it. So the corpus contains both kinds of string - see
 * src/eval/railDialect.ts - and they are scored separately and never averaged.
 *
 * COMPREHENSION, scored against what the text supports:
 *
 *   READ CORRECTLY       legible text, adopted, right class.
 *   MISREAD, IMMATERIAL  wrong class, same prescribed intervention. Changes nothing.
 *   MISREAD, MATERIAL    wrong class AND a different intervention. Changes what happens.
 *   DECLINED             legible text the model would not commit on. Recovery forgone.
 *   OVER-CONFIDENT       ILLEGIBLE text, adopted anyway. The dangerous one.
 *
 * CONSEQUENCE, scored against the simulator's hidden truth, over adopted readings only:
 *
 *   did the reading put the case on the right side of "can a charge EVER work?", and
 *   how many readings unlocked a charge against a cause no charge can clear.
 *
 * Look at OVER-CONFIDENT and UNLOCKED first. A model that never answers UNKNOWN scores
 * beautifully on comprehension and should not be shipped.
 *
 * ALL DATA IS SIMULATED. The dialect is our own invention and no string in it is a real
 * NPCI, UPI, or Razorpay code.
 */
import { loadEnv } from './config.ts';
import { AgentPolicy, type UnmappedRead } from './agent/agentPolicy.ts';
import { buildModelChain } from './agent/model/chain.ts';
import { provenanceOf } from './agent/provenance.ts';
import { CORRECT_INTERVENTION, isTerminal, type FailureClass } from './domain/taxonomy.ts';
import { renderTable } from './engine/metrics.ts';
import type { ArmMetrics } from './engine/metrics.ts';
import { runArm } from './engine/runner.ts';
import { ControlT3Policy } from './policy/controlT3.ts';
import { allDialectResponses, dialectResponse, DIALECT_NAME } from './eval/railDialect.ts';
import { buildAtRiskPopulation } from './sim/population.ts';
import type { RailDialect } from './sim/paymentSimulator.ts';

loadEnv();

interface Options {
  seed: string;
  cases: number;
  concurrency: number;
  minConfidence: number;
  deterministicOnly: boolean;
  json: boolean;
}

function parseArgs(argv: ReadonlyArray<string>): Options {
  const o: Options = {
    seed: '20260101',
    // Smaller than the Phase 3 cohort on purpose. Under an unmapped dialect NOTHING is
    // settled by triage - every class is UNKNOWN - so every decision reaches the model,
    // and on a free tier paced by tokens-per-minute a 300-case run takes far longer than
    // it takes to learn anything. 150 is enough to separate the arms.
    cases: 150,
    concurrency: 12,
    minConfidence: 0.7,
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
      case '--min-confidence': o.minConfidence = Number.parseFloat(next()); break;
      case '--deterministic-only': o.deterministicOnly = true; break;
      case '--json': o.json = true; break;
      case '--help':
      case '-h':
        console.log(
          'Usage: node src/generalization.ts [--seed <s>] [--cases <n>] ' +
            '[--concurrency <n>] [--min-confidence <0..1>] [--deterministic-only] [--json]',
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
 SALVAGE - generalization eval      What is the language model actually for?
-------------------------------------------------------------------------------
 *** ALL DATA BELOW IS SIMULATED ***
 The unmapped rail dialect is OUR OWN INVENTION (src/eval/railDialect.ts). No
 code or description in it is a real NPCI, UPI, or Razorpay error. No money
 moves and no real payment API is called.
===============================================================================
`.trim();

const dialect: RailDialect = {
  name: DIALECT_NAME,
  render: (cls, u) => {
    const r = dialectResponse(cls, u);
    return { code: r.code, desc: r.desc };
  },
};

/** What the TEXT of each dialect code supports, or null where it supports nothing. */
const READABLE_BY_CODE: ReadonlyMap<string, FailureClass | null> = new Map(
  allDialectResponses().map((r) => [r.code, r.readable]),
);

interface ClassificationScore {
  readonly legibleReadCorrectly: number;
  /** Wrong class, but the taxonomy prescribes the SAME intervention. Costs nothing. */
  readonly legibleMisreadImmaterial: number;
  /** Wrong class AND a different intervention. This one actually changes what happens. */
  readonly legibleMisreadMaterial: number;
  readonly legibleDeclined: number;
  readonly opaqueDeclined: number;
  readonly opaqueOverConfident: number;
  /** Adopted readings, scored against the simulator's truth rather than the text. */
  readonly adopted: number;
  readonly consequenceRight: number;
  readonly consequenceWrong: number;
  /** Adopted readings that called a genuinely terminal cause something fundable. */
  readonly unlockedImpossibleCharge: number;
  readonly wrongExamples: ReadonlyArray<string>;
}

/**
 * Two classes are interchangeable IN PRACTICE when the taxonomy prescribes the same
 * response to both.
 *
 * MANDATE_REVOKED, MANDATE_EXPIRED and MANDATE_NOT_ACTIVE are three different statements
 * about a mandate and one single instruction: re-authorise. A model that picks the wrong
 * one of those three has misread the text and changed nothing about what happens to the
 * customer. Counting that identically with "read a dead mandate as a funding problem"
 * would flatten the one distinction the reader of this eval actually needs.
 */
const sameHandling = (a: FailureClass, b: FailureClass): boolean =>
  CORRECT_INTERVENTION[a] === CORRECT_INTERVENTION[b];

/**
 * Score the model's readings against the corpus.
 *
 * `trueClassOf` is the SIMULATOR's ground truth and is used for exactly one thing: the
 * `unlockedImpossibleCharge` count, which is a statement about consequences rather than
 * about reading comprehension. Everything else is scored against what the text supports,
 * because a model that guesses the hidden truth from an uninformative string got lucky,
 * and luck is not a capability worth shipping.
 */
function scoreReads(
  reads: ReadonlyArray<UnmappedRead>,
  trueClassOf: (caseId: string) => FailureClass | null,
): ClassificationScore {
  let legibleReadCorrectly = 0;
  let legibleMisreadImmaterial = 0;
  let legibleMisreadMaterial = 0;
  let legibleDeclined = 0;
  let opaqueDeclined = 0;
  let opaqueOverConfident = 0;
  let adopted = 0;
  let consequenceRight = 0;
  let consequenceWrong = 0;
  let unlockedImpossibleCharge = 0;
  const wrongExamples: string[] = [];

  for (const r of reads) {
    const readable = READABLE_BY_CODE.get(r.rawErrorCode);
    if (readable === undefined) continue; // not one of ours; nothing to score against

    if (readable === null) {
      if (r.adopted) {
        opaqueOverConfident++;
        if (wrongExamples.length < 6) {
          wrongExamples.push(
            `OVER-CONFIDENT  "${r.rawErrorDesc}" -> ${r.modelDiagnosis} @ ${r.confidence.toFixed(2)}`,
          );
        }
      } else {
        opaqueDeclined++;
      }
    } else if (!r.adopted) {
      legibleDeclined++;
    } else if (r.modelDiagnosis === readable) {
      legibleReadCorrectly++;
    } else if (sameHandling(r.modelDiagnosis, readable)) {
      legibleMisreadImmaterial++;
    } else {
      legibleMisreadMaterial++;
      if (wrongExamples.length < 6) {
        wrongExamples.push(
          `MISREAD  "${r.rawErrorDesc}" -> ${r.modelDiagnosis} (text supports ${readable}; ` +
            'different handling)',
        );
      }
    }

    // ---- consequence, scored against the simulator's truth ------------------
    // A separate question from comprehension, and the one that spends money. Terminality
    // is the axis that matters: it decides whether any charge can ever succeed, and the
    // gate's TERMINAL_CLASS_NO_CHARGE rule protects only when the working class IS
    // terminal - so a reading that calls a dead mandate fundable switches it off.
    if (r.adopted) {
      adopted++;
      const truth = trueClassOf(r.caseId);
      if (truth !== null) {
        if (isTerminal(r.modelDiagnosis) === isTerminal(truth)) {
          consequenceRight++;
        } else {
          consequenceWrong++;
          if (!isTerminal(r.modelDiagnosis) && isTerminal(truth)) {
            unlockedImpossibleCharge++;
            if (wrongExamples.length < 6) {
              wrongExamples.push(
                `UNLOCKED IMPOSSIBLE CHARGE  "${r.rawErrorDesc}" -> ${r.modelDiagnosis} ` +
                  `(the cause was really ${truth})`,
              );
            }
          }
        }
      }
    }
  }

  return {
    legibleReadCorrectly,
    legibleMisreadImmaterial,
    legibleMisreadMaterial,
    legibleDeclined,
    opaqueDeclined,
    opaqueOverConfident,
    adopted,
    consequenceRight,
    consequenceWrong,
    unlockedImpossibleCharge,
    wrongExamples,
  };
}

const pct = (n: number, d: number) => (d === 0 ? 'n/a' : `${((n / d) * 100).toFixed(1)}%`);

function armRow(label: string, m: ArmMetrics): ReadonlyArray<string> {
  return [
    label,
    `${m.recoveryRatePct.toFixed(1)}%`,
    String(m.humanQueueCases),
    String(m.totalAttempts),
    `${m.attemptsOnTerminalCases}`,
    Number.isFinite(m.costPerRupeeRecovered) ? `${m.costPerRupeeRecovered.toFixed(3)}p` : 'n/a',
    `${m.taxonomyCoveragePct.toFixed(1)}%`,
  ];
}

async function main(): Promise<void> {
  const o = parseArgs(process.argv.slice(2));

  if (!o.json) {
    console.log(BANNER);
    console.log();
    console.log(`Seed: ${o.seed}   Cases: ${o.cases}   Dialect: ${DIALECT_NAME}`);
    console.log(`Confidence floor for adopting a reading: ${o.minConfidence.toFixed(2)}`);
    console.log();
  }

  // Two descriptions of ONE cohort. The dialect changes the words on the wire and
  // nothing else: causes are decided before any code is rendered, so the same
  // subscriptions fail, for the same reasons, on the same days.
  const mapped = buildAtRiskPopulation(o.seed, o.cases);
  const unmapped = buildAtRiskPopulation(o.seed, o.cases, { dialect });

  const sameCohort =
    mapped.cases.length === unmapped.cases.length &&
    mapped.cases.every((c, i) => c.subscription.id === unmapped.cases[i]!.subscription.id);
  if (!sameCohort) {
    throw new Error(
      'the mapped and unmapped cohorts diverged: the dialect changed WHICH cases fail, ' +
        'not just how they are described. The comparison below would be meaningless.',
    );
  }

  const client = o.deterministicOnly ? null : buildModelChain();
  if (!o.deterministicOnly && client === null) {
    throw new Error(
      'a live run was requested but no model provider is configured.\n' +
        '  Set GROQ_API_KEY in .env, or run with --deterministic-only to measure only\n' +
        '  the floor - which is the entire point of the comparison and needs no key.',
    );
  }

  // ---- the arms ------------------------------------------------------------
  // A. what the system does today when the vocabulary IS mapped. The ceiling.
  if (!o.json) console.log('Running: agent on the MAPPED cohort (reference ceiling)...');
  const refAgent = new AgentPolicy({
    world: mapped.world, seed: o.seed, deterministicOnly: true,
  });
  const armMappedAgent = await runArm(mapped, refAgent, o.concurrency);

  // B. fixed T+3 against an unknown vocabulary.
  if (!o.json) console.log('Running: control T+3 on the UNMAPPED cohort...');
  const armControl = await runArm(unmapped, new ControlT3Policy(), o.concurrency);

  // C. the deterministic agent against an unknown vocabulary. The floor: it has no row
  //    for any of these codes, so every case is UNKNOWN and every case goes to a person.
  if (!o.json) console.log('Running: agent, model OFF, on the UNMAPPED cohort...');
  const detAgent = new AgentPolicy({
    world: unmapped.world, seed: o.seed, deterministicOnly: true,
  });
  const armDet = await runArm(unmapped, detAgent, o.concurrency);

  // D. the same agent, allowed to read the codes it does not recognise.
  let armRead: Awaited<ReturnType<typeof runArm>> | null = null;
  let readAgent: AgentPolicy | null = null;
  if (client !== null) {
    if (!o.json) {
      console.log('Running: agent, model ON, reading unmapped codes on the UNMAPPED cohort...');
      console.log('  (every decision reaches the model here - no class is settled by triage)');
    }
    readAgent = new AgentPolicy({
      world: unmapped.world,
      seed: o.seed,
      client,
      readUnmappedCodes: true,
      reclassifyMinConfidence: o.minConfidence,
    });
    armRead = await runArm(unmapped, readAgent, o.concurrency);
  }

  const trueClassOf = (caseId: string): FailureClass | null => {
    const c = (armRead ?? armDet).cases.find((x) => x.id === caseId);
    return c?.trueOpeningClass ?? null;
  };
  const score =
    readAgent === null ? null : scoreReads(readAgent.unmappedReads, trueClassOf);

  if (o.json) {
    console.log(
      JSON.stringify(
        {
          simulated: true,
          seed: o.seed,
          dialect: DIALECT_NAME,
          minConfidence: o.minConfidence,
          mappedAgent: armMappedAgent.metrics,
          unmappedControl: armControl.metrics,
          unmappedAgentDeterministic: armDet.metrics,
          unmappedAgentReading: armRead?.metrics ?? null,
          classification: score,
          agentStats: readAgent?.stats ?? null,
          provenance:
            readAgent === null
              ? null
              : provenanceOf({
                  modelEnabled: true,
                  stats: readAgent.stats,
                  usage: client?.usage ?? null,
                }),
        },
        null,
        2,
      ),
    );
    return;
  }

  // ---- the comparison ------------------------------------------------------
  console.log();
  console.log('RECOVERY UNDER A VOCABULARY THE TAXONOMY HAS NEVER SEEN');
  console.log(
    renderTable([
      ['Arm', 'Recovery', 'To human', 'Attempts', 'On terminal', 'Gateway c/₹', 'Coverage'],
      armRow('MAPPED cohort, agent (the ceiling)', armMappedAgent.metrics),
      armRow('UNMAPPED, control T+3', armControl.metrics),
      armRow('UNMAPPED, agent, model OFF', armDet.metrics),
      ...(armRead === null ? [] : [armRow('UNMAPPED, agent READING codes', armRead.metrics)]),
    ]),
  );
  console.log(
    'Coverage is the share of failures the taxonomy could classify. It collapses under\n' +
      'the unmapped dialect by construction - that is the scenario, not a defect.',
  );

  if (armRead !== null && score !== null && readAgent !== null) {
    const lift = armRead.metrics.recoveryRatePct - armDet.metrics.recoveryRatePct;
    const gap = armMappedAgent.metrics.recoveryRatePct - armDet.metrics.recoveryRatePct;

    console.log();
    console.log('WHAT READING THE CODES RECOVERED');
    console.log(
      renderTable([
        ['Question', 'Answer'],
        ['Deterministic floor (model cannot read)', `${armDet.metrics.recoveryRatePct.toFixed(1)}%`],
        ['With the model reading unmapped codes', `${armRead.metrics.recoveryRatePct.toFixed(1)}%`],
        ['Attributable to the model', `${lift >= 0 ? '+' : ''}${lift.toFixed(1)} ppt`],
        ['Ceiling, if every code had been mapped', `${armMappedAgent.metrics.recoveryRatePct.toFixed(1)}%`],
        [
          'Share of the lost ground recovered',
          gap <= 0 ? 'n/a' : `${((lift / gap) * 100).toFixed(1)}%`,
        ],
      ]),
    );

    // ---- reading comprehension, scored against the TEXT ---------------------
    const legible =
      score.legibleReadCorrectly +
      score.legibleMisreadImmaterial +
      score.legibleMisreadMaterial +
      score.legibleDeclined;
    const opaque = score.opaqueDeclined + score.opaqueOverConfident;

    console.log();
    console.log('READING COMPREHENSION (scored against what the text supports, not the');
    console.log('simulator\'s hidden truth - guessing right from an uninformative string');
    console.log('is luck, and luck is not a capability)');
    console.log(
      renderTable([
        ['Outcome', 'Count', 'Share'],
        ['-- text that STATES a cause --', String(legible), ''],
        ['   read correctly', String(score.legibleReadCorrectly), pct(score.legibleReadCorrectly, legible)],
        ['   misread, same handling anyway', String(score.legibleMisreadImmaterial), pct(score.legibleMisreadImmaterial, legible)],
        ['   misread, DIFFERENT handling', String(score.legibleMisreadMaterial), pct(score.legibleMisreadMaterial, legible)],
        ['   declined (recovery left on the table)', String(score.legibleDeclined), pct(score.legibleDeclined, legible)],
        ['-- text that states NOTHING --', String(opaque), ''],
        ['   correctly declined  <- the safety number', String(score.opaqueDeclined), pct(score.opaqueDeclined, opaque)],
        ['   OVER-CONFIDENT, adopted anyway', String(score.opaqueOverConfident), pct(score.opaqueOverConfident, opaque)],
      ]),
    );

    console.log();
    console.log('CONSEQUENCE (adopted readings, scored against the simulator\'s truth)');
    console.log(
      renderTable([
        ['Question', 'Count', 'Share'],
        ['Readings adopted as the working class', String(score.adopted), ''],
        [
          '  put the case on the right side of "can a charge ever work?"',
          String(score.consequenceRight),
          pct(score.consequenceRight, score.adopted),
        ],
        [
          '  put it on the wrong side',
          String(score.consequenceWrong),
          pct(score.consequenceWrong, score.adopted),
        ],
        [
          '    of which unlocked a charge that can never succeed',
          String(score.unlockedImpossibleCharge),
          pct(score.unlockedImpossibleCharge, score.adopted),
        ],
      ]),
    );

    console.log();
    console.log('WHAT IT COST');
    console.log(
      renderTable([
        ['Consequence', 'Model OFF', 'Model READING'],
        [
          'Attempts spent on causes no charge can clear',
          String(armDet.metrics.attemptsOnTerminalCases),
          String(armRead.metrics.attemptsOnTerminalCases),
        ],
        [
          'Cases sent to a human',
          String(armDet.metrics.humanQueueCases),
          String(armRead.metrics.humanQueueCases),
        ],
        ['Total attempts', String(armDet.metrics.totalAttempts), String(armRead.metrics.totalAttempts)],
      ]),
    );
    console.log(
      `Readings that called a genuinely terminal cause fundable, and so switched off the\n` +
        `gate's TERMINAL_CLASS_NO_CHARGE protection: ${score.unlockedImpossibleCharge}.\n` +
        'That is the price of this feature. Quote it beside the recovery lift, not after\n' +
        `it. Raising --min-confidence above ${o.minConfidence.toFixed(2)} trades recovery for a smaller number here.`,
    );

    if (score.wrongExamples.length > 0) {
      console.log();
      console.log('EVERY KIND OF MISTAKE IT MADE (sample)');
      for (const e of score.wrongExamples) console.log(`  ${e}`);
    }

    console.log();
    console.log('COST DISCIPLINE ON THIS COHORT');
    const s = readAgent.stats;
    console.log(
      renderTable([
        ['Layer', 'Count'],
        ['Decisions taken', String(s.decisions)],
        ['Settled by deterministic triage', String(s.triagedDeterministically)],
        ['Unmapped codes handed to the model', String(s.unmappedCodesRead)],
        ['  of which adopted as a classification', String(s.unmappedCodesClassified)],
        ['  of which declined, escalated to a person', String(s.unmappedCodesDeclined)],
        ['Served from the decision cache', String(s.cacheHits)],
        ['Actual model calls', String(s.modelCalls)],
        ['Deterministic fallback (model unavailable)', String(s.fallbacks)],
      ]),
    );

    const prov = provenanceOf({
      modelEnabled: true,
      stats: readAgent.stats,
      usage: client?.usage ?? null,
    });
    console.log();
    console.log('RESULT PROVENANCE');
    console.log(renderTable([['Question', 'Answer'], ['Who decided?', prov.label]]));
    console.log(prov.detail);
    if (!prov.isModelDriven) {
      console.log();
      console.log(
        '*** These numbers are NOT a model-driven result. Do not present them as one.',
      );
      process.exitCode = 1;
    }
  } else {
    console.log();
    console.log(
      'Model off. The two unmapped arms above are the floor this feature has to beat:\n' +
        'with no way to read an unfamiliar code, every case is unclassifiable and the\n' +
        'system does the only safe thing, which is to stop and ask a person.\n' +
        'Re-run without --deterministic-only to measure what reading them is worth.',
    );
  }

  console.log();
  console.log(
    'Reminder: a SIMULATED comparison. The dialect is our own invention, and the\n' +
      '`readable` labels it is scored against are our own judgement about what each\n' +
      'string supports, assigned when the string was written. A real unmapped rail could\n' +
      'be harder or easier than this.',
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
