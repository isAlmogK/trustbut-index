# Pilot measurement fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the pilot measure pull requests instead of the run environment. Red at head counts only `test-regressed`; time budgets go up; installs are retried; failures leave output tails. Then rerun the pilot on the same 201 PRs.

**Architecture:** The aggregate family map changes in one place (`src/aggregate/families.ts`). The `pr` job's steps in `src/run/job.ts` get larger budgets, a retry loop around each install command, captured output (`src/run/exec.ts`), and new trustbut flags (`--config config/trustbut.json --output-tail`). `run.json` gains two fields that `isRunRecord` accepts as optional.

**Tech Stack:** TypeScript (ESM, NodeNext, `.js` imports) run with `tsx`, Node >= 22, Vitest, execa 10, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-16-pilot-measurement-fixes-design.md`
**Depends on:** trustbut 0.5.0 (`test-regressed`, `--output-tail`, spec 1.1), built from `docs/superpowers/plans/2026-10-16-test-regressed.md` in trustbut. Tasks 1-5 can be written and tested before 0.5.0 is published. Task 6 needs it on npm.

## Global Constraints

- Test first: every behavior change starts with a failing test.
- Deterministic: no LLM outside `label draft`; randomness only through `src/rng.ts`.
- `pr` jobs never get secrets or write permissions; only `ingest` writes.
- `PREREGISTRATION.md` is a draft (no `prereg-v1` tag), so it is edited in place, not versioned.
- Budgets: `pr` job `timeout-minutes: 120`; install 25 min; verify 85 min; trustbut `timeoutSec` 2400.
- Install retries: up to 3 attempts per command, 30 s apart, inside the install budget; a timeout (exit 124) is not retried.
- Tails: last 50 lines, at most 4,000 characters, ANSI removed.
- trustbut pinned to exactly `0.5.0`.
- Commit after each task with a conventional message ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## File map

| File | Change |
|---|---|
| `src/aggregate/families.ts` | red at head = `test-regressed` |
| `src/report/html.ts:30` | family label |
| `src/run/tail.ts` | new: `tail()` |
| `src/run/exec.ts` | `runShell` captures output |
| `src/run/job.ts` | budgets exported, install retries + tail, verify flags |
| `src/types.ts` | `RunRecord.installRetries?`, `installTail?` |
| `src/run/status.ts` | `isRunRecord` accepts the new fields |
| `config/trustbut.json` | new: `{ "timeoutSec": 2400 }` |
| `.github/workflows/run.yml` | `timeout-minutes: 120`, `TRUSTBUT_SPEC: '0.5.0'` |
| `PREREGISTRATION.md`, `README.md` | rules and versions |
| tests | `test/families.test.ts`, `test/exec.test.ts`, `test/tail.test.ts`, `test/job.test.ts`, `test/status.test.ts`, `test/budgets.test.ts` |

---

### Task 1: Red at head counts only regressions

**Files:**
- Modify: `src/aggregate/families.ts:5-16`, `src/report/html.ts:30`, `PREREGISTRATION.md` (Metrics, "red at head" and "Context only" bullets)
- Test: `test/families.test.ts`

**Interfaces:**
- Produces: `FAMILY_OF['test-regressed'] === 'red-at-head'`; `suite-failing` and `test-failing` have no family.

- [ ] **Step 1: Write the failing test**

Replace the first `it` in `test/families.test.ts` with:
```ts
  it('maps counted ids to families and ignores context ids', () => {
    const rec = r(['deps-changed', 'test-passes-without-change', 'test-skipped', 'escape-added', 'snapshot-changed', 'test-regressed']);
    expect(countedFindings(rec).map((c) => [c.index, c.family])).toEqual([
      [1, 'proof-gap'], [2, 'test-weakening'], [3, 'escapes'], [5, 'red-at-head'],
    ]);
    expect([...familiesOf(rec)].sort()).toEqual(['escapes', 'proof-gap', 'red-at-head', 'test-weakening']);
  });
  it('counts only tests that passed at base as red at head', () => {
    expect(countedFindings(r(['suite-failing', 'test-failing']))).toEqual([]);
    expect(countedFindings(r(['suite-failing', 'test-regressed'])).map((c) => [c.index, c.family])).toEqual([[1, 'red-at-head']]);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/families.test.ts`
Expected: FAIL. `test-regressed` isn't mapped, and `suite-failing` still counts.

- [ ] **Step 3: Implement**

In `src/aggregate/families.ts` replace the two lines
```ts
  'suite-failing': 'red-at-head',
  'test-failing': 'red-at-head',
```
with
```ts
  // Red at head counts only tests that passed at base (trustbut 0.5.0). `suite-failing` and `test-failing` are context:
  // in the first pilot almost all of them failed at base too.
  'test-regressed': 'red-at-head',
```

In `src/report/html.ts:30` change `'red-at-head': 'Tests red at head',` to `'red-at-head': 'Tests that passed at base fail at head',`.

In `PREREGISTRATION.md`, Metrics → Finding families:
- `  - red at head: \`suite-failing\`, \`test-failing\`` → `  - red at head: \`test-regressed\` (a test that passes at base and fails at head)`
- The "Context only, not counted" line: add `suite-failing`, `test-failing` at the start of the list.

- [ ] **Step 4: Run the tests**

Run: `npm test`
Expected: PASS. If a report snapshot contains "Tests red at head", check the label is the only difference, then run `npx vitest run -u` on that file.

- [ ] **Step 5: Commit**

```bash
git add src/aggregate/families.ts src/report/html.ts PREREGISTRATION.md test
git commit -m "fix: red at head counts only tests that passed at base

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `tail()` and captured shell output

**Files:**
- Create: `src/run/tail.ts`, `test/tail.test.ts`
- Modify: `src/run/exec.ts`
- Test: `test/exec.test.ts`

**Interfaces:**
- Produces:
  - `tail(output: string, maxLines = 50, maxChars = 4000): string`
  - `runShell(cmd: string, cwd: string, timeoutMs: number): Promise<{ exit: number; ms: number; output: string }>`: `output` is stdout and stderr interleaved, still streamed to the job log.

- [ ] **Step 1: Write the failing tests**

`test/tail.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { tail } from '../src/run/tail.js';

describe('tail', () => {
  it('keeps the last 50 lines without colour codes or trailing blank lines', () => {
    const out = Array.from({ length: 60 }, (_, i) => `\u001b[31mline ${i + 1}\u001b[0m`).join('\n') + '\n\n';
    expect(tail(out).split('\n')).toEqual(Array.from({ length: 50 }, (_, i) => `line ${i + 11}`));
  });
  it('keeps at most 4,000 characters, from the end', () => {
    const t = tail(`${'a'.repeat(3000)}${'b'.repeat(3000)}`);
    expect(t).toHaveLength(4000);
    expect(t.endsWith('b'.repeat(3000))).toBe(true);
  });
  it('is empty for empty output', () => {
    expect(tail('')).toBe('');
  });
});
```

Add to `test/exec.test.ts`:
```ts
  it('returns the output it streamed, stdout and stderr', async () => {
    const r = await runShell('echo out; echo err >&2; exit 1', process.cwd(), 5000);
    expect(r.exit).toBe(1);
    expect(r.output).toContain('out');
    expect(r.output).toContain('err');
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/tail.test.ts test/exec.test.ts`
Expected: FAIL. `src/run/tail.js` doesn't exist, and `output` is undefined.

- [ ] **Step 3: Implement**

`src/run/tail.ts`:
```ts
/** Terminal colour and cursor codes. */
const ANSI = new RegExp(String.raw`\u001b\[[0-9;]*[A-Za-z]`, 'g');

/** The end of a command's output for run.json: the last `maxLines` lines and at most `maxChars` characters, without colour codes. */
export function tail(output: string, maxLines = 50, maxChars = 4000): string {
  const lines = output.replace(ANSI, '').replace(/\s+$/, '').split(/\r?\n/).slice(-maxLines);
  while (lines.length > 1 && lines.join('\n').length > maxChars) lines.shift();
  const text = lines.join('\n');
  return text.length > maxChars ? text.slice(-maxChars) : text;
}
```

`src/run/exec.ts`:
```ts
import { execa } from 'execa';
import { TIMEOUT_EXIT } from './status.js';

/**
 * Runs `bash -c cmd`, streaming output to this process and also returning it (stdout and stderr interleaved).
 * A timeout reports exit 124, like coreutils `timeout`.
 */
export async function runShell(cmd: string, cwd: string, timeoutMs: number): Promise<{ exit: number; ms: number; output: string }> {
  const start = Date.now();
  const r = await execa('bash', ['-c', cmd], {
    cwd, timeout: Math.max(timeoutMs, 1), reject: false, stdin: 'ignore',
    stdout: ['pipe', 'inherit'], stderr: ['pipe', 'inherit'], all: true,
  });
  const exit = r.timedOut ? TIMEOUT_EXIT : (r.exitCode ?? 1);
  return { exit, ms: Date.now() - start, output: typeof r.all === 'string' ? r.all : '' };
}
```
If execa 10 rejects the array form in TypeScript, check its docs (`node_modules/execa/readme.md`, "Multiple targets") and use the documented equivalent. Don't drop streaming: the job log is how a person watches a run.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/tail.test.ts test/exec.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/run/tail.ts src/run/exec.ts test/tail.test.ts test/exec.test.ts
git commit -m "feat: capture shell output and keep its tail

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Install retries, `installRetries` and `installTail` in run.json

**Files:**
- Modify: `src/run/job.ts` (`install`, `record`, `StepResult`), `src/types.ts:59-69`, `src/run/status.ts` (`isRunRecord`)
- Test: `test/job.test.ts`, `test/status.test.ts`

**Interfaces:**
- Consumes: `runShell` with `output`, `tail()` (Task 2).
- Produces:
  - `install(env: JobEnv, opts?: { waitMs?: number; budgetMs?: number }): Promise<void>`, with defaults `RETRY_WAIT_MS` (30,000) and `INSTALL_BUDGET_MS`.
  - `export const MAX_INSTALL_ATTEMPTS = 3`, `export const RETRY_WAIT_MS = 30_000`.
  - `RunRecord.installRetries?: number`, `RunRecord.installTail?: string`. `record()` always writes `installRetries`, and writes `installTail` only when install failed.

- [ ] **Step 1: Write the failing tests**

In `test/job.test.ts`:
1. In `records the failing install exit code`, change `prep.recipe.node.install = 'exit 3';` to `prep.recipe.node.install = 'echo boom; exit 3';` and `await install(ev);` to `await install(ev, { waitMs: 0 });`, and extend the expectation:
```ts
    expect(await record(ent, ev)).toMatchObject({
      status: 'setup-failed', stage: 'install', exitCodes: { install: 3, verify: null }, installRetries: 2, installTail: 'boom',
    });
```
   All 3 attempts print `boom`. `installTail` holds only the last attempt's output, so it is `'boom'`.
2. Add tests (a helper first):
```ts
async function preparedWith(install: string) {
  const { gitBase, baseSha, headSha } = await fixtureRemote();
  const ev = await env(gitBase);
  const ent = entry(baseSha, headSha);
  await prepare(ent, ev);
  const prep = JSON.parse(await readFile(join(ev.work, 'prep.json'), 'utf8'));
  prep.recipe.node.install = install;
  await writeFile(join(ev.work, 'prep.json'), JSON.stringify(prep));
  return { ev, ent };
}

describe('install retries', () => {
  it('reruns a failing command and succeeds on a later attempt', async () => {
    const { ev, ent } = await preparedWith('n=$(cat .attempts 2>/dev/null || echo 0); n=$((n+1)); echo $n > .attempts; [ "$n" -ge 3 ]');
    await install(ev, { waitMs: 0 });
    await verify(ent, ev);
    const run = await record(ent, ev);
    expect(run).toMatchObject({ status: 'ran', installRetries: 2, exitCodes: { install: 0 } });
    expect(run).not.toHaveProperty('installTail');
  });

  it('does not retry a timeout', async () => {
    const { ev, ent } = await preparedWith('sleep 5');
    await install(ev, { waitMs: 0, budgetMs: 300 });
    expect(await record(ent, ev)).toMatchObject({ status: 'timeout', stage: 'install', installRetries: 0 });
  });

  it('stops retrying when the budget has no room for the wait', async () => {
    const { ev, ent } = await preparedWith('echo nope; exit 1');
    await install(ev, { waitMs: 5000, budgetMs: 1000 });
    expect(await record(ent, ev)).toMatchObject({ status: 'setup-failed', installRetries: 0, installTail: 'nope' });
  });
});
```
   Also pass `{ waitMs: 0 }` to `install(ev)` in the other existing tests that call it, so no test waits 30 s.

In `test/status.test.ts`, inside `accepts a run record and rejects junk`, add:
```ts
    expect(isRunRecord({ ...run, installRetries: 2, installTail: 'npm error ECONNRESET' })).toBe(true);
    expect(isRunRecord({ ...run, installRetries: -1 })).toBe(false);
    expect(isRunRecord({ ...run, installRetries: 1.5 })).toBe(false);
    expect(isRunRecord({ ...run, installTail: 3 })).toBe(false);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/job.test.ts test/status.test.ts`
Expected: FAIL. No retries happen, `installRetries`/`installTail` are missing, `install` ignores options, and `isRunRecord` doesn't check the new fields.

- [ ] **Step 3: Implement**

`src/types.ts`, in `RunRecord` after `exitCodes`:
```ts
  /** How many times a failed install command was run again (absent in runs before 2026-10-16). */
  installRetries?: number;
  /** The end of the failing install command's output (only when install failed). */
  installTail?: string;
```

`src/run/status.ts`, in `isRunRecord`, add to the `&&` chain before `isStr(r.runnerImage)`:
```ts
    (r.installRetries === undefined || (Number.isInteger(r.installRetries) && r.installRetries >= 0)) &&
    (r.installTail === undefined || isStr(r.installTail)) &&
```

`src/run/job.ts`:
- Imports: add `import { setTimeout as sleep } from 'node:timers/promises';` and `import { tail } from './tail.js';`.
- Constants (Task 5 changes the values; keep 20 min here):
```ts
export const INSTALL_BUDGET_MS = 20 * 60_000;
export const VERIFY_BUDGET_MS = 35 * 60_000;
export const MAX_INSTALL_ATTEMPTS = 3;
export const RETRY_WAIT_MS = 30_000;
```
- Add `interface InstallResult extends StepResult { retries: number; tail?: string }`.
- Replace `install` with:
```ts
export async function install(env: JobEnv, opts: { waitMs?: number; budgetMs?: number } = {}): Promise<void> {
  const { waitMs = RETRY_WAIT_MS, budgetMs = INSTALL_BUDGET_MS } = opts;
  const prep = await readJsonOr<Prep>(join(env.work, 'prep.json'), { fetchOk: false, recipe: null });
  const result: InstallResult = { exit: null, ms: 0, retries: 0 };
  if (prep.fetchOk && prep.recipe) {
    const cmds = [...(prep.recipe.node ? [prep.recipe.node.install] : []), ...(prep.recipe.python?.install ?? [])];
    const start = Date.now();
    const left = () => budgetMs - (Date.now() - start);
    result.exit = 0;
    for (const cmd of cmds) {
      let r = { exit: TIMEOUT_EXIT, ms: 0, output: '' };
      for (let attempt = 1; attempt <= MAX_INSTALL_ATTEMPTS; attempt++) {
        r = left() > 0 ? await runShell(cmd, repoDir(env), left()) : { exit: TIMEOUT_EXIT, ms: 0, output: '' };
        // A timeout is not retried; a network flake usually is.
        if (r.exit === 0 || r.exit === TIMEOUT_EXIT || attempt === MAX_INSTALL_ATTEMPTS || left() <= waitMs) break;
        await sleep(waitMs);
        result.retries++;
      }
      if (r.exit !== 0) {
        result.exit = r.exit;
        const t = tail(r.output);
        if (t) result.tail = t;
        break;
      }
    }
    result.ms = Date.now() - start;
  }
  await writeJson(join(env.work, 'install.json'), result);
}
```
  When `left() <= waitMs` there's no time for the wait plus another attempt, so it stops.
- In `record`, read install as `readJsonOr<InstallResult>(join(env.work, 'install.json'), { exit: null, ms: 0, retries: 0 })` and add to the `RunRecord` object after `exitCodes`:
```ts
    installRetries: inst.retries ?? 0,
    ...(inst.exit !== 0 && inst.exit !== null && inst.tail ? { installTail: inst.tail } : {}),
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/job.test.ts test/status.test.ts && npm run typecheck && npm test`
Expected: PASS. `npm test` covers `ingest`, which reads old `run.json` files without the new fields.

- [ ] **Step 5: Commit**

```bash
git add src/run/job.ts src/types.ts src/run/status.ts test/job.test.ts test/status.test.ts
git commit -m "feat: retry failed install commands and record the install output tail

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: trustbut gets the study config and `--output-tail`

**Files:**
- Create: `config/trustbut.json`
- Modify: `src/run/job.ts` (`JobEnv`, `jobEnv`, `verify`)
- Test: `test/job.test.ts`

**Interfaces:**
- Produces: `JobEnv.tbConfig: string`, an absolute path that defaults to `<index checkout>/config/trustbut.json` (env override `TB_CONFIG`). `verify` runs `trustbut verify --base <base> --head <head> --json --config <tbConfig> --output-tail`.

- [ ] **Step 1: Write the failing test**

In `test/job.test.ts`, extend `env()` so the fake trustbut also records its arguments next to itself:
```ts
  await writeFile(tbCli, `import { writeFileSync } from 'node:fs'; writeFileSync(new URL('./args.json', import.meta.url), JSON.stringify(process.argv.slice(2))); process.stdout.write(JSON.stringify({specVersion:'1.0',producer:{name:'trustbut',version:'0.4.0'},subject:{base:'b',head:'h'},verdict:'warn',findings:[],tests:{passed:2,failed:0,errored:0,skipped:0,scope:'full'}})); process.exit(0);`);
```
and return `tbConfig: join(root, 'trustbut.json')` in the `JobEnv` object. Then add to `describe('job steps')`:
```ts
  it('runs trustbut with the study config and output tails', async () => {
    const { gitBase, baseSha, headSha } = await fixtureRemote();
    const ev = await env(gitBase);
    const ent = entry(baseSha, headSha);
    await prepare(ent, ev);
    const prep = JSON.parse(await readFile(join(ev.work, 'prep.json'), 'utf8'));
    prep.recipe.node.install = 'true';
    await writeFile(join(ev.work, 'prep.json'), JSON.stringify(prep));
    await install(ev, { waitMs: 0 });
    await verify(ent, ev);
    const args = JSON.parse(await readFile(join(dirname(ev.tbCli), 'args.json'), 'utf8'));
    expect(args).toEqual(['verify', '--base', baseSha, '--head', headSha, '--json', '--config', ev.tbConfig, '--output-tail']);
  });

  it('defaults the study config to config/trustbut.json in this repo, which sets the suite timeout', async () => {
    const { jobEnv } = await import('../src/run/job.js');
    const path = jobEnv({}).tbConfig;
    expect(path.endsWith('/config/trustbut.json')).toBe(true);
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ timeoutSec: 2400 });
  });
```
Add `dirname` to the `node:path` import.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run test/job.test.ts`
Expected: FAIL. The args lack `--config`/`--output-tail`, and `tbConfig` / `config/trustbut.json` don't exist (typecheck error on `JobEnv`).

- [ ] **Step 3: Implement**

`config/trustbut.json`:
```json
{ "timeoutSec": 2400 }
```

`src/run/job.ts`:
- Import `fileURLToPath` from `node:url`.
- `JobEnv` gains `tbConfig: string;` after `tbCli`.
- In `jobEnv`: `tbConfig: env.TB_CONFIG ?? fileURLToPath(new URL('../../config/trustbut.json', import.meta.url)),`
- In `verify`, the args become:
```ts
    const args = ['verify', '--base', entry.baseSha, '--head', entry.headSha, '--json', '--config', env.tbConfig, '--output-tail'];
    const r = await execa(env.node22, [env.tbCli, ...args], {
```
Add a comment above `args`: `// The study config replaces any .trustbut.json in the repo (no per-repo tuning); --output-tail keeps failure output in the receipt.`

- [ ] **Step 4: Run the tests**

Run: `npx vitest run test/job.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add config/trustbut.json src/run/job.ts test/job.test.ts
git commit -m "feat: run trustbut with the study config and --output-tail

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Budgets, trustbut 0.5.0 pin and docs

**Files:**
- Modify: `src/run/job.ts` (budget constants), `.github/workflows/run.yml` (`TRUSTBUT_SPEC`, `pr.timeout-minutes`), `PREREGISTRATION.md` (line 6 version; Procedure paragraph), `README.md:14`
- Create: `test/budgets.test.ts`

**Interfaces:**
- Consumes: `INSTALL_BUDGET_MS`, `VERIFY_BUDGET_MS` (exported in Task 3), `config/trustbut.json` (Task 4).

- [ ] **Step 1: Write the failing test**

`test/budgets.test.ts`:
```ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { INSTALL_BUDGET_MS, VERIFY_BUDGET_MS } from '../src/run/job.js';

const MIN = 60_000;

describe('run budgets', () => {
  it('match the pre-registered numbers', async () => {
    const yml = await readFile('.github/workflows/run.yml', 'utf8');
    const { timeoutSec } = JSON.parse(await readFile('config/trustbut.json', 'utf8')) as { timeoutSec: number };
    expect(yml).toMatch(/^ {4}timeout-minutes: 120$/m);
    expect(yml).toContain("TRUSTBUT_SPEC: '0.5.0'");
    expect(INSTALL_BUDGET_MS).toBe(25 * MIN);
    expect(VERIFY_BUDGET_MS).toBe(85 * MIN);
    expect(timeoutSec).toBe(2400);
  });

  it('fit inside each other: two trustbut runs in verify, install plus verify plus 10 minutes of setup in the job', async () => {
    const yml = await readFile('.github/workflows/run.yml', 'utf8');
    const jobMinutes = Number(/^ {4}timeout-minutes: (\d+)$/m.exec(yml)![1]);
    const { timeoutSec } = JSON.parse(await readFile('config/trustbut.json', 'utf8')) as { timeoutSec: number };
    expect(2 * timeoutSec * 1000).toBeLessThan(VERIFY_BUDGET_MS);
    expect(INSTALL_BUDGET_MS + VERIFY_BUDGET_MS + 10 * MIN).toBeLessThanOrEqual(jobMinutes * MIN);
  });
});
```
Check `run.yml` indentation first: `timeout-minutes` under `pr:` is indented 4 spaces. Adjust the regex if not.

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run test/budgets.test.ts`
Expected: FAIL (60 minutes, `0.4.0`, 20/35 min).

- [ ] **Step 3: Implement**

- `src/run/job.ts`: `INSTALL_BUDGET_MS = 25 * 60_000`, `VERIFY_BUDGET_MS = 85 * 60_000`.
- `.github/workflows/run.yml`: `TRUSTBUT_SPEC: '0.5.0'`; under `pr:` `timeout-minutes: 120`.
- `PREREGISTRATION.md`:
  - line 6: `trustbut 0.4.0 exactly` → `trustbut 0.5.0 exactly`.
  - Procedure paragraph: `with a 60-minute limit. Within it, dependency installation gets 20 minutes and the trustbut run gets 35 minutes;` → `with a 120-minute limit. Within it, dependency installation gets 25 minutes and the trustbut run gets 85 minutes;`. After "a step that exceeds its budget is recorded as `timeout`." add: "An install command that fails is run again up to two more times, 30 seconds apart, within the install budget; a timed-out command is not." Change `` `verify --base <PR base SHA> --head <PR head SHA> --json` `` to `` `verify --base <PR base SHA> --head <PR head SHA> --json --config config/trustbut.json --output-tail` `` and add: "`config/trustbut.json` sets a 2,400-second limit for each test run and replaces any `.trustbut.json` in the repo."
- `README.md:14`: `running trustbut 0.4.0` → `running trustbut 0.5.0`.

- [ ] **Step 4: Run all tests**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/run/job.ts .github/workflows/run.yml PREREGISTRATION.md README.md test/budgets.test.ts
git commit -m "fix: raise run budgets and pin trustbut 0.5.0

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Spec as built, PR, rerun and comparison

This task has outward-facing steps (push, PR, workflow dispatch). Each needs the user's go-ahead in the session, and trustbut 0.5.0 must already be on npm (`npm view trustbut@0.5.0 version` prints `0.5.0`).

- [ ] **Step 1: Mark the spec implemented**

In `docs/superpowers/specs/2026-10-16-pilot-measurement-fixes-design.md` set `**Status:** Implemented (YYYY-MM-DD)` and add `## As built` listing every difference from the spec, or "none". Known candidates: only the last attempt's output is kept in `installTail`; the budget check test; `TB_CONFIG` override.

- [ ] **Step 2: Commit, push, open the PR**

```bash
git add docs/superpowers/specs/2026-10-16-pilot-measurement-fixes-design.md
git commit -m "docs: pilot measurement fixes as built

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push -u origin fix/pilot-measurement
gh pr create --repo isAlmogK/trustbut-index --base main --head fix/pilot-measurement --title "fix: pilot measurement fixes (red at head, budgets, retries, output tails)" --body-file <body file>
```
The PR body summarizes the four fixes, links the spec and the trustbut PR, and ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

- [ ] **Step 3: After merge, dispatch the rerun**

```bash
gh workflow run run.yml --repo isAlmogK/trustbut-index --ref main -f manifest=manifests/pilot-2026-10-15.jsonl -f batch=0 -f date=pilot-2026-10-16
```
The `ingest` job commits `results/pilot-2026-10-16/` and its `aggregate.json` to main.

- [ ] **Step 4: Compare the two runs**

Once the results are on main: `git fetch origin && git show origin/main:results/pilot-2026-10-16/aggregate.json`. Compare with `pilot-2026-10-15` like with like:
- Run coverage overall and by status and stage, over all 201 PRs.
- The any-counted rate, the proof rate and red at head on the PRs that ran in both runs, overall and agents versus humans.
- Red at head under the old definition (any `suite-failing` or `test-failing`) computed on run 2 as well, to isolate the budget and retry effect; the new definition (`test-regressed`) and "red at head not compared" reported separately for run 2.
- Note that the proof rate is not strictly like for like (0.5.0's base run is larger and can be stopped by a failing unchanged file) and that installs without a lockfile may resolve newer dependencies.

For the PRs that still didn't run, group them by `stage` and by the first line of `installTail` or `x-trustbut.after.outputTail`. Report this after the rerun in the conversation (or a follow-up note), not in the PR description, and as a comment on the merged PR only if the user agrees.
