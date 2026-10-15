# Repo-first Collect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `collect` finish within the workflow time limit and see every qualifying agent PR, by listing qualifying repos first, searching agent PRs inside batches of those repos, and loading PRs only as selection needs them.

**Architecture:** `collect` becomes four steps. (1) A GraphQL repo search, split by star range, lists the repos that pass the cheap rules. (2) A GraphQL issue search per agent query, over batches of 40 repos, finds agent PR keys, splitting any query over 1,000 results. (3) A seeded round-robin selection evaluates hits lazily: repo facts through one GraphQL query per repo, PR details through REST as today. (4) Human matching is unchanged. The workflow keeps its API cache across failed runs.

**Tech Stack:** TypeScript (ESM, NodeNext, `.js` import suffixes), Node ≥ 22, `tsx`, Vitest, GitHub REST + GraphQL via `fetch`.

**Spec:** `docs/superpowers/specs/2026-10-15-repo-first-collect-design.md`

## Global Constraints

- Test first: every behavior change starts with a failing test (`AGENTS.md`).
- Deterministic: every random choice goes through `src/rng.ts` with a named seed. Selection keeps the seed key `<seed>:<agent>`.
- Read-only toward studied repos: only GET and GraphQL queries, never mutations.
- Imports use `.js` extensions. Code-unit ordering uses `byCodeUnit` from `src/rng.ts`.
- Repo frame: `stars:>=1000`, `pushed:>=<now − 30 days>`, `fork:false`, `archived:false`, languages `TypeScript JavaScript Python Vue Svelte`.
- Batch size 40 repos. Search cap 1,000 results per query. Search throttle 1,000 ms between uncached search calls.
- Commit authors: at most 300 commits, stop at 10 distinct authors.
- Workflow: job `timeout-minutes: 350`, Collect step `timeout-minutes: 320`. Cache key `github-api-${{ env.UNTIL }}-${{ github.run_id }}-${{ github.run_attempt }}`, restore key `github-api-${{ env.UNTIL }}-`. Actions pinned to `0400d5f644dc74513175e3cd8d07132dd4860809 # v4.2.4`.
- Commit after each task with a conventional message ending in `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Run every command from the repo root `/Users/Almog/Desktop/trustbut-index`.

## File Structure

```
src/github/client.ts      + graphql(), rateRemaining(), POST support, rate header tracking; − REST search() (Task 6)
src/collect/repos.ts      NEW  repo list: star-range slicing, paging, dedupe, meta rules
src/collect/search.ts     NEW  agent PR search: 40-repo batches, batch/window splitting, paging
src/collect/facts.ts      NEW  repo facts in one GraphQL query (moved out of index.ts)
src/collect/select.ts     selectAgentPrs becomes async and lazy (hits + evaluate)
src/collect/index.ts      pipeline: listRepos → searchAgentPrs → lazy selection → humans; new summary; logs
.github/workflows/collect.yml   cache restore/save always, timeouts
PREREGISTRATION.md, README.md   wording that matches the code
test/github-client.test.ts, test/repos.test.ts (new), test/search.test.ts (new), test/facts.test.ts (new),
test/select.test.ts, test/collect.test.ts, test/collect-workflow.test.ts
```

---

### Task 1: GraphQL in the GitHub client

**Files:**
- Modify: `src/github/client.ts`
- Modify: `test/github-client.test.ts`
- Modify: `test/collect.test.ts:19` (the fake gets a `graphql` stub so typecheck passes)

**Interfaces:**
- Produces:
  - `GitHubApi.graphql<T>(query: string, variables: Record<string, unknown>, opts?: { search?: boolean }): Promise<T>`
  - `GitHubApi.rateRemaining?(): { rest?: number; graphql?: number }`
  - `GitHub.rateRemaining(): { rest?: number; graphql?: number }`
  - Default `searchIntervalMs` becomes 1000.

- [ ] **Step 1: Write the failing tests**

In `test/github-client.test.ts`, change the expectation in `'searches issues, maps repo and number, and throttles'` from `expect(sleeps).toEqual([3000]);` to `expect(sleeps).toEqual([1000]);`. Then append:

```ts
describe('GitHub GraphQL', () => {
  const Q = 'query($x: Int) { a(x: $x) }';

  it('posts the query with auth and caches the data on disk', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'gh-'));
    const { f, calls, inits } = fakeFetch(() => json({ data: { a: 1 } }));
    expect(await new GitHub({ token: 't', cacheDir, fetch: f }).graphql(Q, { x: 1 })).toEqual({ a: 1 });
    expect(await new GitHub({ token: 't', cacheDir, fetch: f }).graphql(Q, { x: 1 })).toEqual({ a: 1 });
    expect(calls).toEqual(['https://api.github.com/graphql']);
    expect(inits[0]?.method).toBe('POST');
    expect(JSON.parse(String(inits[0]?.body))).toEqual({ query: Q, variables: { x: 1 } });
    const headers = inits[0]?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer t');
    expect(headers['content-type']).toBe('application/json');
  });

  it('caches per variables', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'gh-'));
    let n = 0;
    const { f, calls } = fakeFetch(() => json({ data: { n: ++n } }));
    const gh = new GitHub({ cacheDir, fetch: f });
    expect(await gh.graphql(Q, { x: 1 })).toEqual({ n: 1 });
    expect(await gh.graphql(Q, { x: 2 })).toEqual({ n: 2 });
    expect(calls.length).toBe(2);
  });

  it('waits for the GraphQL reset on a RATE_LIMITED error, then retries', async () => {
    let n = 0;
    const { f } = fakeFetch(() =>
      n++ === 0
        ? json({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }, 200, {
            'x-ratelimit-resource': 'graphql', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1010',
          })
        : json({ data: { ok: true } }),
    );
    const sleeps: number[] = [];
    const gh = new GitHub({ fetch: f, now: () => 1_000_000, sleep: async (ms) => void sleeps.push(ms) });
    expect(await gh.graphql(Q, {})).toEqual({ ok: true });
    expect(sleeps).toEqual([11_000]);
  });

  it('returns the data when every error is NOT_FOUND', async () => {
    const { f } = fakeFetch(() =>
      json({ data: { repository: null }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a Repository' }] }),
    );
    expect(await new GitHub({ fetch: f }).graphql(Q, {})).toEqual({ repository: null });
  });

  it('throws on any other error and does not cache it', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'gh-'));
    const { f, calls } = fakeFetch(() => json({ errors: [{ type: 'INVALID', message: 'Field x does not exist' }] }));
    await expect(new GitHub({ cacheDir, fetch: f }).graphql(Q, {})).rejects.toThrow('GitHub GraphQL: Field x does not exist');
    await expect(new GitHub({ cacheDir, fetch: f }).graphql(Q, {})).rejects.toThrow('GitHub GraphQL');
    expect(calls.length).toBe(2);
  });

  it('spaces uncached search calls one second apart, and only search calls', async () => {
    const { f } = fakeFetch(() => json({ data: {} }));
    const sleeps: number[] = [];
    let t = 0;
    const gh = new GitHub({ fetch: f, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } });
    await gh.graphql(Q, { x: 1 }, { search: true });
    await gh.graphql(Q, { x: 2 }, { search: true });
    await gh.graphql(Q, { x: 3 });
    expect(sleeps).toEqual([1000]);
  });

  it('reports the remaining REST and GraphQL budgets from response headers', async () => {
    const { f } = fakeFetch((url) =>
      url.endsWith('/graphql')
        ? json({ data: {} }, 200, { 'x-ratelimit-resource': 'graphql', 'x-ratelimit-remaining': '4000', 'x-ratelimit-reset': '1' })
        : json({}, 200, { 'x-ratelimit-resource': 'core', 'x-ratelimit-remaining': '4990', 'x-ratelimit-reset': '1' }),
    );
    const gh = new GitHub({ fetch: f });
    expect(gh.rateRemaining()).toEqual({ rest: undefined, graphql: undefined });
    await gh.get('/x');
    await gh.graphql(Q, {});
    expect(gh.rateRemaining()).toEqual({ rest: 4990, graphql: 4000 });
  });
});
```

In `test/collect.test.ts`, change the fake's return line to:

```ts
  return { get, paginate: get, search: async (q) => search(q), graphql: async () => { throw new Error('graphql not used'); } };
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/github-client.test.ts`
Expected: FAIL. `gh.graphql is not a function` and `gh.rateRemaining is not a function`; the throttle test expects 1000 but gets 3000.

- [ ] **Step 3: Implement**

In `src/github/client.ts`:

1. Extend the interface:

```ts
export interface GitHubApi {
  get<T>(path: string): Promise<T>;
  paginate<T>(path: string, maxPages: number): Promise<T[]>;
  search(q: string, maxPages?: number): Promise<SearchItem[]>;
  /** GraphQL query or search. `search: true` spaces uncached calls by the search interval. */
  graphql<T>(query: string, variables: Record<string, unknown>, opts?: { search?: boolean }): Promise<T>;
  /** Last seen remaining budget per API, for progress logs only. */
  rateRemaining?(): { rest?: number; graphql?: number };
}
```

2. In the class, add the rate map after `lastSearch`:

```ts
  private readonly rate = new Map<string, { remaining: number; reset: number }>();
