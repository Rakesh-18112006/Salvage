/**
 * Regression tests for the Phase 1 defect named in spec section 8:
 *
 *   "the batch runner records the opening attempt as a failure unconditionally. When
 *    the simulated opening charge actually succeeds, it is logged with an empty error
 *    code and classifies as UNKNOWN (62 of 300 cases). Those cases were never genuinely
 *    at risk, so the true baseline recovery rate is lower than 48.7%."
 *
 * The fix is structural: successes are discarded during cohort construction. These
 * tests assert the properties that fix guarantees, so the defect cannot silently return.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { ControlT3Policy } from '../src/policy/controlT3.ts';
import { buildAtRiskPopulation } from '../src/sim/population.ts';
import { runBatch } from '../src/engine/runner.ts';
import { isTerminal } from '../src/domain/taxonomy.ts';

test('every case in the cohort opens on a genuine failure with a non-empty code', () => {
  const { cases } = buildAtRiskPopulation('cohort-seed', 250);
  assert.equal(cases.length, 250);
  for (const c of cases) {
    assert.equal(c.openingResult.status, 'failed');
    assert.notEqual(c.openingResult.rawErrorCode, '', `${c.subscription.id} has an empty code`);
    assert.notEqual(c.openingResult.trueClass, null);
  }
});

test('no case opens as UNKNOWN unless the rail genuinely returned an unmapped code', async () => {
  // The old defect manufactured UNKNOWN openings out of SUCCESSES. Any UNKNOWN here
  // must correspond to a real unmapped SIM_RAILCODE_*, never to an empty code.
  const { arms } = await runBatch('cohort-seed', 300, [new ControlT3Policy()]);
  for (const c of arms[0]!.cases) {
    const opening = c.attempts[0]!;
    assert.equal(opening.status, 'failed');
    if (opening.failureClass === 'UNKNOWN') {
      assert.match(opening.rawErrorCode, /^SIM_RAILCODE_\d+$/);
      assert.equal(opening.classificationMatched, false);
    }
  }
});

test('the cohort discards more candidates than it keeps, and reports the discards', () => {
  const { stats } = buildAtRiskPopulation('cohort-seed', 300);
  assert.equal(stats.atRiskCases, 300);
  assert.ok(stats.openingChargesSucceeded > 0, 'some opening charges must succeed');
  assert.equal(stats.candidatesGenerated, stats.atRiskCases + stats.openingChargesSucceeded);
  // A book where most scheduled charges fail is not a book. Guard the calibration.
  assert.ok(
    stats.openingFailureRate > 0.05 && stats.openingFailureRate < 0.30,
    `implausible opening failure rate: ${stats.openingFailureRate}`,
  );
});

test('terminal causes are a meaningful minority of failures, not a rounding error', () => {
  const { cases } = buildAtRiskPopulation('cohort-seed', 400);
  const terminal = cases.filter((c) => isTerminal(c.openingResult.trueClass!)).length;
  const share = terminal / cases.length;
  // The problem statement describes roughly a quarter to a third of failures as terminal.
  assert.ok(share > 0.15 && share < 0.45, `terminal share out of range: ${share}`);
});

test('a retry can never recover a case whose true cause is terminal', async () => {
  // The defining property of the terminal set. If this ever fails, either the taxonomy
  // or the simulator is wrong, and the entire thesis of the project is unsound.
  const { arms } = await runBatch('cohort-seed', 400, [new ControlT3Policy()]);
  for (const c of arms[0]!.cases) {
    if (!isTerminal(c.trueOpeningClass)) continue;
    const recoveredByCharge = c.attempts.some((a) => a.status === 'success');
    assert.equal(
      recoveredByCharge,
      false,
      `${c.id} (${c.trueOpeningClass}) was recovered by a charge, which is impossible`,
    );
  }
});
