import type { PrResult } from '../aggregate/index.js';
import { latestFinals } from '../label/metrics.js';
import type { FinalLabel } from '../label/review.js';
import type { SampleItem } from '../label/sample.js';
import type { Family } from '../types.js';

/** A published example. It never carries the test name, which could identify the project by search. */
export interface Example {
  description: string;
  family: Family;
  title: string;
  before: string | null;
  after: string | null;
}

export function describeRepo(stars: number, language: string | null): string {
  const k = stars >= 10_000 ? `${Math.floor(stars / 1000)}k` : `${(Math.floor(stars / 100) / 10).toString()}k`;
  return `a ${k}-star ${language ? `${language} ` : ''}project`;
}

export function pickExamples(sample: SampleItem[], finals: FinalLabel[], results: PrResult[], n = 4): Example[] {
  const real = new Set(latestFinals(finals).filter((f) => f.label === 'real').map((f) => f.key));
  const byId = new Map(results.map((r) => [r.entry.id, r]));
  const out: Example[] = [];
  const seenFamilies = new Set<Family>();
  for (const s of [...sample].sort((a, b) => a.order - b.order)) {
    if (out.length >= n) break;
    if (!real.has(s.key) || s.group !== 'agent' || seenFamilies.has(s.family)) continue;
    const r = byId.get(s.prId);
    if (!r) continue;
    const proof =
      s.family === 'proof-gap' && s.finding.detail
        ? (r.receipt?.proofs ?? []).find((p) => p.file === s.finding.file && p.name === s.finding.detail)
        : undefined;
    out.push({
      description: describeRepo(r.entry.repoStars, r.entry.repoLanguage), family: s.family, title: s.finding.title,
      before: proof?.before ?? null, after: proof?.after ?? null,
    });
    seenFamilies.add(s.family);
  }
  return out;
}
