import { readFile } from 'node:fs/promises';
import type { Command } from 'commander';
import { GitHub } from '../github/client.js';
import { writeJson, writeJsonl } from '../jsonl.js';
import { collect } from './index.js';

async function excludedRepos(): Promise<Set<string>> {
  const text = await readFile('excluded-repos.txt', 'utf8').catch(() => '');
  return new Set(text.split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#')));
}

export function registerCollect(program: Command): void {
  program
    .command('collect')
    .description('Find qualifying agent PRs and matched human PRs; write manifests/<name>.jsonl')
    .option('--until <date>', 'last merge date, YYYY-MM-DD', new Date().toISOString().slice(0, 10))
    .option('--days <n>', 'window length in days', '90')
    .option('--per-agent <n>', 'max agent PRs per agent', '80')
    .option('--per-repo <n>', 'max agent PRs per repo', '3')
    .option('--seed <s>', 'selection seed', 'prereg-v1')
    .option('--pilot', 'pilot: 20 per agent, name pilot-<until>')
    .action(async (o: { until: string; days: string; perAgent: string; perRepo: string; seed: string; pilot?: boolean }) => {
      const token = process.env.GITHUB_TOKEN;
      if (!token) throw new Error('Set GITHUB_TOKEN, e.g. GITHUB_TOKEN=$(gh auth token)');
      const gh = new GitHub({ token, cacheDir: 'cache/github' });
      const until = new Date(`${o.until}T00:00:00Z`);
      const name = o.pilot ? `pilot-${o.until}` : o.until;
      const { entries, summary } = await collect(gh, {
        until, days: Number(o.days), perAgent: o.pilot ? 20 : Number(o.perAgent), perRepo: Number(o.perRepo),
        seed: o.seed, now: new Date(), excluded: await excludedRepos(), minPerAgent: o.pilot ? 0 : 30, log: console.error,
      });
      await writeJsonl(`manifests/${name}.jsonl`, entries);
      await writeJson(`manifests/${name}.summary.json`, summary);
      console.log(JSON.stringify(summary, null, 2));
    });
}
