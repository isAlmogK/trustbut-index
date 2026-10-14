import { join } from 'node:path';
import { readJsonOr, readJsonl } from '../jsonl.js';
import { AGENT_IDS, fileId, type Family, type ManifestEntry, type Receipt, type RunRecord } from '../types.js';
import { FAMILIES, familiesOf } from './families.js';
import { newcombe, wilson, type DiffCI, type RateCI } from './stats.js';

export interface PrResult {
  entry: ManifestEntry;
  run: RunRecord | null;
  receipt: Receipt | null;
}
export interface GroupStats {
  key: string;
  selected: number;
  byStatus: Record<string, number>;
  coverage: RateCI;
  ran: number;
  anyCounted: RateCI;
  families: Record<Family, RateCI>;
  proofs: { provesChange: number; doesNotConstrain: number; failing: number; skipped: number; proofRate: RateCI };
  insufficient: boolean;
}
export interface Comparison {
  metric: Family | 'any-counted' | 'proof-rate';
  agents: RateCI;
  human: RateCI;
  diff: DiffCI;
}
export interface Aggregate {
  date: string;
  trustbutVersions: string[];
  groups: GroupStats[];
  comparisons: Comparison[];
}

export async function loadResults(manifestPath: string, resultsDir: string): Promise<PrResult[]> {
  const entries = await readJsonl<ManifestEntry>(manifestPath);
  return Promise.all(
    entries.map(async (entry) => ({
      entry,
      run: await readJsonOr<RunRecord | null>(join(resultsDir, `${fileId(entry)}.run.json`), null),
      receipt: await readJsonOr<Receipt | null>(join(resultsDir, `${fileId(entry)}.receipt.json`), null),
    })),
  );
}

export function groupStats(key: string, prs: PrResult[], insufficient: boolean): GroupStats {
  const byStatus: Record<string, number> = { ran: 0, 'no-runner': 0, 'setup-failed': 0, timeout: 0, 'trustbut-error': 0, missing: 0 };
  for (const p of prs) byStatus[p.run?.status ?? 'missing']! += 1;
  const ran = prs.filter((p) => p.run?.status === 'ran' && p.receipt);
  const fams = ran.map((p) => familiesOf(p.receipt!));
  const families = Object.fromEntries(FAMILIES.map((f) => [f, wilson(fams.filter((s) => s.has(f)).length, ran.length)])) as Record<Family, RateCI>;
  const proofs = ran.flatMap((p) => p.receipt!.proofs ?? []);
  const count = (v: string) => proofs.filter((x) => x.verdict === v).length;
  const provesChange = count('proves-change');
  const doesNotConstrain = count('does-not-constrain');
  return {
    key,
    selected: prs.length,
    byStatus,
    coverage: wilson(byStatus.ran!, prs.length),
    ran: ran.length,
    anyCounted: wilson(fams.filter((s) => s.size > 0).length, ran.length),
    families,
    proofs: { provesChange, doesNotConstrain, failing: count('failing'), skipped: count('skipped'), proofRate: wilson(provesChange, provesChange + doesNotConstrain) },
    insufficient,
  };
}

export function aggregate(date: string, results: PrResult[], minPerAgent = 30): Aggregate {
  const agentGroups = AGENT_IDS.map((a) => {
    const prs = results.filter((r) => r.entry.agent === a);
    return groupStats(a, prs, prs.length < minPerAgent);
  });
  const sufficient = new Set(agentGroups.filter((g) => !g.insufficient).map((g) => g.key));
  const allAgents = groupStats('all-agents', results.filter((r) => r.entry.agent && sufficient.has(r.entry.agent)), false);
  const human = groupStats('human', results.filter((r) => r.entry.group === 'human'), false);
  const all = groupStats('all', results, false);
  const compare = (metric: Comparison['metric'], pick: (g: GroupStats) => RateCI): Comparison => ({
    metric, agents: pick(allAgents), human: pick(human), diff: newcombe(pick(allAgents), pick(human)),
  });
  const versions = [...new Set(results.map((r) => r.receipt?.producer.version).filter((v): v is string => Boolean(v)))].sort();
  return {
    date,
    trustbutVersions: versions,
    groups: [...agentGroups, allAgents, human, all],
    comparisons: [
      ...FAMILIES.map((f) => compare(f, (g) => g.families[f])),
      compare('any-counted', (g) => g.anyCounted),
      compare('proof-rate', (g) => g.proofs.proofRate),
    ],
  };
}
