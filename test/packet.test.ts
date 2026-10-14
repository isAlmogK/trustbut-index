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
