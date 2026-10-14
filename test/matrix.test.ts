import { describe, expect, it } from 'vitest';
import { batchMatrix } from '../src/run/matrix.js';
import type { ManifestEntry } from '../src/types.js';

const e = (n: number) => ({ id: `o/r#${n}`, repo: 'o/r', pr: n }) as ManifestEntry;

describe('batchMatrix', () => {
  it('slices the manifest into batches of 250 with file-safe ids', () => {
    const entries = Array.from({ length: 600 }, (_, i) => e(i + 1));
    expect(batchMatrix(entries, 0).include.length).toBe(250);
    const last = batchMatrix(entries, 2).include;
    expect(last.length).toBe(100);
    expect(last[0]!.id).toBe('o__r__501');
    expect(JSON.parse(last[0]!.entry)).toMatchObject({ pr: 501 });
  });
});
