# Pre-registration: trustbut agent test-honesty study, v1

**Status:** draft until tagged `prereg-v1`. After the tag, changes require a new version, and the report lists them under "Deviations".

## Question
On real, merged pull requests in established JS/TS and Python projects, does trustbut (pinned `0.4.x`) produce findings that are right, that matter, and can it run at all? How do agent-written PRs compare with human PRs from the same projects?

## Sample
- Repos: public, not forks, not archived; ≥ 1,000 stars; ≥ 10 distinct commit authors in the past 365 days; pushed within 30 days; a GitHub Actions workflow that runs tests; a JS/TS (Vitest, Jest, node:test, Mocha) or Python (pytest) test setup on the default branch; not in `excluded-repos.txt`.
- Agent PRs: merged within the 90 days before the collection date (widened to 180 if an agent has fewer than 30), merged by someone other than the author, changing at least one non-test JS/TS/Python file, and attributed to exactly one agent by the markers below. At most 3 agent PRs per repo and 80 per agent, chosen by seeded round-robin across agents.
- Human PRs: from the same repos and window, author type User, no agent marker and not a bot, same PR rules. As many per repo as that repo's selected agent PRs, chosen at random (seeded).
- Agents with fewer than 30 selected PRs are reported as "insufficient data" and excluded from the "all agents" group.

## Attribution markers
Checked by hand on the pilot (Task 20). Each row records the share of pilot PRs confirmed.

| Agent | Markers | Pilot check |
|---|---|---|
| copilot | author `Copilot` / `copilot-swe-agent[bot]`; branch `copilot/` | to fill in after the pilot |
| codex | author `chatgpt-codex-connector[bot]`; branch `codex/`; body links `chatgpt.com/codex` | to fill in after the pilot |
| claude-code | author `claude[bot]`; body "Generated with Claude Code"; trailer `Co-Authored-By: Claude` | to fill in after the pilot |
| cursor | author `cursor[bot]`; branch `cursor/`; trailer `Co-authored-by: Cursor Agent` | to fill in after the pilot |
| devin | author `devin-ai-integration[bot]` | to fill in after the pilot |
| jules | author `google-labs-jules[bot]` | to fill in after the pilot |

## Procedure
Each PR runs on a fresh GitHub-hosted `ubuntu-24.04` VM with a 60-minute limit. Within it, dependency installation gets 20 minutes and the trustbut run gets 35 minutes; a step that exceeds its budget is recorded as `timeout`. The setup is inferred from repo files only, with no per-repo tuning. Then trustbut runs: `verify --base <PR base SHA> --head <PR head SHA> --json`. Run statuses: `ran` (receipt produced and ≥ 1 test passed at head), `no-runner`, `setup-failed`, `timeout`, `trustbut-error`.

## Metrics
- Finding families:
  - proof gap: `test-passes-without-change`
  - test weakening: `test-skipped`, `test-focused`, `tests-removed`, `assertions-removed`, `test-config-changed`
  - escapes: `escape-added`
  - untested change: `no-tests-changed`
  - red at head: `suite-failing`, `test-failing`
  - Context only, not counted: `deps-changed`, `deps-not-installed`, `base-run-failed`, `proofs-unmatched`, `no-test-results`, `no-runner`, `snapshot-changed`.
- Per agent and for humans: the share of `ran` PRs with at least one finding per family and with any counted finding. The proof rate: `proves-change` / (`proves-change` + `does-not-constrain`) over all new or changed tests. Run coverage.
- Comparisons (the only ones made): all agents with sufficient data versus humans, for each family, for any counted finding, and for the proof rate. Wilson 95% intervals for rates; Newcombe hybrid-score intervals for differences.

## Labeling
- A seeded random sample of `ran` PRs with counted findings, stratified across agents, up to 5 findings per PR, until ≥ 150 agent findings and 50 human findings are reached.
- The evidence is blinded: agent names, bot accounts, branch names, generator lines, co-author trailers, vendor and model names (for example Anthropic, OpenAI, Gemini, Claude Opus/Sonnet/Haiku), and matching words in file paths and test names are replaced with `[agent]`/`[link]` placeholders; the review page does not receive the PR's group or agent.
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

Each is judged on its point estimate. The report shows the intervals. The hit-rate interval multiplies the bounds of two independent 95% intervals; it is an envelope with roughly 90% joint coverage, not a 95% interval.

## What each outcome means
- Precision miss: every confirmed false positive becomes a trustbut fixture scenario and a fix, then a rerun.
- Coverage miss: the next milestone is setup robustness, not new checks.
- Hit-rate miss: trustbut is accurate but rarely finds something real on established projects. Rethink what it checks before building a public index.

## Seed
`prereg-v1`, used for selection, human matching, the labeling sample and its order.

## Publication
The results are published whatever they show, including misses. Raw manifests, receipts and labels are public in this repository. The report's narrative never singles out a project. Maintainers can opt out.
