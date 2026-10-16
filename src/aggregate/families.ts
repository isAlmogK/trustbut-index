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
  // Red at head counts only tests that passed at base (trustbut 0.5.0). `suite-failing` and `test-failing` are context:
  // in the first pilot almost all of them failed at base too.
  'test-regressed': 'red-at-head',
};

export function countedFindings(r: Receipt): { finding: Finding; index: number; family: Family }[] {
  return r.findings.flatMap((finding, index) => {
    // Own keys only: an id like "constructor" must not resolve to an Object.prototype member.
    const family = Object.hasOwn(FAMILY_OF, finding.id) ? FAMILY_OF[finding.id] : undefined;
    return family ? [{ finding, index, family }] : [];
  });
}

/** trustbut reports `test-regressed` from 0.5.0 (receipt spec 1.1); older receipts can't measure red at head. */
const RED_AT_HEAD_SINCE = [0, 5, 0];

/** True when the receipt comes from a trustbut that compares failing tests with base. An unparseable version counts as older. */
export function measuresRedAtHead(r: Receipt): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(r.producer?.version ?? '');
  if (!m) return false;
  for (let i = 0; i < 3; i++) {
    const v = Number(m[i + 1]);
    if (v !== RED_AT_HEAD_SINCE[i]) return v > RED_AT_HEAD_SINCE[i]!;
  }
  return true;
}

/** The receipt's counted families. Red at head is left out for receipts that can't measure it. */
export function familiesOf(r: Receipt): Set<Family> {
  const s = new Set(countedFindings(r).map((c) => c.family));
  if (!measuresRedAtHead(r)) s.delete('red-at-head');
  return s;
}

const isFailing = (outcome: unknown) => outcome === 'fail' || outcome === 'error';

/** True when a test fails or errors at head and has no base result (its id is absent from the base run, or there is no base run). */
export function redAtHeadNotCompared(r: Receipt): boolean {
  const x = r['x-trustbut'];
  const failing = (x?.after?.cases ?? []).filter((c) => isFailing(c?.outcome));
  if (!failing.length) return false;
  const atBase = new Set((x?.before?.cases ?? []).map((c) => c?.id));
  return failing.some((c) => !atBase.has(c.id));
}