```

3. Add the methods after `search`:

```ts
  async graphql<T>(query: string, variables: Record<string, unknown>, opts: { search?: boolean } = {}): Promise<T> {
    const key = `POST /graphql ${query} ${JSON.stringify(variables)}`;
    const cached = await this.readCache(key);
    if (cached !== undefined) return cached as T;
    const max = this.opts.maxRetries ?? 5;
    for (let attempt = 0; ; attempt++) {
      if (opts.search) await this.throttleSearch();
      const res = (await this.request('/graphql', { query, variables })) as {
        data?: unknown;
        errors?: { type?: string; message: string }[];
      };
      const errors = res.errors ?? [];
      // A missing repo comes back as NOT_FOUND with the field set to null; that is an answer, not a failure.
      if (errors.every((e) => e.type === 'NOT_FOUND')) {
        await this.writeCache(key, res.data);
        return res.data as T;
      }
      if (errors.some((e) => e.type === 'RATE_LIMITED') && attempt < max) {
        const reset = (this.rate.get('graphql')?.reset ?? 0) * 1000;
        await this.sleep(Math.max(reset - this.now(), 0) + 1000);
        continue;
      }
      throw new Error(`GitHub GraphQL: ${errors.map((e) => e.message).join('; ')}`);
    }
  }

  rateRemaining(): { rest?: number; graphql?: number } {
    return { rest: this.rate.get('core')?.remaining, graphql: this.rate.get('graphql')?.remaining };
  }
```

4. Change the throttle default from `3000` to `1000` in `throttleSearch`:

```ts
    const wait = this.lastSearch + (this.opts.searchIntervalMs ?? 1000) - this.now();
