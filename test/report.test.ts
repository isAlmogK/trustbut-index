import { describe, expect, it } from 'vitest';
import { aggregate, type PrResult } from '../src/aggregate/index.js';
import { calibration, hitRate, labelStats, notProvenPrecision } from '../src/label/metrics.js';
import type { FinalLabel } from '../src/label/review.js';
import type { SampleItem } from '../src/label/sample.js';
import { describeRepo, pickExamples } from '../src/report/examples.js';
import { renderReport, renderPng, shareSvg, type ReportData } from '../src/report/html.js';
import { verdict } from '../src/verdict.js';

const results: PrResult[] = [1, 2, 3].map((n) => ({
  entry: { id: `o/r#${n}`, repo: 'o/r', pr: n, group: n < 3 ? 'agent' : 'human', agent: n < 3 ? 'copilot' : null, repoStars: 12_400, repoLanguage: 'TypeScript' } as PrResult['entry'],
  run: { status: 'ran' } as PrResult['run'],
  receipt: {
    specVersion: '1.1', producer: { name: 'trustbut', version: '0.5.0' }, subject: { base: 'b', head: 'h' }, verdict: 'warn',
    findings: [{ id: 'test-passes-without-change', severity: 'warn', title: 'Test passes without the change', file: 't.test.ts', detail: 'adds' }],
    proofs: [{ file: 't.test.ts', name: 'adds', before: 'pass', after: 'pass', verdict: 'does-not-constrain' }],
  },
}));
const sample = [{ key: 'o__r__1:0', prId: 'o/r#1', fileId: 'o__r__1', group: 'agent', agent: 'copilot', findingIndex: 0,
  finding: results[0]!.receipt!.findings[0]!, family: 'proof-gap', order: 0, blind: true } as SampleItem];
const finals = [{ key: 'o__r__1:0', label: 'real', draftLabel: 'real', blind: true } as FinalLabel];

