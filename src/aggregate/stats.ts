export interface RateCI {
  k: number;
  n: number;
  p: number;
  lo: number;
  hi: number;
}
export interface DiffCI {
  d: number;
  lo: number;
  hi: number;
}

/** Wilson score interval for k successes out of n. */
export function wilson(k: number, n: number, z = 1.96): RateCI {
  if (n === 0) return { k: 0, n: 0, p: 0, lo: 0, hi: 0 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { k, n, p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

/** Newcombe's hybrid score interval (method 10) for the difference a.p - b.p. */
export function newcombe(a: RateCI, b: RateCI): DiffCI {
  const d = a.p - b.p;
  return {
    d,
    lo: d - Math.sqrt((a.p - a.lo) ** 2 + (b.hi - b.p) ** 2),
    hi: d + Math.sqrt((a.hi - a.p) ** 2 + (b.p - b.lo) ** 2),
  };
}

/** Product of two independent rates; bounds multiply (a conservative envelope, stated in the report). */
export function product(a: RateCI, b: RateCI): { p: number; lo: number; hi: number } {
  const r = (x: number) => Math.round(x * 1e12) / 1e12;
  return { p: r(a.p * b.p), lo: r(a.lo * b.lo), hi: r(a.hi * b.hi) };
}
