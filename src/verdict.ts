import type { Aggregate } from './aggregate/index.js';
import type { RateCI } from './aggregate/stats.js';
import type { HitRate, LabelStats } from './label/metrics.js';

export const THRESHOLDS = { accuracy: 0.95, coverage: 0.5 } as const;

export interface Check {
  value: number;
  lo: number;
  hi: number;
  /** Sample size behind the estimate; 0 means no data. */
  n: number;
  /** null: the number is reported, but no pre-registered bar applies. */
  target: number | null;
  pass: boolean | null;
}
export interface Verdict {
  accuracy: Check;
  coverage: Check;
  precision: Check;
  hitRate: Check;
  notProven: Check;
  pass: boolean;
}

const check = (x: { p: number; lo: number; hi: number }, n: number, target: number): Check => ({ value: x.p, lo: x.lo, hi: x.hi, n, target, pass: n > 0 && x.p >= target });
const reported = (x: { p: number; lo: number; hi: number }, n: number): Check => ({ value: x.p, lo: x.lo, hi: x.hi, n, target: null, pass: null });

export function verdict(agg: Aggregate, stats: LabelStats[], hit: HitRate, notProven: RateCI): Verdict {
  const all = stats.find((s) => s.family === 'all' && s.group === 'all')!;
  const c = agg.groups.find((g) => g.key === 'all')!.coverage;
  const accuracy = check(all.accuracy, all.accuracy.n, THRESHOLDS.accuracy);
  const coverage = check(c, c.n, THRESHOLDS.coverage);
  const precision = reported(all.precision, all.precision.n);
  // The hit rate is a product; it has no data when either factor has none.
  const hitRate = reported(hit, Math.min(hit.anyCounted.n, hit.prsWithReal.n));
  return { accuracy, coverage, precision, hitRate, notProven: reported(notProven, notProven.n), pass: accuracy.pass === true && coverage.pass === true };
}
