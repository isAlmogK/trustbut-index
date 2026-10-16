import { mkdtemp, readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { install, prepare, record, verify, type JobEnv } from '../src/run/job.js';
import type { ManifestEntry } from '../src/types.js';

async function fixtureRemote() {
  const gitBase = await mkdtemp(join(tmpdir(), 'remote-'));
  const dir = join(gitBase, 'o', 'r.git');
  await mkdir(dir, { recursive: true });
  const git = (...a: string[]) => execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir });
  await git('init', '-q');
  await git('config', 'uploadpack.allowReachableSHA1InWant', 'true');
  await writeFile(join(dir, 'package.json'), JSON.stringify({ devDependencies: { vitest: '^3' } }));
  await writeFile(join(dir, 'package-lock.json'), '{}');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'base');
  const baseSha = (await git('rev-parse', 'HEAD')).stdout.trim();
  await writeFile(join(dir, 'a.js'), 'export const a = 1;\n');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'head');
  const headSha = (await git('rev-parse', 'HEAD')).stdout.trim();
  return { gitBase, baseSha, headSha };
}

async function env(gitBase: string): Promise<JobEnv> {
  const root = await mkdtemp(join(tmpdir(), 'job-'));
  const tbCli = join(root, 'fake-trustbut.mjs');
  await writeFile(tbCli, `import { writeFileSync } from 'node:fs'; writeFileSync(new URL('./args.json', import.meta.url), JSON.stringify(process.argv.slice(2))); process.stdout.write(JSON.stringify({specVersion:'1.0',producer:{name:'trustbut',version:'0.4.0'},subject:{base:'b',head:'h'},verdict:'warn',findings:[],tests:{passed:2,failed:0,errored:0,skipped:0,scope:'full'}})); process.exit(0);`);
  await chmod(tbCli, 0o755);
  return { work: join(root, 'work'), out: join(root, 'out'), gitBase, node22: process.execPath, tbCli, tbConfig: join(root, 'trustbut.json'), githubOutput: join(root, 'gh-output'), runnerImage: 'test' };
}

const entry = (baseSha: string, headSha: string) => ({ id: 'o/r#1', repo: 'o/r', pr: 1, baseSha, headSha }) as ManifestEntry;

describe('job steps', () => {
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

  it('prepares, installs, verifies and records a run', async () => {
    const { gitBase, baseSha, headSha } = await fixtureRemote();
    const ev = await env(gitBase);
    const ent = entry(baseSha, headSha);
    await prepare(ent, ev);
    const prep = JSON.parse(await readFile(join(ev.work, 'prep.json'), 'utf8'));
    expect(prep.fetchOk).toBe(true);
    expect(prep.recipe.node).toMatchObject({ pm: 'npm', install: 'npm ci' });
    expect(await readFile(ev.githubOutput!, 'utf8')).toContain('has_node=true');

    prep.recipe.node.install = 'true'; // don't run a real npm ci in unit tests
    await writeFile(join(ev.work, 'prep.json'), JSON.stringify(prep));
    await install(ev, { waitMs: 0 });
    await verify(ent, ev);
    const run = await record(ent, ev);
    expect(run).toMatchObject({ id: 'o__r__1', status: 'ran', stage: null, trustbutVersion: '0.4.0' });
    expect(JSON.parse(await readFile(join(ev.out, 'run.json'), 'utf8')).status).toBe('ran');
    expect(JSON.parse(await readFile(join(ev.out, 'receipt.json'), 'utf8')).verdict).toBe('warn');
  });

  it('records setup-failed when the commits cannot be fetched', async () => {
    const { gitBase } = await fixtureRemote();
    const ev = await env(gitBase);
    const ent = entry('0'.repeat(40), '1'.repeat(40));
    await prepare(ent, ev);
    await install(ev, { waitMs: 0 });
    await verify(ent, ev);
    expect(await record(ent, ev)).toMatchObject({ status: 'setup-failed', stage: 'fetch' });
  });

  it('records the failing install exit code', async () => {
    const { gitBase, baseSha, headSha } = await fixtureRemote();
    const ev = await env(gitBase);
    const ent = entry(baseSha, headSha);
    await prepare(ent, ev);
    const prep = JSON.parse(await readFile(join(ev.work, 'prep.json'), 'utf8'));
    prep.recipe.node.install = 'echo boom; exit 3';
    await writeFile(join(ev.work, 'prep.json'), JSON.stringify(prep));
    await install(ev, { waitMs: 0 });
    await verify(ent, ev);
    expect(await record(ent, ev)).toMatchObject({
      status: 'setup-failed', stage: 'install', exitCodes: { install: 3, verify: null }, installRetries: 2, installTail: 'boom',
    });
  });
});

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

describe('step outputs', () => {
  it('rejects values containing a newline', async () => {
    const { setOutputs } = await import('../src/run/job.js');
    const ev = await env('x');
    await expect(setOutputs(ev, { node_version: '20\nhas_node=false' })).rejects.toThrow(/newline/);
    await expect(setOutputs(ev, { a: 'x\ry' })).rejects.toThrow(/newline/);
  });
});
