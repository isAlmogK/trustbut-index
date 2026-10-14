import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJson } from '../jsonl.js';
import { byCodeUnit } from '../rng.js';
import { fileId, type ManifestEntry, type Receipt, type Recipe, type RunRecord } from '../types.js';
import { isRunRecord, looksLikeReceipt } from './status.js';

async function readParsed(path: string): Promise<{ exists: boolean; value?: unknown }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { exists: false };
  }
  try {
    return { exists: true, value: JSON.parse(text) };
  } catch {
    return { exists: true };
  }
}

function pickRecipe(r: Recipe | null): Recipe | null {
  if (!r) return null;
  return {
    node: r.node ? { version: r.node.version, pm: r.node.pm, install: r.node.install } : null,
    python: r.python ? { version: r.python.version, install: [...r.python.install] } : null,
  };
}

/** Rebuilds the record from known fields only, at every level. */
function pick(r: RunRecord): RunRecord {
  const out: RunRecord = {
    id: r.id, status: r.status, stage: r.stage, recipe: pickRecipe(r.recipe),
    durations: { installMs: r.durations.installMs, verifyMs: r.durations.verifyMs },
    exitCodes: { install: r.exitCodes.install, verify: r.exitCodes.verify },
    runnerImage: r.runnerImage, trustbutVersion: r.trustbutVersion,
  };
  if (r.note !== undefined) out.note = r.note;
  return out;
}

/** Artifacts are untrusted data: parse and check them, never execute them. */
export async function ingest(
  artifactsDir: string,
  resultsDir: string,
  manifest: ManifestEntry[],
  validate: (receiptPath: string) => Promise<boolean>,
): Promise<{ written: number; rejected: { dir: string; reason: string }[] }> {
  const entries = new Map(manifest.map((e) => [fileId(e), e]));
  const rejected: { dir: string; reason: string }[] = [];
  let written = 0;
  let dirs: string[];
  try {
    dirs = (await readdir(artifactsDir)).filter((d) => d.startsWith('result-')).sort(byCodeUnit);
  } catch {
    return { written: 0, rejected: [] };
  }
  for (const dir of dirs) {
    const expected = dir.slice('result-'.length);
    const entry = entries.get(expected);
    if (!entry) {
      rejected.push({ dir, reason: 'artifact is not in the manifest' });
      continue;
    }
    const parsed = await readParsed(join(artifactsDir, dir, 'run.json'));
    const run = parsed.value;
    if (!isRunRecord(run)) {
      rejected.push({ dir, reason: 'run.json missing or malformed' });
      continue;
    }
    if (run.id !== expected) {
      rejected.push({ dir, reason: 'run.json id does not match artifact' });
      continue;
    }
    const record = pick(run);
    const receiptPath = join(artifactsDir, dir, 'receipt.json');
    const receipt = await readParsed(receiptPath);
    let accepted = false;
    if (receipt.exists) {
      if (!looksLikeReceipt(receipt.value) || !(await validate(receiptPath))) {
        record.status = 'trustbut-error';
        record.stage = 'verify';
        record.note = 'receipt failed trustbut validate';
      } else if ((receipt.value as Receipt).subject?.head !== entry.headSha) {
        // A valid receipt for some other commit, e.g. one a test suite forged or copied from another PR.
        record.status = 'trustbut-error';
        record.stage = 'verify';
        record.note = 'receipt subject does not match manifest';
      } else {
        await writeJson(join(resultsDir, `${expected}.receipt.json`), receipt.value);
        accepted = true;
      }
    }
    if (record.status === 'ran' && !accepted) {
      record.status = 'trustbut-error';
      record.stage = 'verify';
      record.note = 'ran without a valid receipt';
    }
    await writeJson(join(resultsDir, `${expected}.run.json`), record);
    written++;
  }
  return { written, rejected };
}
