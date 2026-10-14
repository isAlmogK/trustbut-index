import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { GitHub, apiCacheDir } from '../github/client.js';
import { readJsonlStrict, writeJson, writeJsonl } from '../jsonl.js';
import { collect } from './index.js';

async function excludedRepos(): Promise<Set<string>> {
  const text = await readFile('excluded-repos.txt', 'utf8').catch(() => '');
  return new Set(text.split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#')));
}

/** Commander parser for --days, --per-agent and --per-repo: a positive integer, digits only. */
export function parsePositiveInt(flag: string): (value: string) => number {
  return (value) => {
    if (!/^[1-9]\d*$/.test(value)) throw new Error(`${flag} must be a positive integer, got "${value}"`);
    return Number(value);
  };
}

/** Commander parser for --until: a real calendar date, YYYY-MM-DD. */
export function parseYmd(value: string): string {
  const t = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : Number.NaN;
  const ok = Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === value;
  if (!ok) throw new Error(`--until must be a date in YYYY-MM-DD form, got "${value}"`);
  return value;
}

/** Commander collector: --exclude-manifest may repeat and may hold comma-separated paths. */
export function addPaths(value: string, previous: string[]): string[] {
  return [...previous, ...value.split(',').map((p) => p.trim()).filter(Boolean)];
}

/** The PR ids in the excluded manifests. A missing or empty manifest is an error. */
export async function excludedPrIds(paths: string[]): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const p of paths) for (const e of await readJsonlStrict<{ id: string }>(p)) ids.add(e.id);
  return ids;
}

export function registerCollect(program: Command): void {
  program
    .command('collect')
    .description('Find qualifying agent PRs and matched human PRs; write manifests/<name>.jsonl')
    .option('--until <date>', 'last merge date, YYYY-MM-DD', parseYmd, new Date().toISOString().slice(0, 10))
    .option('--days <n>', 'window length in days', parsePositiveInt('--days'), 90)
    .option('--per-agent <n>', 'max agent PRs per agent', parsePositiveInt('--per-agent'), 80)
    .option('--per-repo <n>', 'max agent PRs per repo', parsePositiveInt('--per-repo'), 3)
    .option('--seed <s>', 'selection seed', 'prereg-v1')
    .option('--pilot', 'pilot: 20 per agent, name pilot-<until>')
    .option('--exclude-manifest <path>', 'skip the PRs in this manifest (repeatable or comma-separated), e.g. the pilot', addPaths, [] as string[])
    .action(async (o: { until: string; days: number; perAgent: number; perRepo: number; seed: string; pilot?: boolean; excludeManifest: string[] }) => {
      const token = process.env.GITHUB_TOKEN;
      if (!token) throw new Error('Set GITHUB_TOKEN, e.g. GITHUB_TOKEN=$(gh auth token)');
      const gh = new GitHub({ token, cacheDir: apiCacheDir(o.until) });
      const until = new Date(`${o.until}T00:00:00Z`);
      const name = o.pilot ? `pilot-${o.until}` : o.until;
      const { entries, summary } = await collect(gh, {
        until, days: o.days, perAgent: o.pilot ? 20 : o.perAgent, perRepo: o.perRepo,
        seed: o.seed, now: new Date(), excluded: await excludedRepos(), excludedPrs: await excludedPrIds(o.excludeManifest),
        minPerAgent: o.pilot ? 0 : 30, log: console.error,
      });
      await writeJsonl(`manifests/${name}.jsonl`, entries);
      await writeJson(`manifests/${name}.summary.json`, summary);
      console.log(JSON.stringify(summary, null, 2));
    });
}
