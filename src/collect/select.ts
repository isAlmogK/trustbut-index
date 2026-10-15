import { byCodeUnit, rngFor, shuffle } from '../rng.js';
import { AGENT_IDS, type AgentId, type ManifestEntry, type PrDetail } from '../types.js';

export interface Candidate {
  pr: PrDetail;
  agent: AgentId;
  evidence: string[];
  model: string;
  repoStars: number;
  repoLanguage: string | null;
}

const key = (repo: string, n: number) => `${repo}#${n}`;

export interface SelectOptions {
  perAgent: number;
  perRepo: number;
  seed: string;
  /** PR keys never selected, e.g. the pilot manifest. */
  excludedPrs?: Set<string>;
}

const repoOf = (k: string) => k.slice(0, k.lastIndexOf('#'));

/**
 * Round-robin across agents so no agent uses up the per-repo cap first. Each agent's hits are shuffled with the seed
 * and evaluated in that order, only as needed: a hit is accepted for an agent only when `evaluate` attributes it to
 * that agent. Excluded hits and hits in a full repo are skipped without evaluating them; each key is evaluated once.
 */
export async function selectAgentPrs(
  hits: Map<AgentId, Set<string>>,
  evaluate: (key: string) => Promise<Candidate | null>,
  opts: SelectOptions,
  onExamine?: (agent: AgentId) => void,
): Promise<Candidate[]> {
  const queues = new Map<AgentId, string[]>();
  for (const agent of AGENT_IDS) {
    queues.set(agent, shuffle([...(hits.get(agent) ?? [])].sort(byCodeUnit), rngFor(`${opts.seed}:${agent}`)));
  }
  const memo = new Map<string, Promise<Candidate | null>>();
  const perAgent = new Map<AgentId, number>();
  const perRepo = new Map<string, number>();
  const chosen = new Set<string>();
  const out: Candidate[] = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const agent of AGENT_IDS) {
      if ((perAgent.get(agent) ?? 0) >= opts.perAgent) continue;
      const q = queues.get(agent)!;
      while (q.length > 0) {
        const k = q.shift()!;
        const repo = repoOf(k);
        if (opts.excludedPrs?.has(k) || chosen.has(k) || (perRepo.get(repo) ?? 0) >= opts.perRepo) continue;
        if (!memo.has(k)) memo.set(k, evaluate(k));
        onExamine?.(agent);
        const c = await memo.get(k)!;
        if (!c || c.agent !== agent) continue;
        out.push(c);
        chosen.add(k);
        perAgent.set(agent, (perAgent.get(agent) ?? 0) + 1);
        perRepo.set(repo, (perRepo.get(repo) ?? 0) + 1);
        progressed = true;
        break;
      }
    }
  }
  return out;
}

export interface BasicPull {
  number: number;
  author: string;
  authorType: string;
  mergedAt: string | null;
}

export async function matchHumans(
  selected: Candidate[],
  pools: Map<string, BasicPull[]>,
  accept: (repo: string, p: BasicPull) => Promise<PrDetail | null>,
  seed: string,
): Promise<{ humans: PrDetail[]; shortfall: number }> {
  const need = new Map<string, number>();
  const agentNumbers = new Set(selected.map((c) => key(c.pr.repo, c.pr.number)));
  for (const c of selected) need.set(c.pr.repo, (need.get(c.pr.repo) ?? 0) + 1);
  const humans: PrDetail[] = [];
  let shortfall = 0;
  for (const repo of [...need.keys()].sort(byCodeUnit)) {
    const k = need.get(repo)!;
    const pool = (pools.get(repo) ?? [])
      .filter((p) => p.authorType === 'User' && p.mergedAt && !agentNumbers.has(key(repo, p.number)))
      .sort((a, b) => a.number - b.number);
    let got = 0;
    for (const p of shuffle(pool, rngFor(`${seed}:human:${repo}`))) {
      if (got >= k) break;
      const d = await accept(repo, p);
      if (d) {
        humans.push(d);
        got++;
      }
    }
    shortfall += k - got;
  }
  return { humans, shortfall };
}

export function toEntry(
  pr: PrDetail,
  info: { group: 'agent' | 'human'; agent: AgentId | null; model: string; evidence: string[]; repoStars: number; repoLanguage: string | null; selectedAt: string },
): ManifestEntry {
  return {
    id: key(pr.repo, pr.number),
    repo: pr.repo,
    pr: pr.number,
    group: info.group,
    agent: info.agent,
    model: info.model,
    attribution: { evidence: info.evidence },
    baseRef: pr.baseRef,
    baseSha: pr.baseSha,
    headSha: pr.headSha,
    mergedAt: pr.mergedAt ?? '',
    selectedAt: info.selectedAt,
    repoStars: info.repoStars,
    repoLanguage: info.repoLanguage,
  };
}
