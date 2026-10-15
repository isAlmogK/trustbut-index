import type { GitHubApi } from '../github/client.js';
import { byCodeUnit } from '../rng.js';
import { repoMetaReasons, type RepoMeta } from './qualify.js';

const DAY = 86_400_000;
/** GitHub search returns at most this many results per query. */
const CAP = 1000;
export const LANGUAGES: readonly string[] = ['TypeScript', 'JavaScript', 'Python', 'Vue', 'Svelte'];

export type StarRange = { lo: number; hi: number | null };

const REPO_SEARCH = `query($q: String!, $after: String) {
  search(type: REPOSITORY, query: $q, first: 100, after: $after) {
    repositoryCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on Repository { nameWithOwner stargazerCount isFork isArchived pushedAt primaryLanguage { name } } }
  }
}`;

interface RepoNode {
  nameWithOwner?: string;
  stargazerCount: number;
  isFork: boolean;
  isArchived: boolean;
  pushedAt: string;
  primaryLanguage: { name: string } | null;
}
interface RepoSearch {
  search: { repositoryCount: number; pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: RepoNode[] };
}

export function repoQuery(r: StarRange, pushedSince: string): string {
  const stars = r.hi === null ? `>=${r.lo}` : `${r.lo}..${r.hi}`;
  const langs = LANGUAGES.map((l) => `language:${l}`).join(' ');
  return `is:public stars:${stars} pushed:>=${pushedSince} fork:false archived:false ${langs}`;
}

/** Halves a star range so each part can come in under the search cap. */
export function splitRange(r: StarRange): [StarRange, StarRange] {
  if (r.hi === null) return [{ lo: r.lo, hi: 2 * r.lo - 1 }, { lo: 2 * r.lo, hi: null }];
  if (r.lo === r.hi) throw new Error(`more than ${CAP} repos with exactly ${r.lo} stars; the repo search cannot be split further`);
  const mid = Math.floor((r.lo + r.hi) / 2);
  return [{ lo: r.lo, hi: mid }, { lo: mid + 1, hi: r.hi }];
}

/** Repos that pass the meta rules (stars, fork, archived, pushed within 30 days, not excluded), in code-unit order. */
export async function listRepos(gh: GitHubApi, o: { now: Date; excluded: Set<string> }): Promise<RepoMeta[]> {
  const pushedSince = new Date(o.now.getTime() - 30 * DAY).toISOString().slice(0, 10);
  const found = new Map<string, RepoMeta>();
  const ranges: StarRange[] = [{ lo: 1000, hi: null }];
  while (ranges.length > 0) {
    const r = ranges.shift()!;
    const q = repoQuery(r, pushedSince);
    let page = await gh.graphql<RepoSearch>(REPO_SEARCH, { q, after: null }, { search: true });
    if (page.search.repositoryCount > CAP) {
      ranges.unshift(...splitRange(r));
      continue;
    }
    for (;;) {
      for (const n of page.search.nodes) {
        if (!n.nameWithOwner) continue;
        found.set(n.nameWithOwner, {
          fullName: n.nameWithOwner, stars: n.stargazerCount, fork: n.isFork, archived: n.isArchived,
          pushedAt: n.pushedAt, language: n.primaryLanguage?.name ?? null,
        });
      }
      if (!page.search.pageInfo.hasNextPage) break;
      page = await gh.graphql<RepoSearch>(REPO_SEARCH, { q, after: page.search.pageInfo.endCursor }, { search: true });
    }
  }
  return [...found.values()]
    .filter((m) => repoMetaReasons(m, o.now, o.excluded).length === 0)
    .sort((a, b) => byCodeUnit(a.fullName, b.fullName));
}
