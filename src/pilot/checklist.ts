import { groupStats, type PrResult } from '../aggregate/index.js';
import { byCodeUnit } from '../rng.js';
import { pct } from '../report/svg.js';
import { AGENT_IDS } from '../types.js';

const STATUSES = ['setup-failed', 'no-runner', 'timeout', 'trustbut-error', 'missing'] as const;
const statusOf = (r: PrResult) => r.run?.status ?? 'missing';
const cell = (s: string) => s.replace(/\|/g, '\\|');

function counts(rs: PrResult[]): Record<string, number> {
  const c: Record<string, number> = { ran: 0, 'setup-failed': 0, 'no-runner': 0, timeout: 0, 'trustbut-error': 0, missing: 0 };
  for (const r of rs) {
    const s = statusOf(r);
    if (Object.hasOwn(c, s)) c[s]! += 1;
  }
  return c;
}

function redAtHeadLine(results: PrResult[]): string {
  const g = groupStats('all', results, false);
  const head = 'Red at head (tests that passed at base fail at head):';
  if (g.notMeasured.includes('red-at-head')) return `${head} not measured. Receipts from trustbut older than 0.5.0 do not compare failing tests with base.`;
  if (g.ran === 0) return `${head} no data.`;
  const r = g.families['red-at-head'];
  const nc = g.redAtHeadNotCompared;
  return `${head} ${r.k} of ${r.n} PRs that ran (${pct(r.p)}). ${nc.k} of ${nc.n} had a failing test with no base result, so the rate is a lower bound.`;
}

/** The hand-check sheet for a pilot: one checkbox row per agent PR, statuses only for the human control. Deterministic. */
export function pilotChecklist(results: PrResult[], date: string): string {
  const total = counts(results);
  const out: string[] = [
    `# Pilot check: ${date}`,
    '',
    `Run coverage: ${total.ran} of ${results.length} PRs ran (${pct(results.length ? total.ran! / results.length : 0)}). ${STATUSES.map((s) => `${s} ${total[s]}`).join(' · ')}`,
    '',
    redAtHeadLine(results),
    '',
    'How to use: open each PR. Tick the box if the PR page confirms that agent wrote it (bot author, branch, PR text or commit trailer). Then record "confirmed/total" per agent in the "Pilot check" column of PREREGISTRATION.md.',
    '',
  ];
  for (const agent of AGENT_IDS) {
    const rows = results.filter((r) => r.entry.agent === agent).sort((a, b) => byCodeUnit(a.entry.id, b.entry.id));
    if (rows.length === 0) continue;
    out.push(`## ${agent} (${rows.length} PRs)`, '', '| Confirmed | PR | Marker evidence | Run status |', '|---|---|---|---|');
    for (const r of rows) {
      const e = r.entry;
      out.push(`| [ ] | [${cell(e.id)}](https://github.com/${e.repo}/pull/${e.pr}) | ${cell(e.attribution.evidence.join(', '))} | ${statusOf(r)} |`);
    }
    out.push('');
  }
  const human = results.filter((r) => r.entry.group === 'human');
  if (human.length > 0) {
    const c = counts(human);
    out.push(`## Human control (${human.length} PRs)`, '', `Run statuses only. These are not checked by hand. ran ${c.ran} · ${STATUSES.map((s) => `${s} ${c[s]}`).join(' · ')}`, '');
  }
  return out.join('\n');
}
