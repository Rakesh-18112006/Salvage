/**
 * SALVAGE - Phase 5: metrics dashboard and audit-trail viewer.
 *
 * Runs both arms against one seeded population and writes a SELF-CONTAINED HTML file.
 * No build step, no framework, no CDN: the data is embedded as JSON and the page is
 * plain HTML, CSS and vanilla JS, so it opens from the filesystem and survives being
 * emailed to someone.
 *
 *   node src/dashboard.ts --cases 300 --out out/dashboard.html
 *
 * The audit viewer is the part that matters (spec demo step 5): pick any case and walk
 * the decision chain end to end - what the agent saw, what it proposed, what the policy
 * gate ruled, and what actually executed.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { loadEnv } from './config.ts';
import { formatINR } from './domain/money.ts';
import { isTerminal } from './domain/taxonomy.ts';
import type { RecoveryCase } from './domain/types.ts';
import { AgentPolicy } from './agent/agentPolicy.ts';
import { buildModelChain } from './agent/modelChain.ts';
import { provenanceOf, type Provenance } from './agent/provenance.ts';
import { ControlT3Policy } from './policy/controlT3.ts';
import { ALL_SOURCED_VALUES } from './policy/compliance.ts';
import { ALL_ASSUMPTIONS } from './assumptions.ts';
import { computeLift, runArm, type ArmResult } from './engine/runner.ts';
import type { ArmMetrics } from './engine/metrics.ts';
import { buildAtRiskPopulation } from './sim/population.ts';
import { formatIst } from './sim/clock.ts';

loadEnv();

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? fallback);
}

const SEED = arg('seed', '20260101');
const CASES = Number(arg('cases', '300'));
const OUT = resolve(arg('out', 'out/dashboard.html'));
const USE_MODEL = process.argv.includes('--use-model');

interface AssumptionRow {
  id: string;
  value: string;
  unit: string;
  basis: string;
}
interface SourcedRow {
  id: string;
  value: string;
  unit: string;
  source: string;
  quote: string;
  retrievedOn: string;
}
interface DashboardData {
  generatedAt: string;
  seed: string;
  /** Derived from what was OBSERVED, not from the --use-model flag. */
  provenance: Provenance;
  population: unknown;
  control: ArmMetrics;
  agent: ArmMetrics;
  lift: ReturnType<typeof computeLift>;
  cases: CaseRecord[];
  assumptions: AssumptionRow[];
  sourced: SourcedRow[];
}

/** One case, flattened for the viewer. */
interface CaseRecord {
  id: string;
  arm: string;
  subscriptionId: string;
  amountPaise: number;
  outcome: string;
  trueClass: string;
  terminal: boolean;
  openedAt: string;
  closedAt: string;
  attempts: Array<{ no: number; at: string; status: string; cls: string; code: string }>;
  decisions: Array<{
    seq: number;
    at: string;
    proposed: string[];
    verdict: string;
    rule: string | null;
    final: string[];
    reasoning: string;
  }>;
  recoveredPaise: number;
  costPaise: number;
  blockedByPolicy: number;
}

function flatten(c: RecoveryCase, amountPaise: number): CaseRecord {
  return {
    id: c.id,
    arm: c.arm,
    subscriptionId: c.subscriptionId,
    amountPaise,
    outcome: c.outcome ?? 'open',
    trueClass: c.trueOpeningClass,
    terminal: isTerminal(c.trueOpeningClass),
    openedAt: formatIst(c.openedAt),
    closedAt: c.closedAt === null ? '-' : formatIst(c.closedAt),
    attempts: c.attempts.map((a) => ({
      no: a.attemptNo,
      at: formatIst(a.executedAt),
      status: a.status,
      cls: a.status === 'success' ? '-' : a.failureClass,
      code: a.rawErrorCode || '-',
    })),
    decisions: c.decisions.map((d) => ({
      seq: d.seq,
      at: formatIst(d.at),
      proposed: d.proposedBundle.actions.map((a) => a.kind),
      verdict: d.policyVerdict,
      rule: d.policyRuleFired,
      final: d.finalBundle.actions.map((a) => a.kind),
      reasoning: d.agentReasoning,
    })),
    recoveredPaise: c.recoveredPaise,
    costPaise: c.costPaise,
    blockedByPolicy: c.blockedByPolicy,
  };
}

