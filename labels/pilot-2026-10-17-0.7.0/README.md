# Pilot labels: pilot-2026-10-17-0.7.0 (trustbut 0.7.0, `change-not-proven` only)

A preview of the precision of `change-not-proven` before the full study. Not part of the pre-registered result.

- Items: every `change-not-proven` finding of every `ran` PR in `results/pilot-2026-10-17-0.7.0` (manifest `manifests/pilot-2026-10-15.jsonl`). There are 14. One (elizaOS/eliza#36297) could not be labeled because the PR returns 404, as in the 0.6.0 labels. That leaves 13: 6 on agent PRs, 7 on human PRs. Other finding types were not labeled.
- `sample.jsonl` lists the 13 items in the protocol's sample order (seed `prereg-v1:label:order`). `packets/` holds the blinded evidence from `label packets`. `drafts.jsonl` holds the drafts.
- Deviations from the protocol:
  - Only `change-not-proven` was labeled, and every one was taken. The protocol's sampling (whole PRs, up to 5 findings each, 150 agent and 50 human findings) was not used. All agents are below 30 PRs.
  - Labels are Claude drafts (`claude-opus-5-5`, `labels/prompt-v2.md`). No human has confirmed them yet.
  - The drafts did not come from the Batches API. Each was made by a separate Claude Code subagent on the same model. The subagent read only `prompt-v2.md` and one packet, with the key removed and the file renamed `item-NN.json`. It was told not to read any other file, run commands, or use the web or GitHub, and each one made only those two reads. So the drafters saw the blinded evidence and nothing else. That is tighter than the 0.6.0 drafts, where the drafters could read the repo.
  - Packets include only code files (`.js .ts .py …`), up to 10. The drafters did not see changes to snapshots, JSON dictionaries, docs or lockfiles. See "Notes for confirmation".

| | real | true-but-benign | false |
|---|---|---|---|
| all (13) | 7 | 6 | 0 |
| agent (6) | 2 | 4 | 0 |
| human (7) | 5 | 2 | 0 |

Precision of `change-not-proven`: 7/13 = 54% (Wilson 95%: 29%–77%), agent and human pooled as the pre-registration defines it. Agent 2/6 = 33% (10%–70%). Human 5/7 = 71% (36%–92%). Factual accuracy 13/13 = 100% (77%–100%). Thirteen findings give a wide interval.

For comparison, 5 of the 71 findings in the 0.6.0 labels were `real` (7%, 3%–15%), over all finding types.

By the fact the finding states:

| `finding.detail` | real | true-but-benign |
|---|---|---|
| no test added or changed (9) | 5 | 4 |
| test files changed, but no new or changed test that ran was found in them (3) | 1 | 2 |
| 1 new or changed test, none fails without the change (1) | 1 | 0 |

Four of the six benign drafts are type-only or formatting changes: PrefectHQ/fastmcp#4831, elizaOS/eliza#34811, vuejs/test-utils#2934 and vuejs/test-utils#2957. The other two are a behaviour-preserving refactor (skfolio/skfolio#324) and a change to playground and example code (vbenjs/vue-vben-admin#8393).

## Notes for confirmation

These come from the PR file lists (GitHub API), which the drafters did not see.

- ardatan/graphql-mesh#9678 (draft `real`): the PR also updates `packages/loaders/openapi/tests/__snapshots__/schemas.test.ts.snap` and `204-response-with-empty-content.test.ts.snap`. The packet left them out because they are not code files. These snapshots may pin the OpenAPI empty-description change. The json-schema, OData and Thrift changes have no snapshot in the file list. Decide whether "nothing proves the change" still holds.
- sunflower-land/sunflower-land#7508 (draft `real`): the PR also changes `src/lib/i18n/dictionaries/dictionary.json`, which the drafter did not see. That does not change the stated fact, since no test changed.
- outline/outline#13750 (draft `real`): the PR body describes a test, but the PR's only file is `server/queues/tasks/APIImportTask.ts`. The stated fact holds.
- The other file lists match what the packets show, apart from docs, changesets, locale JSON, `package.json`, `pyproject.toml` and lockfiles.

## How to confirm

```bash
npm run review pilot-2026-10-17-0.7.0
```

The page writes `final.jsonl` here. All 13 items fall inside the protocol's first 20 in sample order, so the page shows no draft for any of them: they are labeled without seeing the draft. Then compare `final.jsonl` with `drafts.jsonl`, and update the counts and precision above.
