/**
 * METRIC ARITHMETIC AUDIT.
 *
 * Every headline number is recomputed here from the underlying case records, so a
 * reported figure can never drift from the data it claims to summarise.
 *
 * It also pins the distinction that is easiest to misreport: a recovery rate moving from
 * 50.3% to 70.7% is +20.3 PERCENTAGE POINTS, and a ~40% relative improvement. Those are
 * different numbers and calling the first one "40%" - or the second one "ppt" - would
 * overstate or understate the result depending on which way you got it wrong.
 */
import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import { ControlT3Policy } from '../src/policy/controlT3.ts';
import { AgentPolicy } from '../src/agent/agentPolicy.ts';
import { computeLift, runArm } from '../src/engine/runner.ts';
import { buildAtRiskPopulation } from '../src/sim/population.ts';
import { COST } from '../src/assumptions.ts';

const SEED = 'metrics-audit';
const CASES = 120;

async function bothArms() {
  const population = buildAtRiskPopulation(SEED, CASES);
  const control = await runArm(population, new ControlT3Policy(), 8);
  const agent = await runArm(
    population,
    new AgentPolicy({ world: population.world, seed: SEED, deterministicOnly: true }),
    8,
  );
  return { population, control, agent, lift: computeLift(control.metrics, agent.metrics) };
}

describe('metric arithmetic', () => {
  test('recovery rate is recovered cases over total cases', async () => {
    const { control, agent } = await bothArms();
    for (const arm of [control, agent]) {
      const m = arm.metrics;
      const recovered = arm.cases.filter(
        (c) => c.outcome === 'recovered' || c.outcome === 'recovered_self_heal',
      ).length;
      assert.equal(m.recoveredCases, recovered);
      assert.equal(m.recoveryRatePct, (recovered / arm.cases.length) * 100);
    }
  });

  test('recovered rupees equal the sum of per-case recoveries', async () => {
    const { control, agent } = await bothArms();
    for (const arm of [control, agent]) {
      const sum = arm.cases.reduce((s, c) => s + c.recoveredPaise, 0);
      assert.equal(arm.metrics.recoveredPaise, sum);
    }
  });

  test('total attempts equal the sum of per-case attempts', async () => {
    const { control, agent } = await bothArms();
    for (const arm of [control, agent]) {
      const sum = arm.cases.reduce((s, c) => s + c.attempts.length, 0);
      assert.equal(arm.metrics.totalAttempts, sum);
    }
  });

  test('gateway cost equals attempts times the per-attempt fee', async () => {
    // The headline cost metric must be traceable to one fee assumption and a count.
    const { control, agent } = await bothArms();
    for (const arm of [control, agent]) {
      const expected = arm.metrics.totalAttempts * COST.gatewayFeePerAttemptPaise.value;
      assert.equal(
        arm.metrics.gatewayCostPaise,
        expected,
        'gateway cost must be exactly attempts x the modelled per-attempt fee',
      );
    }
  });

  test('cash cost is gateway plus human, and all-in is cash plus shadow', async () => {
    const { control, agent } = await bothArms();
    for (const arm of [control, agent]) {
      const m = arm.metrics;
      assert.equal(m.cashCostPaise, m.gatewayCostPaise + m.humanCostPaise);
      assert.ok(
        m.totalCostPaise >= m.cashCostPaise,
        'all-in cost can never be below cash cost',
      );
      const perCase = arm.cases.reduce((s, c) => s + c.costPaise, 0);
      assert.equal(m.totalCostPaise, perCase);
    }
  });

  test('cost-per-rupee ratios are cost over recovered rupees', async () => {
    const { control, agent } = await bothArms();
    for (const arm of [control, agent]) {
      const m = arm.metrics;
      const rupees = m.recoveredPaise / 100;
      assert.equal(m.costPerRupeeRecovered, m.gatewayCostPaise / rupees);
      assert.equal(m.cashCostPerRupeeRecovered, m.cashCostPaise / rupees);
      assert.equal(m.allInCostPerRupeeRecovered, m.totalCostPaise / rupees);
    }
  });

  test('lift deltas are computed the way their labels say', async () => {
    const { control, agent, lift } = await bothArms();
    const c = control.metrics;
    const a = agent.metrics;

    // A percentage-POINT difference: subtraction of two percentages.
    assert.equal(lift.recoveryRatePpt, a.recoveryRatePct - c.recoveryRatePct);
    assert.equal(lift.recoveredPaiseDelta, a.recoveredPaise - c.recoveredPaise);

    // Relative percentage changes: divided by the control value.
    assert.equal(
      lift.attemptsDeltaPct,
      ((a.totalAttempts - c.totalAttempts) / c.totalAttempts) * 100,
    );
    assert.equal(
      lift.costPerRupeeDeltaPct,
      ((a.costPerRupeeRecovered - c.costPerRupeeRecovered) / c.costPerRupeeRecovered) * 100,
    );
  });

  test('percentage points and relative improvement are different numbers', async () => {
    const { control, agent, lift } = await bothArms();
    const ppt = lift.recoveryRatePpt;
    const relative =
      ((agent.metrics.recoveryRatePct - control.metrics.recoveryRatePct) /
        control.metrics.recoveryRatePct) *
      100;

    // If these were ever equal the distinction would be invisible and a mislabel would
    // go unnoticed. On this cohort they differ by roughly a factor of two.
    assert.ok(
      Math.abs(relative - ppt) > 5,
      `ppt (${ppt.toFixed(1)}) and relative (${relative.toFixed(1)}) must be distinguishable`,
    );
    assert.ok(relative > ppt, 'relative improvement exceeds the point difference here');
  });

  test('both arms are measured on the identical cohort', async () => {
    const { control, agent } = await bothArms();
    assert.equal(control.metrics.cases, agent.metrics.cases);
    assert.equal(
      control.metrics.revenueAtRiskPaise,
      agent.metrics.revenueAtRiskPaise,
      'a different revenue-at-risk would mean different populations',
    );
    const cIds = control.cases.map((c) => c.subscriptionId).sort();
    const aIds = agent.cases.map((c) => c.subscriptionId).sort();
    assert.deepEqual(cIds, aIds);
  });

  test('the negative result is preserved: all-in cost is reported even when it is worse', async () => {
    const { control, agent } = await bothArms();
    // Not asserting a direction - asserting the number EXISTS and is finite, so it can
    // never be quietly dropped from the reporting because it is unflattering.
    assert.ok(Number.isFinite(control.metrics.allInCostPerRupeeRecovered));
    assert.ok(Number.isFinite(agent.metrics.allInCostPerRupeeRecovered));
    assert.ok(agent.metrics.totalContacts > control.metrics.totalContacts);
  });
});
