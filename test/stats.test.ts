import { describe, expect, it } from 'vitest';
import { newcombe, product, wilson } from '../src/aggregate/stats.js';

describe('wilson', () => {
  it('matches published values', () => {
    const a = wilson(5, 10);
    expect(a.p).toBe(0.5);
    expect(a.lo).toBeCloseTo(0.2366, 3);
    expect(a.hi).toBeCloseTo(0.7634, 3);
    const z = wilson(0, 10);
    expect(z.lo).toBe(0);
    expect(z.hi).toBeCloseTo(0.2775, 3);
  });
  it('returns zeros for an empty sample', () => {
    expect(wilson(0, 0)).toEqual({ k: 0, n: 0, p: 0, lo: 0, hi: 0 });
  });
});

describe('newcombe', () => {
  it('matches Newcombe (1998) method 10 for 56/70 vs 48/80', () => {
    const d = newcombe(wilson(56, 70), wilson(48, 80));
    expect(d.d).toBeCloseTo(0.2, 6);
    expect(d.lo).toBeCloseTo(0.0524, 3);
    expect(d.hi).toBeCloseTo(0.3339, 3);
  });
});

describe('product', () => {
  it('multiplies point estimates and bounds', () => {
    expect(product({ k: 1, n: 2, p: 0.5, lo: 0.4, hi: 0.6 }, { k: 1, n: 2, p: 0.5, lo: 0.2, hi: 0.8 })).toEqual({ p: 0.25, lo: 0.08, hi: 0.48 });
  });
});
