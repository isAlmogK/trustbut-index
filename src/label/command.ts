import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import type { Command } from 'commander';
import { aggregate, loadResults } from '../aggregate/index.js';
import { GitHub, apiCacheDir } from '../github/client.js';
import { readJson, readJsonlStrict, writeJson, writeJsonl } from '../jsonl.js';
import { fileId } from '../types.js';
import { collectBatch, submitBatch } from './draft.js';
import { buildPacket, type Packet } from './packet.js';
import { packetFile, startReview } from './review.js';
import { sampleFindings, type SampleItem } from './sample.js';

export const PROMPT_PATH = 'labels/prompt-v2.md';
const dirOf = (date: string) => `labels/${date}`;

export function registerLabel(program: Command): void {
  const label = program.command('label').description('Labeling: sample, packets, draft, review');

  label
    .command('sample')
    .requiredOption('--manifest <path>')
    .requiredOption('--date <date>')
    .option('--seed <s>', 'sampling seed', 'prereg-v1')
    .action(async (o: { manifest: string; date: string; seed: string }) => {
      const results = await loadResults(o.manifest, `results/${o.date}`);
      const insufficient = new Set(aggregate(o.date, results).groups.filter((g) => g.insufficient).map((g) => g.key));
      const sample = sampleFindings(results, { seed: o.seed, insufficient });
      await writeJsonl(join(dirOf(o.date), 'sample.jsonl'), sample);
      console.log(`${sample.length} findings sampled`);
    });

  label
    .command('packets')
    .requiredOption('--manifest <path>')
    .requiredOption('--date <date>')
    .action(async (o: { manifest: string; date: string }) => {
      const token = process.env.GITHUB_TOKEN;
      if (!token) throw new Error('Set GITHUB_TOKEN, e.g. GITHUB_TOKEN=$(gh auth token)');
      const gh = new GitHub({ token, cacheDir: apiCacheDir(o.date) });
      const results = new Map((await loadResults(o.manifest, `results/${o.date}`)).map((r) => [fileId(r.entry), r]));
      for (const item of await readJsonlStrict<SampleItem>(join(dirOf(o.date), 'sample.jsonl'))) {
        const r = results.get(item.fileId)!;
        await writeJson(join(dirOf(o.date), 'packets', packetFile(item.key)), await buildPacket(gh, item, r.entry, r.receipt!));
      }
    });

  const draft = label.command('draft').description('Draft labels with the Claude Batches API');
  draft
    .command('submit')
    .requiredOption('--date <date>')
    .action(async (o: { date: string }) => {
      const sample = await readJsonlStrict<SampleItem>(join(dirOf(o.date), 'sample.jsonl'));
      const packets = await Promise.all(sample.map((s) => readJson<Packet>(join(dirOf(o.date), 'packets', packetFile(s.key)))));
      const prompt = await readFile(PROMPT_PATH, 'utf8');
      const res = await submitBatch(new Anthropic(), packets, prompt);
      await writeJson(join(dirOf(o.date), 'batch.json'), res);
      console.log(`submitted batch ${res.batchId} with ${packets.length} requests`);
    });
  draft
    .command('collect')
    .requiredOption('--date <date>')
    .action(async (o: { date: string }) => {
      const { batchId, ids } = await readJson<{ batchId: string; ids: Record<string, string> }>(join(dirOf(o.date), 'batch.json'));
      const drafts = await collectBatch(new Anthropic(), batchId, ids);
      await writeJsonl(join(dirOf(o.date), 'drafts.jsonl'), drafts);
      console.log(`${drafts.filter((d) => d.label).length}/${drafts.length} drafted`);
    });

  label
    .command('review')
    .requiredOption('--date <date>')
    .action(async (o: { date: string }) => {
      const srv = await startReview(dirOf(o.date));
      console.log(`Review at ${srv.url} (Ctrl-C to stop; progress is saved after every label)`);
    });
}
