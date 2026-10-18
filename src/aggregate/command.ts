import type { Command } from 'commander';
import { writeJson } from '../jsonl.js';
import { parseDate } from '../run/command.js';
import { aggregate, loadResults, minPerAgentFor } from './index.js';

export function registerAggregate(program: Command): void {
  program
    .command('aggregate')
    .description('Compute rates, coverage and intervals into results/<date>/aggregate.json')
    .requiredOption('--manifest <path>')
    .requiredOption('--date <date>')
    .action(async (o: { manifest: string; date: string }) => {
      const date = parseDate(o.date);
      const results = await loadResults(o.manifest, `results/${date}`);
      const agg = aggregate(date, results, minPerAgentFor(date));
      await writeJson(`results/${date}/aggregate.json`, agg);
      console.log(JSON.stringify(agg.groups.map((g) => ({ key: g.key, selected: g.selected, ran: g.ran })), null, 2));
    });
}
