import { isTestPath } from '../collect/qualify.js';
import { readRepoFile, type GitHubApi } from '../github/client.js';
import type { Family, Finding, ManifestEntry, Proof, Receipt, TestCase } from '../types.js';
import { scrub } from './blind.js';
import type { SampleItem } from './sample.js';

export interface Packet {
  key: string;
  finding: Finding;
  family: Family;
  proofs: Proof[];
  pr: { title: string; body: string };
  diff: { file: string; patch: string }[];
  testSource: { file: string; startLine: number; text: string } | null;
  /** For `test-regressed`: the failing head case and its base outcome ('missing' when the base run has no such case). */
  regression: { name: string; before: string; after: string; message?: string } | null;
  baseRun: string;
}

const MAX_BODY = 2000;
const MAX_PATCH = 4000;
const MAX_FILES = 6;
/** `change-not-proven` has no file; its evidence is every proof and every changed source and test file. */
const MAX_FILES_NOT_PROVEN = 10;
const CODE = /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts|vue|svelte|py)$/;
const WINDOW = 40;
const HEAD_LINES = 120;

function sourceWindow(text: string, line: number | undefined): { startLine: number; text: string } {
  const lines = text.split('\n');
  if (!line) return { startLine: 1, text: lines.slice(0, HEAD_LINES).join('\n') };
  const start = Math.max(1, line - WINDOW);
  return { startLine: start, text: lines.slice(start - 1, line + WINDOW).join('\n') };
}

/** Up to `cap` items, half from each list, filling from the other when one runs short. */
function balanced<T>(a: T[], b: T[], cap: number): T[] {
  const na = Math.min(a.length, Math.max(Math.ceil(cap / 2), cap - b.length));
  return [...a.slice(0, na), ...b.slice(0, cap - na)];
}

const isFailing = (c: TestCase) => c.outcome === 'fail' || c.outcome === 'error';

/** The runner reports case files relative to the package root, or absolute; the finding's file is from the repo root. */
function sameFile(caseFile: string, findingFile: string | undefined): boolean {
  if (findingFile === undefined) return true;
  const c = caseFile.replace(/^\.\//, '');
  return c === findingFile || findingFile.endsWith(`/${c}`) || c.endsWith(`/${findingFile}`);
}

/** The head case behind a `test-regressed` finding (matched by name and file), and its base outcome by case id. Raw values. */
function regressedCase(f: Finding, receipt: Receipt): { name: string; before: string; after: string; message?: string } | null {
  if (f.id !== 'test-regressed' || !f.detail) return null;
  const x = receipt['x-trustbut'];
  const head = (x?.after?.cases ?? []).filter((c) => c && c.name === f.detail && typeof c.file === 'string' && sameFile(c.file, f.file));
  const c = head.find(isFailing) ?? head[0];
  if (!c) return null;
  const base = (x?.before?.cases ?? []).find((b) => b && b.id === c.id);
  return { name: c.name, before: base ? String(base.outcome) : 'missing', after: String(c.outcome), ...(typeof c.message === 'string' && c.message ? { message: c.message } : {}) };
}

export function assemblePacket(
  item: SampleItem,
  receipt: Receipt,
  pr: { title: string; body: string | null },
  files: { filename: string; patch?: string }[],
  source: string | null,
): Packet {
  const f = item.finding;
  const notProven = f.id === 'change-not-proven';
  // Filter on raw values; scrubbing happens only after the match.
  const proofs = (receipt.proofs ?? [])
    .filter((p) => notProven || (p.file === f.file && (!f.detail || p.name === f.detail || item.family !== 'proof-gap')))
    .map((p) => ({ ...p, file: scrub(p.file), name: scrub(p.name) }));
  const withPatch = files.filter((x) => x.patch);
  const own = withPatch.filter((x) => x.filename === f.file);
  const sources = withPatch.filter((x) => x.filename !== f.file && !isTestPath(x.filename) && CODE.test(x.filename));
  const tests = withPatch.filter((x) => isTestPath(x.filename) && CODE.test(x.filename));
  const picked = notProven ? balanced(sources, tests, MAX_FILES_NOT_PROVEN) : [...own, ...sources].slice(0, MAX_FILES);
  // Scrub before slicing so a marker cannot be cut at the limit.
  const diff = picked.map((x) => ({ file: scrub(x.filename), patch: scrub(x.patch!).slice(0, MAX_PATCH) }));
  const finding: Finding = {
    ...f,
    title: scrub(f.title),
    ...(f.file !== undefined ? { file: scrub(f.file) } : {}),
    ...(f.detail ? { detail: scrub(f.detail) } : {}),
  };
  const body = scrub(pr.body ?? '').replace(/\n{3,}/g, '\n\n').slice(0, MAX_BODY);
  const raw = regressedCase(f, receipt);
  const regression = raw
    ? { name: scrub(raw.name), before: scrub(raw.before), after: scrub(raw.after), ...(raw.message ? { message: scrub(raw.message) } : {}) }
    : null;
  const runs = [
    ...(regression ? [`${regression.name}: before ${regression.before}, after ${regression.after}${regression.message ? ` (${regression.message})` : ''}`] : []),
    ...proofs.map((p) => `${p.name}: before ${p.before}, after ${p.after}`),
  ];
  return {
    key: item.key,
    finding,
    family: item.family,
    proofs,
    pr: { title: scrub(pr.title), body },
    diff,
    testSource: f.file && source !== null ? { file: scrub(f.file), ...sourceWindow(scrub(source), f.line) } : null,
    regression,
    baseRun: runs.length ? runs.join('; ') : 'n/a',
  };
}

export async function buildPacket(gh: GitHubApi, item: SampleItem, entry: ManifestEntry, receipt: Receipt): Promise<Packet> {
  const pr = await gh.get<{ title: string; body: string | null }>(`/repos/${entry.repo}/pulls/${entry.pr}`);
  const files = await gh.paginate<{ filename: string; patch?: string }>(`/repos/${entry.repo}/pulls/${entry.pr}/files`, 3);
  const source = item.finding.file ? await readRepoFile(gh, entry.repo, item.finding.file, entry.headSha) : null;
  return assemblePacket(item, receipt, pr, files, source);
}
