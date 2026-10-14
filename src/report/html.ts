import { FAMILIES } from '../aggregate/families.js';
import type { Aggregate } from '../aggregate/index.js';
import type { Calibration, HitRate, LabelStats } from '../label/metrics.js';
import { AGENT_IDS } from '../types.js';
import type { Check, Verdict } from '../verdict.js';
import type { Example } from './examples.js';
import { CSS_PALETTE, LIGHT_PALETTE, ciBars, dotPlot, esc, funnel, pct, stackedBars, type Palette } from './svg.js';

export { renderPng } from './share.js';

export interface ReportData {
  date: string;
  agg: Aggregate;
  verdict: Verdict;
  labels: LabelStats[];
  calibration: Calibration;
  hit: HitRate;
  examples: Example[];
  preregUrl: string;
  deviations: string[];
  /** Where site/ is published, e.g. https://isalmogk.github.io/trustbut-index/ (social cards need absolute URLs). */
  baseUrl: string;
}

const FAMILY_NAMES: Record<string, string> = {
  'proof-gap': 'Test passes without the change',
  'test-weakening': 'Tests weakened',
  escapes: 'Checks silenced',
  'untested-change': 'Change without tests',
  'red-at-head': 'Tests red at head',
};

const group = (d: ReportData, key: string) => d.agg.groups.find((g) => g.key === key)!;

function tile(name: string, c: Check, unit: string, interval: string): string {
  return `<div class="tile ${c.pass ? 'pass' : 'miss'}"><div class="tname">${esc(name)}</div><div class="tval">${pct(c.value)}</div>
<div class="tci">${esc(interval)} ${pct(c.lo)}–${pct(c.hi)}</div><div class="ttarget">Target ≥ ${pct(c.target)} ${esc(unit)} · <b>${c.pass ? 'met' : 'missed'}</b></div></div>`;
}

function proofChart(d: ReportData, pal: Palette): string {
  return ciBars([
    { label: 'Agent PRs', value: group(d, 'all-agents').proofs.proofRate, color: pal.agent },
    { label: 'Human PRs', value: group(d, 'human').proofs.proofRate, color: pal.human },
  ], pal, { title: 'Share of new or changed tests that fail before the change and pass after it' });
}

function familyChart(d: ReportData): string {
  const keys = [...AGENT_IDS, 'all-agents', 'human'];
  const rows = keys.map((k) => ({ label: k === 'all-agents' ? 'all agents' : k === 'human' ? 'humans' : k, dimmed: group(d, k).insufficient }));
  const cells = keys.map((k) => FAMILIES.map((f) => (group(d, k).ran > 0 ? group(d, k).families[f] : null)));
  return dotPlot(rows, FAMILIES.map((f) => FAMILY_NAMES[f]!), cells, CSS_PALETTE, (i) => (keys[i] === 'human' ? CSS_PALETTE.human : CSS_PALETTE.agent));
}

function coverageChart(d: ReportData): string {
  const all = group(d, 'all');
  const s = all.byStatus;
  return funnel([
    { label: 'Selected', count: all.selected },
    { label: 'Results returned', count: all.selected - (s.missing ?? 0) },
    { label: 'Set up', count: all.selected - (s.missing ?? 0) - (s['setup-failed'] ?? 0) - (s['no-runner'] ?? 0) },
    { label: 'Ran', count: s.ran ?? 0 },
  ], CSS_PALETTE);
}

function precisionLine(name: string, s: LabelStats): string {
  const p = s.precision;
  return p.n === 0 ? `${name}: precision no data (n=0).` : `${name}: precision ${pct(p.p)} (n=${p.n}, 95% interval ${pct(p.lo)}–${pct(p.hi)}).`;
}

function labelDetail(d: ReportData): string {
  const stat = (g: 'agent' | 'human' | 'all') => d.labels.find((l) => l.family === 'all' && l.group === g)!;
  const unclear = stat('all').unclear;
  return `<p>${esc(precisionLine('Agent findings', stat('agent')))} ${esc(precisionLine('Human findings', stat('human')))} ${unclear} finding${unclear === 1 ? '' : 's'} labeled unclear, excluded from precision.</p>`;
}

