import { describe, expect, it } from 'vitest';
import { countedFindings, familiesOf } from '../src/aggregate/families.js';
import type { Receipt } from '../src/types.js';

const r = (ids: string[]): Receipt => ({
  specVersion: '1.0', producer: { name: 'trustbut', version: '0.4.0' }, subject: { base: 'b', head: 'h' }, verdict: 'warn',
  findings: ids.map((id) => ({ id, severity: 'warn', title: id })),
});

describe('families', () => {
  it('maps counted ids to families and ignores context ids', () => {
    const rec = r(['deps-changed', 'test-passes-without-change', 'test-skipped', 'escape-added', 'snapshot-changed', 'suite-failing']);
    expect(countedFindings(rec).map((c) => [c.index, c.family])).toEqual([
      [1, 'proof-gap'], [2, 'test-weakening'], [3, 'escapes'], [5, 'red-at-head'],
    ]);
    expect([...familiesOf(rec)].sort()).toEqual(['escapes', 'proof-gap', 'red-at-head', 'test-weakening']);
  });
  it('does not count ids that name Object.prototype members', () => {
    const rec = r(['constructor', 'toString', '__proto__', 'hasOwnProperty', 'escape-added']);
    expect(countedFindings(rec).map((c) => [c.index, c.family])).toEqual([[4, 'escapes']]);
  });
});
