/**
 * Deterministic randomness. Spec rule 5: "Determinism is mandatory. Control and agent
 * arms must run against an identical seeded population."
 *
 * Two distinct facilities, and the distinction matters:
 *
 *  1. `Rng` - a sequential stream. Used ONLY to build the population, where the order
 *     of draws is fixed and identical for every arm.
 *
 *  2. `uniform(...)` - an ORDER-INDEPENDENT hashed draw. Used for every environment
 *     outcome (did this charge succeed? was the bank down?). Because the value is a
 *     pure function of (seed, subscription, timestamp, purpose) and NOT of how many
 *     draws came before, the control arm and the agent arm face a bit-identical world
 *     even though they take different actions in different orders. A shared sequential
 *     stream would silently de-synchronise the two arms and make the comparison
 *     worthless - which is precisely what rule 5 is guarding against.
 */

/** FNV-1a 32-bit. Small, fast, adequate for seeding a PRNG. */
function fnv1a(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 - one step of a small, well-behaved 32-bit generator. */
function mulberry32Step(state: number): number {
  let t = (state + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Sequential seeded stream. Population construction only. */
export class Rng {
  private state: number;

  constructor(seed: number | string) {
    this.state = typeof seed === 'number' ? seed >>> 0 : fnv1a(seed);
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform float in [lo, hi). */
  float(lo: number, hi: number): number {
    return lo + this.next() * (hi - lo);
  }

  /** Uniform integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }

  /** Uniform element of a non-empty array. */
  pick<T>(items: ReadonlyArray<T>): T {
    if (items.length === 0) throw new Error('Rng.pick: empty array');
    return items[Math.floor(this.next() * items.length)]!;
  }

  /** Weighted element. Weights need not sum to 1. */
  weighted<T>(items: ReadonlyArray<readonly [T, number]>): T {
    const total = items.reduce((s, [, w]) => s + w, 0);
    if (total <= 0) throw new Error('Rng.weighted: non-positive total weight');
    let r = this.next() * total;
    for (const [item, w] of items) {
      r -= w;
      if (r <= 0) return item;
    }
    return items[items.length - 1]![0];
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }
}

/**
 * Order-independent draw in [0, 1). Pure function of its inputs.
 * `parts` should always begin with a purpose tag so two different questions about the
 * same entity at the same instant do not collide.
 */
export function uniform(...parts: ReadonlyArray<string | number>): number {
  return mulberry32Step(fnv1a(parts.join('|')));
}

/**
 * Short stable tag for a seed, used to namespace generated entity ids.
 *
 * Without this, candidate N of one seed and candidate N of another share an id. In
 * memory that is harmless; in a shared Postgres it means one population's rows quietly
 * stand in for another's, and every downstream number is wrong in a way nothing warns
 * about.
 */
export function seedTag(seed: string): string {
  return fnv1a(seed).toString(36).padStart(6, '0').slice(0, 6);
}

/** Order-independent Bernoulli draw. */
export function chanceAt(p: number, ...parts: ReadonlyArray<string | number>): boolean {
  return uniform(...parts) < p;
}
