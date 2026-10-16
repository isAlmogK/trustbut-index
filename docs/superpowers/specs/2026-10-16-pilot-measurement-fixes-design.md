# Pilot measurement fixes

**Status:** Draft (2026-10-16)
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

The family key stays `red-at-head`, so aggregates stay comparable. The report label becomes "Tests that passed at base fail at head". `PREREGISTRATION.md` (still a draft, not tagged `prereg-v1`) gets the same change, so this is not a deviation.

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

Dispatch `run.yml` with `manifest=manifests/pilot-2026-10-15.jsonl`, `batch=0`, `date=pilot-2026-10-16`. The first run's results stay in `results/pilot-2026-10-15`. After ingest, compare the two runs: run coverage and status by cause, red-at-head rate, counted-finding rate, and proof rate. The comparison goes in the PR description; there's no new code for it.

## Testing

- `families`: `test-regressed` maps to `red-at-head`; `suite-failing` and `test-failing` map to context.
- `job install`: retries a failing command up to 3 attempts, doesn't retry a timeout, stops at the budget, records `installRetries` and `installTail`. Use a fake shell command (an exit-code script), not the network.
- `runShell`: returns captured output and still streams it.
- `isRunRecord`: accepts records with and without the new fields; rejects a wrong type.
- `job verify`: passes `--config` with the study config path.
- Budgets: a test that pins the constants and the workflow's `timeout-minutes` together, so they can't drift apart.

## Done when

- Both PRs are merged, trustbut 0.5.0 is published, and the rerun's results are on main in `results/pilot-2026-10-16`.
- The PR or a follow-up note reports the comparison with the first run.
