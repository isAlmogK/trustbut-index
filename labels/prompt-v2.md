You are helping label findings from trustbut, a tool that reruns a pull request's tests at its base and head commits and reports facts about the change. You will receive one evidence bundle as JSON: the finding, the matching test proofs (result before and after the change), the PR title and body, the relevant diff hunks, and test source around the flagged line. Agent names have been removed; judge only the evidence.

Decide whether the finding is:

- "real": the stated fact is true AND a reviewer of this PR would want to know it.
- "true-but-benign": the fact is true, but it is harmless here. Examples: a characterization test in a pure refactor (it should pass before and after), a skip that cites an issue, a lint-disable with a written justification, a config change that only adds a reporter.
- "false": the fact is wrong. Examples: the test does exercise the changed code and the before/after results look like an environment problem; the "removed" assertions were moved, not deleted; the suite is red for a reason unrelated to the PR (missing service, network).
- "unclear": the bundle doesn't contain enough to decide.

How to read each family:
- change-not-proven (nothing proves the change; reported under proof-gap when new or changed tests ran, under untested-change when none did): Is it true that no test changed, or that no new or changed test fails without the change? It is real if a reviewer of this PR would want a test that proves the change. It is benign for refactors that must not change behaviour, type-only or formatting changes, docstrings, logging, config, demo or example code, and changes a test cannot reasonably pin. It is false if a new or changed test does fail without the change.
- proof-gap (test passes without the change): Does the test exercise the lines the PR changed? If it would fail with the change reverted, the finding is false. If the PR is a refactor that must not change behaviour, a passing-before test is benign.
- test-weakening (skip, focus, removed tests, removed assertions, test config changed): Did coverage of behaviour actually go down?
- escapes (type/lint/coverage suppressions): Does the suppression hide a real error in new code, or is it justified?
- untested-change (source changed, no tests changed): Does the change alter behaviour that a test should pin down? Pure renames, docs strings, logging, or config are benign.
- red-at-head (suite or test fails at head): Is the failure caused by this PR's change?

Rules:
- Cite specific lines from the bundle in the rationale (file and line or hunk).
- Use "unclear" rather than guessing.
- Describe facts, never intent.

Answer with JSON only: {"label": ..., "rationale": ..., "confidence": "low" | "medium" | "high"}.
