import { describe, expect, it } from 'vitest';
import type { Aggregate } from '../src/aggregate/index.js';
import { wilson } from '../src/aggregate/stats.js';
import type { LabelStats } from '../src/label/metrics.js';
import { THRESHOLDS, verdict } from '../src/verdict.js';

const hit = { p: 0.02, lo: 0.01, hi: 0.05, anyCounted: wilson(1, 1), prsWithReal: wilson(1, 1) };

describe('verdict', () => {
  it('passes on factual accuracy and coverage, and only reports precision, hit rate and not-proven', () => {
    const agg = { groups: [{ key: 'all', coverage: wilson(60, 100) }] } as Aggregate;
    const stats = [{ family: 'all', group: 'all', precision: wilson(7, 100), accuracy: wilson(96, 100) }] as LabelStats[];
    const v = verdict(agg, stats, hit, wilson(1, 4));
    expect(THRESHOLDS).toEqual({ accuracy: 0.95, coverage: 0.5 });
    expect(v.accuracy).toMatchObject({ value: 0.96, target: 0.95, pass: true, n: 100 });
    expect(v.coverage).toMatchObject({ value: 0.6, target: 0.5, pass: true });
    expect(v.precision).toMatchObject({ value: 0.07, target: null, pass: null, n: 100 });
    expect(v.hitRate).toMatchObject({ value: 0.02, target: null, pass: null });
    expect(v.notProven).toMatchObject({ value: 0.25, target: null, pass: null, n: 4 });
    expect(v.pass).toBe(true);
  });
  it('fails when accuracy is below the bar', () => {
    const agg = { groups: [{ key: 'all', coverage: wilson(60, 100) }] } as Aggregate;
    const stats = [{ family: 'all', group: 'all', precision: wilson(85, 100), accuracy: wilson(90, 100) }] as LabelStats[];
    const v = verdict(agg, stats, hit, wilson(0, 0));
    expect(v.accuracy.pass).toBe(false);
    expect(v.pass).toBe(false);
  });
  it('records n=0 when a threshold has no data', () => {
    const agg = { groups: [{ key: 'all', coverage: wilson(0, 0) }] } as Aggregate;
    const stats = [{ family: 'all', group: 'all', precision: wilson(0, 0), accuracy: wilson(0, 0) }] as LabelStats[];
    const v = verdict(agg, stats, { p: 0, lo: 0, hi: 0, anyCounted: wilson(3, 10), prsWithReal: wilson(0, 0) }, wilson(0, 0));
    expect([v.accuracy.n, v.hitRate.n, v.coverage.n, v.notProven.n]).toEqual([0, 0, 0, 0]);
    expect(v.accuracy.pass).toBe(false);
    expect(v.pass).toBe(false);
  });
});
