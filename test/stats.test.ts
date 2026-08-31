/**
 * The statistics behind the multi-seed intervals.
 *
 * These matter more than their size suggests. Every headline in the README now carries
 * an interval produced by this file, and an interval that is subtly wrong is worse than
 * no interval at all: it converts an unsupported claim into an unsupported claim with a
 * number of decimal places after it.
 */
import { strict as assert } from 'node:assert';
import { describe, test } from 'node:test';

import {
  bootstrapInterval,
  mean,
  pairedSummary,
  quantile,
  renderInterval,
  sd,
} from '../src/stats.ts';

describe('summary statistics', () => {
  test('mean and sample sd match hand-computed values', () => {
    const xs = [2, 4, 4, 4, 5, 5, 7, 9];
    assert.equal(mean(xs), 5);
    // Sample sd (n-1) of this set is sqrt(32/7).
    assert.ok(Math.abs(sd(xs) - Math.sqrt(32 / 7)) < 1e-12);
  });

  test('sd of a single observation is NaN, not zero', () => {
    // Zero would claim the spread is known to be nothing, which is a much stronger
    // statement than "one point tells you nothing about spread".
    assert.ok(Number.isNaN(sd([4])));
  });

  test('quantile interpolates between neighbours', () => {
    const s = [0, 10, 20, 30, 40];
    assert.equal(quantile(s, 0), 0);
    assert.equal(quantile(s, 1), 40);
    assert.equal(quantile(s, 0.5), 20);
    assert.equal(quantile(s, 0.25), 10);
  });
});

describe('the bootstrap interval', () => {
  const xs = [18.1, 19.4, 20.3, 21.0, 19.8, 20.6, 18.9, 22.1, 20.0, 19.2];

  test('is exactly reproducible for a given resample seed', () => {
    // A published interval nobody can reproduce is an anecdote. The resample stream is
    // part of the signature precisely so that a quoted interval can be recomputed.
    const a = bootstrapInterval(xs, { resampleSeed: 'fixed' });
    const b = bootstrapInterval(xs, { resampleSeed: 'fixed' });
    assert.deepEqual(a, b);
  });

  test('a different resample seed gives a different, nearby interval', () => {
    const a = bootstrapInterval(xs, { resampleSeed: 'one' });
    const b = bootstrapInterval(xs, { resampleSeed: 'two' });
    assert.equal(a.mean, b.mean, 'the point estimate does not depend on resampling');
    assert.ok(Math.abs(a.lo - b.lo) < 0.5, 'two honest resamplings should broadly agree');
  });

  test('brackets the sample mean and reports n', () => {
    const iv = bootstrapInterval(xs, { resampleSeed: 'fixed' });
    assert.equal(iv.n, xs.length);
    assert.ok(iv.lo < iv.mean && iv.mean < iv.hi, `${iv.lo} < ${iv.mean} < ${iv.hi}`);
  });

  test('narrows as the sample grows', () => {
    const wide = bootstrapInterval(xs.slice(0, 4), { resampleSeed: 'fixed' });
    const many = Array.from({ length: 200 }, (_, i) => xs[i % xs.length]!);
    const narrow = bootstrapInterval(many, { resampleSeed: 'fixed' });
    assert.ok(narrow.hi - narrow.lo < wide.hi - wide.lo);
  });

  test('a constant sample gives a zero-width interval', () => {
    const iv = bootstrapInterval([5, 5, 5, 5, 5], { resampleSeed: 'fixed' });
    assert.equal(iv.lo, 5);
    assert.equal(iv.hi, 5);
  });

  test('degenerate inputs do not fabricate an interval', () => {
    assert.equal(bootstrapInterval([], { resampleSeed: 'x' }).n, 0);
    const one = bootstrapInterval([7], { resampleSeed: 'x' });
    assert.equal(one.lo, 7);
    assert.equal(one.hi, 7);
    assert.ok(Number.isNaN(one.sd), 'one point cannot support a spread');
  });
});

describe('the paired summary', () => {
  test('the paired interval is tighter than the two marginals', () => {
    // The whole reason for pairing. Both arms move together with the cohort, so the
    // difference cancels a shared effect that two separate intervals would carry.
    const control = [40, 50, 60, 45, 55, 42, 58, 47];
    const treatment = control.map((c) => c + 20);

    const s = pairedSummary(control, treatment, 'paired-test');
    const controlWidth = s.control.hi - s.control.lo;
    const diffWidth = s.difference.hi - s.difference.lo;

    assert.ok(
      diffWidth < controlWidth,
      `paired width ${diffWidth} should be far below the marginal width ${controlWidth}`,
    );
    assert.equal(s.difference.mean, 20);
    assert.equal(s.treatmentWins, 8);
    assert.equal(s.seeds, 8);
  });

  test('counts wins and ties honestly', () => {
    const s = pairedSummary([10, 10, 10, 10], [12, 10, 8, 11], 'wins-test');
    assert.equal(s.treatmentWins, 2);
    assert.equal(s.ties, 1);
  });

  test('an effect that is not there produces an interval spanning zero', () => {
    // The case the harness must be able to detect, since src/seeds.ts exits non-zero on it.
    const control = [50, 48, 52, 49, 51, 47, 53, 50];
    const treatment = [51, 47, 51, 50, 50, 48, 52, 49];
    const s = pairedSummary(control, treatment, 'null-test');
    assert.ok(s.difference.lo < 0 && s.difference.hi > 0, 'must not claim an effect');
  });

  test('mismatched arm lengths are refused rather than silently truncated', () => {
    assert.throws(() => pairedSummary([1, 2, 3], [1, 2], 'x'), /equal-length/);
  });
});

describe('rendering', () => {
  test('prints mean with its interval', () => {
    const iv = bootstrapInterval([19, 20, 21], { resampleSeed: 'fixed' });
    assert.match(renderInterval(iv, 1, '%'), /^20\.0% \[\d+\.\d, \d+\.\d\]$/);
  });

  test('an interval that does not exist prints n/a rather than NaN', () => {
    assert.equal(renderInterval(bootstrapInterval([], { resampleSeed: 'x' })), 'n/a');
  });
});
