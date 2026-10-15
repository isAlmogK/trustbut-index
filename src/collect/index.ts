import type { GitHubApi } from '../github/client.js';
import { byCodeUnit } from '../rng.js';
import { AGENT_IDS, type AgentId, type ManifestEntry, type PrDetail } from '../types.js';
import { attribute, extractModel, hasAgentMarker } from './agents.js';
import { loadFacts } from './facts.js';
import { prReasons, repoReasons, type RepoFacts } from './qualify.js';
import { listRepos } from './repos.js';
import { searchAgentPrs } from './search.js';
import { matchHumans, selectAgentPrs, toEntry, type BasicPull, type Candidate } from './select.js';

export interface CollectOptions {
  until: Date;
  days: number;
  perAgent: number;
  perRepo: number;
  seed: string;
  now: Date;
  excluded: Set<string>;
  minPerAgent: number;
  /** PR ids ("owner/name#123") never selected, as agent PRs or as human matches (e.g. the pilot manifest). */
  excludedPrs?: Set<string>;
  log?: (m: string) => void;
}
export interface CollectSummary {
  window: { since: string; until: string };
  /** Repos that pass the star, fork, archive, push and language rules. */
  reposListed: number;
  /** PRs each agent's search queries found. */
  searchHits: Record<AgentId, number>;
  uniqueHits: number;
  /** Hits evaluated on each agent's turn (repo, PR rules and attribution). */
  examined: Record<AgentId, number>;
  /** Repos whose facts were loaded. */
  reposChecked: number;
  reposQualified: number;
  ambiguous: number;
  selected: Record<AgentId, number>;
  humansSelected: number;
  humanShortfall: number;
  insufficient: string[];
}

const DAY = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const perAgentZero = () => Object.fromEntries(AGENT_IDS.map((a) => [a, 0])) as Record<AgentId, number>;

interface PullJson {
  number: number;
  title: string;
  user: { login: string; type: string };
  merged_by: { login: string } | null;
  merged_at: string | null;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
  body: string | null;
}

export async function loadPr(gh: GitHubApi, repo: string, n: number): Promise<PrDetail> {
  const p = await gh.get<PullJson>(`/repos/${repo}/pulls/${n}`);
  const files = await gh.paginate<{ filename: string }>(`/repos/${repo}/pulls/${n}/files`, 3);
  const commits = await gh.paginate<{ commit: { message: string } }>(`/repos/${repo}/pulls/${n}/commits`, 1);
  return {
    repo, number: n, title: p.title, author: p.user.login, authorType: p.user.type, mergedBy: p.merged_by?.login ?? null,
    mergedAt: p.merged_at, baseRef: p.base.ref, baseSha: p.base.sha, headSha: p.head.sha, branch: p.head.ref,
    body: p.body ?? '', files: files.map((f) => f.filename), commitMessages: commits.map((c) => c.commit.message),
  };
}

