import { NotFoundError, readRepoFile, type GitHubApi } from '../github/client.js';
import { byCodeUnit } from '../rng.js';
import { AGENT_IDS, type ManifestEntry, type PrDetail } from '../types.js';
import { AGENTS, attribute, extractModel, hasAgentMarker } from './agents.js';
import {
  PY_TEST_FILES, ciRunsTests, detectJsTests, detectPyTests, prReasons, repoMetaReasons, repoReasons,
  type RepoFacts, type RepoMeta,
} from './qualify.js';
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
  searchHits: number;
  uniqueRepos: number;
  reposQualified: number;
  candidates: Record<string, number>;
  selected: Record<string, number>;
  ambiguous: number;
  humansSelected: number;
  humanShortfall: number;
  insufficient: string[];
}

const DAY = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export function weekSlices(since: Date, until: Date): [string, string][] {
  const out: [string, string][] = [];
  for (let t = since.getTime(); t <= until.getTime(); t += 7 * DAY) {
    const end = Math.min(t + 6 * DAY, until.getTime());
    out.push([ymd(new Date(t)), ymd(new Date(end))]);
  }
  return out;
}

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

async function loadMeta(gh: GitHubApi, repo: string): Promise<RepoMeta> {
  const r = await gh.get<{ full_name: string; stargazers_count: number; fork: boolean; archived: boolean; pushed_at: string; language: string | null }>(
    `/repos/${repo}`,
  );
  return { fullName: r.full_name, stars: r.stargazers_count, fork: r.fork, archived: r.archived, pushedAt: r.pushed_at, language: r.language };
}

async function loadFacts(gh: GitHubApi, meta: RepoMeta, now: Date): Promise<RepoFacts> {
  const repo = meta.fullName;
  const since = new Date(now.getTime() - 365 * DAY).toISOString();
  const commits = await gh.paginate<{ author: { login: string } | null; commit?: { author?: { email?: string } } }>(
    `/repos/${repo}/commits?since=${since}`, 3,
  );
  const authors = new Set(commits.map((c) => c.author?.login ?? c.commit?.author?.email ?? '').filter(Boolean));
  let workflowTexts: string[] = [];
  try {
    const dir = await gh.get<{ path: string; type: string }[]>(`/repos/${repo}/contents/.github/workflows`);
    const files = dir.filter((f) => f.type === 'file' && /\.ya?ml$/.test(f.path)).slice(0, 10);
    workflowTexts = (await Promise.all(files.map((f) => readRepoFile(gh, repo, f.path)))).filter((t): t is string => t !== null);
  } catch (e) {
    if (!(e instanceof NotFoundError)) throw e;
  }
  let hasJsTests = false;
  const pkg = await readRepoFile(gh, repo, 'package.json');
  if (pkg) {
    try {
      hasJsTests = detectJsTests(JSON.parse(pkg));
    } catch {
      hasJsTests = false;
    }
  }
  let hasPyTests = false;
  if (!hasJsTests) {
    const files: Record<string, string | null> = {};
    for (const f of PY_TEST_FILES) files[f] = await readRepoFile(gh, repo, f);
    hasPyTests = detectPyTests(files);
  }
  return { ...meta, contributorsLastYear: authors.size, ciRunsTests: ciRunsTests(workflowTexts), hasJsTests, hasPyTests };
}

export async function collect(gh: GitHubApi, o: CollectOptions): Promise<{ entries: ManifestEntry[]; summary: CollectSummary }> {
  const log = o.log ?? (() => {});
  const excludedPrs = o.excludedPrs ?? new Set<string>();
  const since = new Date(o.until.getTime() - o.days * DAY);
  const window = { since, until: new Date(o.until.getTime() + DAY - 1) };

  const hits = new Map<string, { repo: string; number: number }>();
  let searchHits = 0;
  for (const agent of AGENTS) {
    for (const q of agent.queries) {
      for (const [s, e] of weekSlices(since, o.until)) {
        const items = await gh.search(`${q} is:pr is:merged is:public merged:${s}..${e}`);
        searchHits += items.length;
        for (const it of items) hits.set(`${it.repo}#${it.number}`, it);
      }
    }
    log(`searched ${agent.id}: ${hits.size} unique PRs so far`);
  }

  const repoCache = new Map<string, RepoFacts | null>();
  async function qualifiedRepo(repo: string): Promise<RepoFacts | null> {
    if (repoCache.has(repo)) return repoCache.get(repo)!;
    let facts: RepoFacts | null = null;
    try {
      const meta = await loadMeta(gh, repo);
      if (repoMetaReasons(meta, o.now, o.excluded).length === 0) {
        const f = await loadFacts(gh, meta, o.now);
        if (repoReasons(f, o.now, o.excluded).length === 0) facts = f;
      }
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
    }
    repoCache.set(repo, facts);
    return facts;
  }

  const candidates: Candidate[] = [];
  let ambiguous = 0;
  for (const k of [...hits.keys()].sort(byCodeUnit)) {
    if (excludedPrs.has(k)) continue;
    const { repo, number } = hits.get(k)!;
    const facts = await qualifiedRepo(repo);
    if (!facts) continue;
    const pr = await loadPr(gh, repo, number);
    if (prReasons(pr, window).length > 0) continue;
    const a = attribute(pr);
    if (!a) continue;
    if ('ambiguous' in a) {
      ambiguous++;
      continue;
    }
    candidates.push({ pr, agent: a.agent, evidence: a.evidence, model: extractModel(pr), repoStars: facts.stars, repoLanguage: facts.language });
  }

  const selected = selectAgentPrs(candidates, { perAgent: o.perAgent, perRepo: o.perRepo, seed: o.seed });
  const pools = new Map<string, BasicPull[]>();
  for (const repo of new Set(selected.map((c) => c.pr.repo))) {
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

  const selectedAt = o.now.toISOString();
  const entries = [
    ...selected.map((c) => toEntry(c.pr, { group: 'agent', agent: c.agent, model: c.model, evidence: c.evidence, repoStars: c.repoStars, repoLanguage: c.repoLanguage, selectedAt })),
    ...humans.map((h) => {
      const f = repoCache.get(h.repo)!;
      return toEntry(h, { group: 'human', agent: null, model: 'unknown', evidence: [], repoStars: f.stars, repoLanguage: f.language, selectedAt });
    }),
  ].sort((a, b) => byCodeUnit(a.id, b.id));

  const count = (xs: { agent: string }[]) => Object.fromEntries(AGENT_IDS.map((a) => [a, xs.filter((x) => x.agent === a).length]));
  const selectedCounts = count(selected);
  return {
    entries,
    summary: {
      window: { since: ymd(since), until: ymd(o.until) },
      searchHits,
      uniqueRepos: new Set([...hits.values()].map((h) => h.repo)).size,
      reposQualified: [...repoCache.values()].filter(Boolean).length,
      candidates: count(candidates),
      selected: selectedCounts,
      ambiguous,
      humansSelected: humans.length,
      humanShortfall: shortfall,
      insufficient: AGENT_IDS.filter((a) => selectedCounts[a]! < o.minPerAgent),
    },
  };
}
