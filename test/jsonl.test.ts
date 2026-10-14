import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendJsonl, readJson, readJsonOr, readJsonl, writeJson, writeJsonl } from '../src/jsonl.js';

describe('jsonl', () => {
  it('round-trips rows, appends, and creates parent folders', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jsonl-'));
    const path = join(dir, 'a', 'b.jsonl');
    await writeJsonl(path, [{ n: 1 }, { n: 2 }]);
    await appendJsonl(path, { n: 3 });
    expect(await readJsonl(path)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });

  it('reads a missing JSONL file as empty', async () => {
    expect(await readJsonl('/nonexistent/x.jsonl')).toEqual([]);
  });

  it('writes pretty JSON and falls back when missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'json-'));
    await writeJson(join(dir, 'x', 'v.json'), { a: 1 });
    expect(await readJson(join(dir, 'x', 'v.json'))).toEqual({ a: 1 });
    expect(await readJsonOr(join(dir, 'missing.json'), { d: true })).toEqual({ d: true });
  });
});
