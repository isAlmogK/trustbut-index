# Pre-registration: trustbut agent test-honesty study, v1

**Status:** draft until tagged `prereg-v1`. After the tag, changes require a new version, and the report lists them under "Deviations".

## Question
On real, merged pull requests in established JS/TS and Python projects, does trustbut (trustbut 0.5.0 exactly; any other version is a deviation) produce findings that are right, that matter, and can it run at all? How do agent-written PRs compare with human PRs from the same projects?

## Sample
- Repos: public, not forks, not archived; ≥ 1,000 stars; primary language (as GitHub reports it) TypeScript, JavaScript, Python, Vue or Svelte; ≥ 10 distinct commit authors in the past 365 days; pushed within 30 days; a GitHub Actions workflow that runs tests; a JS/TS (Vitest, Jest, node:test, Mocha) or Python (pytest) test setup on the default branch; not in `excluded-repos.txt`.
- Agent PRs: merged in the window before the collection date, merged by someone other than the author, changing at least one source file, and attributed to exactly one agent by the markers below. A source file is a path ending in `.js .jsx .ts .tsx .mjs .cjs .mts .cts .vue .svelte .py`, excluding `.d.ts` files, paths containing a `doc/`, `docs/`, `example/` or `examples/` directory, and test paths: directories `test/`, `tests/`, `__tests__/`, `spec/`, `__mocks__/`, `fixture/` or `fixtures/`; JS/TS files named `*.test.*` or `*.spec.*`; Python files named `test_*.py`, `*_test.py` or `conftest.py`. Window: the default is 90 days (`collect --days`), and the collection summary records the window used. A window of N days ending on the collection date `until` covers merge times from 00:00 UTC on `until − N days` through 23:59:59.999 UTC on `until`, so both end dates are included. If any agent has fewer than 30 selected PRs, the whole collection is rerun once with a 180-day window for all agents, and the report states the window used. This rerun is a manual step; the code does not widen the window by itself. Candidates are the PRs that an agent's search queries (below) find in the qualifying repos; a PR is a candidate only for an agent whose queries found it. At most 3 agent PRs per repo and 80 per agent, chosen by seeded round-robin across agents: each agent's hits are shuffled with the seed and examined in that order until 80 pass or the hits run out, and a hit whose repo already has 3 selected agent PRs is skipped.
- Human PRs: from the same repos and window, author type User, no agent marker and not a bot, same PR rules. As many per repo as that repo's selected agent PRs, chosen at random (seeded).
- PRs in the pilot manifest are excluded from the full study. The full collection passes the pilot manifest to `collect --exclude-manifest`, so its PRs are never selected, as agent PRs or as human matches.
- Agents with fewer than 30 selected PRs are reported as "insufficient data" and excluded from the "all agents" group.

## Attribution markers
Checked by hand on the pilot (Task 20). Each row records the share of pilot PRs confirmed. Author logins match case-insensitively. A Claude trailer counts only with Anthropic's noreply address, so a human co-author named Claude is not a marker. The model is recorded only for claude-code PRs whose trailer names one (for example `Claude Opus 4.8`); otherwise it is `unknown`.

| Agent | Markers | Pilot check |
|---|---|---|
| copilot | author `Copilot` / `copilot-swe-agent[bot]`; branch `copilot/` | 20/20 (pilot-2026-10-16) |
| codex | author `chatgpt-codex-connector[bot]`; branch `codex/`; body links `chatgpt.com/codex` | 20/20 (pilot-2026-10-16); 20 of 20 by branch `codex/` alone |
| claude-code | author `claude[bot]`; body "Generated with Claude Code"; trailer `Co-Authored-By: Claude… <noreply@anthropic.com>` | 20/20 (pilot-2026-10-16) |
| cursor | author `cursor[bot]`; branch `cursor/`; trailer `Co-authored-by: Cursor Agent` | 20/20 (pilot-2026-10-16); 17 of 20 by branch `cursor/` alone |
| devin | author `devin-ai-integration[bot]` | 20/20 (pilot-2026-10-16) |
| jules | author `google-labs-jules[bot]` | 3/3 (pilot-2026-10-16) |

Search queries, each combined with `is:pr is:merged merged:<window>` and a batch of repos: copilot `author:app/copilot-swe-agent`; codex `"chatgpt.com/codex" in:body`, `head:codex`; claude-code `"Generated with Claude Code" in:body`, `author:app/claude`; cursor `head:cursor`, `"Cursor Agent" in:body`; devin `author:app/devin-ai-integration`; jules `author:app/google-labs-jules`.

## Procedure
Each PR runs on a fresh GitHub-hosted `ubuntu-24.04` VM with a 120-minute limit. Within it, dependency installation gets 25 minutes and the trustbut run gets 85 minutes; a step that exceeds its budget is recorded as `timeout`. An install command that fails is run again up to two more times, 30 seconds apart, within the install budget; a timed-out command is not. The setup is inferred from repo files only, with no per-repo tuning. Then trustbut runs: `verify --base <PR base SHA> --head <PR head SHA> --json --config config/trustbut.json --output-tail`. `config/trustbut.json` sets a 2,400-second limit for each test run and replaces any `.trustbut.json` in the repo. Run status is assigned by the first matching rule, in this order:

1. fetch failed → `setup-failed`
2. no supported test setup inferred → `no-runner`
3. install timed out → `timeout`
4. install failed → `setup-failed`
5. trustbut timed out → `timeout`
6. no valid receipt → `trustbut-error`
7. receipt reports no runner → `no-runner`
8. at least one test passed at head → `ran`
9. otherwise (zero passing tests) → `setup-failed`

