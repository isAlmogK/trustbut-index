import { describe, expect, it } from 'vitest';
import { assemblePacket } from '../src/label/packet.js';
import type { SampleItem } from '../src/label/sample.js';
import type { Receipt } from '../src/types.js';

const receipt: Receipt = {
  specVersion: '1.0', producer: { name: 'trustbut', version: '0.4.0' }, subject: { base: 'b', head: 'h' }, verdict: 'warn',
  findings: [{ id: 'test-passes-without-change', severity: 'warn', title: 'Test passes without the change', file: 'test/a.test.ts', detail: 'adds' }],
  proofs: [
    { file: 'test/a.test.ts', name: 'adds', before: 'pass', after: 'pass', verdict: 'does-not-constrain' },
    { file: 'test/b.test.ts', name: 'other', before: 'fail', after: 'pass', verdict: 'proves-change' },
  ],
};
const item: SampleItem = {
  key: 'o__r__1:0', prId: 'o/r#1', fileId: 'o__r__1', group: 'agent', agent: 'copilot', findingIndex: 0,
  finding: receipt.findings[0]!, family: 'proof-gap', order: 0, blind: true,
};

describe('assemblePacket', () => {
  it('keeps the finding, its proofs, the relevant diffs and test source, blinded', () => {
    const source = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\n');
    const p = assemblePacket(item, receipt, { title: 'Fix add', body: 'Generated with Claude Code\nreal text' },
      [{ filename: 'src/add.ts', patch: '@@ -1 +1 @@\n-a\n+b' }, { filename: 'test/a.test.ts', patch: '@@ +1 @@\n+it("adds")' }, { filename: 'README.md', patch: 'x' }],
      source);
    expect(p.proofs).toEqual([receipt.proofs![0]]);
    expect(p.diff.map((d) => d.file)).toEqual(['test/a.test.ts', 'src/add.ts']);
    expect(p.pr.body).not.toMatch(/claude/i);
    expect(p.pr.body).toContain('real text');
    expect(p.testSource).toMatchObject({ file: 'test/a.test.ts', startLine: 1 });
    expect(p.testSource!.text.split('\n').length).toBe(120);
    expect(p.baseRun).toBe('adds: before pass, after pass');
  });
});

describe('assemblePacket blinding gaps', () => {
  const base = { title: 'Fix add', body: 'x' } as const;

  it('scrubs proof names and baseRun, filtering on raw values first', () => {
    const r: Receipt = {
      ...receipt,
      proofs: [{ file: 'test/a.test.ts', name: 'copilot adds', before: 'pass', after: 'pass', verdict: 'does-not-constrain' }],
    };
    const it2: SampleItem = { ...item, finding: { ...receipt.findings[0]!, detail: 'copilot adds' } };
    const p = assemblePacket(it2, r, { title: 'Fix', body: '' }, [], null);
    expect(p.proofs).toHaveLength(1);
    expect(p.proofs[0]!.name).toBe('[agent] adds');
    expect(p.baseRun).toBe('[agent] adds: before pass, after pass');
    expect(JSON.stringify(p)).not.toMatch(/copilot/i);
  });

  it('scrubs marker words out of every path field', () => {
    const cursorFile = '.cursor/rules.test.ts';
    const r: Receipt = {
      ...receipt,
      proofs: [{ file: cursorFile, name: 'adds', before: 'pass', after: 'pass', verdict: 'does-not-constrain' }],
    };
    const it2: SampleItem = { ...item, finding: { ...receipt.findings[0]!, file: cursorFile, detail: undefined } };
    const p = assemblePacket(
      it2, r, base,
      [
        { filename: cursorFile, patch: '@@ +1 @@\n+it("adds")' },
        { filename: 'copilot/helper.ts', patch: '@@\n+export const a = 1' },
      ],
      'line 1\nline 2',
    );
    expect(p.finding.file).not.toMatch(/cursor/i);
    expect(p.proofs[0]!.file).not.toMatch(/cursor/i);
    expect(p.testSource!.file).not.toMatch(/cursor/i);
    expect(p.diff.map((d) => d.file).join(' ')).not.toMatch(/cursor|copilot/i);
  });

  it('drops a body marker line without shifting the rest of the body', () => {
    const p = assemblePacket(item, receipt, { title: 'Fix', body: 'Fixed.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\nreal' }, [], null);
    expect(p.pr.body).toBe('Fixed.\n\nreal');
  });

  it('keeps source line numbering when a marker line is in the test source', () => {
    const src = 'line 1\n\nCo-authored-by: Claude <x>\nline 4';
    const p = assemblePacket(item, receipt, base, [], src);
    expect(p.testSource!.text.split('\n').length).toBe(4);
    expect(p.testSource!.text.split('\n')[3]).toBe('line 4');
    expect(p.testSource!.text).not.toMatch(/claude/i);
  });

  it('collapses runs of blank lines in the PR body only', () => {
    const p = assemblePacket(item, receipt, { title: 'Fix', body: 'a\n\n\n\n\nb' }, [{ filename: 'src/add.ts', patch: '@@\n+a\n\n\n+b' }], null);
    expect(p.pr.body).toBe('a\n\nb');
    expect(p.diff[0]!.patch).toBe('@@\n+a\n\n\n+b');
  });

  it('scrubs the body before slicing so a marker cannot be cut at the limit', () => {
    const body = `${'x'.repeat(1985)}\nCo-authored-by: Claude Opus 4.5 <noreply@anthropic.com>`;
    const p = assemblePacket(item, receipt, { title: 'Fix', body }, [], null);
    expect(p.pr.body.toLowerCase()).not.toContain('co-authored-by');
    expect(p.pr.body.toLowerCase()).not.toContain('claude');
  });

  it('scrubs the diff patch before slicing so a marker cannot be cut at the limit', () => {
    const patch = `${'a'.repeat(3985)}\nCo-authored-by: Claude Opus 4.5`;
    const p = assemblePacket(item, receipt, base, [{ filename: 'src/add.ts', patch }], null);
    expect(p.diff[0]!.patch.toLowerCase()).not.toContain('co-authored-by');
    expect(p.diff[0]!.patch.toLowerCase()).not.toContain('claude');
  });
});