```

5. Make `request` accept a JSON body and record rate headers:

```ts
  private async request(path: string, body?: unknown): Promise<unknown> {
    const max = this.opts.maxRetries ?? 5;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchFn(`${API}${path}`, {
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
        },
      });
      this.noteRate(res);
      if (res.ok) return res.json();
      if (res.status === 404) throw new NotFoundError(path);
      const text = await res.text();
      const wait = this.retryWait(res, text, attempt);
      if (wait !== null && attempt < max) {
        await this.sleep(wait);
        continue;
      }
      throw new Error(`GitHub ${res.status} for ${path}: ${text}`);
    }
  }

  private noteRate(res: Response): void {
    const resource = res.headers.get('x-ratelimit-resource');
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (!resource || remaining === null || !Number.isFinite(Number(remaining))) return;
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    this.rate.set(resource, { remaining: Number(remaining), reset: Number.isFinite(reset) ? reset : 0 });
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/github-client.test.ts && npm run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/github/client.ts test/github-client.test.ts test/collect.test.ts
git commit -m "feat: GraphQL queries in the GitHub client, with caching, rate-limit waits and budget tracking

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Repo list by star-sliced GraphQL search

**Files:**
- Create: `src/collect/repos.ts`
- Create: `test/repos.test.ts`

**Interfaces:**
- Consumes: `GitHubApi.graphql` (Task 1); `repoMetaReasons`, `RepoMeta` from `src/collect/qualify.ts`; `byCodeUnit` from `src/rng.ts`.
- Produces:
  - `type StarRange = { lo: number; hi: number | null }`
  - `LANGUAGES: readonly string[]`
  - `repoQuery(r: StarRange, pushedSince: string): string`
  - `splitRange(r: StarRange): [StarRange, StarRange]`
  - `listRepos(gh: GitHubApi, o: { now: Date; excluded: Set<string> }): Promise<RepoMeta[]>`: meta-qualified repos sorted by `fullName`.

- [ ] **Step 1: Write the failing test**

`test/repos.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { GitHubApi } from '../src/github/client.js';
import { listRepos, repoQuery, splitRange } from '../src/collect/repos.js';

const now = new Date('2026-11-01T00:00:00Z');
const node = (name: string, p: { stars?: number; pushedAt?: string } = {}) => ({
  nameWithOwner: name, stargazerCount: p.stars ?? 5000, isFork: false, isArchived: false,
  pushedAt: p.pushedAt ?? '2026-10-30T00:00:00Z', primaryLanguage: { name: 'TypeScript' },
});

/** Repo search fake: `slices` maps the stars expression (">=2000", "1000..1999") to its repos; `counts` overrides repositoryCount. */
function fakeSearch(slices: Record<string, ReturnType<typeof node>[]>, counts: Record<string, number> = {}) {
  const queries: { q: string; after: string | null }[] = [];
  const gh = {
    graphql: async (_query: string, vars: Record<string, unknown>) => {
      const q = vars.q as string;
      const after = (vars.after as string | null) ?? null;
      queries.push({ q, after });
      const stars = /stars:(\S+)/.exec(q)![1]!;
      const all = slices[stars] ?? [];
      const start = after === null ? 0 : Number(after);
      return {
        search: {
          repositoryCount: counts[stars] ?? all.length,
          pageInfo: { hasNextPage: start + 100 < all.length, endCursor: String(start + 100) },
          nodes: all.slice(start, start + 100),
        },
      };
    },
  } as unknown as GitHubApi;
  return { gh, queries };
}

describe('splitRange', () => {
  it('splits an open range at twice its floor and a closed range in half', () => {
    expect(splitRange({ lo: 1000, hi: null })).toEqual([{ lo: 1000, hi: 1999 }, { lo: 2000, hi: null }]);
    expect(splitRange({ lo: 1000, hi: 1999 })).toEqual([{ lo: 1000, hi: 1499 }, { lo: 1500, hi: 1999 }]);
  });
  it('throws when a single star count has too many repos to list', () => {
    expect(() => splitRange({ lo: 1200, hi: 1200 })).toThrow(/exactly 1200 stars/);
  });
});

describe('repoQuery', () => {
  it('builds the repo search text', () => {
    expect(repoQuery({ lo: 1000, hi: null }, '2026-10-02')).toBe(
      'is:public stars:>=1000 pushed:>=2026-10-02 fork:false archived:false language:TypeScript language:JavaScript language:Python language:Vue language:Svelte',
    );
    expect(repoQuery({ lo: 1000, hi: 1999 }, '2026-10-02')).toContain(' stars:1000..1999 ');
  });
});

describe('listRepos', () => {
  it('splits star ranges over 1,000, pages by cursor, dedupes, applies the meta rules and sorts', async () => {
    const many = Array.from({ length: 150 }, (_, i) => node(`o/r${String(i).padStart(3, '0')}`, { stars: 1500 }));
    const { gh, queries } = fakeSearch(
      {
        '>=1000': [],
        '1000..1999': [...many, node('z/stale', { stars: 1100, pushedAt: '2026-09-01T00:00:00Z' })],
        '>=2000': [node('a/big', { stars: 9000 }), node('o/r000', { stars: 2001 }), node('bad/excluded')],
      },
      { '>=1000': 1001 },
    );
    const repos = await listRepos(gh, { now, excluded: new Set(['bad/excluded']) });
    expect(queries.map((x) => [/stars:(\S+)/.exec(x.q)![1], x.after])).toEqual([
      ['>=1000', null], ['1000..1999', null], ['1000..1999', '100'], ['>=2000', null],
    ]);
    expect(queries[0]!.q).toContain('pushed:>=2026-10-02');
    const names = repos.map((r) => r.fullName);
    expect(names.length).toBe(151);
    expect(names).not.toContain('z/stale');
    expect(names).not.toContain('bad/excluded');
    expect(names).toEqual([...names].sort());
    expect(repos[0]).toEqual({
      fullName: 'a/big', stars: 9000, fork: false, archived: false, pushedAt: '2026-10-30T00:00:00Z', language: 'TypeScript',
    });
    expect(repos.find((r) => r.fullName === 'o/r000')!.stars).toBe(2001);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/repos.test.ts`
Expected: FAIL, `Cannot find module '../src/collect/repos.js'`.

- [ ] **Step 3: Implement `src/collect/repos.ts`**

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/repos.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/collect/repos.ts test/repos.test.ts
git commit -m "feat: list qualifying repos by star-sliced GraphQL search

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Agent PR search in repo batches

**Files:**
- Create: `src/collect/search.ts`
- Create: `test/search.test.ts`

**Interfaces:**
- Consumes: `GitHubApi.graphql`, `GitHubApi.rateRemaining?` (Task 1); `AGENTS` from `src/collect/agents.ts`; `AGENT_IDS`, `AgentId` from `src/types.ts`.
- Produces:
  - `BATCH = 40`
  - `interface SearchWindow { since: string; until: string }`: inclusive `YYYY-MM-DD`
  - `prQuery(q: string, repos: string[], w: SearchWindow): string`
  - `splitWindow(w: SearchWindow): [SearchWindow, SearchWindow]`
  - `searchAgentPrs(gh: GitHubApi, repos: string[], w: SearchWindow, log?: (m: string) => void): Promise<Map<AgentId, Set<string>>>`: keys are `owner/name#n`, with an entry for every agent id.

- [ ] **Step 1: Write the failing test**

`test/search.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { GitHubApi } from '../src/github/client.js';
import { BATCH, prQuery, searchAgentPrs, splitWindow } from '../src/collect/search.js';

const W = { since: '2026-08-03', until: '2026-11-01' };
const COPILOT = 'author:app/copilot-swe-agent';
type Item = { q: string; repo: string; number: number };

/** PR search fake: returns the items whose agent query starts the search text and whose repo is a repo: token in it. */
function fakeSearch(items: Item[], count: (q: string) => number | undefined = () => undefined) {
  const seen: { q: string; after: string | null }[] = [];
  const gh = {
    graphql: async (_query: string, vars: Record<string, unknown>) => {
      const q = vars.q as string;
      const after = (vars.after as string | null) ?? null;
      seen.push({ q, after });
      const tokens = new Set(q.split(' '));
      const all = items
        .filter((i) => q.startsWith(`${i.q} is:pr`) && tokens.has(`repo:${i.repo}`))
        .map((i) => ({ number: i.number, repository: { nameWithOwner: i.repo } }));
      const start = after === null ? 0 : Number(after);
      return {
        search: {
          issueCount: count(q) ?? all.length,
          pageInfo: { hasNextPage: start + 100 < all.length, endCursor: String(start + 100) },
          nodes: all.slice(start, start + 100),
        },
      };
    },
  } as unknown as GitHubApi;
  return { gh, seen };
}
const reposIn = (q: string) => q.split(' ').filter((t) => t.startsWith('repo:')).map((t) => t.slice(5));
const mergedIn = (q: string) => /merged:(\S+)/.exec(q)![1];

describe('prQuery', () => {
  it('builds the search text for one agent query and a batch of repos', () => {
    expect(prQuery(COPILOT, ['a/b', 'c/d'], W)).toBe(
      'author:app/copilot-swe-agent is:pr is:merged merged:2026-08-03..2026-11-01 repo:a/b repo:c/d',
    );
  });
});

describe('splitWindow', () => {
  it('splits a window into two halves by days', () => {
    expect(splitWindow(W)).toEqual([
      { since: '2026-08-03', until: '2026-09-17' },
      { since: '2026-09-18', until: '2026-11-01' },
    ]);
    expect(splitWindow({ since: '2026-08-03', until: '2026-08-04' })).toEqual([
      { since: '2026-08-03', until: '2026-08-03' },
      { since: '2026-08-04', until: '2026-08-04' },
    ]);
  });
  it('throws on a one-day window', () => {
    expect(() => splitWindow({ since: '2026-08-03', until: '2026-08-03' })).toThrow(/one-day window 2026-08-03/);
  });
});

describe('searchAgentPrs', () => {
  it('runs every agent query over batches of 40 repos and keeps hits per agent', async () => {
    const repos = Array.from({ length: 85 }, (_, i) => `o/r${String(i).padStart(2, '0')}`);
    const { gh, seen } = fakeSearch([
      { q: COPILOT, repo: 'o/r00', number: 1 },
      { q: 'head:codex', repo: 'o/r84', number: 2 },
      { q: '"chatgpt.com/codex" in:body', repo: 'o/r84', number: 2 },
      { q: '"chatgpt.com/codex" in:body', repo: 'o/r84', number: 3 },
    ]);
    const hits = await searchAgentPrs(gh, repos, W);
    expect(BATCH).toBe(40);
    expect(seen.length).toBe(3 * 9);
    expect(seen.filter((s) => s.q.startsWith(COPILOT)).map((s) => reposIn(s.q).length)).toEqual([40, 40, 5]);
    expect([...hits.get('copilot')!]).toEqual(['o/r00#1']);
    expect([...hits.get('codex')!].sort()).toEqual(['o/r84#2', 'o/r84#3']);
    expect(hits.get('jules')!.size).toBe(0);
    expect([...hits.keys()]).toEqual(['copilot', 'codex', 'claude-code', 'cursor', 'devin', 'jules']);
  });

  it('splits a batch with more than 1,000 results in half until each part fits', async () => {
    const { gh, seen } = fakeSearch(
      [{ q: COPILOT, repo: 'a', number: 1 }, { q: COPILOT, repo: 'd', number: 2 }],
      (q) => (reposIn(q).length > 1 && reposIn(q).includes('a') ? 1001 : undefined),
    );
    const hits = await searchAgentPrs(gh, ['a', 'b', 'c', 'd'], W);
    expect(seen.filter((s) => s.q.startsWith(COPILOT)).map((s) => reposIn(s.q))).toEqual([
      ['a', 'b', 'c', 'd'], ['a', 'b'], ['a'], ['b'], ['c', 'd'],
    ]);
    expect([...hits.get('copilot')!].sort()).toEqual(['a#1', 'd#2']);
  });

  it('splits the window for a single repo with more than 1,000 results', async () => {
    const { gh, seen } = fakeSearch([{ q: COPILOT, repo: 'a', number: 1 }], (q) =>
      q.startsWith(COPILOT) && mergedIn(q) === '2026-08-03..2026-11-01' ? 1001 : undefined,
    );
    await searchAgentPrs(gh, ['a'], W);
    expect(seen.filter((s) => s.q.startsWith(COPILOT)).map((s) => mergedIn(s.q))).toEqual([
      '2026-08-03..2026-11-01', '2026-08-03..2026-09-17', '2026-09-18..2026-11-01',
    ]);
  });

  it('fails when one repo has more than 1,000 results on one day', async () => {
    const { gh } = fakeSearch([], () => 1001);
    await expect(searchAgentPrs(gh, ['a'], { since: '2026-08-03', until: '2026-08-03' })).rejects.toThrow(/one-day window 2026-08-03/);
  });

  it('pages through results by cursor', async () => {
    const items = Array.from({ length: 250 }, (_, i) => ({ q: COPILOT, repo: 'a', number: i + 1 }));
    const { gh, seen } = fakeSearch(items);
    const hits = await searchAgentPrs(gh, ['a'], W);
    expect(hits.get('copilot')!.size).toBe(250);
    expect(seen.filter((s) => s.q.startsWith(COPILOT)).map((s) => s.after)).toEqual([null, '100', '200']);
  });

  it('logs progress with the remaining GraphQL budget', async () => {
    const { gh } = fakeSearch([]);
    const lines: string[] = [];
    await searchAgentPrs(gh, ['a'], W, (m) => lines.push(m));
    expect(lines).toEqual([
      'searched batch 1/1: copilot 0, codex 0, claude-code 0, cursor 0, devin 0, jules 0; GraphQL remaining unknown',
    ]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/search.test.ts`
Expected: FAIL, `Cannot find module '../src/collect/search.js'`.

- [ ] **Step 3: Implement `src/collect/search.ts`**

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/search.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/collect/search.ts test/search.test.ts
git commit -m "feat: search agent PRs in 40-repo batches, splitting any query over 1,000 results

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Repo facts in one GraphQL query

**Files:**
- Create: `src/collect/facts.ts`
- Create: `test/facts.test.ts`

**Interfaces:**
- Consumes: `GitHubApi.graphql` (Task 1); `PY_TEST_FILES`, `ciRunsTests`, `detectJsTests`, `detectPyTests`, `RepoFacts`, `RepoMeta` from `src/collect/qualify.ts`.
- Produces: `loadFacts(gh: GitHubApi, meta: RepoMeta, now: Date): Promise<RepoFacts | null>`. It returns null when the repo no longer resolves. `contributorsLastYear` is a lower bound: counting stops at 10.

- [ ] **Step 1: Write the failing test**

`test/facts.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { GitHubApi } from '../src/github/client.js';
import { loadFacts } from '../src/collect/facts.js';
import type { RepoMeta } from '../src/collect/qualify.js';

const now = new Date('2026-11-01T00:00:00Z');
const meta: RepoMeta = { fullName: 'big/repo', stars: 5000, fork: false, archived: false, pushedAt: '2026-10-30T00:00:00Z', language: 'TypeScript' };
const commits = (logins: string[], next: string | null) => ({
  pageInfo: { hasNextPage: next !== null, endCursor: next },
  nodes: logins.map((l) => ({ author: { email: `${l}@x.dev`, user: { login: l } } })),
});
const wf = (path: string, text: string) => ({ path, type: 'blob', object: { text } });
const repo = (p: Record<string, unknown> = {}) => ({
  workflows: { entries: [wf('.github/workflows/ci.yml', 'steps:\n  - run: npm test\n')] },
  packageJson: { text: JSON.stringify({ devDependencies: { vitest: '^3' } }) },
  defaultBranchRef: { target: { history: commits(Array.from({ length: 12 }, (_, i) => `dev${i}`), null) } },
  ...p,
});

/** Facts fake: the first query returns `repository`; history pages are looked up by their `after` cursor. */
function fakeFacts(repository: unknown, pages: Record<string, ReturnType<typeof commits>> = {}) {
  const calls: Record<string, unknown>[] = [];
  const gh = {
    graphql: async (_q: string, vars: Record<string, unknown>) => {
      calls.push(vars);
      if (vars.after) return { repository: { defaultBranchRef: { target: { history: pages[vars.after as string] } } } };
      return { repository };
    },
  } as unknown as GitHubApi;
  return { gh, calls };
}

describe('loadFacts', () => {
  it('reads CI, the test setup and contributors in one query', async () => {
    const { gh, calls } = fakeFacts(repo());
    expect(await loadFacts(gh, meta, now)).toEqual({ ...meta, contributorsLastYear: 12, ciRunsTests: true, hasJsTests: true, hasPyTests: false });
    expect(calls).toEqual([{ owner: 'big', name: 'repo', since: '2025-11-01T00:00:00.000Z' }]);
  });

  it('detects a pytest setup when there is no JS test setup', async () => {
    const { gh } = fakeFacts(repo({ packageJson: null, py0: { text: '[pytest]\n' } }));
    expect(await loadFacts(gh, meta, now)).toMatchObject({ hasJsTests: false, hasPyTests: true });
  });

  it('reads only the first 10 workflow YAML files, in tree order', async () => {
    const quiet = Array.from({ length: 10 }, (_, i) => wf(`.github/workflows/a${i}.yml`, 'run: echo hi'));
    const extra = [
      wf('.github/workflows/README.md', 'npm test'),
      { path: '.github/workflows/sub', type: 'tree', object: {} },
    ];
    const late = { gh: fakeFacts(repo({ workflows: { entries: [...extra, ...quiet, wf('.github/workflows/zz.yml', 'npm test')] } })).gh };
    expect(await loadFacts(late.gh, meta, now)).toMatchObject({ ciRunsTests: false });
    const early = { gh: fakeFacts(repo({ workflows: { entries: [...extra, ...quiet.slice(1), wf('.github/workflows/zz.yml', 'npm test')] } })).gh };
    expect(await loadFacts(early.gh, meta, now)).toMatchObject({ ciRunsTests: true });
  });

  it('pages commit history until 10 distinct authors are seen', async () => {
    const first = commits(Array.from({ length: 100 }, (_, i) => `dev${i % 3}`), 'c1');
    const { gh, calls } = fakeFacts(repo({ defaultBranchRef: { target: { history: first } } }), {
      c1: commits(Array.from({ length: 100 }, (_, i) => `p${i % 20}`), 'c2'),
      c2: commits(['late'], null),
    });
    expect(await loadFacts(gh, meta, now)).toMatchObject({ contributorsLastYear: 23 });
    expect(calls.length).toBe(2);
    expect(calls[1]).toEqual({ owner: 'big', name: 'repo', since: '2025-11-01T00:00:00.000Z', after: 'c1' });
  });

  it('stops after 300 commits', async () => {
    const same = (next: string) => commits(Array.from({ length: 100 }, () => 'solo'), next);
    const { gh, calls } = fakeFacts(repo({ defaultBranchRef: { target: { history: same('c1') } } }), { c1: same('c2'), c2: same('c3'), c3: same('c4') });
    expect(await loadFacts(gh, meta, now)).toMatchObject({ contributorsLastYear: 1 });
    expect(calls.length).toBe(3);
  });

  it('uses the commit email when the author has no GitHub user', async () => {
    const history = {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{ author: { email: 'a@x.dev', user: null } }, { author: { email: 'b@x.dev', user: null } }, { author: null }],
    };
    const { gh } = fakeFacts(repo({ defaultBranchRef: { target: { history } } }));
    expect(await loadFacts(gh, meta, now)).toMatchObject({ contributorsLastYear: 2 });
  });

  it('returns null for a repo that no longer resolves', async () => {
    const { gh } = fakeFacts(null);
    expect(await loadFacts(gh, meta, now)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/facts.test.ts`
Expected: FAIL, `Cannot find module '../src/collect/facts.js'`.

- [ ] **Step 3: Implement `src/collect/facts.ts`**

```ts
import type { GitHubApi } from '../github/client.js';
import { PY_TEST_FILES, ciRunsTests, detectJsTests, detectPyTests, type RepoFacts, type RepoMeta } from './qualify.js';

const DAY = 86_400_000;
const MAX_COMMITS = 300;
/** The contributor rule is "at least 10"; counting further never changes the result. */
const ENOUGH_AUTHORS = 10;
const MAX_WORKFLOWS = 10;

const HISTORY = 'pageInfo { hasNextPage endCursor } nodes { author { email user { login } } }';
const blob = (alias: string, path: string) => `${alias}: object(expression: "HEAD:${path}") { ... on Blob { text } }`;

const FACTS = `query($owner: String!, $name: String!, $since: GitTimestamp!) {
  repository(owner: $owner, name: $name) {
    workflows: object(expression: "HEAD:.github/workflows") { ... on Tree { entries { path type object { ... on Blob { text } } } } }
    ${blob('packageJson', 'package.json')}
    ${PY_TEST_FILES.map((f, i) => blob(`py${i}`, f)).join('\n    ')}
    defaultBranchRef { target { ... on Commit { history(first: 100, since: $since) { ${HISTORY} } } } }
  }
}`;

const MORE_HISTORY = `query($owner: String!, $name: String!, $since: GitTimestamp!, $after: String!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { target { ... on Commit { history(first: 100, since: $since, after: $after) { ${HISTORY} } } } }
  }
}`;

type Blob = { text?: string | null } | null | undefined;
interface History {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: { author: { email: string | null; user: { login: string } | null } | null }[];
}
interface Branch {
  defaultBranchRef: { target: { history?: History } | null } | null;
}
type FactsRepo = Branch & {
  workflows: { entries?: { path: string; type: string; object: Blob }[] } | null;
  packageJson: Blob;
  [alias: `py${number}`]: Blob;
};

const textOf = (b: Blob): string | null => (typeof b?.text === 'string' ? b.text : null);

/** Repo facts for the repo rules, from one GraphQL query (plus history pages when fewer than 10 authors are seen). */
export async function loadFacts(gh: GitHubApi, meta: RepoMeta, now: Date): Promise<RepoFacts | null> {
  const [owner, name] = meta.fullName.split('/') as [string, string];
  const since = new Date(now.getTime() - 365 * DAY).toISOString();
  const r = (await gh.graphql<{ repository: FactsRepo | null }>(FACTS, { owner, name, since })).repository;
  if (!r) return null;

  const workflowTexts = (r.workflows?.entries ?? [])
    .filter((e) => e.type === 'blob' && /\.ya?ml$/.test(e.path))
    .slice(0, MAX_WORKFLOWS)
    .map((e) => textOf(e.object))
    .filter((t): t is string => t !== null);

  let hasJsTests = false;
  const pkg = textOf(r.packageJson);
  if (pkg) {
    try {
      hasJsTests = detectJsTests(JSON.parse(pkg));
    } catch {
      hasJsTests = false;
    }
  }
  const hasPyTests = !hasJsTests && detectPyTests(Object.fromEntries(PY_TEST_FILES.map((f, i) => [f, textOf(r[`py${i}`])])));

  const authors = new Set<string>();
  let history = r.defaultBranchRef?.target?.history;
  let seen = 0;
  while (history) {
    for (const n of history.nodes) {
      const id = n.author?.user?.login ?? n.author?.email ?? '';
      if (id) authors.add(id);
    }
    seen += history.nodes.length;
    if (authors.size >= ENOUGH_AUTHORS || seen >= MAX_COMMITS || !history.pageInfo.hasNextPage) break;
    const more = await gh.graphql<{ repository: Branch | null }>(MORE_HISTORY, { owner, name, since, after: history.pageInfo.endCursor });
    history = more.repository?.defaultBranchRef?.target?.history;
  }

  return { ...meta, contributorsLastYear: authors.size, ciRunsTests: ciRunsTests(workflowTexts), hasJsTests, hasPyTests };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/facts.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/collect/facts.ts test/facts.test.ts
git commit -m "feat: repo facts from one GraphQL query, stopping the author count at 10

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Lazy seeded selection

**Files:**
- Modify: `src/collect/select.ts` (`selectAgentPrs` only)
- Modify: `test/select.test.ts` (the `selectAgentPrs` describe block)
- Modify: `src/collect/index.ts` (temporary adapter so the existing pipeline still compiles and passes until Task 6)

**Interfaces:**
- Consumes: `shuffle`, `rngFor`, `byCodeUnit` from `src/rng.ts`.
- Produces:
  - `interface SelectOptions { perAgent: number; perRepo: number; seed: string; excludedPrs?: Set<string> }`
  - `selectAgentPrs(hits: Map<AgentId, Set<string>>, evaluate: (key: string) => Promise<Candidate | null>, opts: SelectOptions, onExamine?: (agent: AgentId) => void): Promise<Candidate[]>`

- [ ] **Step 1: Write the failing tests**

In `test/select.test.ts`:
- Add `import { rngFor, shuffle } from '../src/rng.js';`.
- Replace the whole `describe('selectAgentPrs', …)` block with:

```ts
const keyOf = (c: Candidate) => `${c.pr.repo}#${c.pr.number}`;
const hitsOf = (cands: Candidate[]) => {
  const m = new Map<AgentId, Set<string>>();
  for (const c of cands) m.set(c.agent, (m.get(c.agent) ?? new Set()).add(keyOf(c)));
  return m;
};
const lookup = (cands: Candidate[]) => {
  const m = new Map(cands.map((c) => [keyOf(c), c]));
  return async (k: string) => m.get(k) ?? null;
};
const opts = { perAgent: 3, perRepo: 3, seed: 's' };

