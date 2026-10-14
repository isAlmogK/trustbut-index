import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Command } from 'commander';
import { loadResults, type Aggregate } from '../aggregate/index.js';
import { readJson, readJsonl } from '../jsonl.js';
import type { Draft } from '../label/draft.js';
import { calibration, hitRate, labelStats } from '../label/metrics.js';
import type { FinalLabel } from '../label/review.js';
import type { SampleItem } from '../label/sample.js';
import { verdict } from '../verdict.js';
import { pickExamples } from './examples.js';
import { renderPng, renderReport, shareSvg } from './html.js';

export function registerReport(program: Command): void {
  program
    .command('report')
    .description('Build site/<date>/index.html and share.png')
    .requiredOption('--manifest <path>')
    .requiredOption('--date <date>')
    .option('--prereg <url>', 'pre-registration URL', 'https://github.com/isAlmogK/trustbut-index/blob/prereg-v1/PREREGISTRATION.md')
    .action(async (o: { manifest: string; date: string; prereg: string }) => {
      const agg = await readJson<Aggregate>(`results/${o.date}/aggregate.json`);
      const dir = `labels/${o.date}`;
      const sample = await readJsonl<SampleItem>(join(dir, 'sample.jsonl'));
      const finals = await readJsonl<FinalLabel>(join(dir, 'final.jsonl'));
      const drafts = await readJsonl<Draft>(join(dir, 'drafts.jsonl'));
      const results = await loadResults(o.manifest, `results/${o.date}`);
      const labels = labelStats(sample, finals);
      const hit = hitRate(agg.groups.find((g) => g.key === 'all-agents')!, sample, finals);
      const deviations = (await readFile(`results/${o.date}/deviations.txt`, 'utf8').catch(() => '')).split('\n').map((l) => l.trim()).filter(Boolean);
      const data = {
        date: o.date, agg, labels, hit, calibration: calibration(sample, finals, drafts), verdict: verdict(agg, labels, hit),
        examples: pickExamples(sample, finals, results), preregUrl: o.prereg, deviations,
      };
      await mkdir(`site/${o.date}`, { recursive: true });
      await writeFile(`site/${o.date}/index.html`, renderReport(data));
      await writeFile(`site/${o.date}/share.png`, renderPng(shareSvg(data)));
      await writeFile('site/index.html', `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${o.date}/"><title>trustbut-index</title><a href="${o.date}/">Latest study</a>\n`);
      console.log(`wrote site/${o.date}/ (verdict: ${data.verdict.pass ? 'all thresholds met' : 'not all thresholds met'})`);
    });
}
