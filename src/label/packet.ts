import { isTestPath } from '../collect/qualify.js';
import { readRepoFile, type GitHubApi } from '../github/client.js';
import type { Family, Finding, ManifestEntry, Proof, Receipt } from '../types.js';
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
  baseRun: string;
}

const MAX_BODY = 2000;
const MAX_PATCH = 4000;
const MAX_FILES = 6;
const WINDOW = 40;
const HEAD_LINES = 120;

function sourceWindow(text: string, line: number | undefined): { startLine: number; text: string } {
  const lines = text.split('\n');
  if (!line) return { startLine: 1, text: lines.slice(0, HEAD_LINES).join('\n') };
  const start = Math.max(1, line - WINDOW);
  return { startLine: start, text: lines.slice(start - 1, line + WINDOW).join('\n') };
}

export function assemblePacket(
  item: SampleItem,
  receipt: Receipt,
  pr: { title: string; body: string | null },
  files: { filename: string; patch?: string }[],
  source: string | null,
): Packet {
  const f = item.finding;
  const proofs = (receipt.proofs ?? []).filter((p) => p.file === f.file && (!f.detail || p.name === f.detail || item.family !== 'proof-gap'));
  const withPatch = files.filter((x) => x.patch);
  const own = withPatch.filter((x) => x.filename === f.file);
  const sources = withPatch.filter((x) => x.filename !== f.file && !isTestPath(x.filename) && /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts|vue|svelte|py)$/.test(x.filename));
  const diff = [...own, ...sources].slice(0, MAX_FILES).map((x) => ({ file: x.filename, patch: scrub(x.patch!.slice(0, MAX_PATCH)) }));
  return {
    key: item.key,
    finding: { ...f, title: scrub(f.title), ...(f.detail ? { detail: scrub(f.detail) } : {}) },
    family: item.family,
    proofs,
    pr: { title: scrub(pr.title), body: scrub((pr.body ?? '').slice(0, MAX_BODY)) },
    diff,
    testSource: f.file && source !== null ? { file: f.file, ...sourceWindow(scrub(source), f.line) } : null,
    baseRun: proofs.length ? proofs.map((p) => `${p.name}: before ${p.before}, after ${p.after}`).join('; ') : 'n/a',
  };
}

export async function buildPacket(gh: GitHubApi, item: SampleItem, entry: ManifestEntry, receipt: Receipt): Promise<Packet> {
  const pr = await gh.get<{ title: string; body: string | null }>(`/repos/${entry.repo}/pulls/${entry.pr}`);
  const files = await gh.paginate<{ filename: string; patch?: string }>(`/repos/${entry.repo}/pulls/${entry.pr}/files`, 3);
  const source = item.finding.file ? await readRepoFile(gh, entry.repo, item.finding.file, entry.headSha) : null;
  return assemblePacket(item, receipt, pr, files, source);
}
