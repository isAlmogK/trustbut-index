import { countedFindings } from '../aggregate/families.js';
import type { PrResult } from '../aggregate/index.js';
import { rngFor, shuffle } from '../rng.js';
import { AGENT_IDS, fileId, type AgentId, type Family, type Finding, type Group } from '../types.js';

export interface SampleItem {
  key: string;
  prId: string;
  fileId: string;
  group: Group;
  agent: AgentId | null;
  findingIndex: number;
  finding: Finding;
  family: Family;
  order: number;
  blind: boolean;
}

type Pending = Omit<SampleItem, 'order' | 'blind'>;

function itemsOf(p: PrResult, perPr: number): Pending[] {
  return countedFindings(p.receipt!).slice(0, perPr).map(({ finding, index, family }) => ({
    key: `${fileId(p.entry)}:${index}`, prId: p.entry.id, fileId: fileId(p.entry), group: p.entry.group, agent: p.entry.agent,
    findingIndex: index, finding, family,
  }));
}

export function sampleFindings(
  results: PrResult[],
  opts: { seed: string; insufficient: Set<string>; agentTarget?: number; humanTarget?: number; perPr?: number; blindCount?: number },
): SampleItem[] {
  const { seed, insufficient, agentTarget = 150, humanTarget = 50, perPr = 5, blindCount = 20 } = opts;
  const eligible = results
    .filter((r) => r.run?.status === 'ran' && r.receipt && countedFindings(r.receipt).length > 0)
    .sort((a, b) => a.entry.id.localeCompare(b.entry.id, 'en', { numeric: true }));

  const picked: Pending[] = [];
  const queues = AGENT_IDS.filter((a) => !insufficient.has(a)).map((a) =>
    shuffle(eligible.filter((r) => r.entry.agent === a), rngFor(`${seed}:label:${a}`)),
  );
  let agentCount = 0;
  while (agentCount < agentTarget && queues.some((q) => q.length > 0)) {
    for (const q of queues) {
      if (agentCount >= agentTarget) break;
      const next = q.shift();
      if (!next) continue;
      const items = itemsOf(next, perPr);
      picked.push(...items);
      agentCount += items.length;
    }
  }
  let humanCount = 0;
  for (const r of shuffle(eligible.filter((r) => r.entry.group === 'human'), rngFor(`${seed}:label:human`))) {
    if (humanCount >= humanTarget) break;
    const items = itemsOf(r, Math.min(perPr, humanTarget - humanCount));
    picked.push(...items);
    humanCount += items.length;
  }
  return shuffle(picked.sort((a, b) => a.key.localeCompare(b.key)), rngFor(`${seed}:label:order`)).map((x, order) => ({
    ...x, order, blind: order < blindCount,
  }));
}
