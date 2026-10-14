import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { appendJsonl, readJson, readJsonOr, readJsonl, readJsonlStrict, writeJson, writeJsonl } from '../src/jsonl.js';

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

  it('falls back only when the file is missing; other errors throw', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'strict-'));
    await writeFile(join(dir, 'bad.jsonl'), '{"n":1}\n{not json\n');
    await writeFile(join(dir, 'bad.json'), '{not json');
    await expect(readJsonl(join(dir, 'bad.jsonl'))).rejects.toThrow(SyntaxError);
    await expect(readJsonOr(join(dir, 'bad.json'), null)).rejects.toThrow(SyntaxError);
    // Reading a directory fails with EISDIR, not ENOENT.
    await expect(readJsonl(dir)).rejects.toMatchObject({ code: 'EISDIR' });
    await expect(readJsonOr(dir, null)).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('readJsonlStrict throws on a missing or empty file and reads rows otherwise', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'strict-'));
    await expect(readJsonlStrict(join(dir, 'missing.jsonl'))).rejects.toThrow(/missing\.jsonl/);
    await writeFile(join(dir, 'empty.jsonl'), '\n');
    await expect(readJsonlStrict(join(dir, 'empty.jsonl'))).rejects.toThrow(/no rows/);
    await writeJsonl(join(dir, 'ok.jsonl'), [{ n: 1 }]);
    expect(await readJsonlStrict(join(dir, 'ok.jsonl'))).toEqual([{ n: 1 }]);
  });
});