async function main(): Promise<void> {
  console.log(`Building dashboard: seed=${SEED} cases=${CASES} model=${USE_MODEL ? 'on' : 'off'}`);

  const population = buildAtRiskPopulation(SEED, CASES);
  const control = new ControlT3Policy();
  const client = USE_MODEL ? buildModelChain() : null;
  if (USE_MODEL && client === null) {
    throw new Error('--use-model requested but no provider key is configured (set GROQ_API_KEY)');
  }
  const agent = new AgentPolicy({
    world: population.world,
    seed: SEED,
    client,
    deterministicOnly: !USE_MODEL,
  });

  const controlArm: ArmResult = await runArm(population, control, 12);
  const agentArm: ArmResult = await runArm(population, agent, 12);
  const lift = computeLift(controlArm.metrics, agentArm.metrics);

  const amountOf = (id: string) => population.world.subscription(id).amountPaise;
  const cases: CaseRecord[] = [
    ...controlArm.cases.map((c) => flatten(c, amountOf(c.subscriptionId))),
    ...agentArm.cases.map((c) => flatten(c, amountOf(c.subscriptionId))),
  ];

  const provenance = provenanceOf({
    modelEnabled: USE_MODEL,
    stats: agent.stats,
    usage: client?.usage ?? null,
  });

  const data: DashboardData = {
    generatedAt: new Date().toISOString(),
    seed: SEED,
    provenance,
    population: population.stats,
    control: controlArm.metrics,
    agent: agentArm.metrics,
    lift,
    cases,
    assumptions: ALL_ASSUMPTIONS.map((a) => ({
      id: a.id,
      value: String(a.value),
      unit: a.unit,
      basis: a.basis,
    })),
    sourced: ALL_SOURCED_VALUES.map((v) => ({
      id: v.id,
      value: String(v.value),
      unit: v.unit,
      source: v.source,
      quote: v.quote,
      retrievedOn: v.retrievedOn,
    })),
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, renderHtml(data), 'utf8');

  console.log(`wrote ${OUT}`);
  console.log(`provenance: ${provenance.label}`);
  console.log(
    `control ${controlArm.metrics.recoveryRatePct.toFixed(1)}%  ->  ` +
      `agent ${agentArm.metrics.recoveryRatePct.toFixed(1)}%  ` +
      `(${lift.recoveryRatePpt >= 0 ? '+' : ''}${lift.recoveryRatePpt.toFixed(1)} ppt)`,
  );
}

// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function metricRows(c: ArmMetrics, a: ArmMetrics, lift: ReturnType<typeof computeLift>): string {
  const rows: Array<[string, string, string, string, boolean]> = [
    [
      'Recovery rate',
      `${c.recoveryRatePct.toFixed(1)}%`,
      `${a.recoveryRatePct.toFixed(1)}%`,
      `${lift.recoveryRatePpt >= 0 ? '+' : ''}${lift.recoveryRatePpt.toFixed(1)} ppt`,
      a.recoveryRatePct > c.recoveryRatePct,
    ],
    [
      'Recovered',
      formatINR(c.recoveredPaise),
      formatINR(a.recoveredPaise),
      `${lift.recoveredPaiseDelta >= 0 ? '+' : ''}${formatINR(lift.recoveredPaiseDelta)}`,
      a.recoveredPaise > c.recoveredPaise,
    ],
    [
      'Gateway cost per rupee recovered',
      `${c.costPerRupeeRecovered.toFixed(3)}p`,
      `${a.costPerRupeeRecovered.toFixed(3)}p`,
      `${lift.costPerRupeeDeltaPct.toFixed(1)}%`,
      a.costPerRupeeRecovered < c.costPerRupeeRecovered,
    ],
    [
      'All-in cost per rupee',
      `${c.allInCostPerRupeeRecovered.toFixed(3)}p`,
      `${a.allInCostPerRupeeRecovered.toFixed(3)}p`,
      `${lift.allInCostPerRupeeDeltaPct.toFixed(1)}%`,
      a.allInCostPerRupeeRecovered < c.allInCostPerRupeeRecovered,
    ],
    [
      'Total attempts',
      String(c.totalAttempts),
      String(a.totalAttempts),
      `${lift.attemptsDeltaPct.toFixed(1)}%`,
      a.totalAttempts < c.totalAttempts,
    ],
    [
      'Attempts burned on terminal cases',
      `${c.attemptsOnTerminalCases} (${c.attemptsOnTerminalPct.toFixed(1)}%)`,
      `${a.attemptsOnTerminalCases} (${a.attemptsOnTerminalPct.toFixed(1)}%)`,
      String(a.attemptsOnTerminalCases - c.attemptsOnTerminalCases),
      a.attemptsOnTerminalCases <= c.attemptsOnTerminalCases,
    ],
    [
      'Customer contacts',
      String(c.totalContacts),
      String(a.totalContacts),
      `+${lift.contactsDelta}`,
      false,
    ],
    [
      'Actions blocked by the policy gate',
      String(c.blockedByPolicy),
      String(a.blockedByPolicy),
      '',
      true,
    ],
  ];
  return rows
    .map(
      ([label, cv, av, d, good]) =>
        `<tr><th>${esc(label)}</th><td>${esc(cv)}</td><td class="agent">${esc(av)}</td>` +
        `<td class="${good ? 'good' : 'warn'}">${esc(d)}</td></tr>`,
    )
    .join('');
}

