import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { readJsonOr, writeJson } from '../jsonl.js';
import { fileId, type ManifestEntry, type Receipt, type Recipe, type RunRecord } from '../types.js';
import { runShell } from './exec.js';
import { tail } from './tail.js';
import { fsFiles, inferRecipe } from './recipe.js';
import { TIMEOUT_EXIT, classify, looksLikeReceipt } from './status.js';

export const INSTALL_BUDGET_MS = 25 * 60_000;
export const VERIFY_BUDGET_MS = 85 * 60_000;
export const MAX_INSTALL_ATTEMPTS = 3;
export const RETRY_WAIT_MS = 30_000;

export interface JobEnv {
  work: string;
  out: string;
  gitBase: string;
  node22: string;
  tbCli: string;
  tbConfig: string;
  githubOutput?: string;
  runnerImage: string;
}

export function jobEnv(env: NodeJS.ProcessEnv = process.env): JobEnv {
  const temp = env.RUNNER_TEMP ?? '/tmp';
  return {
    work: env.WORK ?? join(temp, 'work'),
    out: env.OUT ?? join(temp, 'out'),
    gitBase: env.INDEX_GIT_BASE ?? 'https://github.com',
    node22: env.NODE22 ?? process.execPath,
    tbCli: env.TB_CLI ?? 'trustbut',
    tbConfig: env.TB_CONFIG ?? fileURLToPath(new URL('../../config/trustbut.json', import.meta.url)),
    githubOutput: env.GITHUB_OUTPUT,
    runnerImage: `${env.ImageOS ?? 'unknown'}/${env.ImageVersion ?? 'unknown'}`,
  };
}

interface Prep { fetchOk: boolean; recipe: Recipe | null }
interface StepResult { exit: number | null; ms: number }
interface InstallResult extends StepResult { retries: number; tail?: string }

const repoDir = (env: JobEnv) => join(env.work, 'repo');

async function git(args: string[]): Promise<boolean> {
  return (await execa('git', args, { reject: false, stdio: 'inherit' })).exitCode === 0;
}

export async function setOutputs(env: JobEnv, outputs: Record<string, string>): Promise<void> {
  for (const [k, v] of Object.entries(outputs)) if (/[\r\n]/.test(v)) throw new Error(`output ${k} contains a newline`);
  if (!env.githubOutput) return;
  await appendFile(env.githubOutput, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''));
}

export async function prepare(entry: ManifestEntry, env: JobEnv): Promise<void> {
  await mkdir(env.work, { recursive: true });
  await mkdir(env.out, { recursive: true });
  const dir = repoDir(env);
  const fetch = (refs: string[]) => git(['-C', dir, 'fetch', '-q', '--no-tags', 'origin', ...refs]);
  let fetchOk =
    (await git(['init', '-q', dir])) &&
    (await git(['-C', dir, 'remote', 'add', 'origin', `${env.gitBase}/${entry.repo}.git`])) &&
    ((await fetch([entry.baseSha, entry.headSha])) || (await fetch([entry.baseSha, `refs/pull/${entry.pr}/head`])));
  if (fetchOk) fetchOk = await git(['-C', dir, 'checkout', '-q', '--detach', entry.headSha]);
  const recipe = fetchOk ? inferRecipe(fsFiles(dir)) : null;
  await writeJson(join(env.work, 'prep.json'), { fetchOk, recipe } satisfies Prep);
  await setOutputs(env, {
    has_node: String(Boolean(recipe?.node)),
    node_version: recipe?.node?.version ?? '',
    pm: recipe?.node?.pm ?? '',
    has_python: String(Boolean(recipe?.python)),
    python_version: recipe?.python?.version ?? '',
  });
}

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

export async function verify(entry: ManifestEntry, env: JobEnv): Promise<void> {
  const inst = await readJsonOr<StepResult>(join(env.work, 'install.json'), { exit: null, ms: 0 });
  const result: StepResult = { exit: null, ms: 0 };
  if (inst.exit === 0) {
    const start = Date.now();
    // The study config replaces any .trustbut.json in the repo (no per-repo tuning); --output-tail keeps failure output in the receipt.
    const args = ['verify', '--base', entry.baseSha, '--head', entry.headSha, '--json', '--config', env.tbConfig, '--output-tail'];
    const r = await execa(env.node22, [env.tbCli, ...args], {
      cwd: repoDir(env), timeout: VERIFY_BUDGET_MS, reject: false, stderr: 'inherit',
    });
    result.exit = r.timedOut ? TIMEOUT_EXIT : (r.exitCode ?? 1);
    result.ms = Date.now() - start;
    try {
      const parsed: unknown = JSON.parse(String(r.stdout));
      if (looksLikeReceipt(parsed)) await writeJson(join(env.out, 'receipt.json'), parsed);
    } catch {
      // no receipt: classified as trustbut-error or timeout
    }
  }
  await writeJson(join(env.work, 'verify.json'), result);
}

export async function record(entry: ManifestEntry, env: JobEnv): Promise<RunRecord> {
  const prep = await readJsonOr<Prep>(join(env.work, 'prep.json'), { fetchOk: false, recipe: null });
  const inst = await readJsonOr<InstallResult>(join(env.work, 'install.json'), { exit: null, ms: 0, retries: 0 });
  const ver = await readJsonOr<StepResult>(join(env.work, 'verify.json'), { exit: null, ms: 0 });
  const receipt = await readJsonOr<Receipt | null>(join(env.out, 'receipt.json'), null);
  const { status, stage } = classify({ fetchOk: prep.fetchOk, recipe: prep.recipe, installExit: inst.exit, verifyExit: ver.exit, receipt });
  const run: RunRecord = {
    id: fileId(entry), status, stage, recipe: prep.recipe,
    durations: { installMs: inst.ms, verifyMs: ver.ms },
    exitCodes: { install: inst.exit, verify: ver.exit },
    installRetries: inst.retries ?? 0,
    ...(inst.exit !== 0 && inst.exit !== null && inst.tail ? { installTail: inst.tail } : {}),
    runnerImage: env.runnerImage,
    trustbutVersion: receipt?.producer.version ?? 'unknown',
  };
  await mkdir(env.out, { recursive: true });
  await writeJson(join(env.out, 'run.json'), run);
  return run;
}