function labelChart(d: ReportData): string {
  const rows = FAMILIES.map((f) => d.labels.find((l) => l.family === f && l.group === 'all')!).filter((l) => l.real + l.benign + l.false > 0);
  return stackedBars(rows.map((l) => ({
    label: FAMILY_NAMES[l.family]!,
    parts: [
      { name: 'real', value: l.real, color: CSS_PALETTE.real },
      { name: 'true but benign', value: l.benign, color: CSS_PALETTE.benign },
      { name: 'false', value: l.false, color: CSS_PALETTE.false },
    ],
  })), CSS_PALETTE);
}

const STYLE = `
:root{--bg:#fff;--fg:#1a1a1a;--muted:#6b6b6b;--grid:#e4e4e4;--agent:#2457d6;--human:#b5651d;--real:#2e7d32;--benign:#9e9e9e;--false:#c62828;--pass:#2e7d32;--miss:#c62828;--card:#f7f7f7}
@media (prefers-color-scheme: dark){:root{--bg:#121212;--fg:#ececec;--muted:#a3a3a3;--grid:#2c2c2c;--agent:#7ea2ff;--human:#e0a060;--real:#66bb6a;--benign:#8a8a8a;--false:#ef5350;--pass:#66bb6a;--miss:#ef5350;--card:#1c1c1c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,sans-serif}
main{max-width:980px;margin:0 auto;padding:24px 16px 64px}h1{font-size:28px;line-height:1.2}h2{margin-top:48px}
.muted{color:var(--muted)}a{color:var(--agent)}.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}
.tile{background:var(--card);border-radius:10px;padding:16px;border-left:6px solid var(--miss)}.tile.pass{border-left-color:var(--pass)}
.tname{font-weight:600}.tval{font-size:40px;font-weight:700}.tci,.ttarget{color:var(--muted);font-size:14px}
.ex{background:var(--card);border-radius:10px;padding:12px 16px;margin:8px 0}figure{margin:0}svg{max-width:100%;height:auto}figure{overflow-x:auto}figure svg{min-width:560px}
.legend span{display:inline-block;margin-right:16px}.legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px}`;

export function renderReport(d: ReportData): string {
  const agents = group(d, 'all-agents');
  const human = group(d, 'human');
  const pg = d.agg.comparisons.find((c) => c.metric === 'proof-rate')!;
  const examples = d.examples.length
    ? d.examples.map((e) => `<div class="ex"><b>${esc(FAMILY_NAMES[e.family]!)}</b> in ${esc(e.description)}: ${esc(e.title)}${e.before !== null && e.after !== null ? `. The test: ${esc(e.before)} before the change, ${esc(e.after)} after.` : '.'}</div>`).join('')
    : '<p class="muted">No confirmed-real examples.</p>';
  const page = `${d.baseUrl.endsWith('/') ? d.baseUrl : `${d.baseUrl}/`}${d.date}/`;
  const title = `Agent test honesty ${d.date}`;
  const description = 'trustbut receipts on real agent and human pull requests, scored against pre-registered thresholds.';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(page)}">
<meta property="og:image" content="${esc(`${page}share.png`)}">
<meta name="twitter:card" content="summary_large_image"><style>${STYLE}</style></head><body><main>
<h1>Do AI agents' tests prove their changes?</h1>
<p class="muted">Study of ${d.agg.groups.find((g) => g.key === 'all')!.selected} merged pull requests in established open-source projects, ${esc(d.date)}. trustbut ${esc(d.agg.trustbutVersions.join(', '))}.</p>

<section id="verdict"><h2>Verdict</h2><p>${d.verdict.pass ? 'All three pre-registered thresholds were met.' : 'Not every pre-registered threshold was met.'}</p>
<div class="tiles">${tile('Precision', d.verdict.precision, 'of labeled findings real', '95% interval')}${tile('Hit rate', d.verdict.hitRate, 'of agent PRs with a real finding', '≈90% envelope')}${tile('Run coverage', d.verdict.coverage, 'of selected PRs ran', '95% interval')}</div></section>

<section id="proof"><h2>Do new tests prove the change?</h2>
<p>Of the new or changed tests in agent PRs, ${pct(agents.proofs.proofRate.p)} failed before the change and passed after it, compared with ${pct(human.proofs.proofRate.p)} in human PRs from the same projects (difference ${pct(pg.diff.d)}, 95% interval ${pct(pg.diff.lo)} to ${pct(pg.diff.hi)}).</p>
<figure>${proofChart(d, CSS_PALETTE)}</figure></section>

