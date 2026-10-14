import { describe, expect, it } from 'vitest';
import { classify, isRunRecord, looksLikeReceipt, type Outcome } from '../src/run/status.js';
import type { Receipt } from '../src/types.js';

const recipe = { node: { version: '22', pm: 'npm' as const, install: 'npm ci' }, python: null };
const receipt = (p: Partial<Receipt> = {}): Receipt => ({
  specVersion: '1.0', producer: { name: 'trustbut', version: '0.4.0' }, subject: { base: 'b', head: 'h' },
  verdict: 'pass', findings: [], tests: { passed: 3, failed: 0, errored: 0, skipped: 0, scope: 'full' }, ...p,
});
const o = (p: Partial<Outcome>): Outcome => ({ fetchOk: true, recipe, installExit: 0, verifyExit: 0, receipt: receipt(), ...p });

describe('classify', () => {
  it('maps every outcome to one status and stage', () => {
    expect(classify(o({}))).toEqual({ status: 'ran', stage: null });
    expect(classify(o({ verifyExit: 1, receipt: receipt({ verdict: 'fail' }) }))).toEqual({ status: 'ran', stage: null });
    expect(classify(o({ fetchOk: false }))).toEqual({ status: 'setup-failed', stage: 'fetch' });
    expect(classify(o({ recipe: null, installExit: null }))).toEqual({ status: 'no-runner', stage: 'recipe' });
    expect(classify(o({ installExit: 124 }))).toEqual({ status: 'timeout', stage: 'install' });
    expect(classify(o({ installExit: 1 }))).toEqual({ status: 'setup-failed', stage: 'install' });
    expect(classify(o({ verifyExit: 124, receipt: null }))).toEqual({ status: 'timeout', stage: 'verify' });
    expect(classify(o({ verifyExit: 2, receipt: null }))).toEqual({ status: 'trustbut-error', stage: 'verify' });
    expect(classify(o({ receipt: receipt({ findings: [{ id: 'no-runner', severity: 'warn', title: 'x' }], tests: undefined }) }))).toEqual({
      status: 'no-runner', stage: 'verify',
    });
    expect(classify(o({ receipt: receipt({ tests: { passed: 0, failed: 5, errored: 0, skipped: 0, scope: 'full' } }) }))).toEqual({
      status: 'setup-failed', stage: 'no-passing-tests',
    });
  });
});

describe('shape checks', () => {
  it('accepts a run record and rejects junk', () => {
    const run = { id: 'o__r__1', status: 'ran', stage: null, recipe: null, durations: { installMs: 1, verifyMs: 2 },
      exitCodes: { install: 0, verify: 0 }, runnerImage: 'ubuntu24', trustbutVersion: '0.4.0' };
    expect(isRunRecord(run)).toBe(true);
    expect(isRunRecord({ ...run, status: 'great' })).toBe(false);
    expect(isRunRecord('x')).toBe(false);
  });
  it('accepts a receipt-shaped object', () => {
    expect(looksLikeReceipt(receipt())).toBe(true);
    expect(looksLikeReceipt({ findings: 'no' })).toBe(false);
  });
});
