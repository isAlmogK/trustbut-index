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
  it('parseDate accepts a pilot folder suffix of lowercase letters, digits and dots', () => {
    expect(parseDate('pilot-2026-10-17-0.7.0')).toBe('pilot-2026-10-17-0.7.0');
    expect(parseDate('pilot-2026-10-17-rerun2')).toBe('pilot-2026-10-17-rerun2');
    for (const bad of ['2026-10-17-0.7.0', 'pilot-2026-10-17-', 'pilot-2026-10-17-.', 'pilot-2026-10-17-..', 'pilot-2026-10-17-a/b', 'pilot-2026-10-17-A', 'pilot-2026-10-17-a b', 'pilot-2026-10-17-a\nb'])
      expect(() => parseDate(bad)).toThrow(/date/);
  });
});

describe('run.yml', () => {
  it('never interpolates workflow inputs into a script', async () => {
    const yml = await readFile('.github/workflows/run.yml', 'utf8');
    const lines = yml.split('\n').filter((l) => /\$\{\{\s*inputs\./.test(l));
    expect(lines.filter((l) => !/^\s+(MANIFEST|BATCH|DATE): \$\{\{ inputs\.\w+ \}\}$/.test(l))).toEqual([]);
  });
  it('pins trustbut to exactly 0.7.0, as the pre-registration states', async () => {
    const yml = await readFile('.github/workflows/run.yml', 'utf8');
    expect(yml).toMatch(/^  TRUSTBUT_SPEC: '0\.7\.0'$/m);
    expect(await readFile('PREREGISTRATION.md', 'utf8')).toContain('trustbut 0.7.0 exactly; any other version is a deviation');
  });
  it('lets ingest jobs run concurrently and retries the push', async () => {
    const yml = await readFile('.github/workflows/run.yml', 'utf8');
    const ingestJob = yml.slice(yml.indexOf('\n  ingest:'));
    expect(ingestJob).not.toMatch(/concurrency:/);
    expect(ingestJob).toMatch(/for attempt in 1 2 3 4 5; do/);
    expect(ingestJob).toMatch(/git pull --rebase && git push/);
    expect(ingestJob).toMatch(/sleep /);
  });
  it('ingest checks results against the manifest and pins its actions to commit SHAs', async () => {
    const yml = await readFile('.github/workflows/run.yml', 'utf8');
    const ingestJob = yml.slice(yml.indexOf('\n  ingest:'));
    expect(ingestJob).toMatch(/ingest --artifacts artifacts --date "\$DATE" --manifest "\$MANIFEST"/);
    expect(ingestJob).toMatch(/^\s+MANIFEST: \$\{\{ inputs\.manifest \}\}$/m);
    const uses = ingestJob.match(/uses: .*/g)!;
    expect(uses.length).toBe(3);
    for (const u of uses) expect(u).toMatch(/^uses: actions\/(checkout|setup-node|download-artifact)@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
    expect(ingestJob).not.toMatch(/cache: npm/);
  });
});

