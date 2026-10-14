import { describe, expect, it } from 'vitest';
import { byCodeUnit, mulberry32, rngFor, seedFrom, shuffle } from '../src/rng.js';
import { fileId } from '../src/types.js';

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

describe('golden values (locale- and platform-independent)', () => {
  it('pins mulberry32(seedFrom("prereg-v1"))', () => {
    expect(seedFrom('prereg-v1')).toBe(235559890);
    const r = mulberry32(seedFrom('prereg-v1'));
    expect([r(), r(), r()]).toEqual([0.8680260356049985, 0.3072372586466372, 0.9896764545701444]);
  });
  it('pins shuffle([0..9], rngFor("prereg-v1"))', () => {
    expect(shuffle([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], rngFor('prereg-v1'))).toEqual([3, 5, 9, 1, 0, 4, 6, 7, 2, 8]);
  });
  it('pins fileId', () => {
    expect(fileId({ repo: 'Owner/name', pr: 123 })).toBe('Owner__name__123');
  });
});

describe('byCodeUnit', () => {
  it('orders by UTF-16 code unit, not by locale', () => {
    expect(['b', 'a', 'B', '_', 'A', '#10', '#9'].sort(byCodeUnit)).toEqual(['#10', '#9', 'A', 'B', '_', 'a', 'b']);
    expect(byCodeUnit('x', 'x')).toBe(0);
  });
});
