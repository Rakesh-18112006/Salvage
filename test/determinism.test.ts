/**
 * Spec rule 5: "Determinism is mandatory. Control and agent arms must run against an
 * identical seeded population. Non-deterministic comparison is worthless."
 *
 * These are the tests that make the eventual control-vs-agent claim defensible, so they
 * are the first tests in the project.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { ControlT3Policy } from '../src/policy/controlT3.ts';
import { buildAtRiskPopulation } from '../src/sim/population.ts';
import { runArm, runBatch } from '../src/engine/runner.ts';

test('identical seed produces identical metrics', async () => {
  const a = await runBatch('seed-alpha', 120, [new ControlT3Policy()]);
  const b = await runBatch('seed-alpha', 120, [new ControlT3Policy()]);
  assert.deepEqual(a.arms[0]!.metrics, b.arms[0]!.metrics);
  assert.deepEqual(a.population.stats, b.population.stats);
});

test('different seed produces different metrics', async () => {
  const a = await runBatch('seed-alpha', 120, [new ControlT3Policy()]);
  const b = await runBatch('seed-beta', 120, [new ControlT3Policy()]);
  assert.notDeepEqual(a.arms[0]!.metrics, b.arms[0]!.metrics);
});

test('identical seed produces an identical case-by-case audit trail', async () => {
  const a = await runBatch('seed-gamma', 60, [new ControlT3Policy()]);
  const b = await runBatch('seed-gamma', 60, [new ControlT3Policy()]);

  const trail = (r: typeof a) =>
    r.arms[0]!.cases.map((c) => ({
      id: c.id,
      outcome: c.outcome,
      closedAt: c.closedAt,
      attempts: c.attempts.map((x) => [x.executedAt, x.status, x.rawErrorCode]),
      decisions: c.decisions.map((d) => [d.seq, d.at, d.finalBundle.actions.map((x) => x.kind)]),
    }));

  assert.deepEqual(trail(a), trail(b));
});

test('the environment is order-independent: re-running an arm on one population repeats exactly', async () => {
  // This is the property that lets two arms taking DIFFERENT actions still face the
  // same world. A shared sequential PRNG would fail this the moment the arms diverged.
  const population = buildAtRiskPopulation('seed-delta', 80);
  const first = await runArm(population, new ControlT3Policy());
  const second = await runArm(population, new ControlT3Policy());
  assert.deepEqual(first.metrics, second.metrics);
});

test('an arm that acts on a different schedule still sees the same bank outages', async () => {
  // Two policies with different retry spacing must observe identical downtime at any
  // instant they happen to share.
  const { isBankDown } = await import('../src/sim/banks.ts');
  const t = Date.UTC(2026, 2, 15, 3, 0, 0);
  const asked = [
    isBankDown('seed-eps', 'SIMBANK_B', t),
    isBankDown('seed-eps', 'SIMBANK_B', t),
  ];
  assert.equal(asked[0], asked[1]);
  // Asking about a different bank in between must not perturb the answer.
  isBankDown('seed-eps', 'SIMBANK_D', t);
  assert.equal(isBankDown('seed-eps', 'SIMBANK_B', t), asked[0]);
});
