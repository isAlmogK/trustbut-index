import type { Command } from 'commander';
import { execa } from 'execa';
import { readJsonlStrict } from '../jsonl.js';
import type { ManifestEntry } from '../types.js';
import { ingest } from './ingest.js';
import { install, jobEnv, prepare, record, verify } from './job.js';
import { batchMatrix } from './matrix.js';

export function parseBatch(s: string): number {
  if (!/^\d+$/.test(s)) throw new Error(`invalid batch "${s}": expected digits only`);
  return Number(s);
}

export function parseDate(s: string): string {
  if (!/^(pilot-)?\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`invalid date "${s}": expected YYYY-MM-DD or pilot-YYYY-MM-DD`);
  return s;
}

export function registerRun(program: Command): void {
  program
    .command('matrix')
    .description('Print the Actions matrix for one batch of a manifest')
    .requiredOption('--manifest <path>')
    .option('--batch <n>', 'batch index', '0')
    .action(async (o: { manifest: string; batch: string }) => {
      const entries = await readJsonlStrict<ManifestEntry>(o.manifest);
      process.stdout.write(JSON.stringify(batchMatrix(entries, parseBatch(o.batch))));
    });

  program
    .command('job')
    .description('One step of a per-PR job; reads the manifest entry from $ENTRY')
    .argument('<step>', 'prepare | install | verify | record')
    .action(async (step: string) => {
      const entry = JSON.parse(process.env.ENTRY ?? 'null') as ManifestEntry | null;
      if (!entry) throw new Error('ENTRY is not set');
      const env = jobEnv();
      if (step === 'prepare') await prepare(entry, env);
      else if (step === 'install') await install(env);
      else if (step === 'verify') await verify(entry, env);
      else if (step === 'record') console.log(JSON.stringify(await record(entry, env)));
      else throw new Error(`unknown step ${step}`);
    });

  program
    .command('ingest')
    .description('Validate downloaded run artifacts and write results/<date>/')
    .requiredOption('--artifacts <dir>')
    .requiredOption('--date <date>')
    .requiredOption('--manifest <path>', 'the manifest the run used; artifacts and receipts are checked against it')
    .action(async (o: { artifacts: string; date: string; manifest: string }) => {
      const env = jobEnv();
      const manifest = await readJsonlStrict<ManifestEntry>(o.manifest);
      const res = await ingest(o.artifacts, `results/${parseDate(o.date)}`, manifest, async (p) =>
        (await execa(env.node22, [env.tbCli, 'validate', p], { reject: false })).exitCode === 0,
      );
      console.log(JSON.stringify(res, null, 2));
    });
}
