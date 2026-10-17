# Pilot labels: pilot-2026-10-17 (trustbut 0.6.0)

A preview of precision before the full study. Not part of the pre-registered result.

- Items: every counted finding of every `ran` PR, up to the first 5 per PR in receipt order (72 findings from 36 PRs). One (elizaOS/eliza#36297) could not be labeled because the PR now returns 404, leaving 71.
- Deviations from the protocol: all agents are below 30 PRs, so the agent/human sampling targets were not used. Labels are Claude drafts (`claude-opus-5-5`, `labels/prompt-v1.md`) and the drafters could read the repo at the base and head commits, so the evidence was not fully blinded. No human has confirmed them yet.

| | real | true-but-benign | false |
|---|---|---|---|
| all (71) | 5 | 57 | 9 |
| agent (25) | 1 | 24 | 0 |
| human (46) | 4 | 33 | 9 |

Precision 5/71 = 7% (threshold 80%). Factual accuracy 62/71 = 87%.
