import type { Aggregate } from './aggregate/index.js';
import type { HitRate, LabelStats } from './label/metrics.js';

export const THRESHOLDS = { precision: 0.8, hitRate: 0.1, coverage: 0.5 } as const;

export interface Check {
  value: number;
  lo: number;
  hi: number;
  target: number;
  pass: boolean;
}
export interface Verdict {
  precision: Check;
  hitRate: Check;
  coverage: Check;
  pass: boolean;
}

const check = (x: { p: number; lo: number; hi: number }, target: number): Check => ({ value: x.p, lo: x.lo, hi: x.hi, target, pass: x.p >= target });

export function verdict(agg: Aggregate, stats: LabelStats[], hit: HitRate): Verdict {
  const precision = check(stats.find((s) => s.family === 'all' && s.group === 'all')!.precision, THRESHOLDS.precision);
  const coverage = check(agg.groups.find((g) => g.key === 'all')!.coverage, THRESHOLDS.coverage);
  const hitRate = check(hit, THRESHOLDS.hitRate);
  return { precision, hitRate, coverage, pass: precision.pass && hitRate.pass && coverage.pass };
}
