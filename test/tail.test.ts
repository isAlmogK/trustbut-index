import { describe, expect, it } from 'vitest';
import { tail } from '../src/run/tail.js';

describe('tail', () => {
  it('keeps the last 50 lines without colour codes or trailing blank lines', () => {
    const out = Array.from({ length: 60 }, (_, i) => `\u001b[31mline ${i + 1}\u001b[0m`).join('\n') + '\n\n';
    expect(tail(out).split('\n')).toEqual(Array.from({ length: 50 }, (_, i) => `line ${i + 11}`));
  });
  it('keeps at most 4,000 characters, from the end', () => {
    const t = tail(`${'a'.repeat(3000)}${'b'.repeat(3000)}`);
    expect(t).toHaveLength(4000);
    expect(t.endsWith('b'.repeat(3000))).toBe(true);
  });
  it('is empty for empty output', () => {
    expect(tail('')).toBe('');
  });
});