A receipt is valid when it passes `trustbut validate` and its `subject.head` is the PR's head commit from the manifest; results for PRs not in the manifest are discarded. Results that never arrive count as `missing` and as not run.

### Collection limits
- No search result is truncated. Repos are listed by GitHub repository search, split by star range until no query has more than 1,000 results. Agent PRs are searched in batches of 40 repos, and a query with more than 1,000 results is split, first by repos and then by window, until none has.
- Distinct commit authors (used for the repo's contributor count) are counted over at most 300 commits from the past 365 days, stopping once 10 are seen.
- At most 10 workflow files are read per repo. A workflow runs tests when it contains a test command (`npm`, `pnpm`, `yarn` or `bun` `[run] test`; `pnpm -r test`; `make test`; `turbo [run] test`; `nx test`; `node --test`) or a runner name standing alone (`vitest`, `jest`, `mocha`, `pytest`, `tox`, `nox`), not as part of a longer or hyphenated name such as `eslint-plugin-jest`.
- Human candidates come from the 500 most recently updated closed PRs per repo (merged or not); only merged, non-agent User PRs are matched.
- A repo that can't supply enough human PRs is recorded as a shortfall (`humanShortfall` in the collection summary). The report page does not show it.

## Metrics
- Finding families:
  - proof gap: `test-passes-without-change`
  - test weakening: `test-skipped`, `test-focused`, `tests-removed`, `assertions-removed`, `test-config-changed`
  - escapes: `escape-added`
  - untested change: `no-tests-changed`
  - red at head: `test-regressed` (a test that passes at base and fails at head). A failing test with no base result is not counted: the base run failed or timed out, the test file could not be resolved or did not exist at base, or the case id differs between the runs. The rate is therefore a lower bound. Receipts from trustbut older than 0.5.0 have no `test-regressed`; a group with any such receipt reports red at head as not measured.
  - Context only, not counted: `suite-failing`, `test-failing`, `deps-changed`, `deps-not-installed`, `base-run-failed`, `proofs-unmatched`, `no-test-results`, `no-runner`, `snapshot-changed`.
- Per agent and for humans: the share of `ran` PRs with at least one finding per family and with any counted finding. The proof rate: `proves-change` / (`proves-change` + `does-not-constrain`) over all new or changed tests. Run coverage.
- Context, not compared: per agent and for humans, the share of `ran` PRs with at least one head test case that fails or errors and whose id is absent from `x-trustbut.before.cases` (or with no `x-trustbut.before`): "red at head not compared". It bounds how much red at head can be undercounted.
- Comparisons (the only ones made): all agents with sufficient data versus humans, for each family, for any counted finding, and for the proof rate. Wilson 95% intervals for rates; Newcombe hybrid-score intervals for differences. Intervals treat tests (proof rate) and findings (precision) as independent; tests and findings from the same PR are correlated, so the true uncertainty is somewhat wider.

## Labeling
- Eligible items are findings of `ran` PRs that have at least one counted finding. Agents with insufficient data (fewer than 30 selected PRs) are not sampled. Agent findings are drawn round-robin across the remaining agents (each agent's PRs shuffled with the seed), a whole PR at a time, taking up to the first 5 counted findings in receipt order from each PR, until at least 150 agent findings are drawn. Human findings are drawn from randomly ordered (seeded) human PRs, taking up to the first 5 counted findings in receipt order from each PR (fewer from the last PR, to stop at exactly 50), until exactly 50 are drawn (fewer only if the eligible human PRs run out).
- The evidence is blinded. Lines containing generator text ("Generated with ...") or co-author trailers are removed. Other matches are replaced with placeholders: agent names, bot accounts, branch names, vendor and model names (for example Anthropic, OpenAI, Gemini, Claude Opus/Sonnet/Haiku), and matching words in file paths and test names become `[agent]`, and vendor links become `[link]`. The review page does not receive the PR's group or agent.
- Labels:
  - `real`: true, and a reviewer would want to know it.
  - `true-but-benign`: true but harmless.
  - `false`: the stated fact is wrong.
  - `unclear`: excluded from the math.
- If a finding is labeled more than once, the latest label counts.
- Drafts come from `claude-opus-5-5` (effort high, prompt `labels/prompt-v1.md`) via the Batches API, from the same blinded evidence; the request omits the finding key, which names the repo and PR. The author confirms or changes each one. The first 20 items in sample order are labeled without seeing the draft.
- Precision = real / (real + benign + false). Factual accuracy = (real + benign) / the same total.

## Thresholds (decided before any data)
1. Precision ≥ 80%, over all labeled findings.
2. Hit rate ≥ 10%: (share of `ran` agent PRs with any counted finding) × (share of sampled agent PRs with ≥ 1 `real` label).
3. Run coverage ≥ 50% of all selected PRs.

Each is judged on its point estimate. The report shows the intervals. The hit-rate interval multiplies the lower bounds and the upper bounds of the two Wilson 95% intervals; it is an envelope with roughly 90% joint coverage, not a 95% interval.

## What each outcome means
- Precision miss: every confirmed false positive becomes a trustbut fixture scenario and a fix, then a rerun.
- Coverage miss: the next milestone is setup robustness, not new checks.
- Hit-rate miss: trustbut is accurate but rarely finds something real on established projects. Rethink what it checks before building a public index.

## Seed
`prereg-v1`, used for selection, human matching, the labeling sample and its order.

## Publication
The results are published whatever they show, including misses. Raw manifests, receipts and labels are public in this repository. The report's narrative never singles out a project. Maintainers can opt out.
