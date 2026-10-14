import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parseBatch, parseDate } from '../src/run/command.js';

describe('run command validators', () => {
  it('parseBatch accepts digits only', () => {
    expect(parseBatch('0')).toBe(0);
    expect(parseBatch('12')).toBe(12);
    for (const bad of ['', '-1', '1.5', '1; echo hi', '1\n2', 'x']) expect(() => parseBatch(bad)).toThrow(/batch/);
  });
  it('parseDate accepts YYYY-MM-DD with optional pilot- prefix', () => {
    expect(parseDate('2026-11-02')).toBe('2026-11-02');
    expect(parseDate('pilot-2026-11-02')).toBe('pilot-2026-11-02');
    for (const bad of ['', '../x', '2026-11-02/../..', '2026-11-02\nx', 'pilot-', '26-1-2']) expect(() => parseDate(bad)).toThrow(/date/);
  });
});

describe('run.yml', () => {
  it('never interpolates workflow inputs into a script', async () => {
    const yml = await readFile('.github/workflows/run.yml', 'utf8');
    const lines = yml.split('\n').filter((l) => /\$\{\{\s*inputs\./.test(l));
    expect(lines.filter((l) => !/^\s+(MANIFEST|BATCH|DATE): \$\{\{ inputs\.\w+ \}\}$/.test(l))).toEqual([]);
  });
});