export async function collect(gh: GitHubApi, o: CollectOptions): Promise<{ entries: ManifestEntry[]; summary: CollectSummary }> {
  const log = o.log ?? (() => {});
  const excludedPrs = o.excludedPrs ?? new Set<string>();
  const since = new Date(o.until.getTime() - o.days * DAY);
  const window = { since, until: new Date(o.until.getTime() + DAY - 1) };

  const repos = await listRepos(gh, { now: o.now, excluded: o.excluded });
  log(`listed ${repos.length} repos that pass the star, fork, archive, push and language rules`);
  const metaByRepo = new Map(repos.map((m) => [m.fullName, m]));
  const hits = await searchAgentPrs(gh, repos.map((m) => m.fullName), { since: ymd(since), until: ymd(o.until) }, log);
  const searchHits = perAgentZero();
  for (const a of AGENT_IDS) searchHits[a] = hits.get(a)!.size;
  const uniqueHits = new Set(AGENT_IDS.flatMap((a) => [...hits.get(a)!])).size;

  const repoCache = new Map<string, RepoFacts | null>();
  let reposChecked = 0;
  async function qualifiedRepo(repo: string): Promise<RepoFacts | null> {
    if (repoCache.has(repo)) return repoCache.get(repo)!;
    const meta = metaByRepo.get(repo);
    let facts: RepoFacts | null = null;
    if (meta) {
      reposChecked++;
      const f = await loadFacts(gh, meta, o.now);
      if (f && repoReasons(f, o.now, o.excluded).length === 0) facts = f;
    }
    repoCache.set(repo, facts);
    return facts;
  }

  let ambiguous = 0;
  async function evaluate(k: string): Promise<Candidate | null> {
    const at = k.lastIndexOf('#');
    const repo = k.slice(0, at);
    const facts = await qualifiedRepo(repo);
    if (!facts) return null;
    const pr = await loadPr(gh, repo, Number(k.slice(at + 1)));
    if (prReasons(pr, window).length > 0) return null;
    const a = attribute(pr);
    if (!a) return null;
    if ('ambiguous' in a) {
      ambiguous++;
      return null;
    }
    return { pr, agent: a.agent, evidence: a.evidence, model: extractModel(pr, a.agent), repoStars: facts.stars, repoLanguage: facts.language };
  }

  const examined = perAgentZero();
  let total = 0;
  const selected = await selectAgentPrs(
    hits, evaluate, { perAgent: o.perAgent, perRepo: o.perRepo, seed: o.seed, excludedPrs },
    (agent) => {
      examined[agent]++;
      if (++total % 25 === 0) {
        const counts = AGENT_IDS.map((a) => `${a} ${examined[a]}`).join(', ');
        log(`examined ${total} PRs (${counts}); REST remaining ${gh.rateRemaining?.().rest ?? 'unknown'}`);
      }
    },
  );

  const humanRepos = [...new Set(selected.map((c) => c.pr.repo))];
  log(`selected ${selected.length} agent PRs; matching human PRs in ${humanRepos.length} repos`);
  const pools = new Map<string, BasicPull[]>();
  for (const repo of humanRepos) {
    const rows = await gh.paginate<{ number: number; user: { login: string; type: string }; merged_at: string | null }>(
      `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc`, 5,
    );
    pools.set(repo, rows
      .filter((r) => !excludedPrs.has(`${repo}#${r.number}`))
      .map((r) => ({ number: r.number, author: r.user.login, authorType: r.user.type, mergedAt: r.merged_at })));
  }
  const { humans, shortfall } = await matchHumans(selected, pools, async (repo, p) => {
    const d = await loadPr(gh, repo, p.number);
    return d.authorType === 'User' && !hasAgentMarker(d) && prReasons(d, window).length === 0 ? d : null;
  }, o.seed);
  log(`matched ${humans.length} human PRs (shortfall ${shortfall})`);

  const selectedAt = o.now.toISOString();
  const entries = [
    ...selected.map((c) => toEntry(c.pr, { group: 'agent', agent: c.agent, model: c.model, evidence: c.evidence, repoStars: c.repoStars, repoLanguage: c.repoLanguage, selectedAt })),
    ...humans.map((h) => {
      const f = repoCache.get(h.repo)!;
      return toEntry(h, { group: 'human', agent: null, model: 'unknown', evidence: [], repoStars: f.stars, repoLanguage: f.language, selectedAt });
    }),
  ].sort((a, b) => byCodeUnit(a.id, b.id));

  const selectedCounts = perAgentZero();
  for (const c of selected) selectedCounts[c.agent]++;
  return {
    entries,
    summary: {
      window: { since: ymd(since), until: ymd(o.until) },
      reposListed: repos.length,
      searchHits,
      uniqueHits,
      examined,
      reposChecked,
      reposQualified: [...repoCache.values()].filter(Boolean).length,
      ambiguous,
      selected: selectedCounts,
      humansSelected: humans.length,
      humanShortfall: shortfall,
      insufficient: AGENT_IDS.filter((a) => selectedCounts[a] < o.minPerAgent),
    },
  };
}
