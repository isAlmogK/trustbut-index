import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { INSTALL_BUDGET_MS, VERIFY_BUDGET_MS } from '../src/run/job.js';

const MIN = 60_000;

describe('run budgets', () => {
  it('match the pre-registered numbers', async () => {
    const yml = await readFile('.github/workflows/run.yml', 'utf8');
    const { timeoutSec } = JSON.parse(await readFile('config/trustbut.json', 'utf8')) as { timeoutSec: number };
    expect(yml).toMatch(/^ {4}timeout-minutes: 120$/m);
    expect(yml).toContain("TRUSTBUT_SPEC: '0.6.0'");
    expect(INSTALL_BUDGET_MS).toBe(25 * MIN);
    expect(VERIFY_BUDGET_MS).toBe(85 * MIN);
    expect(timeoutSec).toBe(2400);
  });

  it('fit inside each other: two trustbut runs in verify, install plus verify plus 10 minutes of setup in the job', async () => {
    const yml = await readFile('.github/workflows/run.yml', 'utf8');
    const jobMinutes = Number(/^ {4}timeout-minutes: (\d+)$/m.exec(yml)![1]);
    const { timeoutSec } = JSON.parse(await readFile('config/trustbut.json', 'utf8')) as { timeoutSec: number };
    expect(2 * timeoutSec * 1000).toBeLessThan(VERIFY_BUDGET_MS);
    expect(INSTALL_BUDGET_MS + VERIFY_BUDGET_MS + 10 * MIN).toBeLessThanOrEqual(jobMinutes * MIN);
  });
});
