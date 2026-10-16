import { describe, expect, it } from 'vitest';
import { countedFindings, familiesOf, measuresRedAtHead } from '../src/aggregate/families.js';
import type { Receipt } from '../src/types.js';

const r = (ids: string[], version = '0.5.0'): Receipt => ({
  specVersion: version === '0.4.0' ? '1.0' : '1.1', producer: { name: 'trustbut', version }, subject: { base: 'b', head: 'h' }, verdict: 'warn',
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
});
