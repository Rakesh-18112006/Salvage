/**
 * Metrics (spec section 9).
 *
 * Reporting rule that governs this file: report INCREMENTAL lift against the control
 * arm, never gross. A gross recovery number with no control arm is the standard way a
 * hackathon project overclaims, and section 10 forbids it.
 */
import type { RecoveryCase, Subscription } from '../domain/types.ts';
import { FAILURE_CLASSES, isTerminal, type FailureClass } from '../domain/taxonomy.ts';
import type { Paise } from '../domain/money.ts';
import { formatINR } from '../domain/money.ts';
import { HOUR_MS } from '../sim/clock.ts';

export interface ArmMetrics {
  readonly arm: string;
  readonly policyName: string;
  readonly cases: number;

  readonly recoveredCases: number;
  readonly recoveryRatePct: number;
  readonly selfHealCases: number;
  readonly exhaustedCases: number;
  readonly humanQueueCases: number;

  readonly revenueAtRiskPaise: Paise;
  readonly recoveredPaise: Paise;
  readonly recoveredValuePct: number;

  readonly totalAttempts: number;
  readonly totalContacts: number;
  readonly attemptsOnTerminalCases: number;
  readonly attemptsOnTerminalPct: number;

  readonly totalCostPaise: Paise;
  readonly gatewayCostPaise: Paise;
  readonly humanCostPaise: Paise;
  readonly cashCostPaise: Paise;
  /**
   * GATEWAY fees per rupee recovered: the price of trying to collect, over what came
   * back. This is the headline, because it is the cost a collection policy actually
   * controls. The other two views are reported beside it, never instead of it.
   */
  readonly costPerRupeeRecovered: number;
  /** Gateway fees plus compliance-driven human escalation. */
  readonly cashCostPerRupeeRecovered: number;
  /**
   * All-in cost per rupee recovered, including the modelled price of customer patience,
   * friction, and float. Reported alongside, never instead of, the cash figure - a
   * policy can win on cash by harassing customers, and this is the number that shows it.
   */
  readonly allInCostPerRupeeRecovered: number;

  readonly medianHoursToRecover: number | null;
  readonly taxonomyCoveragePct: number;

  /** Actions the policy gate refused outright. The compliance headline. */
  readonly blockedByPolicy: number;
  /** Which rules fired, and how often. "Blocked by policy" with no rule name is a claim. */
  readonly policyRuleCounts: Readonly<Record<string, number>>;

  readonly openingClassMix: ReadonlyArray<{ cls: FailureClass; count: number; terminal: boolean }>;
}

