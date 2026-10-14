import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command } from 'commander';
import { loadResults } from '../aggregate/index.js';
import { parseDate } from '../run/command.js';
import { pilotChecklist } from './checklist.js';

/** Reads the manifest and results/<date>/, writes results/<date>/pilot-check.md under `root`, returns its path. */
export async function runChecklist(o: { manifest: string; date: string }, root = '.'): Promise<string> {
  const date = parseDate(o.date);
  const results = await loadResults(o.manifest, join(root, 'results', date));
  const path = join(root, 'results', date, 'pilot-check.md');
  await mkdir(join(root, 'results', date), { recursive: true });
  await writeFile(path, pilotChecklist(results, date));
  return path;
}

export function registerPilot(program: Command): void {
  program
    .command('checklist')
    .description('Write results/<date>/pilot-check.md: the by-hand marker check for a pilot')
    .requiredOption('--manifest <path>')
    .requiredOption('--date <date>')
    .action(async (o: { manifest: string; date: string }) => {
      console.log(`wrote ${await runChecklist(o)}`);
    });
}