function renderHtml(d: DashboardData): string {
  const c = d.control;
  const a = d.agent;
  const allRules = [
    ...new Set([...Object.keys(c.policyRuleCounts), ...Object.keys(a.policyRuleCounts)]),
  ].sort(
    (x, y) =>
      (c.policyRuleCounts[y] ?? 0) + (a.policyRuleCounts[y] ?? 0) -
      ((c.policyRuleCounts[x] ?? 0) + (a.policyRuleCounts[x] ?? 0)),
  );

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SALVAGE — recovery dashboard</title>
<style>
  :root{--bg:#fbfaf9;--fg:#1a1817;--muted:#6b6560;--line:#e3ded9;--card:#fff;
        --good:#0f7b52;--warn:#b3541e;--accent:#1f4fd8;--term:#a3341f}
  @media (prefers-color-scheme:dark){
    :root{--bg:#141312;--fg:#eceae8;--muted:#9b938c;--line:#2e2b28;--card:#1c1a19;
          --good:#4ec38a;--warn:#e08a4c;--accent:#7ea2ff;--term:#e0705a}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);
       font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
  .wrap{max-width:1080px;margin:0 auto;padding:32px 20px 80px}
  h1{font-size:26px;margin:0 0 4px;letter-spacing:-.02em}
  h2{font-size:18px;margin:38px 0 12px;letter-spacing:-.01em}
  .sub{color:var(--muted);margin:0 0 20px;font-size:14px}
  .prov{border-radius:8px;padding:12px 14px;font-size:13.5px;margin:0 0 16px;
        border:1px solid var(--line)}
  .prov-det{background:#eef2fb;border-color:#b9c8ea;color:#2a3c66}
  .prov-model{background:#e9f6ef;border-color:#a5d6bd;color:#12543a}
  @media (prefers-color-scheme:dark){
    .prov-det{background:#161d2e;border-color:#2f3f63;color:#b9c8ea}
    .prov-model{background:#132419;border-color:#2a4a37;color:#a5d6bd}}
  .sim{background:#fff4e5;border:1px solid #f0c893;color:#7a4a12;
       padding:12px 14px;border-radius:8px;font-size:13.5px;margin:0 0 24px}
  @media (prefers-color-scheme:dark){.sim{background:#2e2313;border-color:#5c4526;color:#f0c893}}
  .card{background:var(--card);border:1px solid var(--line);border-radius:10px;
        padding:4px 16px 12px;margin:0 0 16px;overflow-x:auto}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
  thead th{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
  tbody th{font-weight:500}
  td.agent{font-weight:650}
  .good{color:var(--good);font-weight:600}
  .warn{color:var(--warn);font-weight:600}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px}
  .pill{display:inline-block;padding:1px 7px;border-radius:99px;font-size:11.5px;
        border:1px solid var(--line);color:var(--muted)}
  .pill.term{color:var(--term);border-color:var(--term)}
  .pill.deny{color:var(--warn);border-color:var(--warn)}
  .pill.ok{color:var(--good);border-color:var(--good)}
  .controls{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 12px}
  input,select{background:var(--card);color:var(--fg);border:1px solid var(--line);
               border-radius:7px;padding:7px 10px;font:inherit;font-size:13.5px}
  .caselist{max-height:340px;overflow:auto;border:1px solid var(--line);border-radius:10px}
  .caselist table{font-size:13px}
  .caselist tbody tr{cursor:pointer}
  .caselist tbody tr:hover{background:rgba(127,127,127,.09)}
  .caselist tbody tr.sel{background:rgba(31,79,216,.12)}
  .chain{border-left:2px solid var(--line);margin:10px 0 0 8px;padding:0 0 0 16px}
  .step{margin:0 0 16px}
  .step .when{color:var(--muted);font-size:12px}
  .arrow{color:var(--muted);padding:0 6px}
  details summary{cursor:pointer;color:var(--muted);font-size:13px;margin:6px 0}
  .foot{color:var(--muted);font-size:12.5px;margin-top:40px;border-top:1px solid var(--line);
        padding-top:14px}
  code{font-family:ui-monospace,Menlo,monospace;font-size:12.5px}
</style></head><body><div class="wrap">

<h1>SALVAGE — autonomous payment recovery</h1>
<p class="sub">Control (fixed T+3) vs agent, on one identical seeded population.
Seed <code>${esc(d.seed)}</code> · ${d.cases.length / 2} cases per arm ·
generated ${esc(d.generatedAt)}</p>

<div class="prov ${d.provenance.isModelDriven ? 'prov-model' : 'prov-det'}">
  <strong>Who decided: ${esc(d.provenance.label)}</strong><br>${esc(d.provenance.detail)}
</div>

<div class="sim"><strong>All data here is simulated.</strong> Customers, banks, mandates,
decline codes, outages and outcomes come from a seeded model. No money moves, and no real
payment API is called. This is a working prototype with a measured comparison against a
control arm — not a measurement of any production system.</div>

<h2>Headline</h2>
<div class="card"><table>
<thead><tr><th>Metric</th><th>Control (T+3)</th><th>Agent</th><th>Delta</th></tr></thead>
<tbody>${metricRows(c, a, d.lift)}</tbody></table></div>

<h2>Policy gate</h2>
<p class="sub">Deterministic rules neither arm can argue past. The gate applies to
<strong>both</strong> arms — it is enforcement, not a feature of the agent. Every
rejection names the rule that fired.</p>
<div class="card"><table>
<thead><tr><th>Rule</th><th>Control</th><th>Agent</th></tr></thead><tbody>
${allRules
  .map(
    (r) =>
      `<tr><th class="mono">${esc(r)}</th><td>${c.policyRuleCounts[r] ?? 0}</td>` +
      `<td class="agent">${a.policyRuleCounts[r] ?? 0}</td></tr>`,
  )
  .join('')}
</tbody></table></div>

<h2>Audit trail</h2>
<p class="sub">Pick a case to walk its decision chain: what was proposed, what the gate
ruled, and what actually executed.</p>
<div class="controls">
  <input id="q" placeholder="filter by id, outcome or cause…" style="flex:1;min-width:200px">
  <select id="arm"><option value="">both arms</option><option>control</option><option>agent</option></select>
  <select id="kind"><option value="">all cases</option><option value="terminal">terminal only</option>
    <option value="blocked">had actions blocked</option><option value="recovered">recovered</option></select>
</div>
<div class="caselist"><table>
  <thead><tr><th>Case</th><th>Arm</th><th>Cause</th><th>Outcome</th><th>Att</th><th>Amount</th></tr></thead>
  <tbody id="rows"></tbody></table></div>
<div class="card" id="detail"><p class="sub" style="margin:12px 0">No case selected.</p></div>

<h2>Sourced regulatory parameters</h2>
<p class="sub">Not stand-ins. Read from the RBI's own site, each with its citation.</p>
<div class="card"><table><thead><tr><th>Parameter</th><th>Value</th><th>Source</th></tr></thead><tbody>
${d.sourced
  .map(
    (v) =>
      `<tr><th class="mono">${esc(v.id)}</th><td>${esc(v.unit)}</td>` +
      `<td style="font-size:12.5px;color:var(--muted)">${esc(v.source)}<br><em>“${esc(v.quote)}”</em></td></tr>`,
  )
  .join('')}
</tbody></table></div>

<h2>Modelled assumptions</h2>
<p class="sub">Every stand-in value, with its basis. None of these is a measured figure.</p>
<details><summary>Show all ${d.assumptions.length} assumptions</summary>
<div class="card"><table><thead><tr><th>Assumption</th><th>Value</th><th>Basis</th></tr></thead><tbody>
${d.assumptions
  .map(
    (v) =>
      `<tr><th class="mono">${esc(v.id)}</th><td>${esc(v.value)}</td>` +
      `<td style="font-size:12.5px;color:var(--muted)">${esc(v.basis)}</td></tr>`,
  )
  .join('')}
</tbody></table></div></details>

<p class="foot">SALVAGE — Razorpay AI Buildathon 2026, Track 3. Simulated data throughout.
Reported as incremental lift against a control arm, never gross.</p>

<script id="data" type="application/json">${JSON.stringify(d.cases).replace(/</g, '\\u003c')}</script>
<script>
const CASES = JSON.parse(document.getElementById('data').textContent);
const rows = document.getElementById('rows');
const detail = document.getElementById('detail');
const q = document.getElementById('q'), armSel = document.getElementById('arm'), kindSel = document.getElementById('kind');
const inr = p => '₹' + (p/100).toLocaleString('en-IN', {minimumFractionDigits:2, maximumFractionDigits:2});

function visible(){
  const t = q.value.trim().toLowerCase(), arm = armSel.value, kind = kindSel.value;
  return CASES.filter(c => {
    if (arm && c.arm !== arm) return false;
    if (kind === 'terminal' && !c.terminal) return false;
    if (kind === 'blocked' && c.blockedByPolicy === 0) return false;
    if (kind === 'recovered' && !c.outcome.startsWith('recovered')) return false;
    if (!t) return true;
    return (c.id + ' ' + c.outcome + ' ' + c.trueClass).toLowerCase().includes(t);
  }).slice(0, 400);
}

function render(){
  const list = visible();
  rows.innerHTML = list.map((c,i) =>
    '<tr data-i="'+CASES.indexOf(c)+'">' +
    '<td class="mono">'+c.id.replace('case_','')+'</td>' +
    '<td>'+c.arm+'</td>' +
    '<td><span class="pill '+(c.terminal?'term':'')+'">'+c.trueClass+'</span></td>' +
    '<td>'+c.outcome+'</td>' +
    '<td>'+c.attempts.length+'</td>' +
    '<td>'+inr(c.amountPaise)+'</td></tr>').join('');
  if (list.length === 0) rows.innerHTML = '<tr><td colspan="6">No cases match.</td></tr>';
}

function show(c){
  document.querySelectorAll('.caselist tr').forEach(r => r.classList.remove('sel'));
  const chain = c.decisions.map(dd => {
    const changed = JSON.stringify(dd.proposed) !== JSON.stringify(dd.final);
    const cls = dd.verdict === 'APPROVE' ? 'ok' : 'deny';
    return '<div class="step">' +
      '<div><strong>Decision ' + dd.seq + '</strong> <span class="when">' + dd.at + '</span></div>' +
      '<div class="mono">proposed: ' + dd.proposed.join(' + ') +
      (changed ? '<span class="arrow">→</span>executed: ' + (dd.final.join(' + ') || 'nothing') : '') +
      '</div>' +
      '<div><span class="pill ' + cls + '">' + dd.verdict + '</span> ' +
      (dd.rule ? '<span class="pill deny mono">' + dd.rule + '</span>' : '') + '</div>' +
      '<div class="when">' + dd.reasoning + '</div></div>';
  }).join('');

  const attempts = c.attempts.map(at =>
    '<tr><td>' + at.no + '</td><td class="when">' + at.at + '</td><td>' + at.status +
    '</td><td>' + at.cls + '</td><td class="mono">' + at.code + '</td></tr>').join('');

  detail.innerHTML =
    '<h3 style="margin:12px 0 4px;font-size:16px" class="mono">' + c.id + '</h3>' +
    '<p class="sub" style="margin:0 0 10px">' +
      'true cause <strong>' + c.trueClass + '</strong>' + (c.terminal ? ' (terminal — no retry can ever succeed)' : '') +
      ' · opened ' + c.openedAt + ' · closed ' + c.closedAt +
      ' · outcome <strong>' + c.outcome + '</strong>' +
      ' · recovered ' + inr(c.recoveredPaise) + ' · modelled cost ' + inr(c.costPaise) +
      (c.blockedByPolicy ? ' · <strong>' + c.blockedByPolicy + ' action(s) blocked by policy</strong>' : '') +
    '</p>' +
    '<table><thead><tr><th>#</th><th>When</th><th>Result</th><th>Class</th><th>Raw code</th></tr></thead>' +
    '<tbody>' + attempts + '</tbody></table>' +
    '<div class="chain">' + (chain || '<span class="sub">No decisions recorded.</span>') + '</div>';
}

rows.addEventListener('click', e => {
  const tr = e.target.closest('tr[data-i]');
  if (!tr) return;
  tr.classList.add('sel');
  show(CASES[Number(tr.dataset.i)]);
});
[q, armSel, kindSel].forEach(el => el.addEventListener('input', render));
render();
</script>
</div></body></html>`;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
