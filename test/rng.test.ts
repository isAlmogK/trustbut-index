import { describe, expect, it } from 'vitest';
import { mulberry32, rngFor, seedFrom, shuffle } from '../src/rng.js';

describe('rng', () => {
  it('is deterministic for a seed and different across seeds', () => {
    const a = mulberry32(42), b = mulberry32(42), c = mulberry32(43);
    const sa = [a(), a(), a()], sb = [b(), b(), b()], sc = [c(), c(), c()];
    expect(sa).toEqual(sb);
    expect(sa).not.toEqual(sc);
    for (const x of sa) expect(x >= 0 && x < 1).toBe(true);
  });

  it('hashes strings to stable, distinct seeds', () => {
    expect(seedFrom('prereg-v1')).toBe(seedFrom('prereg-v1'));
    expect(seedFrom('a')).not.toBe(seedFrom('b'));
  });

  it('shuffles into a deterministic permutation without mutating the input', () => {
    const xs = Array.from({ length: 20 }, (_, i) => i);
    const s1 = shuffle(xs, rngFor('k')), s2 = shuffle(xs, rngFor('k')), s3 = shuffle(xs, rngFor('other'));
    expect(s1).toEqual(s2);
    expect(s1).not.toEqual(s3);
    expect([...s1].sort((p, q) => p - q)).toEqual(xs);
    expect(xs[0]).toBe(0);
  });
});
