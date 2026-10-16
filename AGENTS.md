# AGENTS.md

trustbut-index runs trustbut on real agent and human pull requests and reports how often its findings are right, how often it finds something real, and how often it can run at all. Read `PREREGISTRATION.md` and the design spec (trustbut repo, `docs/superpowers/specs/2026-10-14-agent-test-honesty-index-design.md`) before changing behavior.
Where the study-design spec and `PREREGISTRATION.md` differ, `PREREGISTRATION.md` wins.

## Stack
- TypeScript, ESM, Node >= 22, run with `tsx`. Imports use `.js` extensions (NodeNext).
- Tests: Vitest. `npm test`, `npm run typecheck`.

## Rules
- Test first. Every behavior change starts with a failing test.
- Deterministic. No LLM anywhere except `label draft`. Every random choice goes through `src/rng.ts` with a named seed.
- Never interact with studied repositories: read-only API calls and clones only. No comments, issues, PRs, stars or forks.
- The run jobs execute untrusted code. They never get secrets or write permissions. Only the ingest job writes to this repo, and it never executes anything from a studied repo.
- Report text states facts, never intent.
- Once `prereg-v1` is tagged, changes to selection, metrics, thresholds or labeling rules need a new `PREREGISTRATION.md` version and an entry under "Deviations".
- Commit after each task with a conventional message.
