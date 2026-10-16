# Pilot measurement fixes

**Status:** Implemented (2026-10-16)
**Repos:** trustbut-index (this spec, the feature) · [trustbut](https://github.com/isAlmogK/trustbut/blob/main/docs/superpowers/specs/2026-10-16-test-regressed-design.md)
**Study design:** [agent test-honesty index design](https://github.com/isAlmogK/trustbut/blob/main/docs/superpowers/specs/2026-10-14-agent-test-honesty-index-design.md) in trustbut.

## Problem

The first pilot run (`results/pilot-2026-10-15`, Actions run 38804374585) measured the run environment more than the pull requests.

**Red at head is mostly environment.** 74% of the 93 PRs that ran had a red-at-head finding, humans (77%) as often as agents. Every PR in the sample was merged, so it passed its own CI. Of 529 failing new or changed tests, 513 failed the same way at base. 40 PRs had `suite-failing` only from tests the PR didn't touch, which trustbut 0.4.0 never runs at base. Counting these findings would put most of the labeling sample on environment failures and make the hit-rate estimate meaningless.

**Run coverage was 46%** (93 of 201), under the pre-registered 50%. Of the 108 PRs that didn't run:

| Cause | PRs | Repos |
|---|---|---|
| Install failed (npm `ECONNRESET`, vscode, others) | 24 | 9 |
| trustbut's 900 s suite timeout | 23 | 11 |
| Tests error at collection or import | 20 | 9 |
| Test command failed with no tests reported | 19 | 6 |
| No runner (recipe or verify) | 13 | 8 |
| Every test failed | 6 | 3 |
| Needs a build step | 3 | 2 |

Most of the install failures and the remaining test-command failures can't be diagnosed from the results. `run.json` has only exit codes, and the receipt keeps at most one line of output.

## Goals

1. Red at head counts only tests that passed at base.
2. Fewer PRs lost to time limits and network flakes.
3. Every failure leaves enough output in the results to diagnose it.
4. Rerun the same 201 PRs and compare with the first run.

Not goals: per-repo setup tuning (the pre-registration forbids it) and build steps for monorepos. Those are left for after the rerun shows what remains.

## Design

### trustbut 0.5.0

trustbut adds the finding `test-regressed` (a test passes at base and fails at head, for any failing test, not only changed ones) and an `outputTail` on failed runs under `x-trustbut`. Receipts become spec `1.1`. The contract is in the [trustbut spec](https://github.com/isAlmogK/trustbut/blob/main/docs/superpowers/specs/2026-10-16-test-regressed-design.md#contract-for-consumers-trustbut-index). The index pins `TRUSTBUT_SPEC: '0.5.0'` in `run.yml`.

### Red at head counts only regressions

`src/aggregate/families.ts`:

| Family | Finding ids |
|---|---|
| Red at head | `test-regressed` |
| Context, not counted | adds `suite-failing`, `test-failing` |

The family key stays `red-at-head` for code continuity only: the definition changed, so rates from trustbut < 0.5.0 and ≥ 0.5.0 are not comparable. `aggregate` reports red at head as not measured for groups with receipts from trustbut older than 0.5.0. The report label becomes "Tests that passed at base fail at head". `PREREGISTRATION.md` (still a draft, not tagged `prereg-v1`) gets the same change, so this is not a deviation.

### Time budgets

| Limit | Before | After |
|---|---|---|
| `pr` job `timeout-minutes` | 60 | 120 |
| Install budget (`INSTALL_BUDGET_MS`) | 20 min | 25 min |
| Verify budget (`VERIFY_BUDGET_MS`) | 35 min | 85 min |
| trustbut suite timeout (`timeoutSec`) | 900 s | 2400 s |

The verify budget covers a head run and a base run, each up to 2400 s, plus overhead. trustbut gets `timeoutSec` from a study config file, `config/trustbut.json` (`{ "timeoutSec": 2400 }`), passed as `trustbut verify --config <path>`. That file replaces a repo's own `.trustbut.json`; no pilot repo has one, and the pre-registration already says no per-repo tuning. `PREREGISTRATION.md` gets the new numbers.

### Install retries

In `job install` (`src/run/job.ts`), a recipe command that exits non-zero is run again, up to 3 attempts per command, with 30 s between attempts, all inside the install budget. A timeout (exit 124) is not retried. `run.json` gains `installRetries` (number of re-runs, 0 when none).

### Output tails

- `runShell` (`src/run/exec.ts`) keeps streaming output to the job log and also captures it.
- When install fails, `run.json` gains `installTail`: the last 50 lines and at most 4,000 characters of the failing command's output, ANSI codes removed.
- Test output tails come from the receipt (`x-trustbut.after.outputTail`, `x-trustbut.before.outputTail`). trustbut writes them only when asked, so `job verify` passes `--output-tail`. The index adds no copy of its own.
- `isRunRecord` accepts both new fields as optional, so `pilot-2026-10-15` results still validate.

The `pr` jobs have no secrets, and the output comes from public repositories' own tests, so committing tails publicly exposes nothing the repos don't already print.

### Rerun

Dispatch `run.yml` with `manifest=manifests/pilot-2026-10-15.jsonl`, `batch=0`, `date=pilot-2026-10-16`. The first run's results stay in `results/pilot-2026-10-15`. After ingest, compare the two runs like with like:

- Run coverage and status by cause (status and stage) over all 201 PRs.
- Rates (counted findings, proof rate, red at head) on the PRs that ran in both runs.
- Red at head under the old definition (any `suite-failing` or `test-failing`) on run 2 as well, so the change from run 1 isolates the effect of the budgets and retries. The new definition (`test-regressed`) is reported separately; run 1 has no value for it. Run 2 also reports "red at head not compared".
- The proof rate is not strictly like for like: trustbut 0.5.0's base run is larger (it also reruns failing unchanged files, and one failing file can stop the shared base run), and installs without a lockfile may resolve newer dependencies than in run 1.

The comparison is reported after the rerun, in the conversation or a follow-up note, not in the PR description. There's no new code for it.

## Testing

- `families`: `test-regressed` maps to `red-at-head`; `suite-failing` and `test-failing` map to context.
- `job install`: retries a failing command up to 3 attempts, doesn't retry a timeout, stops at the budget, records `installRetries` and `installTail`. Use a fake shell command (an exit-code script), not the network.
- `runShell`: returns captured output and still streams it.
- `isRunRecord`: accepts records with and without the new fields; rejects a wrong type.
- `job verify`: passes `--config` with the study config path.
- Budgets: a test that pins the constants and the workflow's `timeout-minutes` together, so they can't drift apart.

## Done when

- Both PRs are merged, trustbut 0.5.0 is published, and the rerun's results are on main in `results/pilot-2026-10-16`.
- A follow-up note (or the conversation) reports the comparison with the first run, after the rerun.

## As built

- `ingest` copies `installRetries` and `installTail` from the artifact and checks them again: `installTail` is cut with `tail()` again, and an `installRetries` above (`MAX_INSTALL_ATTEMPTS` − 1) × the recipe's install commands (node install plus each python install) rejects the artifact (`run.json installRetries out of range`). A non-integer or negative value fails `isRunRecord`, as before.
- `runShell` starts bash in its own process group (`detached: true`) and SIGKILLs the whole group on timeout and as soon as bash exits, so a child or background process that holds the output pipes can't keep the call waiting past its budget. Exit 124 on timeout is unchanged. Background processes an install command leaves running are killed when it exits.
- `aggregate`: a group with any `ran` receipt from trustbut older than 0.5.0 (by `producer.version`; an unparseable version counts as older) lists `red-at-head` in `notMeasured`, gets an n=0 red-at-head rate and no red-at-head comparison, and those receipts never count red at head in any-counted. `Aggregate.notMeasured` lists families not measured in any group. The report's family chart writes "not measured" in those cells with a note under the heading, and the pilot checklist has a red-at-head line that says "not measured" or gives the rate. The committed `results/pilot-2026-10-15/aggregate.json` was not regenerated; re-aggregating it now gives `notMeasured: ["red-at-head"]`.
- "Red at head not compared" is implemented in `aggregate` as the context rate `redAtHeadNotCompared` per group (PRs that ran with a fail or error head case whose id is absent from `x-trustbut.before.cases`, or with no `before`). It has no comparison. The checklist shows it next to the red-at-head rate. `PREREGISTRATION.md` lists it under Metrics and says the red-at-head rate is a lower bound.
- Label packets for a `test-regressed` finding carry `regression`: the matching head case (by finding `detail` = case name and file, allowing package-root-relative or absolute case paths), its outcome and failure message, and the base outcome by case id (`missing` when absent), all scrubbed. It leads the packet's `baseRun` text.
- `Receipt` gains an optional `x-trustbut` with `after` and `before` runs (cases, `outputTail`).
- `installTail` keeps only the last attempt's output. A retry that starts with little budget left can time out and replace the earlier failure's tail and status (timeout instead of setup-failed). Known, deferred.
- Untrusted install scripts could redirect `TB_CONFIG` through `$GITHUB_ENV`, or edit the index checkout. This is the same accepted exposure as `TB_CLI` and `NODE22`: the `pr` job has no secrets or write access, and ingest re-validates every receipt.
- Output tails (`installTail`, the receipt's `outputTail`) are committed unscrubbed. They come from public repositories' own test and install runs, and the paths in them are runner temp paths. Decision recorded.
- `TB_CONFIG` overrides the study config path; the default `config/trustbut.json` is resolved from the module path.
- `test/budgets.test.ts` also checks that the budgets nest (two trustbut runs fit in the verify budget; install, verify and 10 minutes of setup fit in the job timeout).
