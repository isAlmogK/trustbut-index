import type { Aggregate } from './aggregate/index.js';
import type { HitRate, LabelStats } from './label/metrics.js';

export const THRESHOLDS = { precision: 0.8, hitRate: 0.1, coverage: 0.5 } as const;

export interface Check {
  value: number;
  lo: number;
  hi: number;
  /** Sample size behind the estimate; 0 means no data. */
  n: number;
  target: number;
  pass: boolean;
}
export interface Verdict {
  precision: Check;
  hitRate: Check;
  coverage: Check;
  pass: boolean;
}

const check = (x: { p: number; lo: number; hi: number }, n: number, target: number): Check => ({ value: x.p, lo: x.lo, hi: x.hi, n, target, pass: n > 0 && x.p >= target });

export function verdict(agg: Aggregate, stats: LabelStats[], hit: HitRate): Verdict {
  const p = stats.find((s) => s.family === 'all' && s.group === 'all')!.precision;
  const c = agg.groups.find((g) => g.key === 'all')!.coverage;
  const precision = check(p, p.n, THRESHOLDS.precision);
  const coverage = check(c, c.n, THRESHOLDS.coverage);
  // The hit rate is a product; it has no data when either factor has none.
  const hitRate = check(hit, Math.min(hit.anyCounted.n, hit.prsWithReal.n), THRESHOLDS.hitRate);
  return { precision, hitRate, coverage, pass: precision.pass && hitRate.pass && coverage.pass };
}
