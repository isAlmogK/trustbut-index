# Repo-first collect

**Status:** Approved (2026-10-15)
**Study design:** [agent test-honesty index design](https://github.com/isAlmogK/trustbut/blob/main/docs/superpowers/specs/2026-10-14-agent-test-honesty-index-design.md) in trustbut. This spec changes only how `collect` builds its candidate pool and how the collect workflow runs.

## Problem

The first pilot `collect` run (Actions run 38631670279, 2026-10-14) was cancelled after 5h30m by the job's `timeout-minutes: 330`. Its log ends with "The operation was canceled." and nothing was committed.

- **Search** took 1h25m. It ran each agent query over 13 weekly slices of the 90-day window and found 103,925 unique PRs.
- **Qualification** then ran for 4h05m with no log output. `collect` qualifies the repo and loads every hit before selecting 20 per agent: a repo lookup, about 12 to 15 REST calls of repo facts, and 3 calls per PR. That is several hundred thousand REST calls against a 5,000/hour limit, about 60+ hours.
- **Cache:** `actions/cache` saves only on success, so the API responses from 5.5 hours were lost.

Two measurements show the design, not only the run time, needs to change.

1. **Almost every hit is wasted.** In a sample of 180 repos from three agents' search hits, 2 had ≥ 1,000 stars. 98% of the work went to repos that fail the first rule.
2. **The search is truncated.** GitHub search returns at most 1,000 results per query. One day of `author:app/copilot-swe-agent` merged public PRs has about 1,900 results; one day of `"Generated with Claude Code" in:body` has about 77,000. Weekly slices therefore saw at most 1,000 of each agent's PRs per week, in GitHub's best-match order. The pool was not the population `PREREGISTRATION.md` describes.

## Design

Start from the repos instead of the PRs. The repos that pass the cheap rules are few (9,267 on 2026-10-15), so searching agent PRs inside them in small batches never hits the 1,000 cap. Selection then loads PRs one at a time in seeded order and stops when each agent has enough.

### 1. Repo list (`src/collect/repos.ts`)

`listRepos(gh, { now, excluded })` runs a GraphQL repository search:

```
is:public stars:<range> pushed:>=<now − 30 days> fork:false archived:false language:TypeScript language:JavaScript language:Python language:Vue language:Svelte
```

The language qualifiers combine as OR (checked: 9,267 repos for the five together). Each node returns `nameWithOwner`, `stargazerCount`, `isFork`, `isArchived`, `pushedAt` and `primaryLanguage`, which replaces the per-repo `/repos/{repo}` lookup.

- **Star slicing.** The first range is `>=1000`. A range whose `repositoryCount` is over 1,000 is split. An open range `>=lo` becomes `lo..2lo−1` and `>=2lo`. A closed range `lo..hi` becomes two halves. A single star value with over 1,000 repos throws an error naming the range.
- **Paging.** 100 per page, by cursor, until `hasNextPage` is false.
- **Result.** Deduplicated by `nameWithOwner` (star counts can move a repo between slices during a run). `repoMetaReasons` then filters the result exactly as today, including `excluded-repos.txt`. Sorted by code unit.

Cost: about 120 GraphQL points.

### 2. Agent PR search (`src/collect/search.ts`)

`searchAgentPrs(gh, repos, window)` returns, for each agent, the set of PR keys (`owner/name#n`) its queries found.

- Repos are chunked in list order, 40 per batch. A 40-repo batch returned exactly the sum of its 40 single-repo counts (187), so `repo:` qualifiers combine as OR with nothing dropped.
- For each batch, agent (in `AGENTS` order) and agent query, it runs one GraphQL issue search:
  `<query> is:pr is:merged merged:<since>..<until> repo:a repo:b …`
  `since` and `until` are whole UTC days, as today.
- **Over 1,000 results:** a batch of more than one repo is split in half and each half searched. A single repo has its window split in half by days. A single repo on a single day with over 1,000 results throws an error.
- **Paging:** 100 per page, by cursor. Each node returns only `number` and `repository.nameWithOwner`.
- `OR` inside a query is not supported by search (checked), so each agent query is its own search.
- **Throttle:** at least 1 second between GraphQL searches. 40 sequential searches ran at about 1 per second with no rate-limit response.

Cost: 232 batches × 9 queries ≈ 2,100 searches, plus extra pages for busy batches. About 1 hour.

The REST `search()` method and `weekSlices` are removed, since nothing else uses them.

### 3. Seeded selection that loads only what it needs (`src/collect/select.ts`)

`selectAgentPrs` becomes async and takes the per-agent hit lists and an `evaluate(key)` callback instead of a full candidate list.

- Each agent's hits are sorted by code unit and shuffled with `rngFor(<seed>:<agent>)`, the same seed key as today.
- **Round-robin.** The loop runs across agents in `AGENT_IDS` order, the same as today. On its turn, an agent below `perAgent` takes hits from its queue until one is accepted or the queue is empty.
- **A hit is skipped without any API call** if:
  - it is in `excludedPrs`;
  - its repo already has `perRepo` selected PRs;
  - it is already selected.
- **Otherwise `evaluate` decides,** memoized per key, so a PR found by two agents' queries loads once. It:
  1. qualifies the repo (cached per repo);
  2. loads the PR (`loadPr`, REST, unchanged);
  3. applies `prReasons`;
  4. attributes the PR with `attribute`.
  It returns a `Candidate` or null. An ambiguous PR is counted once and returns null.
- **The hit is accepted** when `evaluate` returns a candidate whose `agent` is the agent whose turn it is.

This is today's algorithm applied to a lazily filtered queue. Filtering a seeded random order keeps it a seeded random order of the qualifying PRs, so the outcome has the same distribution. Today's code also skips a candidate whose repo is full; the new code does it before loading. The one change in meaning: a PR is a candidate only for an agent whose own queries found it. Before, a PR found by agent A's query but carrying only agent B's markers joined B's pool. Such a PR is rare (search queries mirror the markers), and the pre-registration now states the rule.

### 4. Repo facts in one GraphQL query

`loadFacts` makes one GraphQL query per repo instead of about 12 to 15 REST calls. Checked on vitest-dev/vitest: cost 1.

- `object(expression: "HEAD:.github/workflows")`: the tree entries with blob text. Entries with `type: blob` and a `.yml` or `.yaml` path, the first 10 in tree order, feed `ciRunsTests`, as today.
- `object(expression: "HEAD:package.json")` and one aliased `object` per `PY_TEST_FILES` entry: blob text or null. `detectJsTests` and `detectPyTests` apply as today. The Python files are now always fetched, which costs nothing extra. The pass or fail result is unchanged.
- `defaultBranchRef.target.history(first: 100, since: <now − 365 days>)`: the author identity is `user.login ?? email`, the same as today's REST rule `author.login ?? commit.author.email`. Paging stops at 300 commits, as today, or as soon as 10 distinct authors are seen. The rule is "≥ 10", so stopping early never changes the result. `contributorsLastYear` becomes a lower bound and is not written to the manifest.
- A null `repository` (deleted, renamed or private since listing) means the repo does not qualify.

### 5. GitHub client

`GitHubApi` gains `graphql<T>(query: string, variables: Record<string, unknown>, opts?: { search?: boolean }): Promise<T>`:

- **Request:** `POST /graphql` with the same headers as REST.
- **Cache:** on disk, keyed by `sha1(query + JSON.stringify(variables))`, in the same per-collection cache folder.
- **Retries:**
  - an HTTP 403 or 429 rate limit uses the existing `retryWait` rules;
  - a 200 response whose `errors` include `type: "RATE_LIMITED"` waits until `x-ratelimit-reset`;
  - any other `errors` entry throws an error with the messages.
- **Search throttle:** uncached calls made with `{ search: true }` (repo list and agent PR search) are spaced at least `searchIntervalMs` apart. The default changes from 3000 to 1000, because the REST search it was tuned for is removed.
- **Rate limits:** the client keeps the last seen `x-ratelimit-remaining` for REST and GraphQL and exposes it as `rateRemaining(): { rest?: number; graphql?: number }`, used only for progress logs.

### 6. Progress logs

`collect` logs:

- after the repo list: the number of repos listed and qualified by meta;
- every 20 search batches: batch i of n, hits per agent so far, GraphQL points remaining;
- every 25 evaluations: PRs examined, selected per agent, REST remaining;
- the start and end of human matching.

### 7. Summary

`CollectSummary` becomes:

```ts
{
  window: { since: string; until: string };
  reposListed: number;              // repos passing the meta rules
  searchHits: Record<AgentId, number>;
  uniqueHits: number;
  examined: Record<AgentId, number>; // hits evaluated on that agent's turn
  reposChecked: number;              // repos whose facts were loaded
  reposQualified: number;
  ambiguous: number;
  selected: Record<AgentId, number>;
  humansSelected: number;
  humanShortfall: number;
  insufficient: string[];
}
```

`uniqueRepos` and `candidates` are removed, because the full candidate pool is never loaded. The workflow's step summary reads only `selected`, `humansSelected`, `humanShortfall`, `insufficient` and `window`, which all stay.

### 8. Workflow (`.github/workflows/collect.yml`)

- **Cache restore:** `actions/cache` becomes `actions/cache/restore` before Collect, with:
  - key `github-api-${{ env.UNTIL }}-${{ github.run_id }}-${{ github.run_attempt }}`;
  - restore key `github-api-${{ env.UNTIL }}-`.
- **Cache save:** `actions/cache/save` runs after Collect with `if: always()`, so a failed or timed-out run keeps its responses. Both actions are pinned to the same SHA as today's `actions/cache` pin.
- **Timeouts:** the Collect step gets `timeout-minutes: 320` and the job `timeout-minutes: 350`. When Collect runs out of time, the step fails, the commit and batch steps are skipped, and the cache save still runs.
- **Rerunning:** running collect again with the same `until` resumes from the cache.

### Expected run time

These estimates assume about 1 in 6 examined hits is selected. The first pilot will show the real rate.

| Phase | Pilot (20 per agent) | Full (80 per agent) |
|---|---|---|
| Repo list | ~2 min | ~2 min |
| Agent PR search | ~1 h | ~1 h (cached after the pilot only if `until` matches) |
| Selection (REST PR loads, GraphQL repo facts) | ~20 min | ~1 h 20 min |
| Human matching (REST) | ~15 min | ~1 h |

The full run needs about 3 to 3.5 hours, inside the 320-minute step limit. If it runs over, a rerun picks up from the cache.

## Documentation changes

**`PREREGISTRATION.md`.** Still a draft, so it is edited in place with no Deviations entry.
- Repos: add "primary language (as GitHub reports it) TypeScript, JavaScript, Python, Vue or Svelte".
- Agent PRs:
  - Candidates are the PRs found by the agent's search queries within the qualifying repos (list the queries) and attributed to exactly one agent. A PR is a candidate only for the agent whose queries found it.
  - Selection order: each agent's hits are shuffled with the seed and examined in that order, round-robin across agents, until 80 pass or the hits run out. A hit whose repo already has 3 selected agent PRs is skipped.
- Collection limits: distinct commit authors are counted over at most 300 commits, stopping once 10 are seen.

**`README.md`.**
- Expected collect duration.
- Rerunning with the same `until` resumes from the cache.
- Summary fields.

## Testing

All tests come first and run against fakes. There are no network calls.

**`test/repos.test.ts`.**
- Star-range splitting: open and closed ranges, and a single star value over 1,000 throws.
- Cursor paging.
- Deduplication across slices.
- Meta rules and `excluded-repos.txt` applied.
- Code-unit order.

**`test/search.test.ts`.**
- Batches of 40.
- Batch splitting over 1,000.
- Window splitting for one repo, and a single repo on a single day over 1,000 throws.
- Cursor paging.
- The exact query text.
- Hits kept per agent.

**`test/select.test.ts`.**
- Seeded order matches `shuffle(sorted, rngFor(seed:agent))`.
- Round-robin order.
- A per-repo-cap skip makes no `evaluate` call.
- Excluded keys make no call.
- `evaluate` is memoized across agents.
- A PR attributed to another agent is not accepted.
- Selection stops at `perAgent`.

**`test/collect.test.ts`.**
- The end-to-end fake moves to GraphQL search and facts plus REST PR loads.
- New summary fields.
- Ambiguous counted once.
- Human matching unchanged.

**`test/github-client.test.ts`.**
- GraphQL POST and caching.
- `RATE_LIMITED` errors wait for the reset.
- Other errors throw.
- The search throttle.
- `rateRemaining`.

**`test/collect-workflow.test.ts`.**
- Cache restore and save pins.
- `if: always()` on save.
- The unique key and restore key.
- Step and job timeouts.

## Out of scope

- Human matching, `loadPr`, attribution markers, PR rules and every later stage (`run`, `ingest`, `aggregate`, `label`, `report`).
- Making the repo list reproducible across days. The live search reflects current star counts, as before; the per-`until` cache keeps a rerun on the same date stable.
