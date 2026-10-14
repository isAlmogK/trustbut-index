import { FAMILIES } from '../aggregate/families.js';
import type { GroupStats } from '../aggregate/index.js';
import { product, wilson, type RateCI } from '../aggregate/stats.js';
import type { Family } from '../types.js';
import type { Draft } from './draft.js';
import type { FinalLabel } from './review.js';
import type { SampleItem } from './sample.js';

export interface LabelStats {
  family: Family | 'all';
  group: 'agent' | 'human' | 'all';
  real: number;
  benign: number;
  false: number;
  unclear: number;
  precision: RateCI;
  accuracy: RateCI;
}

/** Keeps the last line per finding key, in first-appearance order. A repeat POST in the review page is a relabel. */
export function latestFinals(finals: FinalLabel[]): FinalLabel[] {
  const last = new Map<string, FinalLabel>();
  for (const f of finals) last.set(f.key, f);
  return [...last.values()];
}

export function labelStats(sample: SampleItem[], finals: FinalLabel[]): LabelStats[] {
  const byKey = new Map(latestFinals(finals).map((f) => [f.key, f]));
  const out: LabelStats[] = [];
  for (const group of ['all', 'agent', 'human'] as const) {
    for (const family of ['all', ...FAMILIES] as const) {
      const labels = sample
        .filter((s) => (group === 'all' || s.group === group) && (family === 'all' || s.family === family))
        .map((s) => byKey.get(s.key)?.label)
        .filter(Boolean);
      const n = (l: string) => labels.filter((x) => x === l).length;
      const real = n('real'), benign = n('true-but-benign'), fals = n('false'), unclear = n('unclear');
      const decided = real + benign + fals;
      out.push({ family, group, real, benign, false: fals, unclear, precision: wilson(real, decided), accuracy: wilson(real + benign, decided) });
    }
  }
  return out;
}

export interface Calibration {
  blind: RateCI;
  overruled: RateCI;
}

export function calibration(sample: SampleItem[], latest: FinalLabel[], drafts: Draft[]): Calibration {
  const finals = latestFinals(latest);
  const draftOf = new Map(drafts.map((d) => [d.key, d.label]));
  const blindKeys = new Set(sample.filter((s) => s.blind).map((s) => s.key));
  const withDraft = finals.map((f) => ({ ...f, draft: f.draftLabel ?? draftOf.get(f.key) ?? null })).filter((f) => f.draft);
  const blind = withDraft.filter((f) => blindKeys.has(f.key));
  const shown = withDraft.filter((f) => !blindKeys.has(f.key));
  return {
    blind: wilson(blind.filter((f) => f.label === f.draft).length, blind.length),
    overruled: wilson(shown.filter((f) => f.label !== f.draft).length, shown.length),
  };
}

export interface HitRate {
  p: number;
  lo: number;
  hi: number;
  anyCounted: RateCI;
  prsWithReal: RateCI;
}

export function hitRate(allAgents: GroupStats, sample: SampleItem[], finals: FinalLabel[]): HitRate {
  const real = new Set(latestFinals(finals).filter((f) => f.label === 'real').map((f) => f.key));
  const prs = new Map<string, boolean>();
  for (const s of sample.filter((x) => x.group === 'agent')) prs.set(s.prId, (prs.get(s.prId) ?? false) || real.has(s.key));
  const prsWithReal = wilson([...prs.values()].filter(Boolean).length, prs.size);
  return { ...product(allAgents.anyCounted, prsWithReal), anyCounted: allAgents.anyCounted, prsWithReal };
}
