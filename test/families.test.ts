import { describe, expect, it } from 'vitest';
import { countedFindings, familiesOf, isProofFirst, measuresRedAtHead } from '../src/aggregate/families.js';
import type { Receipt } from '../src/types.js';

const r = (ids: string[], version = '0.5.0'): Receipt => ({
  specVersion: version === '0.4.0' ? '1.0' : version === '0.7.0' ? '1.2' : '1.1', producer: { name: 'trustbut', version }, subject: { base: 'b', head: 'h' }, verdict: 'warn',
  findings: ids.map((id) => ({ id, severity: 'warn', title: id })),
});

describe('families', () => {
  it('maps counted ids to families and ignores context ids', () => {
    const rec = r(['deps-changed', 'test-passes-without-change', 'test-skipped', 'escape-added', 'snapshot-changed', 'test-regressed']);
    expect(countedFindings(rec).map((c) => [c.index, c.family])).toEqual([
      [1, 'proof-gap'], [2, 'test-weakening'], [3, 'escapes'], [5, 'red-at-head'],
    ]);
    expect([...familiesOf(rec)].sort()).toEqual(['escapes', 'proof-gap', 'red-at-head', 'test-weakening']);
  });
  it('counts only tests that passed at base as red at head', () => {
    expect(countedFindings(r(['suite-failing', 'test-failing']))).toEqual([]);
    expect(countedFindings(r(['suite-failing', 'test-regressed'])).map((c) => [c.index, c.family])).toEqual([[1, 'red-at-head']]);
  });
  it('does not count ids that name Object.prototype members', () => {
    const rec = r(['constructor', 'toString', '__proto__', 'hasOwnProperty', 'escape-added']);
    expect(countedFindings(rec).map((c) => [c.index, c.family])).toEqual([[4, 'escapes']]);
  });
  it('measures red at head only from trustbut 0.5.0 on', () => {
    expect(['0.4.0', '0.4.9', '0.0.1', 'dev', ''].map((v) => measuresRedAtHead(r([], v)))).toEqual([false, false, false, false, false]);
    expect(['0.5.0', '0.5.0-rc.1', '0.10.0', '1.0.0'].map((v) => measuresRedAtHead(r([], v)))).toEqual([true, true, true, true]);
    expect([...familiesOf(r(['test-regressed', 'escape-added'], '0.4.0'))]).toEqual(['escapes']);
  });
  it('counts change-not-proven as untested change without proofs and as a proof gap with proofs', () => {
    const base = r(['change-not-proven'], '0.7.0');
    expect(countedFindings(base).map((c) => c.family)).toEqual(['untested-change']);
    expect(countedFindings({ ...base, proofs: [] }).map((c) => c.family)).toEqual(['untested-change']);
    const withProof = { ...base, proofs: [{ file: 't.test.ts', name: 'a', before: 'pass', after: 'pass', verdict: 'does-not-constrain' }] } as Receipt;
    expect(countedFindings(withProof).map((c) => c.family)).toEqual(['proof-gap']);
  });
  it('tells trustbut 0.7.0 receipts from older ones', () => {
    expect(['0.6.0', '0.6.9', 'dev', ''].map((v) => isProofFirst(r([], v)))).toEqual([false, false, false, false]);
    expect(['0.7.0', '0.7.1', '1.0.0'].map((v) => isProofFirst(r([], v)))).toEqual([true, true, true]);
  });
});