describe('selectAgentPrs', () => {
  it('caps per agent and per repo (across agents), deterministically', async () => {
    const cands = [
      ...Array.from({ length: 10 }, (_, i) => cand('copilot', `r${i % 2}/x`, i)),
      ...Array.from({ length: 4 }, (_, i) => cand('codex', 'r0/x', 100 + i)),
    ];
    const s1 = await selectAgentPrs(hitsOf(cands), lookup(cands), opts);
    const s2 = await selectAgentPrs(hitsOf([...cands].reverse()), lookup(cands), opts);
    expect(s1.map((c) => c.pr.number)).toEqual(s2.map((c) => c.pr.number));
    expect(s1.filter((c) => c.agent === 'copilot').length).toBe(3);
    expect(s1.filter((c) => c.pr.repo === 'r0/x').length).toBe(3);
    expect(s1.filter((c) => c.agent === 'codex').length).toBeGreaterThanOrEqual(1);
  });

  it("takes each agent's hits in the seeded order of its sorted keys", async () => {
    const cands = Array.from({ length: 8 }, (_, i) => cand('copilot', `r${i}/x`, i));
    const want = shuffle(cands.map(keyOf).sort(), rngFor('s:copilot')).slice(0, 3);
    const got = await selectAgentPrs(hitsOf(cands), lookup(cands), opts);
    expect(got.map(keyOf)).toEqual(want);
  });

  it('skips excluded hits and hits in a full repo without evaluating them', async () => {
    const cands = Array.from({ length: 5 }, (_, i) => cand('copilot', 'r0/x', i));
    const evaluated: string[] = [];
    const find = lookup(cands);
    const got = await selectAgentPrs(hitsOf(cands), async (k) => { evaluated.push(k); return find(k); }, {
      perAgent: 5, perRepo: 2, seed: 's', excludedPrs: new Set(['r0/x#0']),
    });
    expect(got.length).toBe(2);
    expect(evaluated.length).toBe(2);
    expect(evaluated).not.toContain('r0/x#0');
  });

  it('evaluates a PR found by two agents once and accepts it only for the agent it is attributed to', async () => {
    const c = cand('codex', 'o/r', 1);
    const hits = new Map<AgentId, Set<string>>([['copilot', new Set(['o/r#1'])], ['codex', new Set(['o/r#1'])]]);
    let n = 0;
    const examined: AgentId[] = [];
    const got = await selectAgentPrs(hits, async () => { n++; return c; }, opts, (a) => examined.push(a));
    expect(got).toEqual([c]);
    expect(n).toBe(1);
    expect(examined).toEqual(['copilot', 'codex']);
  });

  it('stops evaluating once the agent is full', async () => {
    const cands = Array.from({ length: 10 }, (_, i) => cand('copilot', `r${i}/x`, i));
    let n = 0;
    const find = lookup(cands);
    const got = await selectAgentPrs(hitsOf(cands), async (k) => { n++; return find(k); }, { ...opts, perAgent: 2 });
    expect(got.length).toBe(2);
    expect(n).toBe(2);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/select.test.ts`
Expected: FAIL. The old `selectAgentPrs` takes a candidate array, so the calls throw or return wrong results.

- [ ] **Step 3: Implement**

In `src/collect/select.ts`, replace `selectAgentPrs` with:

```ts
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
```

The `key` helper stays (it is used by `matchHumans`).

In `src/collect/index.ts`, adapt the one call so the existing pipeline compiles until Task 6 rewrites it. Replace

```ts
  const selected = selectAgentPrs(candidates, { perAgent: o.perAgent, perRepo: o.perRepo, seed: o.seed });
```

with

```ts
  const byKey = new Map(candidates.map((c) => [`${c.pr.repo}#${c.pr.number}`, c]));
  const candidateHits = new Map<AgentId, Set<string>>(AGENT_IDS.map((a) => [a, new Set<string>()]));
  for (const [k, c] of byKey) candidateHits.get(c.agent)!.add(k);
  const selected = await selectAgentPrs(candidateHits, async (k) => byKey.get(k) ?? null, {
    perAgent: o.perAgent, perRepo: o.perRepo, seed: o.seed,
  });
```

Also add `type AgentId` to the `../types.js` import in `src/collect/index.ts`.

- [ ] **Step 4: Run all tests to verify they pass**

Run: `npm test && npm run typecheck`
Expected: PASS, including the unchanged `test/collect.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/collect/select.ts src/collect/index.ts test/select.test.ts
git commit -m "feat: seeded round-robin selection that evaluates hits only as needed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Repo-first pipeline, new summary, progress logs

**Files:**
- Modify: `src/collect/index.ts` (full rewrite below)
- Modify: `src/github/client.ts` (remove REST `search`, `SearchItem`)
- Modify: `test/github-client.test.ts` (remove the REST search test)
- Modify: `test/collect.test.ts` (full rewrite of the `collect` and `collect edge cases` blocks)

**Interfaces:**
- Consumes:
  - `listRepos` (Task 2), `searchAgentPrs` (Task 3), `loadFacts` (Task 4), `selectAgentPrs` (Task 5);
  - `matchHumans`, `toEntry` (unchanged);
  - `attribute`, `extractModel`, `hasAgentMarker` from `agents.ts`;
  - `prReasons`, `repoReasons` from `qualify.ts`.
- Produces: `collect(gh, o: CollectOptions)` with the new `CollectSummary`:

```ts
export interface CollectSummary {
  window: { since: string; until: string };
  reposListed: number;
  searchHits: Record<AgentId, number>;
  uniqueHits: number;
  examined: Record<AgentId, number>;
  reposChecked: number;
  reposQualified: number;
  ambiguous: number;
  selected: Record<AgentId, number>;
  humansSelected: number;
  humanShortfall: number;
  insufficient: string[];
}
```

`loadPr` stays exported and unchanged. `weekSlices` is removed.

- [ ] **Step 1: Write the failing tests**

Replace the top of `test/collect.test.ts` (imports through the end of the `describe('collect', …)` block) and the `describe('collect edge cases', …)` block. Keep the `describe('excluded manifests', …)` and `describe('collect option validation', …)` blocks unchanged. The resulting file:

```ts
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addPaths, excludedPrIds, parsePositiveInt, parseYmd } from '../src/collect/command.js';
import { collect } from '../src/collect/index.js';
import { NotFoundError, type GitHubApi } from '../src/github/client.js';
import { writeJsonl } from '../src/jsonl.js';

const now = new Date('2026-11-01T00:00:00Z');
const COPILOT = 'author:app/copilot-swe-agent';
type Hit = { q: string; repo: string; number: number };

const repoNode = (name: string, stars: number) => ({
  nameWithOwner: name, stargazerCount: stars, isFork: false, isArchived: false,
  pushedAt: '2026-10-30T00:00:00Z', primaryLanguage: { name: 'TypeScript' },
});
const REPOS = [repoNode('big/repo', 5000), repoNode('tiny/repo', 3)];
const FACTS: Record<string, unknown> = {
  'big/repo': {
    workflows: { entries: [{ path: '.github/workflows/ci.yml', type: 'blob', object: { text: 'steps:\n  - run: npm test\n' } }] },
    packageJson: { text: JSON.stringify({ devDependencies: { vitest: '^3' } }) },
    defaultBranchRef: { target: { history: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: Array.from({ length: 12 }, (_, i) => ({ author: { email: null, user: { login: `dev${i}` } } })),
    } } },
  },
};

/** REST routes serve PR loads and human pools; GraphQL serves the repo list, the agent PR search (`hits`) and repo facts. */
function fakeApi(routes: Record<string, unknown>, hits: Hit[]) {
  const gets: string[] = [];
  const get = async <T>(path: string): Promise<T> => {
    gets.push(path);
    const k = path.split('?')[0]!;
    if (!(k in routes)) throw new NotFoundError(path);
    return routes[k] as T;
  };
  const graphql = async <T>(query: string, vars: Record<string, unknown>): Promise<T> => {
    const done = { hasNextPage: false, endCursor: null };
    if (query.includes('type: REPOSITORY')) return { search: { repositoryCount: REPOS.length, pageInfo: done, nodes: REPOS } } as T;
    if (query.includes('type: ISSUE')) {
      const q = vars.q as string;
      const tokens = new Set(q.split(' '));
      const nodes = hits
        .filter((h) => q.startsWith(`${h.q} is:pr`) && tokens.has(`repo:${h.repo}`))
        .map((h) => ({ number: h.number, repository: { nameWithOwner: h.repo } }));
      return { search: { issueCount: nodes.length, pageInfo: done, nodes } } as T;
    }
    return { repository: FACTS[`${vars.owner}/${vars.name}`] ?? null } as T;
  };
  const gh: GitHubApi = { get, paginate: get, graphql };
  return { gh, gets };
}

const pull = (n: number, p: Record<string, unknown>) => ({
  number: n, title: `PR ${n}`, user: { login: 'alice', type: 'User' }, merged_by: { login: 'maint' },
  merged_at: '2026-10-10T00:00:00Z', base: { ref: 'main', sha: `base${n}` }, head: { ref: `branch${n}`, sha: `head${n}` }, body: '', ...p,
});

const routes: Record<string, unknown> = {
  '/repos/big/repo/pulls/1': pull(1, { user: { login: 'Copilot', type: 'Bot' }, head: { ref: 'copilot/fix', sha: 'head1' } }),
  '/repos/big/repo/pulls/1/files': [{ filename: 'src/a.ts' }],
  '/repos/big/repo/pulls/1/commits': [{ commit: { message: 'fix' } }],
  '/repos/big/repo/pulls': [
    { number: 1, user: { login: 'Copilot', type: 'Bot' }, merged_at: '2026-10-10T00:00:00Z' },
    { number: 5, user: { login: 'alice', type: 'User' }, merged_at: '2026-10-11T00:00:00Z' },
    { number: 6, user: { login: 'bob', type: 'User' }, merged_at: null },
  ],
  '/repos/big/repo/pulls/5': pull(5, {}),
  '/repos/big/repo/pulls/5/files': [{ filename: 'src/b.ts' }],
  '/repos/big/repo/pulls/5/commits': [{ commit: { message: 'feat: b' } }],
};

const base = { until: now, days: 90, perAgent: 80, perRepo: 3, seed: 's', now, excluded: new Set<string>(), minPerAgent: 30 };

describe('collect', () => {
  it('selects qualifying agent PRs plus matched human PRs from the same repos', async () => {
    const { gh } = fakeApi(routes, [{ q: COPILOT, repo: 'big/repo', number: 1 }, { q: COPILOT, repo: 'tiny/repo', number: 2 }]);
    const { entries, summary } = await collect(gh, base);
    expect(entries.map((e) => [e.id, e.group, e.agent])).toEqual([
      ['big/repo#1', 'agent', 'copilot'],
      ['big/repo#5', 'human', null],
    ]);
    expect(entries[0]).toMatchObject({ baseSha: 'base1', headSha: 'head1', repoStars: 5000, repoLanguage: 'TypeScript' });
    expect(entries[0]!.attribution.evidence).toEqual(['author:Copilot', 'branch:copilot/']);
    expect(summary).toMatchObject({
      window: { since: '2026-08-03', until: '2026-11-01' },
      reposListed: 1, uniqueHits: 1, reposChecked: 1, reposQualified: 1, ambiguous: 0, humansSelected: 1, humanShortfall: 0,
    });
    expect(summary.searchHits.copilot).toBe(1);
    expect(summary.examined.copilot).toBe(1);
    expect(summary.selected.copilot).toBe(1);
    expect(summary.insufficient).toContain('copilot');
  });

  it('stops loading agent PRs once the agent has enough', async () => {
    const r = {
      ...routes,
      '/repos/big/repo/pulls/3': pull(3, { user: { login: 'Copilot', type: 'Bot' }, head: { ref: 'copilot/other', sha: 'head3' } }),
      '/repos/big/repo/pulls/3/files': [{ filename: 'src/c.ts' }],
      '/repos/big/repo/pulls/3/commits': [{ commit: { message: 'fix' } }],
    };
    const { gh, gets } = fakeApi(r, [1, 3].map((number) => ({ q: COPILOT, repo: 'big/repo', number })));
    const { summary } = await collect(gh, { ...base, perAgent: 1 });
    expect(summary.selected.copilot).toBe(1);
    expect(summary.examined.copilot).toBe(1);
    expect(gets.filter((p) => /^\/repos\/big\/repo\/pulls\/[13]$/.test(p)).length).toBe(1);
  });

  it('logs each phase', async () => {
    const { gh } = fakeApi(routes, [{ q: COPILOT, repo: 'big/repo', number: 1 }]);
    const lines: string[] = [];
    await collect(gh, { ...base, log: (m) => lines.push(m) });
    expect(lines[0]).toMatch(/^listed 1 repos/);
    expect(lines.some((l) => l.startsWith('searched batch 1/1:'))).toBe(true);
    expect(lines).toContain('selected 1 agent PRs; matching human PRs in 1 repos');
    expect(lines).toContain('matched 1 human PRs (shortfall 0)');
  });

  it('skips PRs listed in an excluded (pilot) manifest, as candidates and as human matches', async () => {
    const { gh } = fakeApi(routes, [{ q: COPILOT, repo: 'big/repo', number: 1 }]);
    const noHuman = await collect(gh, { ...base, excludedPrs: new Set(['big/repo#5']) });
    expect(noHuman.entries.map((e) => e.id)).toEqual(['big/repo#1']);
    expect(noHuman.summary.humanShortfall).toBe(1);
    const noAgent = await collect(gh, { ...base, excludedPrs: new Set(['big/repo#1']) });
    expect(noAgent.entries).toEqual([]);
  });
});

describe('collect edge cases', () => {
  it('counts a PR with markers of two agents as ambiguous and does not select it', async () => {
    const r = {
      ...routes,
      '/repos/big/repo/pulls/2': pull(2, { head: { ref: 'codex/fix', sha: 'head2' }, body: 'Generated with Claude Code' }),
      '/repos/big/repo/pulls/2/files': [{ filename: 'src/c.ts' }],
      '/repos/big/repo/pulls/2/commits': [{ commit: { message: 'fix' } }],
    };
    const { gh } = fakeApi(r, [{ q: 'head:codex', repo: 'big/repo', number: 2 }]);
    const { entries, summary } = await collect(gh, base);
    expect(summary.ambiguous).toBe(1);
    expect(entries).toEqual([]);
    expect(summary.examined.codex).toBe(1);
    expect(summary.selected.codex).toBe(0);
    expect(summary.selected['claude-code']).toBe(0);
  });

  it('rejects a User-authored PR on a codex/ branch from the human pool', async () => {
    const r = {
      ...routes,
      '/repos/big/repo/pulls': [
        { number: 1, user: { login: 'Copilot', type: 'Bot' }, merged_at: '2026-10-10T00:00:00Z' },
        { number: 7, user: { login: 'carol', type: 'User' }, merged_at: '2026-10-12T00:00:00Z' },
      ],
      '/repos/big/repo/pulls/7': pull(7, { user: { login: 'carol', type: 'User' }, head: { ref: 'codex/tweak', sha: 'head7' } }),
      '/repos/big/repo/pulls/7/files': [{ filename: 'src/d.ts' }],
      '/repos/big/repo/pulls/7/commits': [{ commit: { message: 'tweak' } }],
    };
    const { gh } = fakeApi(r, [{ q: COPILOT, repo: 'big/repo', number: 1 }]);
    const { entries, summary } = await collect(gh, base);
    expect(entries.map((e) => e.id)).toEqual(['big/repo#1']);
    expect(summary.humansSelected).toBe(0);
    expect(summary.humanShortfall).toBe(1);
  });
});
```

(The `describe('excluded manifests', …)` and `describe('collect option validation', …)` blocks follow, unchanged.)

In `test/github-client.test.ts`, delete the test `'searches issues, maps repo and number, and throttles'`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/collect.test.ts`
Expected: FAIL. The pipeline still calls `gh.search` (`gh.search is not a function`), and the summary lacks `reposListed`.

- [ ] **Step 3: Implement**

Rewrite `src/collect/index.ts`:

```ts
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
```

In `src/github/client.ts`:
- delete the `SearchItem` interface;
- delete the `search(q: string, maxPages?: number): Promise<SearchItem[]>;` line in `GitHubApi`;
- delete the `async search(…)` method of `GitHub`. Keep `throttleSearch`, which `graphql` uses.

Then confirm nothing else references the removed names:

Run: `grep -rn "weekSlices\|SearchItem\|gh\.search\|\.search(" src test`
Expected: no output.

- [ ] **Step 4: Run all tests and the typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/collect/index.ts src/github/client.ts test/collect.test.ts test/github-client.test.ts
git commit -m "fix: collect lists qualifying repos first and loads PRs only as selection needs them

The pilot collect run timed out after 5h30m: it qualified all ~104k search
hits before selecting 20 per agent, and weekly searches were capped at 1,000
results. Collect now lists repos by star-sliced search, searches agent PRs in
40-repo batches with no truncation, and evaluates hits in seeded order.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Workflow keeps its cache and gives collect a step timeout

**Files:**
- Modify: `.github/workflows/collect.yml`
- Modify: `test/collect-workflow.test.ts`

**Interfaces:** none (workflow only).

- [ ] **Step 1: Write the failing tests**

In `test/collect-workflow.test.ts`, replace the test `'pins every action to a commit SHA'` with:

```ts
  it('pins every action to a commit SHA', async () => {
    const uses = (await load('collect.yml')).match(/uses: .*/g)!;
    expect(uses.length).toBe(4);
    for (const u of uses) expect(u).toMatch(/^uses: actions\/(checkout|setup-node|cache\/restore|cache\/save)@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  });
```

and add, inside `describe('collect.yml', …)`:

```ts
  it('restores the API cache by date and saves it even when collect fails or times out', async () => {
    const yml = await load('collect.yml');
    const key = 'key: github-api-${{ env.UNTIL }}-${{ github.run_id }}-${{ github.run_attempt }}';
    expect(yml.split(key).length - 1).toBe(2);
    expect(yml).toContain('restore-keys: github-api-${{ env.UNTIL }}-');
    const restoreAt = yml.indexOf('name: Restore the API cache');
    const collectAt = yml.indexOf('name: Collect');
    const saveAt = yml.indexOf('name: Save the API cache');
    expect(restoreAt).toBeGreaterThan(-1);
    expect(restoreAt).toBeLessThan(collectAt);
    expect(saveAt).toBeGreaterThan(collectAt);
    expect(saveAt).toBeLessThan(yml.indexOf('name: Commit the manifest'));
    expect(yml.slice(saveAt, saveAt + 200)).toMatch(/\n\s+if: always\(\) && env\.UNTIL != ''\n/);
  });

  it('gives the collect step its own timeout inside the job timeout', async () => {
    const yml = await load('collect.yml');
    expect(yml).toMatch(/^ {4}timeout-minutes: 350$/m);
    const step = yml.slice(yml.indexOf('name: Collect'), yml.indexOf('name: Save the API cache'));
    expect(step).toMatch(/^ {8}timeout-minutes: 320$/m);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/collect-workflow.test.ts`
Expected: FAIL. There are 3 `uses:` lines, and there is no restore/save step and no timeouts.

- [ ] **Step 3: Implement**

In `.github/workflows/collect.yml`:

1. Change `    timeout-minutes: 330` to `    timeout-minutes: 350`.
2. Replace the cache step

```yaml
      - uses: actions/cache@0400d5f644dc74513175e3cd8d07132dd4860809 # v4.2.4
        with:
          path: cache/github
          key: github-api-${{ env.UNTIL }}
```

with

```yaml
      # One cache per run; a rerun with the same until restores the newest one, so a failed or timed-out run resumes.
      - name: Restore the API cache
        uses: actions/cache/restore@0400d5f644dc74513175e3cd8d07132dd4860809 # v4.2.4
        with:
          path: cache/github
          key: github-api-${{ env.UNTIL }}-${{ github.run_id }}-${{ github.run_attempt }}
          restore-keys: github-api-${{ env.UNTIL }}-
```

3. Add `timeout-minutes: 320` to the Collect step, directly under `- name: Collect`:

```yaml
      - name: Collect
        timeout-minutes: 320
        env:
```

4. Insert after the Collect step and before `- name: Commit the manifest`:

```yaml
      - name: Save the API cache
        if: always() && env.UNTIL != ''
        uses: actions/cache/save@0400d5f644dc74513175e3cd8d07132dd4860809 # v4.2.4
        with:
          path: cache/github
          key: github-api-${{ env.UNTIL }}-${{ github.run_id }}-${{ github.run_attempt }}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/collect-workflow.test.ts`
Expected: PASS, including the existing `github-api-${{ env.UNTIL }}` and ingest-pin tests.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/collect.yml test/collect-workflow.test.ts
git commit -m "fix: collect workflow saves its API cache even on failure and gives collect a step timeout

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Pre-registration and README match the code

**Files:**
- Modify: `PREREGISTRATION.md`
- Modify: `README.md`

**Interfaces:** none.

- [ ] **Step 1: Edit `PREREGISTRATION.md`**

1. In the `- Repos:` line, replace `≥ 1,000 stars; ` with `≥ 1,000 stars; primary language (as GitHub reports it) TypeScript, JavaScript, Python, Vue or Svelte; `.
2. In the `- Agent PRs:` line, replace the final sentence `At most 3 agent PRs per repo and 80 per agent, chosen by seeded round-robin across agents.` with:

   `Candidates are the PRs that an agent's search queries (below) find in the qualifying repos; a PR is a candidate only for an agent whose queries found it. At most 3 agent PRs per repo and 80 per agent, chosen by seeded round-robin across agents: each agent's hits are shuffled with the seed and examined in that order until 80 pass or the hits run out, and a hit whose repo already has 3 selected agent PRs is skipped.`

3. After the markers table row `| jules | author \`google-labs-jules[bot]\` | to fill in after the pilot |`, add a blank line and:

   ``Search queries, each combined with `is:pr is:merged merged:<window>` and a batch of repos: copilot `author:app/copilot-swe-agent`; codex `"chatgpt.com/codex" in:body`, `head:codex`; claude-code `"Generated with Claude Code" in:body`, `author:app/claude`; cursor `head:cursor`, `"Cursor Agent" in:body`; devin `author:app/devin-ai-integration`; jules `author:app/google-labs-jules`.``

4. Under `### Collection limits`, replace the first bullet with:

   `- Distinct commit authors (used for the repo's contributor count) are counted over at most 300 commits from the past 365 days, stopping once 10 are seen.`

   and add as the first bullet:

   `- No search result is truncated. Repos are listed by GitHub repository search, split by star range until no query has more than 1,000 results. Agent PRs are searched in batches of 40 repos, and a query with more than 1,000 results is split, first by repos and then by window, until none has.`

- [ ] **Step 2: Edit `README.md`**

1. After the sentence `A failed collect run can be rerun.` insert: `Every run saves its GitHub API cache, even when it fails or times out, so a rerun with the same \`until\` picks up where the last one stopped. A pilot collect takes about 1.5 hours and a full one about 3 to 3.5 hours.`
2. Replace `` `manifests/<name>.summary.json`: counts from collection.`` with `` `manifests/<name>.summary.json`: counts from collection (repos listed, search hits, PRs examined and selected per agent, human matches and shortfall).``

- [ ] **Step 3: Check that the docs match the code**

Run: `grep -n "language:\|BATCH\|ENOUGH_AUTHORS\|MAX_COMMITS" src/collect/*.ts`
Then confirm the numbers in the two docs (40 repos, 1,000 results, 300 commits, 10 authors, five languages) match the code. Confirm the search queries match `src/collect/agents.ts`:

Run: `grep -n "queries:" src/collect/agents.ts`

- [ ] **Step 4: Commit**

```bash
git add PREREGISTRATION.md README.md
git commit -m "docs: pre-registration and README describe repo-first collection

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Live smoke check of every GraphQL query

The fakes can't catch a GraphQL syntax or schema mistake. This task runs each query once against the real API with the user's token (read-only, about 150 GraphQL points). It does not commit anything.

**Files:**
- Create (scratch, not committed): `<scratchpad>/smoke.ts`

- [ ] **Step 1: Write the smoke script**

```ts
import { GitHub } from '/Users/Almog/Desktop/trustbut-index/src/github/client.js';
import { listRepos } from '/Users/Almog/Desktop/trustbut-index/src/collect/repos.js';
import { searchAgentPrs } from '/Users/Almog/Desktop/trustbut-index/src/collect/search.js';
import { loadFacts } from '/Users/Almog/Desktop/trustbut-index/src/collect/facts.js';
import { repoReasons } from '/Users/Almog/Desktop/trustbut-index/src/collect/qualify.js';

const gh = new GitHub({ token: process.env.GITHUB_TOKEN, cacheDir: process.argv[2] });
const now = new Date();
const t0 = Date.now();
const repos = await listRepos(gh, { now, excluded: new Set() });
console.log('repos', repos.length, 'in', Math.round((Date.now() - t0) / 1000), 's; first', repos[0]);
const batch = repos.slice(0, 40).map((r) => r.fullName);
const until = now.toISOString().slice(0, 10);
const since = new Date(now.getTime() - 90 * 86_400_000).toISOString().slice(0, 10);
const hits = await searchAgentPrs(gh, batch, { since, until }, console.log);
console.log(Object.fromEntries([...hits].map(([a, s]) => [a, s.size])));
for (const m of repos.slice(0, 5)) {
  const f = await loadFacts(gh, m, now);
  console.log(m.fullName, f && { contributors: f.contributorsLastYear, ci: f.ciRunsTests, js: f.hasJsTests, py: f.hasPyTests, reasons: repoReasons(f, now, new Set()) });
}
console.log(gh.rateRemaining());
```

- [ ] **Step 2: Run it**

Run: `cd /Users/Almog/Desktop/trustbut-index && GITHUB_TOKEN=$(gh auth token) npx tsx <scratchpad>/smoke.ts <scratchpad>/smoke-cache`
Expected:
- About 9,000 repos listed.
- The search logs one batch with non-zero hits for at least copilot and claude-code.
- Five facts lines with plausible values.
- No `GitHub GraphQL:` errors.

If a query fails, fix it test-first in its task's file and commit as `fix:`.

- [ ] **Step 3: Cross-check facts against the old REST path for one repo**

Run `loadFacts` for vitest-dev/vitest (add it to the smoke script's facts loop) and compare it with a manual REST check:

- `gh api repos/vitest-dev/vitest/contents/.github/workflows --jq '.[].name'`: the first 10 `.yml` names should match the GraphQL tree order.
- `gh api repos/vitest-dev/vitest/contents/package.json --jq .name`: it exists.

Record any difference in the spec's `## As built`.

---

### Task 10: Full verification and finish

- [ ] **Step 1:** Run `npm test && npm run typecheck`. All tests must pass.
- [ ] **Step 2:** In `docs/superpowers/specs/2026-10-15-repo-first-collect-design.md`, set the status to `**Status:** Implemented (YYYY-MM-DD)` and add `## As built`. List every place the code differs from the spec, or "none".
- [ ] **Step 3:** Commit `docs: repo-first collect spec as built`.
- [ ] **Step 4:** Use superpowers:finishing-a-development-branch. Open a PR against `main`, whose body explains the timeout root cause and links the cancelled run https://github.com/isAlmogK/trustbut-index/actions/runs/38631670279.
- [ ] **Step 5:** After merge, the user starts the pilot from Actions (collect, pilot = true). If it runs over, rerun with the same `until`.
