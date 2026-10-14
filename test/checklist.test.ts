import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PrResult } from '../src/aggregate/index.js';
import { pilotChecklist } from '../src/pilot/checklist.js';
import { fileId, type AgentId, type ManifestEntry, type RunStatus } from '../src/types.js';

function pr(repo: string, n: number, agent: AgentId | null, evidence: string[], status: RunStatus | null): PrResult {
  const entry: ManifestEntry = {
    id: `${repo}#${n}`, repo, pr: n, group: agent ? 'agent' : 'human', agent, model: 'unknown', attribution: { evidence },
    baseRef: 'main', baseSha: 'a', headSha: 'b', mergedAt: '2026-10-01T00:00:00Z', selectedAt: '2026-10-14T00:00:00Z', repoStars: 1, repoLanguage: null,
  };
  const run = status ? { id: fileId(entry), status, stage: null, recipe: null, durations: { installMs: 0, verifyMs: 0 }, exitCodes: { install: null, verify: null }, runnerImage: 'x', trustbutVersion: '0.4.0' } : null;
  return { entry, run, receipt: null };
}

const results: PrResult[] = [
  pr('o/r', 12, 'codex', ['author:chatgpt-codex-connector[bot]'], 'ran'),
  pr('o/r', 3, 'copilot', ['author:Copilot', 'branch:copilot/'], 'ran'),
  pr('a/b', 7, 'copilot', ['branch:a|b'], 'setup-failed'),
  pr('z/z', 1, 'copilot', ['author:Copilot'], null),
  pr('o/r', 40, null, [], 'ran'),
  pr('o/r', 41, null, [], 'timeout'),
];
const md = pilotChecklist(results, 'pilot-2026-10-14');

describe('pilotChecklist', () => {
  it('has a header and run coverage with status counts', () => {
    expect(md.startsWith('# Pilot check: pilot-2026-10-14\n')).toBe(true);
    expect(md).toContain('Run coverage: 3 of 6 PRs ran (50.0%). setup-failed 1 · no-runner 0 · timeout 1 · trustbut-error 0 · missing 1');
    expect(md).toContain('open each PR');
    expect(md).toContain('PREREGISTRATION.md');
  });
  it('orders agent sections by AGENT_IDS and skips agents with no PRs', () => {
    const heads = [...md.matchAll(/^## (.*)$/gm)].map((m) => m[1]);
    expect(heads).toEqual(['copilot (3 PRs)', 'codex (1 PRs)', 'Human control (2 PRs)']);
  });
  it('sorts rows by id in code-unit order', () => {
    const ids = [...md.matchAll(/^\| \[ \] \| \[([^\]]+)\]/gm)].map((m) => m[1]);
    expect(ids).toEqual(['a/b#7', 'o/r#3', 'z/z#1', 'o/r#12']);
  });
  it('links each PR and shows evidence and run status', () => {
    expect(md).toContain('| [ ] | [o/r#3](https://github.com/o/r/pull/3) | author:Copilot, branch:copilot/ | ran |');
  });
  it('escapes pipes in evidence', () => {
    expect(md).toContain('| branch:a\\|b | setup-failed |');
  });
  it('shows a PR without a run as missing', () => {
    expect(md).toContain('| [z/z#1](https://github.com/z/z/pull/1) | author:Copilot | missing |');
  });
  it('lists human PRs as statuses only, with no checkboxes or rows', () => {
    const human = md.slice(md.indexOf('## Human control'));
    expect(human).not.toContain('[ ]');
    expect(human).not.toContain('|');
    expect(human).toContain('ran 1 · setup-failed 0 · no-runner 0 · timeout 1 · trustbut-error 0 · missing 0');
  });
  it('is deterministic regardless of input order', () => {
    expect(pilotChecklist([...results].reverse(), 'pilot-2026-10-14')).toBe(md);
  });
  it('omits the human section when there are no human PRs', () => {
    expect(pilotChecklist(results.slice(0, 4), 'd')).not.toContain('Human control');
  });
});

describe('checklist command', () => {
  it('rejects a bad date before touching anything', async () => {
    const { runChecklist } = await import('../src/pilot/command.js');
    await expect(runChecklist({ manifest: 'nope.jsonl', date: '../x' })).rejects.toThrow(/date/);
  });
  it('writes results/<date>/pilot-check.md from a manifest', async () => {
    const { runChecklist } = await import('../src/pilot/command.js');
    const dir = await mkdtemp(join(tmpdir(), 'chk-'));
    const manifest = join(dir, 'm.jsonl');
    await writeFile(manifest, results.slice(0, 2).map((r) => JSON.stringify(r.entry)).join('\n') + '\n');
    const out = await runChecklist({ manifest, date: 'pilot-2026-10-14' }, dir);
    expect(out).toBe(join(dir, 'results/pilot-2026-10-14/pilot-check.md'));
    expect(await readFile(out, 'utf8')).toContain('## copilot (1 PRs)');
  });
});

describe('aggregate command', () => {
  it('validates --date with parseDate', async () => {
    const { execa } = await import('execa');
    const r = await execa('npx', ['tsx', 'src/cli.ts', 'aggregate', '--manifest', 'nope.jsonl', '--date', '../x'], { reject: false });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/invalid date/);
  });
});