describe('assemblePacket for test-regressed', () => {
  const finding = { id: 'test-regressed', severity: 'fail' as const, title: 'Test passes at base and fails at head', file: 'pkg/test/a.test.ts', detail: 'copilot adds' };
  const reg: Receipt = {
    specVersion: '1.1', producer: { name: 'trustbut', version: '0.5.0' }, subject: { base: 'b', head: 'h' }, verdict: 'fail',
    findings: [finding], proofs: [],
    'x-trustbut': {
      after: { cases: [
        { id: 'test/a.test.ts::copilot adds', file: 'test/a.test.ts', name: 'copilot adds', outcome: 'fail', message: 'expected 1 to be 2 (from copilot helper)' },
        { id: 'test/b.test.ts::copilot adds', file: 'test/b.test.ts', name: 'copilot adds', outcome: 'pass' },
      ] },
      before: { cases: [{ id: 'test/a.test.ts::copilot adds', file: 'test/a.test.ts', name: 'copilot adds', outcome: 'pass' }] },
    },
  };
  const regItem: SampleItem = { ...item, finding, family: 'red-at-head' };

  it('adds the head case with its failure message and the base outcome, blinded', () => {
    const p = assemblePacket(regItem, reg, { title: 'Fix', body: '' }, [], null);
    expect(p.regression).toEqual({ name: '[agent] adds', before: 'pass', after: 'fail', message: 'expected 1 to be 2 (from [agent] helper)' });
    expect(p.baseRun).toBe('[agent] adds: before pass, after fail (expected 1 to be 2 (from [agent] helper))');
    expect(JSON.stringify(p)).not.toMatch(/copilot/i);
  });

  it('matches a case file reported as an absolute path and reports a base result that is missing', () => {
    const abs: Receipt = { ...reg, 'x-trustbut': { after: { cases: [{ id: 'x', file: '/tmp/wt/pkg/test/a.test.ts', name: 'copilot adds', outcome: 'error' }] }, before: { cases: [] } } };
    const p = assemblePacket(regItem, abs, { title: 'Fix', body: '' }, [], null);
    expect(p.regression).toMatchObject({ before: 'missing', after: 'error' });
    expect(p.regression).not.toHaveProperty('message');
    expect(p.baseRun).toBe('[agent] adds: before missing, after error');
  });

  it('has no regression evidence when the receipt has no matching head case', () => {
    const none: Receipt = { ...reg, 'x-trustbut': undefined };
    const p = assemblePacket(regItem, none, { title: 'Fix', body: '' }, [], null);
    expect(p.regression).toBeNull();
    expect(p.baseRun).toBe('n/a');
    expect(assemblePacket(item, receipt, { title: 'Fix', body: '' }, [], null).regression).toBeNull();
  });
});
