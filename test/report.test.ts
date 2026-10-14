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
    baseUrl: 'https://isalmogk.github.io/trustbut-index/',
  };
}

describe('examples', () => {
  it('anonymizes repos', () => {
    expect(describeRepo(12_400, 'TypeScript')).toBe('a 12k-star TypeScript project');
    expect(describeRepo(1_500, null)).toBe('a 1.5k-star project');
  });
  it('picks real-labelled findings with their before/after, never the test name', () => {
    expect(pickExamples(sample, finals, results)).toEqual([{
      description: 'a 12k-star TypeScript project', family: 'proof-gap', title: 'Test passes without the change', before: 'pass', after: 'pass',
    }]);
  });
  it('uses the latest label per finding', () => {
    const relabelled = [...finals, { key: 'o__r__1:0', label: 'false', draftLabel: 'real', blind: true } as FinalLabel];
    expect(pickExamples(sample, relabelled, results)).toEqual([]);
  });
  it('attaches before/after only to a proof-gap finding whose detail names the proof', () => {
    const mismatch = [{ ...sample[0]!, finding: { ...sample[0]!.finding, detail: 'other test' } }];
    expect(pickExamples(mismatch, finals, results)[0]).toMatchObject({ before: null, after: null });
    const escape = [{ ...sample[0]!, family: 'escapes', finding: { ...sample[0]!.finding, id: 'escape-added' } } as SampleItem];
    expect(pickExamples(escape, finals, results)[0]).toMatchObject({ family: 'escapes', before: null, after: null });
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
    expect(html).not.toContain('<code>adds</code>');
    expect(html).toContain('pass before the change, pass after');
  });
  it('labels the hit-rate tile as an envelope and the other tiles as 95% intervals', () => {
    const tiles = html.split('<div class="tile ').slice(1);
    expect(tiles).toHaveLength(3);
    expect(tiles[0]).toContain('95% interval');
    expect(tiles[1]).toContain('≈90% envelope');
    expect(tiles[1]).not.toContain('95% interval');
    expect(tiles[2]).toContain('95% interval');
  });
  it('states the clustering caveat', () => {
    expect(html).toContain('Intervals treat tests (proof rate) and findings (precision) as independent; tests and findings from the same PR are correlated, so the true uncertainty is somewhat wider.');
  });
  it('has absolute social-card tags', () => {
    expect(html).toContain('<meta property="og:image" content="https://isalmogk.github.io/trustbut-index/2026-11-02/share.png">');
    expect(html).toContain('<meta property="og:url" content="https://isalmogk.github.io/trustbut-index/2026-11-02/">');
    expect(html).toMatch(/<meta property="og:title" content="[^"]+">/);
    expect(html).toMatch(/<meta property="og:description" content="[^"]+">/);
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).not.toContain('content="share.png"');
    expect(renderReport({ ...data(), baseUrl: 'https://example.org/x' })).toContain('content="https://example.org/x/2026-11-02/share.png"');
  });
  it('is deterministic', () => {
    expect(renderReport(data())).toBe(html);
  });
});

describe('label detail', () => {
  it('shows agent and human precision with n and 95% interval, and the unclear count', () => {
    const it2 = (key: string, group: 'agent' | 'human') => ({ ...sample[0]!, key, group }) as SampleItem;
    const s2 = [it2('a1', 'agent'), it2('a2', 'agent'), it2('a3', 'agent'), it2('h1', 'human'), it2('h2', 'human')];
    const f2 = (['real', 'false', 'unclear', 'real', 'true-but-benign'] as const).map((label, i) => ({ key: s2[i]!.key, label }) as FinalLabel);
    const html = renderReport({ ...data(), labels: labelStats(s2, f2) });
    const section = html.slice(html.indexOf('id="labels"'), html.indexOf('id="examples"'));
    expect(section).toContain('Agent findings: precision 50.0% (n=2, 95% interval 9.5%–90.5%)');
    expect(section).toContain('Human findings: precision 50.0% (n=2, 95% interval 9.5%–90.5%)');
    expect(section).toContain('1 finding labeled unclear');
  });
});

describe('share card', () => {
  it('renders a 1200-wide PNG', () => {
    const png = renderPng(shareSvg(data()));
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(1200);
  });
});
