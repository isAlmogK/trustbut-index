import { describe, expect, it } from 'vitest';
import { aggregate, type PrResult } from '../src/aggregate/index.js';
import type { AgentId, Receipt, RunRecord, RunStatus } from '../src/types.js';

const run = (status: RunStatus): RunRecord => ({ id: 'x', status, stage: null, recipe: null, durations: { installMs: 0, verifyMs: 0 },
  exitCodes: { install: 0, verify: 0 }, runnerImage: 'x', trustbutVersion: '0.4.0' });
const receipt = (ids: string[], proofs: Receipt['proofs'] = []): Receipt => ({
  specVersion: '1.0', producer: { name: 'trustbut', version: '0.4.0' }, subject: { base: 'b', head: 'h' }, verdict: 'warn',
  findings: ids.map((id) => ({ id, severity: 'warn', title: id })), proofs,
});
const pr = (n: number, agent: AgentId | null, status: RunStatus | null, ids: string[] = [], proofs: Receipt['proofs'] = []): PrResult => ({
  entry: { id: `o/r#${n}`, repo: 'o/r', pr: n, group: agent ? 'agent' : 'human', agent } as PrResult['entry'],
  run: status ? run(status) : null,
  receipt: status === 'ran' ? receipt(ids, proofs) : null,
});
const proof = (verdict: 'proves-change' | 'does-not-constrain') => ({ file: 't', name: 'n', before: 'x', after: 'pass', verdict });

describe('aggregate', () => {
  const results: PrResult[] = [
    pr(1, 'copilot', 'ran', ['test-passes-without-change'], [proof('proves-change'), proof('does-not-constrain')]),
    pr(2, 'copilot', 'ran', [], [proof('proves-change')]),
    pr(3, 'copilot', 'setup-failed'),
    pr(4, 'copilot', null),
    pr(5, null, 'ran', [], [proof('proves-change')]),
    pr(6, null, 'ran', ['escape-added']),
  ];
  const agg = aggregate('2026-11-02', results, 2);
  const g = (k: string) => agg.groups.find((x) => x.key === k)!;

  it('counts statuses and coverage per group', () => {
    expect(g('copilot')).toMatchObject({ selected: 4, ran: 2, insufficient: false });
    expect(g('copilot').byStatus).toMatchObject({ ran: 2, 'setup-failed': 1, missing: 1 });
    expect(g('copilot').coverage).toMatchObject({ k: 2, n: 4 });
    expect(g('all').coverage).toMatchObject({ k: 4, n: 6 });
    expect(g('codex').insufficient).toBe(true);
  });

  it('computes family rates and proof rates over ran PRs', () => {
    expect(g('copilot').families['proof-gap']).toMatchObject({ k: 1, n: 2 });
    expect(g('copilot').anyCounted).toMatchObject({ k: 1, n: 2 });
    expect(g('copilot').proofs).toMatchObject({ provesChange: 2, doesNotConstrain: 1 });
    expect(g('copilot').proofs.proofRate).toMatchObject({ k: 2, n: 3 });
    expect(g('human').families.escapes).toMatchObject({ k: 1, n: 2 });
  });

  it('compares sufficient agents with humans', () => {
    const c = agg.comparisons.find((x) => x.metric === 'proof-gap')!;
    expect(c.agents).toMatchObject({ k: 1, n: 2 });
    expect(c.human).toMatchObject({ k: 0, n: 2 });
    expect(c.diff.d).toBeCloseTo(0.5, 6);
    expect(agg.trustbutVersions).toEqual(['0.4.0']);
  });
});