function median(xs: ReadonlyArray<number>): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export function computeMetrics(
  arm: string,
  policyName: string,
  cases: ReadonlyArray<RecoveryCase>,
  subscriptionOf: (id: string) => Subscription,
): ArmMetrics {
  let revenueAtRisk = 0;
  let recovered = 0;
  let recoveredCases = 0;
  let selfHeal = 0;
  let exhausted = 0;
  let humanQueue = 0;
  let attempts = 0;
  let contacts = 0;
  let attemptsTerminal = 0;
  let cost = 0;
  let gatewayCost = 0;
  let humanCost = 0;
  let failedAttempts = 0;
  let classifiedAttempts = 0;
  const hoursToRecover: number[] = [];
  const classCounts = new Map<FailureClass, number>();
  let blocked = 0;
  const ruleCounts = new Map<string, number>();

  for (const c of cases) {
    revenueAtRisk += subscriptionOf(c.subscriptionId).amountPaise;
    recovered += c.recoveredPaise;
    cost += c.costPaise;
    gatewayCost += c.gatewayCostPaise;
    humanCost += c.humanCostPaise;
    attempts += c.attempts.length;
    contacts += c.contactsUsed;

    if (isTerminal(c.trueOpeningClass)) attemptsTerminal += c.attempts.length;

    blocked += c.blockedByPolicy;
    for (const [rule, n] of Object.entries(c.policyRuleCounts)) {
      ruleCounts.set(rule, (ruleCounts.get(rule) ?? 0) + n);
    }

    for (const a of c.attempts) {
      if (a.status === 'failed') {
        failedAttempts++;
        if (a.classificationMatched) classifiedAttempts++;
      }
    }

    const openingClass = c.attempts[0]!.failureClass;
    classCounts.set(openingClass, (classCounts.get(openingClass) ?? 0) + 1);

    if (c.outcome === 'recovered' || c.outcome === 'recovered_self_heal') {
      recoveredCases++;
      if (c.outcome === 'recovered_self_heal') selfHeal++;
      if (c.closedAt !== null) hoursToRecover.push((c.closedAt - c.openedAt) / HOUR_MS);
    } else if (c.outcome === 'handed_to_human') {
      humanQueue++;
    } else {
      exhausted++;
    }
  }

  const recoveredRupees = recovered / 100;

  return {
    arm,
    policyName,
    cases: cases.length,
    recoveredCases,
    recoveryRatePct: cases.length === 0 ? 0 : (recoveredCases / cases.length) * 100,
    selfHealCases: selfHeal,
    exhaustedCases: exhausted,
    humanQueueCases: humanQueue,
    revenueAtRiskPaise: revenueAtRisk,
    recoveredPaise: recovered,
    recoveredValuePct: revenueAtRisk === 0 ? 0 : (recovered / revenueAtRisk) * 100,
    totalAttempts: attempts,
    totalContacts: contacts,
    attemptsOnTerminalCases: attemptsTerminal,
    attemptsOnTerminalPct: attempts === 0 ? 0 : (attemptsTerminal / attempts) * 100,
    totalCostPaise: cost,
    gatewayCostPaise: gatewayCost,
    humanCostPaise: humanCost,
    cashCostPaise: gatewayCost + humanCost,
    costPerRupeeRecovered:
      recoveredRupees === 0 ? Number.POSITIVE_INFINITY : gatewayCost / recoveredRupees,
    cashCostPerRupeeRecovered:
      recoveredRupees === 0
        ? Number.POSITIVE_INFINITY
        : (gatewayCost + humanCost) / recoveredRupees,
    allInCostPerRupeeRecovered:
      recoveredRupees === 0 ? Number.POSITIVE_INFINITY : cost / recoveredRupees,
    blockedByPolicy: blocked,
    policyRuleCounts: Object.fromEntries(
      [...ruleCounts.entries()].sort((a, b) => b[1] - a[1]),
    ),
    medianHoursToRecover: median(hoursToRecover),
    taxonomyCoveragePct:
      failedAttempts === 0 ? 100 : (classifiedAttempts / failedAttempts) * 100,
    openingClassMix: FAILURE_CLASSES
      .map((cls) => ({ cls, count: classCounts.get(cls) ?? 0, terminal: isTerminal(cls) }))
      .filter((r) => r.count > 0)
      .sort((a, b) => b.count - a.count),
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const pct = (n: number) => `${n.toFixed(1)}%`;
const num = (n: number) => n.toLocaleString('en-IN');

export function renderTable(rows: ReadonlyArray<ReadonlyArray<string>>): string {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  const line = (l: string, m: string, r: string) =>
    l + widths.map((w) => '-'.repeat(w + 2)).join(m) + r;

  const out: string[] = [line('+', '+', '+')];
  rows.forEach((row, idx) => {
    const cells = widths.map((w, i) => ` ${(row[i] ?? '').padEnd(w)} `);
    out.push(`|${cells.join('|')}|`);
    if (idx === 0) out.push(line('+', '+', '+'));
  });
  out.push(line('+', '+', '+'));
  return out.join('\n');
}

export function renderArmMetrics(m: ArmMetrics): string {
  const rows: string[][] = [
    ['Metric', `${m.arm} (${m.policyName})`],
    ['Cases (all opened on a genuine failure)', num(m.cases)],
    ['Recovery rate', pct(m.recoveryRatePct)],
    ['  of which self-healed, no intervention', num(m.selfHealCases)],
    ['Revenue at risk', formatINR(m.revenueAtRiskPaise)],
    ['Recovered', `${formatINR(m.recoveredPaise)}  (${pct(m.recoveredValuePct)})`],
    ['Total attempts', num(m.totalAttempts)],
    ['Total customer contacts', num(m.totalContacts)],
    [
      'Attempts burned on terminal cases',
      `${num(m.attemptsOnTerminalCases)}  (${pct(m.attemptsOnTerminalPct)})`,
    ],
    ['Gateway fees (the cost of trying to collect)', formatINR(m.gatewayCostPaise)],
    ['Human escalation (compliance obligation)', formatINR(m.humanCostPaise)],
    ['Modelled patience / friction / float', formatINR(m.totalCostPaise - m.cashCostPaise)],
    ['GATEWAY cost per rupee recovered', `${m.costPerRupeeRecovered.toFixed(3)} paise`],
    ['+ human escalation, per rupee', `${m.cashCostPerRupeeRecovered.toFixed(3)} paise`],
    ['All-in per rupee (incl. patience/friction)', `${m.allInCostPerRupeeRecovered.toFixed(3)} paise`],
    [
      'Median hours to recovery',
      m.medianHoursToRecover === null ? 'n/a' : m.medianHoursToRecover.toFixed(1),
    ],
    ['Taxonomy coverage', pct(m.taxonomyCoveragePct)],
    ['Actions blocked by the policy gate', num(m.blockedByPolicy)],
    ['Cases exhausted', num(m.exhaustedCases)],
    ['Cases handed to a human', num(m.humanQueueCases)],
  ];
  return renderTable(rows);
}

export function renderOpeningClassMix(m: ArmMetrics): string {
  const rows: string[][] = [['Opening failure class', 'Cases', 'Share', 'Terminal?']];
  for (const r of m.openingClassMix) {
    rows.push([
      r.cls,
      num(r.count),
      pct((r.count / m.cases) * 100),
      r.terminal ? 'TERMINAL' : 'retryable',
    ]);
  }
  const terminalCases = m.openingClassMix
    .filter((r) => r.terminal)
    .reduce((s, r) => s + r.count, 0);
  rows.push(['-- terminal subtotal --', num(terminalCases), pct((terminalCases / m.cases) * 100), '']);
  return renderTable(rows);
}
