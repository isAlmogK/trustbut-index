import type { Family, Finding, Receipt } from '../types.js';

export const FAMILIES: Family[] = ['proof-gap', 'test-weakening', 'escapes', 'untested-change', 'red-at-head'];

export const FAMILY_OF: Record<string, Family> = {
  'test-passes-without-change': 'proof-gap',
  'test-skipped': 'test-weakening',
  'test-focused': 'test-weakening',
  'tests-removed': 'test-weakening',
  'assertions-removed': 'test-weakening',
  'test-config-changed': 'test-weakening',
  'escape-added': 'escapes',
  'no-tests-changed': 'untested-change',
  'suite-failing': 'red-at-head',
  'test-failing': 'red-at-head',
};

export function countedFindings(r: Receipt): { finding: Finding; index: number; family: Family }[] {
  return r.findings.flatMap((finding, index) => {
    // Own keys only: an id like "constructor" must not resolve to an Object.prototype member.
    const family = Object.hasOwn(FAMILY_OF, finding.id) ? FAMILY_OF[finding.id] : undefined;
    return family ? [{ finding, index, family }] : [];
  });
}

export function familiesOf(r: Receipt): Set<Family> {
  return new Set(countedFindings(r).map((c) => c.family));
}
