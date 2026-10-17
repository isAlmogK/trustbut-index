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

/** The family a finding counts in, or undefined for context findings. `change-not-proven` (trustbut 0.7.0) depends on whether the receipt has proofs. */
export function familyOf(finding: Finding, r: Receipt): Family | undefined {
  if (finding.id === 'change-not-proven') return (r.proofs?.length ?? 0) > 0 ? 'proof-gap' : 'untested-change';
  // Own keys only: an id like "constructor" must not resolve to an Object.prototype member.
  return Object.hasOwn(FAMILY_OF, finding.id) ? FAMILY_OF[finding.id] : undefined;
}

export function countedFindings(r: Receipt): { finding: Finding; index: number; family: Family }[] {
  return r.findings.flatMap((finding, index) => {
    const family = familyOf(finding, r);
    return family ? [{ finding, index, family }] : [];
  });
}

/** True when the receipt's trustbut version is at least `min`. An unparseable version counts as older. */
function atLeast(r: Receipt, min: number[]): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(r.producer?.version ?? '');
  if (!m) return false;
  for (let i = 0; i < 3; i++) {
    const v = Number(m[i + 1]);
    if (v !== min[i]) return v > min[i]!;
  }
  return true;
}

/** trustbut reports `test-regressed` from 0.5.0 (receipt spec 1.1); older receipts can't measure red at head. */
const RED_AT_HEAD_SINCE = [0, 5, 0];

/** True when the receipt comes from a trustbut that compares failing tests with base. An unparseable version counts as older. */
export function measuresRedAtHead(r: Receipt): boolean {
  return atLeast(r, RED_AT_HEAD_SINCE);
}

/** trustbut 0.7.0 is proof-first: it reports `change-not-proven` and no longer `test-passes-without-change` or `no-tests-changed`. */
export const PROOF_FIRST_SINCE = [0, 7, 0];

/** True when the receipt comes from a proof-first trustbut (0.7.0 or later). */
export function isProofFirst(r: Receipt): boolean {
  return atLeast(r, PROOF_FIRST_SINCE);
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
