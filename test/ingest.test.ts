import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ingest } from '../src/run/ingest.js';

const run = (id: string) => ({ id, status: 'ran', stage: null, recipe: null, durations: { installMs: 1, verifyMs: 1 },
  exitCodes: { install: 0, verify: 0 }, runnerImage: 'x', trustbutVersion: '0.4.0' });
const receipt = { specVersion: '1.0', producer: { name: 'trustbut', version: '0.4.0' }, subject: { base: 'b', head: 'h' }, verdict: 'pass', findings: [] };

async function artifact(root: string, name: string, files: Record<string, unknown>) {
  await mkdir(join(root, name), { recursive: true });
  for (const [f, v] of Object.entries(files)) await writeFile(join(root, name, f), typeof v === 'string' ? v : JSON.stringify(v));
}

describe('ingest', () => {
  it('copies valid results, rejects mismatched ids, and downgrades receipts that fail validation', async () => {
    const arts = await mkdtemp(join(tmpdir(), 'arts-'));
    const out = await mkdtemp(join(tmpdir(), 'res-'));
    await artifact(arts, 'result-o__r__1', { 'run.json': run('o__r__1'), 'receipt.json': receipt });
    await artifact(arts, 'result-o__r__2', { 'run.json': run('o__r__9') });
    await artifact(arts, 'result-o__r__3', { 'run.json': run('o__r__3'), 'receipt.json': { ...receipt, verdict: 'bogus' } });
    const res = await ingest(arts, out, async (p) => !(await readFile(p, 'utf8')).includes('bogus'));
    expect(res.written).toBe(2);
    expect(res.rejected).toEqual([{ dir: 'result-o__r__2', reason: 'run.json id does not match artifact' }]);
    expect((await readdir(out)).sort()).toEqual(['o__r__1.receipt.json', 'o__r__1.run.json', 'o__r__3.run.json']);
    const r3 = JSON.parse(await readFile(join(out, 'o__r__3.run.json'), 'utf8'));
    expect(r3).toMatchObject({ status: 'trustbut-error', stage: 'verify', note: 'receipt failed trustbut validate' });
  });

  it('treats an unparseable receipt as a validation failure', async () => {
    const arts = await mkdtemp(join(tmpdir(), 'arts-'));
    const out = await mkdtemp(join(tmpdir(), 'res-'));
    await artifact(arts, 'result-a__b__1', { 'run.json': run('a__b__1'), 'receipt.json': '{not json' });
    await ingest(arts, out, async () => true);
    expect(JSON.parse(await readFile(join(out, 'a__b__1.run.json'), 'utf8'))).toMatchObject({ status: 'trustbut-error', stage: 'verify', note: 'receipt failed trustbut validate' });
    expect(await readdir(out)).toEqual(['a__b__1.run.json']);
  });
  it('downgrades ran without a receipt', async () => {
    const arts = await mkdtemp(join(tmpdir(), 'arts-'));
    const out = await mkdtemp(join(tmpdir(), 'res-'));
    await artifact(arts, 'result-a__b__2', { 'run.json': run('a__b__2') });
    await ingest(arts, out, async () => true);
    expect(JSON.parse(await readFile(join(out, 'a__b__2.run.json'), 'utf8'))).toMatchObject({ status: 'trustbut-error', stage: 'verify', note: 'ran without a valid receipt' });
  });
  it('writes only known RunRecord fields', async () => {
    const arts = await mkdtemp(join(tmpdir(), 'arts-'));
    const out = await mkdtemp(join(tmpdir(), 'res-'));
    await artifact(arts, 'result-a__b__3', { 'run.json': { ...run('a__b__3'), evil: 'x' }, 'receipt.json': receipt });
    await ingest(arts, out, async () => true);
    expect(Object.keys(JSON.parse(await readFile(join(out, 'a__b__3.run.json'), 'utf8'))).sort()).toEqual(
      ['durations', 'exitCodes', 'id', 'recipe', 'runnerImage', 'stage', 'status', 'trustbutVersion']);
  });
  it('returns zero when the artifacts directory does not exist', async () => {
    const out = await mkdtemp(join(tmpdir(), 'res-'));
    expect(await ingest(join(out, 'nope'), out, async () => true)).toEqual({ written: 0, rejected: [] });
  });
});
