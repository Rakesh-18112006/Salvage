/**
 * Statistics for the multi-seed harness. Small, deterministic, and deliberately plain.
 *
 * WHY BOOTSTRAP RATHER THAN A t-INTERVAL
 * --------------------------------------
 * A t-interval assumes the per-seed values are normally distributed. Over 25 cohorts of
 * 300 cases they very likely are, but "very likely" is a claim we would then have to
 * defend, and defending it is more work than not needing it. The percentile bootstrap
 * makes no distributional assumption: it resamples the seeds themselves and reads the
 * interval off the resulting distribution. With a fixed resampling seed it is also
 * exactly reproducible, which a normal approximation and a looked-up t value are not
 * meaningfully more so.
 *
 * WHY THE PAIRED INTERVAL IS THE ONE THAT MATTERS
 * ----------------------------------------------
 * The two arms are not independent samples. They run against the SAME cohort, so a seed
 * that happens to draw an unusually large share of dead mandates makes both arms look
 * bad together. Comparing two separate intervals throws that pairing away and reports a
 * far wider uncertainty than the experiment actually has - the honest statistic is the
 * interval around the per-seed DIFFERENCE, which cancels the shared cohort effect.
 *
 * `pairedSummary` therefore reports the difference interval as the headline, and the two
 * marginal intervals only as context.
 */
import { Rng } from './sim/rng.ts';

export interface Interval {
  readonly mean: number;
  readonly sd: number;
  readonly lo: number;
  readonly hi: number;
  readonly n: number;
}

export function mean(xs: ReadonlyArray<number>): number {
  if (xs.length === 0) return Number.NaN;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Sample standard deviation (n-1). NaN for n < 2, which is the honest answer. */
export function sd(xs: ReadonlyArray<number>): number {
  if (xs.length < 2) return Number.NaN;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

export function quantile(sorted: ReadonlyArray<number>, q: number): number {
  if (sorted.length === 0) return Number.NaN;
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (pos - lo) * (sorted[hi]! - sorted[lo]!);
}

/**
 * Percentile bootstrap interval for the mean of `xs`.
 *
 * `resampleSeed` is part of the signature rather than defaulted at the call site so that
 * a published interval names the exact stream that produced it and can be reproduced.
 */
export function bootstrapInterval(
  xs: ReadonlyArray<number>,
  opts: { resamples?: number; level?: number; resampleSeed: string } ,
): Interval {
  const resamples = opts.resamples ?? 10_000;
  const level = opts.level ?? 0.95;
  const n = xs.length;

  if (n === 0) return { mean: Number.NaN, sd: Number.NaN, lo: Number.NaN, hi: Number.NaN, n: 0 };
  if (n === 1) return { mean: xs[0]!, sd: Number.NaN, lo: xs[0]!, hi: xs[0]!, n: 1 };

  const rng = new Rng(`${opts.resampleSeed}|bootstrap|${n}|${resamples}`);
  const means = new Array<number>(resamples);
  for (let b = 0; b < resamples; b++) {
    let total = 0;
    for (let i = 0; i < n; i++) total += xs[Math.floor(rng.next() * n)]!;
    means[b] = total / n;
  }
  means.sort((a, b) => a - b);

  const tail = (1 - level) / 2;
  return {
    mean: mean(xs),
    sd: sd(xs),
    lo: quantile(means, tail),
    hi: quantile(means, 1 - tail),
    n,
  };
}

export interface PairedSummary {
  readonly control: Interval;
  readonly treatment: Interval;
  /** The headline: the interval around the per-seed difference. */
  readonly difference: Interval;
  /** Seeds on which the treatment value was strictly greater than the control value. */
  readonly treatmentWins: number;
  readonly ties: number;
  readonly seeds: number;
}

/**
 * Summarise a paired experiment: `control[i]` and `treatment[i]` are the same cohort.
 *
 * `treatmentWins` is reported alongside the interval because it answers a different and
 * blunter question - not "how big is the effect" but "did it ever fail to appear". An
 * effect that is positive on 25 of 25 cohorts is a different kind of evidence from one
 * that averages positive across a mix.
 */
export function pairedSummary(
  control: ReadonlyArray<number>,
  treatment: ReadonlyArray<number>,
  resampleSeed: string,
): PairedSummary {
  if (control.length !== treatment.length) {
    throw new Error(
      `paired summary needs equal-length arms: ${control.length} vs ${treatment.length}`,
    );
  }
  const diffs = control.map((c, i) => treatment[i]! - c);
  return {
    control: bootstrapInterval(control, { resampleSeed: `${resampleSeed}|control` }),
    treatment: bootstrapInterval(treatment, { resampleSeed: `${resampleSeed}|treatment` }),
    difference: bootstrapInterval(diffs, { resampleSeed: `${resampleSeed}|difference` }),
    treatmentWins: diffs.filter((d) => d > 0).length,
    ties: diffs.filter((d) => d === 0).length,
    seeds: diffs.length,
  };
}

/** `12.3 [11.8, 12.9]`, the form every interval in this project is printed in. */
export function renderInterval(iv: Interval, digits = 1, unit = ''): string {
  if (!Number.isFinite(iv.mean)) return 'n/a';
  return (
    `${iv.mean.toFixed(digits)}${unit} ` +
    `[${iv.lo.toFixed(digits)}, ${iv.hi.toFixed(digits)}]`
  );
}
