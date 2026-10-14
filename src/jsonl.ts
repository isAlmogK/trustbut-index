import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const isMissing = (e: unknown) => (e as NodeJS.ErrnoException | null)?.code === 'ENOENT';

function parseLines<T>(text: string): T[] {
  return text.split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as T);
}

/** Rows of a JSONL file; a missing file reads as empty. Any other error (permissions, bad JSON) throws. */
export async function readJsonl<T>(path: string): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if (isMissing(e)) return [];
    throw e;
  }
  return parseLines<T>(text);
}

/** Rows of a JSONL file that must exist and have at least one row (a manifest, a sample). */
export async function readJsonlStrict<T>(path: string): Promise<T[]> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if (isMissing(e)) throw new Error(`${path} does not exist`);
    throw e;
  }
  const rows = parseLines<T>(text);
  if (rows.length === 0) throw new Error(`${path} has no rows`);
  return rows;
}

export async function writeJsonl(path: string, rows: readonly unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

export async function appendJsonl(path: string, row: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(row) + '\n');
}

export async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

/** A JSON file, or `fallback` when the file is missing. Any other error (permissions, bad JSON) throws. */
export async function readJsonOr<T>(path: string, fallback: T): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if (isMissing(e)) return fallback;
    throw e;
  }
  return JSON.parse(text) as T;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n');
}
