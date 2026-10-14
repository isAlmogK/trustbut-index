import { describe, expect, it } from 'vitest';
import { aggregate, type PrResult } from '../src/aggregate/index.js';
import { calibration, hitRate, labelStats } from '../src/label/metrics.js';
import type { FinalLabel } from '../src/label/review.js';
import type { SampleItem } from '../src/label/sample.js';
import { describeRepo, pickExamples } from '../src/report/examples.js';
import { renderReport, renderPng, shareSvg, type ReportData } from '../src/report/html.js';
import { verdict } from '../src/verdict.js';

const results: PrResult[] = [1, 2, 3].map((n) => ({
  entry: { id: `o/r#${n}`, repo: 'o/r', pr: n, group: n < 3 ? 'agent' : 'human', agent: n < 3 ? 'copilot' : null, repoStars: 12_400, repoLanguage: 'TypeScript' } as PrResult['entry'],
  run: { status: 'ran' } as PrResult['run'],
  receipt: {
    specVersion: '1.0', producer: { name: 'trustbut', version: '0.4.0' }, subject: { base: 'b', head: 'h' }, verdict: 'warn',
    findings: [{ id: 'test-passes-without-change', severity: 'warn', title: 'Test passes without the change', file: 't.test.ts', detail: 'adds' }],
    proofs: [{ file: 't.test.ts', name: 'adds', before: 'pass', after: 'pass', verdict: 'does-not-constrain' }],
  },
}));
const sample = [{ key: 'o__r__1:0', prId: 'o/r#1', fileId: 'o__r__1', group: 'agent', agent: 'copilot', findingIndex: 0,
  finding: results[0]!.receipt!.findings[0]!, family: 'proof-gap', order: 0, blind: true } as SampleItem];
const finals = [{ key: 'o__r__1:0', label: 'real', draftLabel: 'real', blind: true } as FinalLabel];

function data(): ReportData {
  const agg = aggregate('2026-11-02', results, 1);
  const labels = labelStats(sample, finals);
  const hit = hitRate(agg.groups.find((g) => g.key === 'all-agents')!, sample, finals);
  return {
    date: '2026-11-02', agg, labels, hit, calibration: calibration(sample, finals, []), verdict: verdict(agg, labels, hit),
    examples: pickExamples(sample, finals, results), preregUrl: 'https://github.com/isAlmogK/trustbut-index/blob/prereg-v1/PREREGISTRATION.md', deviations: [],
  };
}

describe('examples', () => {
  it('anonymizes repos', () => {
    expect(describeRepo(12_400, 'TypeScript')).toBe('a 12k-star TypeScript project');
    expect(describeRepo(1_500, null)).toBe('a 1.5k-star project');
  });
  it('picks real-labelled findings with their before/after', () => {
    expect(pickExamples(sample, finals, results)).toEqual([{
      description: 'a 12k-star TypeScript project', family: 'proof-gap', title: 'Test passes without the change', testName: 'adds', before: 'pass', after: 'pass',
    }]);
  });
});

describe('renderReport', () => {
  const html = renderReport(data());
  it('has the seven sections in order, theming, and no external scripts', () => {
    const order = ['id="verdict"', 'id="proof"', 'id="families"', 'id="coverage"', 'id="labels"', 'id="examples"', 'id="method"'].map((s) => html.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).toMatch(/a\{color:var\(--agent\)\}/);
    expect(html).toContain('figure{overflow-x:auto}figure svg{min-width:560px}');
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).toContain('Precision');
    expect(html).toContain('roughly 90% joint coverage');
    expect(html).toContain('Some structural tells may remain');
    expect(html).not.toMatch(/o\/r#1/);
  });
  it('is deterministic', () => {
    expect(renderReport(data())).toBe(html);
  });
});

describe('share card', () => {
  it('renders a 1200-wide PNG', () => {
    const png = renderPng(shareSvg(data()));
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(1200);
  });
});
