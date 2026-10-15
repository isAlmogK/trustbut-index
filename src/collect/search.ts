import type { GitHubApi } from '../github/client.js';
import { AGENT_IDS, type AgentId } from '../types.js';
import { AGENTS } from './agents.js';

/** Repos per search. 40 repo: qualifiers were checked to return exactly the sum of the 40 single-repo searches. */
export const BATCH = 40;
/** GitHub search returns at most this many results per query. */
const CAP = 1000;
const DAY = 86_400_000;
const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);

/** Inclusive merge dates, YYYY-MM-DD. */
export interface SearchWindow {
  since: string;
  until: string;
}

const PR_SEARCH = `query($q: String!, $after: String) {
  search(type: ISSUE, query: $q, first: 100, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { number repository { nameWithOwner } } }
  }
}`;

interface PrSearch {
  search: {
    issueCount: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: { number?: number; repository?: { nameWithOwner: string } }[];
  };
}

export function prQuery(q: string, repos: string[], w: SearchWindow): string {
  return `${q} is:pr is:merged merged:${w.since}..${w.until} ${repos.map((r) => `repo:${r}`).join(' ')}`;
}

export function splitWindow(w: SearchWindow): [SearchWindow, SearchWindow] {
  const s = Date.parse(`${w.since}T00:00:00Z`);
  const e = Date.parse(`${w.until}T00:00:00Z`);
  if (s >= e) throw new Error(`more than ${CAP} search results in the one-day window ${w.since}; the search cannot be split further`);
  const mid = s + Math.floor((e - s) / DAY / 2) * DAY;
  return [{ since: w.since, until: ymd(mid) }, { since: ymd(mid + DAY), until: w.until }];
}

async function searchOne(gh: GitHubApi, q: string, repos: string[], w: SearchWindow, out: Set<string>): Promise<void> {
  const text = prQuery(q, repos, w);
  let page = await gh.graphql<PrSearch>(PR_SEARCH, { q: text, after: null }, { search: true });
  if (page.search.issueCount > CAP) {
    if (repos.length > 1) {
      const half = Math.ceil(repos.length / 2);
      await searchOne(gh, q, repos.slice(0, half), w, out);
      await searchOne(gh, q, repos.slice(half), w, out);
    } else {
      for (const part of splitWindow(w)) await searchOne(gh, q, repos, part, out);
    }
    return;
  }
  for (;;) {
    for (const n of page.search.nodes) if (n.repository && n.number !== undefined) out.add(`${n.repository.nameWithOwner}#${n.number}`);
    if (!page.search.pageInfo.hasNextPage) return;
    page = await gh.graphql<PrSearch>(PR_SEARCH, { q: text, after: page.search.pageInfo.endCursor }, { search: true });
  }
}

/** Every merged PR in the window that an agent's queries find in the repos, per agent, as "owner/name#n". */
export async function searchAgentPrs(
  gh: GitHubApi, repos: string[], w: SearchWindow, log?: (m: string) => void,
): Promise<Map<AgentId, Set<string>>> {
  const hits = new Map<AgentId, Set<string>>(AGENT_IDS.map((a) => [a, new Set<string>()]));
  const batches: string[][] = [];
  for (let i = 0; i < repos.length; i += BATCH) batches.push(repos.slice(i, i + BATCH));
  for (let i = 0; i < batches.length; i++) {
    for (const agent of AGENTS) for (const q of agent.queries) await searchOne(gh, q, batches[i]!, w, hits.get(agent.id)!);
    if (log && ((i + 1) % 20 === 0 || i + 1 === batches.length)) {
      const counts = AGENT_IDS.map((a) => `${a} ${hits.get(a)!.size}`).join(', ');
      log(`searched batch ${i + 1}/${batches.length}: ${counts}; GraphQL remaining ${gh.rateRemaining?.().graphql ?? 'unknown'}`);
    }
  }
  return hits;
}
