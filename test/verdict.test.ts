import { describe, expect, it } from 'vitest';
import type { Aggregate } from '../src/aggregate/index.js';
import { wilson } from '../src/aggregate/stats.js';
import type { LabelStats } from '../src/label/metrics.js';
import { verdict } from '../src/verdict.js';

describe('verdict', () => {
  it('scores each threshold on its point estimate', () => {
    const agg = { groups: [{ key: 'all', coverage: wilson(60, 100) }] } as Aggregate;
    const stats = [{ family: 'all', group: 'all', precision: wilson(85, 100) }] as LabelStats[];
    const v = verdict(agg, stats, { p: 0.08, lo: 0.05, hi: 0.12, anyCounted: wilson(1, 1), prsWithReal: wilson(1, 1) });
    expect(v.precision).toMatchObject({ value: 0.85, target: 0.8, pass: true });
    expect(v.coverage).toMatchObject({ value: 0.6, target: 0.5, pass: true });
    expect(v.hitRate).toMatchObject({ value: 0.08, target: 0.1, pass: false });
    expect(v.pass).toBe(false);
  });
});
