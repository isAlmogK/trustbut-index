# Pre-registration: trustbut agent test-honesty study, v1

**Status:** draft until tagged `prereg-v1`. After the tag, changes require a new version, and the report lists them under "Deviations".

## Question
On real, merged pull requests in established JS/TS and Python projects, does trustbut (trustbut 0.4.0 exactly; any other version is a deviation) produce findings that are right, that matter, and can it run at all? How do agent-written PRs compare with human PRs from the same projects?

## Sample
- Repos: public, not forks, not archived; ≥ 1,000 stars; ≥ 10 distinct commit authors in the past 365 days; pushed within 30 days; a GitHub Actions workflow that runs tests; a JS/TS (Vitest, Jest, node:test, Mocha) or Python (pytest) test setup on the default branch; not in `excluded-repos.txt`.
- Agent PRs: merged within the 90 days before the collection date, merged by someone other than the author, changing at least one source file, and attributed to exactly one agent by the markers below. A source file is a path ending in `.js .jsx .ts .tsx .mjs .cjs .mts .cts .vue .svelte .py`, excluding `.d.ts` files, paths containing a `doc/`, `docs/`, `example/` or `examples/` directory, and test paths: directories `test/`, `tests/`, `__tests__/`, `spec/`, `__mocks__/`, `fixture/` or `fixtures/`; JS/TS files named `*.test.*` or `*.spec.*`; Python files named `test_*.py`, `*_test.py` or `conftest.py`. Window: the default is 90 days (`collect --days`), and the collection summary records the window used. If any agent has fewer than 30 selected PRs, the whole collection is rerun once with a 180-day window for all agents, and the report states the window used. This rerun is a manual step; the code does not widen the window by itself. At most 3 agent PRs per repo and 80 per agent, chosen by seeded round-robin across agents.
- Human PRs: from the same repos and window, author type User, no agent marker and not a bot, same PR rules. As many per repo as that repo's selected agent PRs, chosen at random (seeded).
- PRs in the pilot manifest are excluded from the full study. The full collection passes the pilot manifest to `collect --exclude-manifest`, so its PRs are never selected, as agent PRs or as human matches.
- Agents with fewer than 30 selected PRs are reported as "insufficient data" and excluded from the "all agents" group.

## Attribution markers
Checked by hand on the pilot (Task 20). Each row records the share of pilot PRs confirmed. Author logins match case-insensitively. A Claude trailer counts only with Anthropic's noreply address, so a human co-author named Claude is not a marker. The model is recorded only for claude-code PRs whose trailer names one (for example `Claude Opus 4.8`); otherwise it is `unknown`.

| Agent | Markers | Pilot check |
|---|---|---|
| copilot | author `Copilot` / `copilot-swe-agent[bot]`; branch `copilot/` | to fill in after the pilot |
| codex | author `chatgpt-codex-connector[bot]`; branch `codex/`; body links `chatgpt.com/codex` | to fill in after the pilot |
| claude-code | author `claude[bot]`; body "Generated with Claude Code"; trailer `Co-Authored-By: Claude… <noreply@anthropic.com>` | to fill in after the pilot |
| cursor | author `cursor[bot]`; branch `cursor/`; trailer `Co-authored-by: Cursor Agent` | to fill in after the pilot |
| devin | author `devin-ai-integration[bot]` | to fill in after the pilot |
| jules | author `google-labs-jules[bot]` | to fill in after the pilot |

## Procedure
Each PR runs on a fresh GitHub-hosted `ubuntu-24.04` VM with a 60-minute limit. Within it, dependency installation gets 20 minutes and the trustbut run gets 35 minutes; a step that exceeds its budget is recorded as `timeout`. The setup is inferred from repo files only, with no per-repo tuning. Then trustbut runs: `verify --base <PR base SHA> --head <PR head SHA> --json`. Run status is assigned by the first matching rule, in this order:

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
- Distinct commit authors (used for the repo's contributor count) are counted over at most 300 commits from the past 365 days.
- At most 10 workflow files are read per repo. A workflow runs tests when it contains a test command (`npm`, `pnpm`, `yarn` or `bun` `[run] test`; `pnpm -r test`; `make test`; `turbo [run] test`; `nx test`; `node --test`) or a runner name standing alone (`vitest`, `jest`, `mocha`, `pytest`, `tox`, `nox`), not as part of a longer or hyphenated name such as `eslint-plugin-jest`.
- Human candidates come from the 500 most recently updated closed PRs per repo (merged or not); only merged, non-agent User PRs are matched.
- A repo that can't supply enough human PRs is recorded as a shortfall (`humanShortfall` in the collection summary). The report page does not show it.

## Metrics
- Finding families:
  - proof gap: `test-passes-without-change`
  - test weakening: `test-skipped`, `test-focused`, `tests-removed`, `assertions-removed`, `test-config-changed`
  - escapes: `escape-added`
  - untested change: `no-tests-changed`
  - red at head: `suite-failing`, `test-failing`
  - Context only, not counted: `deps-changed`, `deps-not-installed`, `base-run-failed`, `proofs-unmatched`, `no-test-results`, `no-runner`, `snapshot-changed`.
- Per agent and for humans: the share of `ran` PRs with at least one finding per family and with any counted finding. The proof rate: `proves-change` / (`proves-change` + `does-not-constrain`) over all new or changed tests. Run coverage.
- Comparisons (the only ones made): all agents with sufficient data versus humans, for each family, for any counted finding, and for the proof rate. Wilson 95% intervals for rates; Newcombe hybrid-score intervals for differences. Intervals treat tests (proof rate) and findings (precision) as independent; tests and findings from the same PR are correlated, so the true uncertainty is somewhat wider.

## Labeling
- Eligible items are findings of `ran` PRs that have at least one counted finding. Agents with insufficient data (fewer than 30 selected PRs) are not sampled. Agent findings are drawn round-robin across the remaining agents (each agent's PRs shuffled with the seed), a whole PR at a time, up to 5 findings per PR, until at least 150 agent findings are drawn. Human findings are drawn from randomly ordered (seeded) human PRs, up to 5 per PR, until exactly 50 are drawn (fewer only if the eligible human PRs run out).
- The evidence is blinded. Lines containing generator text ("Generated with ...") or co-author trailers are removed. Other matches are replaced with placeholders: agent names, bot accounts, branch names, vendor and model names (for example Anthropic, OpenAI, Gemini, Claude Opus/Sonnet/Haiku), and matching words in file paths and test names become `[agent]`, and vendor links become `[link]`. The review page does not receive the PR's group or agent.
- Labels:
  - `real`: true, and a reviewer would want to know it.
  - `true-but-benign`: true but harmless.
  - `false`: the stated fact is wrong.
  - `unclear`: excluded from the math.
- If a finding is labeled more than once, the latest label counts.
- Drafts come from `claude-opus-5-5` (effort high, prompt `labels/prompt-v1.md`) via the Batches API. The author confirms or changes each one. The first 20 items in sample order are labeled without seeing the draft.
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
