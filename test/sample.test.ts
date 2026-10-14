import { describe, expect, it } from 'vitest';
import type { PrResult } from '../src/aggregate/index.js';
import { sampleFindings } from '../src/label/sample.js';
import type { AgentId } from '../src/types.js';

const pr = (n: number, agent: AgentId | null, findings: number): PrResult => ({
  entry: { id: `o/r#${n}`, repo: 'o/r', pr: n, group: agent ? 'agent' : 'human', agent } as PrResult['entry'],
  run: { status: 'ran' } as PrResult['run'],
  receipt: {
    specVersion: '1.0', producer: { name: 'trustbut', version: '0.4.0' }, subject: { base: 'b', head: 'h' }, verdict: 'warn',
    findings: [{ id: 'deps-changed', severity: 'info', title: 'd' }, ...Array.from({ length: findings }, () => ({ id: 'escape-added', severity: 'warn' as const, title: 'e' }))],
  },
});

describe('sampleFindings', () => {
  const results = [
    ...Array.from({ length: 30 }, (_, i) => pr(i + 1, 'copilot', 2)),
    ...Array.from({ length: 30 }, (_, i) => pr(100 + i, 'codex', 8)),
    ...Array.from({ length: 5 }, (_, i) => pr(200 + i, 'jules', 1)),
    ...Array.from({ length: 30 }, (_, i) => pr(300 + i, null, 1)),
    pr(400, 'copilot', 0),
  ];
  const s = sampleFindings(results, { seed: 's', insufficient: new Set(['jules']), agentTarget: 40, humanTarget: 10 });

  it('reaches the targets with counted findings only, capped per PR, skipping insufficient agents', () => {
    const agent = s.filter((x) => x.group === 'agent');
    expect(agent.length).toBeGreaterThanOrEqual(40);
    expect(s.filter((x) => x.group === 'human').length).toBe(10);
    expect(s.every((x) => x.finding.id === 'escape-added' && x.findingIndex >= 1)).toBe(true);
    expect(s.some((x) => x.agent === 'jules')).toBe(false);
    const perPr = new Map<string, number>();
    for (const x of s) perPr.set(x.prId, (perPr.get(x.prId) ?? 0) + 1);
    expect(Math.max(...perPr.values())).toBeLessThanOrEqual(5);
    expect(new Set(agent.map((x) => x.agent))).toEqual(new Set(['copilot', 'codex']));
  });

  it('marks the first 20 in sample order blind and is deterministic', () => {
    expect(s.map((x) => x.order)).toEqual(s.map((_, i) => i));
    expect(s.filter((x) => x.blind).map((x) => x.order)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    const again = sampleFindings([...results].reverse(), { seed: 's', insufficient: new Set(['jules']), agentTarget: 40, humanTarget: 10 });
    expect(again.map((x) => x.key)).toEqual(s.map((x) => x.key));
  });
});

describe('sampleFindings golden order', () => {
  const at = (repo: string, n: number, agent: AgentId | null, findings: number): PrResult => ({
    entry: { id: `${repo}#${n}`, repo, pr: n, group: agent ? 'agent' : 'human', agent } as PrResult['entry'],
    run: { status: 'ran' } as PrResult['run'],
    receipt: {
      specVersion: '1.0', producer: { name: 'trustbut', version: '0.4.0' }, subject: { base: 'b', head: 'h' }, verdict: 'warn',
      findings: Array.from({ length: findings }, () => ({ id: 'escape-added', severity: 'warn' as const, title: 'e' })),
    },
  });
  it('pins the key order for mixed-case repos and #9/#10 ids (code-unit sort, seed prereg-v1)', () => {
    const results = [at('a/x', 9, 'copilot', 1), at('a/x', 10, 'copilot', 2), at('B/y', 1, 'codex', 1), at('_z/w', 3, 'codex', 1), at('a/x', 11, null, 1), at('Z/q', 2, null, 1)];
    const keys = sampleFindings(results, { seed: 'prereg-v1', insufficient: new Set(), blindCount: 2 }).map((s) => s.key);
    expect(keys).toEqual(['B__y__1:0', '_z__w__3:0', 'Z__q__2:0', 'a__x__10:1', 'a__x__11:0', 'a__x__10:0', 'a__x__9:0']);
  });
});