<section id="families"><h2>Findings by family</h2><p>Share of PRs that ran with at least one finding of each kind. Dots are estimates, lines are 95% intervals. Faded rows have fewer than 30 PRs.</p>
<figure>${familyChart(d)}</figure></section>

<section id="coverage"><h2>Can trustbut run on real projects?</h2><figure>${coverageChart(d)}</figure></section>

<section id="labels"><h2>Are the findings right?</h2><p>A random sample of findings was labeled by hand from blinded evidence, with Claude drafting a label and the author confirming each one. On the first ${d.calibration.blind.n} items, labeled without seeing drafts, the draft matched the author's label ${pct(d.calibration.blind.p)} of the time. Afterwards the author changed ${pct(d.calibration.overruled.p)} of the drafts.</p>
${labelDetail(d)}
<p class="legend"><span><i style="background:var(--real)"></i>real</span><span><i style="background:var(--benign)"></i>true but benign</span><span><i style="background:var(--false)"></i>false</span></p>
<figure>${labelChart(d)}</figure></section>

<section id="examples"><h2>Examples</h2>${examples}</section>

<section id="method"><h2>Method and limitations</h2>
<p>Selection rules, metrics and thresholds were fixed before the first run: <a href="${esc(d.preregUrl)}">pre-registration</a>.</p>
${d.deviations.length ? `<p>Deviations:</p><ul>${d.deviations.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<p>No deviations from the pre-registration.</p>'}
<ul><li>Agents are identified by public markers (bot accounts, branch prefixes, PR text, commit trailers). Undisclosed agent use in the human group makes the groups look more alike, so it can only shrink measured differences.</li>
<li>A test suite could in principle forge its own receipt, or another PR's in the same run; receipts were validated against the spec and against each PR's head commit. Labeled findings were checked against the real diff.</li>
<li>The hit-rate interval multiplies the bounds of two independent 95% intervals. It is an envelope with roughly 90% joint coverage, not a 95% interval.</li>
<li>Intervals treat tests (proof rate) and findings (precision) as independent; tests and findings from the same PR are correlated, so the true uncertainty is somewhat wider.</li>
<li>Evidence shown to labelers was blinded (agent names, bots, branches, trailers and vendor or model names removed, replaced by [agent]/[link] placeholders). Some structural tells may remain, such as a title prefix like [WIP] or an agent's habitual PR section layout.</li>
<li>Conflict of interest: the study is run by trustbut's author. The pre-registration and the public data exist so anyone can check it.</li></ul></section>
</main></body></html>
`;
}

/** 1200×630 share card in the light palette (PNG rendering can't resolve CSS variables). */
export function shareSvg(d: ReportData): string {
  const pal = LIGHT_PALETTE;
  const t = (x: number, label: string, c: Check) =>
    `<g transform="translate(${x},150)"><rect width="360" height="170" rx="14" fill="#f4f4f4"/><rect width="8" height="170" fill="${c.pass ? pal.pass : pal.miss}"/>
<text x="28" y="44" font-size="26" font-weight="600">${esc(label)}</text><text x="28" y="112" font-size="60" font-weight="700">${pct(c.value)}</text>
<text x="28" y="150" font-size="20" fill="${pal.muted}">target ≥ ${pct(c.target)} · ${c.pass ? 'met' : 'missed'}</text></g>`;
  const chart = proofChart(d, pal).replace(' width="100%"', '').replace('font-family="system-ui, sans-serif"', 'font-family="DejaVu Sans, Arial, sans-serif"').replace('<svg ', '<svg x="120" y="350" width="960" height="230" ');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630" font-family="DejaVu Sans, Arial, sans-serif" fill="${pal.fg}">
<rect width="1200" height="630" fill="${pal.bg}"/><text x="40" y="80" font-size="40" font-weight="700">Do AI agents' tests prove their changes?</text>
<text x="40" y="118" font-size="22" fill="${pal.muted}">trustbut-index · ${esc(d.date)}</text>
${t(40, 'Precision', d.verdict.precision)}${t(420, 'Hit rate', d.verdict.hitRate)}${t(800, 'Run coverage', d.verdict.coverage)}${chart}</svg>`;
}