function data(rs: PrResult[] = results): ReportData {
  const agg = aggregate('2026-11-02', rs, 1);
  const labels = labelStats(sample, finals);
  const hit = hitRate(agg.groups.find((g) => g.key === 'all-agents')!, sample, finals);
  return {
    date: '2026-11-02', agg, labels, hit, calibration: calibration(sample, finals, []), verdict: verdict(agg, labels, hit, notProvenPrecision(sample, finals)),
    examples: pickExamples(sample, finals, rs), preregUrl: 'https://github.com/isAlmogK/trustbut-index/blob/prereg-v1/PREREGISTRATION.md', deviations: [],
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
      description: 'a 12k-star TypeScript project', family: 'proof-gap', title: 'Test passes without the change', detail: null, before: 'pass', after: 'pass',
    }]);
  });
  it('shows the detail of a change-not-proven example, scrubbed, with no before/after', () => {
    const finding = { id: 'change-not-proven', severity: 'warn' as const, title: 'Nothing proves the change', detail: '1 new or changed test (copilot), none fails without the change' };
    const rs = results.map((r) => ({ ...r, receipt: { ...r.receipt!, producer: { name: 'trustbut', version: '0.7.0' }, findings: [finding] } }));
    const np = [{ ...sample[0]!, finding, family: 'proof-gap' } as SampleItem];
    const ex = pickExamples(np, finals, rs);
    expect(ex).toEqual([{
      description: 'a 12k-star TypeScript project', family: 'proof-gap', title: 'Nothing proves the change',
      detail: '1 new or changed test ([agent]), none fails without the change', before: null, after: null,
    }]);
    const html = renderReport({ ...data(), examples: ex });
    expect(html).toContain("<b>New tests don't prove the change</b> in a 12k-star TypeScript project: Nothing proves the change: 1 new or changed test ([agent]), none fails without the change.</div>");
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
    expect(html).toContain('so it would tend to shrink measured differences');
    expect(html).not.toMatch(/o\/r#1/);
    expect(html).not.toContain('<code>adds</code>');
    expect(html).toContain('pass before the change, pass after');
  });
  it('labels the hit-rate tile as an envelope and the other tiles as 95% intervals', () => {
    const tiles = html.slice(0, html.indexOf('id="proof"')).split('<div class="tile ').slice(1);
    expect(tiles).toHaveLength(4);
    expect(tiles[0]).toContain('95% interval');
    expect(tiles[1]).toContain('95% interval');
    expect(tiles[2]).toContain('95% interval');
    expect(tiles[3]).toContain('≈90% envelope');
    expect(tiles[3]).not.toContain('95% interval');
  });
  it('states that receipts were checked against each PR head commit', () => {
    expect(html).toContain("A test suite could in principle forge its own receipt, or another PR's in the same run; receipts were validated against the spec and against each PR's head commit.");
  });
  it('labels the funnel stage that still includes install timeouts honestly', () => {
    const funnel = html.slice(html.indexOf('id="coverage"'), html.indexOf('id="labels"'));
    expect(funnel).toContain('>Set up or timed out<');
    expect(funnel).not.toContain('>Set up<');
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
  it('says when the pre-registration was fixed and that the bar and families changed after the pilot', () => {
    const method = html.slice(html.indexOf('id="method"'));
    expect(method).toContain("Selection rules, metrics and thresholds were fixed before the study's first run: <a href=\"https://github.com/isAlmogK/trustbut-index/blob/prereg-v1/PREREGISTRATION.md\">pre-registration</a>.");
    expect(method).toContain('The success bar and the finding families were changed after the pilot: <a href="https://github.com/isAlmogK/trustbut-index/blob/prereg-v1/PREREGISTRATION.md#changes-after-the-pilot">changes after the pilot</a>.');
    expect(method).not.toContain('fixed before the first run');
  });
  it('names the proof families for change-not-proven', () => {
    const families = html.slice(html.indexOf('id="families"'), html.indexOf('id="coverage"'));
    expect(families).toContain("New tests don't prove the change");
    expect(families).toContain('No test proves the change');
    expect(families).not.toContain('Test passes without the change');
    expect(families).not.toContain('Change without tests');
    expect(html).toContain("<b>New tests don't prove the change</b> in a 12k-star TypeScript project: Test passes without the change. The test: pass before the change, pass after.");
  });
  it('is deterministic', () => {
    expect(renderReport(data())).toBe(html);
  });
});

describe('verdict tiles', () => {
  it('shows bars on accuracy and coverage and "reported, no bar" on precision and hit rate', () => {
    const tiles = renderReport(data()).split('<div class="tile ').slice(1);
    expect(tiles[0]).toContain('Factual accuracy');
    expect(tiles[0]).toContain('Target ≥ 95.0%');
    expect(tiles[1]).toContain('Run coverage');
    expect(tiles[1]).toContain('Target ≥ 50.0%');
    expect(tiles[2]).toContain('Precision');
    expect(tiles[2]).toContain('reported, no bar');
    expect(tiles[2].startsWith('info')).toBe(true);
    expect(tiles[3]).toContain('Hit rate');
    expect(tiles[3]).toContain('reported, no bar');
  });
  it('reports the not-proven precision under the tiles', () => {
    const np = { ...sample[0]!, finding: { ...sample[0]!.finding, id: 'change-not-proven' } } as SampleItem;
    const d = data();
    const html = renderReport({ ...d, verdict: { ...d.verdict, notProven: verdict({ groups: [{ key: 'all', coverage: d.agg.groups[0]!.coverage }] } as never, d.labels, d.hit, notProvenPrecision([np], finals)).notProven } });
    expect(html).toContain('“Nothing proves the change” worth a reviewer\'s time: 100.0% (n=1, 95% interval 20.7%–100.0%)');
  });
  it('words the verdict sentence on the two bars', () => {
    const d = data();
    expect(renderReport({ ...d, verdict: { ...d.verdict, pass: true } })).toContain('Both pre-registered thresholds were met.');
    expect(renderReport({ ...d, verdict: { ...d.verdict, pass: false } })).toContain('Not every pre-registered threshold was met.');
  });
  it('renders the share card with accuracy, coverage and precision', () => {
    const svg = shareSvg(data());
    expect(svg).toContain('Factual accuracy');
    expect(svg).toContain('Run coverage');
    expect(svg).toContain('Precision');
    expect(svg).not.toContain('Hit rate');
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

describe('empty samples', () => {
  it('shows "no data" on a verdict tile with n=0, in the page and the share card', () => {
    const d = data();
    const empty = { ...d, verdict: { ...d.verdict, accuracy: { value: 0, lo: 0, hi: 0, n: 0, target: 0.95, pass: false } } };
    const tiles = renderReport(empty).split('<div class="tile ').slice(1);
    expect(tiles[0]).toContain('no data');
    expect(tiles[0]).not.toContain('0.0%–0.0%');
    expect(tiles[1]).not.toContain('no data');
    expect(shareSvg(empty)).toContain('no data');
  });
});

describe('share card', () => {
  it('renders a 1200-wide PNG', () => {
    const png = renderPng(shareSvg(data()));
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(1200);
  });
});

describe('red at head from old receipts', () => {
  it('shows red at head as not measured, not as a rate', () => {
    const old = results.map((r) => ({ ...r, receipt: { ...r.receipt!, specVersion: '1.0', producer: { name: 'trustbut', version: '0.4.0' } } }));
    const html = renderReport(data(old));
    const section = html.slice(html.indexOf('id="families"'), html.indexOf('id="coverage"'));
    expect(section).toContain('>not measured<');
    expect(section).toContain('Tests that passed at base fail at head: not measured. Some receipts come from trustbut older than 0.5.0, which does not compare failing tests with base.');
  });
  it('shows no not-measured note when every receipt is from 0.5.0', () => {
    const section = renderReport(data()).slice(renderReport(data()).indexOf('id="families"'), renderReport(data()).indexOf('id="coverage"'));
    expect(section).not.toContain('not measured');
  });
});
