import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { loadResults } from '../src/aggregate/index.js';
import { startReview } from '../src/label/review.js';

const TSX = resolve('node_modules/.bin/tsx');
const CLI = resolve('src/cli.ts');
const entry = { id: 'o/r#1', repo: 'o/r', pr: 1, group: 'agent', agent: 'copilot' };

/** Runs the CLI in a fresh folder, so relative paths (results/, labels/) resolve inside it. */
async function cli(args: string[], setup: Record<string, string> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'cli-'));
  for (const [f, text] of Object.entries(setup)) {
    await mkdir(join(cwd, f, '..'), { recursive: true });
    await writeFile(join(cwd, f), text);
  }
  const r = await execa(TSX, [CLI, ...args], { cwd, reject: false, env: { GITHUB_TOKEN: 'x', ANTHROPIC_API_KEY: 'x' } });
  return { exitCode: r.exitCode, stderr: String(r.stderr) };
}

describe('missing inputs are user errors', () => {
  it('loadResults throws on a missing or empty manifest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lr-'));
    await expect(loadResults(join(dir, 'nope.jsonl'), dir)).rejects.toThrow(/nope\.jsonl does not exist/);
    await writeFile(join(dir, 'empty.jsonl'), '');
    await expect(loadResults(join(dir, 'empty.jsonl'), dir)).rejects.toThrow(/empty\.jsonl has no rows/);
  });

  it('startReview throws when sample.jsonl is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rv-'));
    await expect(startReview(dir, 0)).rejects.toThrow(/sample\.jsonl does not exist/);
  });

  it('matrix, aggregate and label sample fail on a missing manifest', async () => {
    for (const args of [['matrix', '--manifest', 'm.jsonl'], ['aggregate', '--manifest', 'm.jsonl', '--date', 'd'], ['label', 'sample', '--manifest', 'm.jsonl', '--date', 'd']]) {
      const r = await cli(args);
      expect(r.exitCode, args.join(' ')).not.toBe(0);
      expect(r.stderr).toContain('m.jsonl does not exist');
    }
  });

  it('label packets fails on a missing manifest, then on a missing sample', async () => {
    expect((await cli(['label', 'packets', '--manifest', 'm.jsonl', '--date', 'd'])).stderr).toContain('m.jsonl does not exist');
    const r = await cli(['label', 'packets', '--manifest', 'm.jsonl', '--date', 'd'], { 'm.jsonl': JSON.stringify(entry) + '\n' });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('sample.jsonl does not exist');
  });

  it('label draft submit fails on a missing sample', async () => {
    const r = await cli(['label', 'draft', 'submit', '--date', 'd']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('sample.jsonl does not exist');
  });

  it('report fails on a missing sample', async () => {
    const r = await cli(['report', '--manifest', 'm.jsonl', '--date', 'd'], { 'm.jsonl': JSON.stringify(entry) + '\n', 'results/d/aggregate.json': '{}' });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toContain('sample.jsonl does not exist');
  });
});
