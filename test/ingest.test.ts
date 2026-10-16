import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ingest } from '../src/run/ingest.js';
import type { ManifestEntry } from '../src/types.js';

/** Manifest entries for file ids like "o__r__1" (repo o/r, PR 1), all with head "h". */
const manifest = (...ids: string[]): ManifestEntry[] =>
  ids.map((id) => {
    const [o, r, n] = id.split('__');
    return { id: `${o}/${r}#${n}`, repo: `${o}/${r}`, pr: Number(n), headSha: 'h' } as ManifestEntry;
  });

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
    const res = await ingest(arts, out, manifest('o__r__1', 'o__r__2', 'o__r__3'), async (p) => !(await readFile(p, 'utf8')).includes('bogus'));
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
    await ingest(arts, out, manifest('a__b__1'), async () => true);
    expect(JSON.parse(await readFile(join(out, 'a__b__1.run.json'), 'utf8'))).toMatchObject({ status: 'trustbut-error', stage: 'verify', note: 'receipt failed trustbut validate' });
    expect(await readdir(out)).toEqual(['a__b__1.run.json']);
  });
  it('downgrades ran without a receipt', async () => {
    const arts = await mkdtemp(join(tmpdir(), 'arts-'));
    const out = await mkdtemp(join(tmpdir(), 'res-'));
    await artifact(arts, 'result-a__b__2', { 'run.json': run('a__b__2') });
    await ingest(arts, out, manifest('a__b__2'), async () => true);
    expect(JSON.parse(await readFile(join(out, 'a__b__2.run.json'), 'utf8'))).toMatchObject({ status: 'trustbut-error', stage: 'verify', note: 'ran without a valid receipt' });
  });
  it('writes only known RunRecord fields', async () => {
    const arts = await mkdtemp(join(tmpdir(), 'arts-'));
    const out = await mkdtemp(join(tmpdir(), 'res-'));
    await artifact(arts, 'result-a__b__3', { 'run.json': { ...run('a__b__3'), evil: 'x' }, 'receipt.json': receipt });
    const recipe = { node: { version: '22', pm: 'npm', install: 'npm ci' }, python: null };
    await artifact(arts, 'result-a__b__4', { 'run.json': { ...run('a__b__4'), recipe, status: 'setup-failed', stage: 'install',
      exitCodes: { install: 1, verify: null }, installRetries: 2, installTail: 'boom', evil: 'x' } });
    await ingest(arts, out, manifest('a__b__3', 'a__b__4'), async () => true);
    expect(Object.keys(JSON.parse(await readFile(join(out, 'a__b__3.run.json'), 'utf8'))).sort()).toEqual(
      ['durations', 'exitCodes', 'id', 'recipe', 'runnerImage', 'stage', 'status', 'trustbutVersion']);
    expect(Object.keys(JSON.parse(await readFile(join(out, 'a__b__4.run.json'), 'utf8'))).sort()).toEqual(
      ['durations', 'exitCodes', 'id', 'installRetries', 'installTail', 'recipe', 'runnerImage', 'stage', 'status', 'trustbutVersion']);
  });
  it('copies installRetries and installTail from the artifact', async () => {
    const arts = await mkdtemp(join(tmpdir(), 'arts-'));
    const out = await mkdtemp(join(tmpdir(), 'res-'));
    const recipe = { node: { version: '22', pm: 'npm', install: 'npm ci' }, python: null };
    await artifact(arts, 'result-a__b__6', { 'run.json': { ...run('a__b__6'), status: 'setup-failed', stage: 'install', recipe,
      exitCodes: { install: 1, verify: null }, installRetries: 2, installTail: 'npm ERR! ECONNRESET' } });
    await ingest(arts, out, manifest('a__b__6'), async () => true);
    expect(JSON.parse(await readFile(join(out, 'a__b__6.run.json'), 'utf8'))).toMatchObject({ installRetries: 2, installTail: 'npm ERR! ECONNRESET' });
  });
  it('re-applies the tail limits to an oversized installTail', async () => {
    const arts = await mkdtemp(join(tmpdir(), 'arts-'));
    const out = await mkdtemp(join(tmpdir(), 'res-'));
    const long = Array.from({ length: 200 }, (_, i) => `\u001b[31mline ${i}\u001b[0m ${'x'.repeat(60)}`).join('\n');
    await artifact(arts, 'result-a__b__7', { 'run.json': { ...run('a__b__7'), status: 'setup-failed', stage: 'install', exitCodes: { install: 1, verify: null }, installTail: long } });
    await ingest(arts, out, manifest('a__b__7'), async () => true);
    const t: string = JSON.parse(await readFile(join(out, 'a__b__7.run.json'), 'utf8')).installTail;
    expect(t.length).toBeLessThanOrEqual(4000);
    expect(t.split('\n').length).toBeLessThanOrEqual(50);
    expect(t).not.toContain('\u001b');
    expect(t.endsWith(`line 199 ${'x'.repeat(60)}`)).toBe(true);
  });
  it('rejects installRetries above what the recipe allows, or not a non-negative integer', async () => {
    const arts = await mkdtemp(join(tmpdir(), 'arts-'));
    const out = await mkdtemp(join(tmpdir(), 'res-'));
    const recipe = { node: { version: '22', pm: 'npm', install: 'npm ci' }, python: { version: '3.12', install: ['pip install a', 'pip install b'] } };
    // 3 install commands, up to 3 attempts each: at most 6 re-runs.
    await artifact(arts, 'result-a__b__8', { 'run.json': { ...run('a__b__8'), recipe, installRetries: 6 }, 'receipt.json': receipt });
    await artifact(arts, 'result-a__b__9', { 'run.json': { ...run('a__b__9'), recipe, installRetries: 7 }, 'receipt.json': receipt });
    await artifact(arts, 'result-a__b__10', { 'run.json': { ...run('a__b__10'), installRetries: 1 }, 'receipt.json': receipt });
    await artifact(arts, 'result-a__b__11', { 'run.json': { ...run('a__b__11'), recipe, installRetries: 1.5 }, 'receipt.json': receipt });
    const res = await ingest(arts, out, manifest('a__b__8', 'a__b__9', 'a__b__10', 'a__b__11'), async () => true);
    expect(res.rejected).toEqual([
      { dir: 'result-a__b__10', reason: 'run.json installRetries out of range' },
      { dir: 'result-a__b__11', reason: 'run.json missing or malformed' },
      { dir: 'result-a__b__9', reason: 'run.json installRetries out of range' },
    ]);
    expect(JSON.parse(await readFile(join(out, 'a__b__8.run.json'), 'utf8')).installRetries).toBe(6);
  });
  it('rebuilds the recipe from known fields only', async () => {
    const arts = await mkdtemp(join(tmpdir(), 'arts-'));
    const out = await mkdtemp(join(tmpdir(), 'res-'));
    const recipe = { node: { version: '22', pm: 'npm', install: 'npm ci', evil: 1 }, python: { version: '3.12', install: ['uv pip install pytest'], evil: 2 }, evil: 3 };
    await artifact(arts, 'result-a__b__4', { 'run.json': { ...run('a__b__4'), recipe }, 'receipt.json': receipt });
    await ingest(arts, out, manifest('a__b__4'), async () => true);
    expect(JSON.parse(await readFile(join(out, 'a__b__4.run.json'), 'utf8')).recipe).toEqual({
      node: { version: '22', pm: 'npm', install: 'npm ci' }, python: { version: '3.12', install: ['uv pip install pytest'] },
    });
  });
  it('rejects an artifact whose id is not in the manifest', async () => {
    const arts = await mkdtemp(join(tmpdir(), 'arts-'));
    const out = await mkdtemp(join(tmpdir(), 'res-'));
    await artifact(arts, 'result-x__y__1', { 'run.json': run('x__y__1'), 'receipt.json': receipt });
    const res = await ingest(arts, out, manifest('a__b__1'), async () => true);
    expect(res).toEqual({ written: 0, rejected: [{ dir: 'result-x__y__1', reason: 'artifact is not in the manifest' }] });
    expect(await readdir(out)).toEqual([]);
  });
  it('downgrades a receipt whose subject head is not the manifest head commit', async () => {
    const arts = await mkdtemp(join(tmpdir(), 'arts-'));
    const out = await mkdtemp(join(tmpdir(), 'res-'));
    await artifact(arts, 'result-a__b__5', { 'run.json': run('a__b__5'), 'receipt.json': { ...receipt, subject: { base: 'b', head: 'other' } } });
    await ingest(arts, out, manifest('a__b__5'), async () => true);
    expect(await readdir(out)).toEqual(['a__b__5.run.json']);
    expect(JSON.parse(await readFile(join(out, 'a__b__5.run.json'), 'utf8'))).toMatchObject({
      status: 'trustbut-error', stage: 'verify', note: 'receipt subject does not match manifest',
    });
  });
  it('returns zero when the artifacts directory does not exist', async () => {
    const out = await mkdtemp(join(tmpdir(), 'res-'));
    expect(await ingest(join(out, 'nope'), out, manifest('a__b__1'), async () => true)).toEqual({ written: 0, rejected: [] });
  });
});
