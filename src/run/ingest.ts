import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJson } from '../jsonl.js';
import { isRunRecord, looksLikeReceipt } from './status.js';

async function readParsed(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Artifacts are untrusted data: parse and check them, never execute them. */
export async function ingest(
  artifactsDir: string,
  resultsDir: string,
  validate: (receiptPath: string) => Promise<boolean>,
): Promise<{ written: number; rejected: { dir: string; reason: string }[] }> {
  const rejected: { dir: string; reason: string }[] = [];
  let written = 0;
  const dirs = (await readdir(artifactsDir)).filter((d) => d.startsWith('result-')).sort();
  for (const dir of dirs) {
    const expected = dir.slice('result-'.length);
    const run = await readParsed(join(artifactsDir, dir, 'run.json'));
    if (!isRunRecord(run)) {
      rejected.push({ dir, reason: 'run.json missing or malformed' });
      continue;
    }
    if (run.id !== expected) {
      rejected.push({ dir, reason: 'run.json id does not match artifact' });
      continue;
    }
    const receiptPath = join(artifactsDir, dir, 'receipt.json');
    const receipt = await readParsed(receiptPath);
    if (receipt !== undefined) {
      if (looksLikeReceipt(receipt) && (await validate(receiptPath))) {
        await writeJson(join(resultsDir, `${expected}.receipt.json`), receipt);
      } else {
        run.status = 'trustbut-error';
        run.stage = 'verify';
        run.note = 'receipt failed trustbut validate';
      }
    }
    await writeJson(join(resultsDir, `${expected}.run.json`), run);
    written++;
  }
  return { written, rejected };
}
