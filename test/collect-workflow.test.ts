import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const load = (f: string) => readFile(`.github/workflows/${f}`, 'utf8');
const ENV_LINE = /^\s+[A-Z_]+: \$\{\{ (inputs\.\w+|secrets\.\w+|github\.token) \}\}$/;

describe('collect.yml', () => {
  it('uses inputs and secrets only on env: mapping lines', async () => {
    const yml = await load('collect.yml');
    const risky = yml.split('\n').filter((l) => /\$\{\{\s*(inputs|secrets)\./.test(l));
    expect(risky.length).toBeGreaterThan(0);
    expect(risky.filter((l) => !ENV_LINE.test(l))).toEqual([]);
  });
  it('declares the one-click inputs and least-privilege permissions', async () => {
    const yml = await load('collect.yml');
    for (const k of ['pilot:', 'until:', 'days:', 'exclude:']) expect(yml).toContain(`      ${k}`);
    expect(yml).toMatch(/^permissions: \{\}$/m);
    expect(yml).toMatch(/contents: write/);
    expect(yml).toMatch(/actions: write/);
    expect(yml).toMatch(/group: collect\n\s+cancel-in-progress: false/);
  });
  it('pins every action to a commit SHA', async () => {
    const uses = (await load('collect.yml')).match(/uses: .*/g)!;
    expect(uses.length).toBe(4);
    for (const u of uses) expect(u).toMatch(/^uses: actions\/(checkout|setup-node|cache\/restore|cache\/save)@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  });
  it('restores the API cache by date and saves it even when collect fails or times out', async () => {
    const yml = await load('collect.yml');
    const key = 'key: github-api-${{ env.UNTIL }}-${{ github.run_id }}-${{ github.run_attempt }}';
    expect(yml.split(key).length - 1).toBe(2);
    expect(yml).toContain('restore-keys: github-api-${{ env.UNTIL }}-');
    const restoreAt = yml.indexOf('name: Restore the API cache');
    const collectAt = yml.indexOf('name: Collect');
    const saveAt = yml.indexOf('name: Save the API cache');
    expect(restoreAt).toBeGreaterThan(-1);
    expect(restoreAt).toBeLessThan(collectAt);
    expect(saveAt).toBeGreaterThan(collectAt);
    expect(saveAt).toBeLessThan(yml.indexOf('name: Commit the manifest'));
    expect(yml.slice(saveAt, saveAt + 200)).toMatch(/\n\s+if: always\(\) && env\.UNTIL != ''\n/);
  });
  it('gives the collect step its own timeout inside the job timeout', async () => {
    const yml = await load('collect.yml');
    expect(yml).toMatch(/^ {4}timeout-minutes: 350$/m);
    const step = yml.slice(yml.indexOf('name: Collect'), yml.indexOf('name: Save the API cache'));
    expect(step).toMatch(/^ {8}timeout-minutes: 320$/m);
  });
  it('uses the same checkout and setup-node pins as the ingest job in run.yml', async () => {
    const ingest = (await load('run.yml')).match(/uses: actions\/(?:checkout|setup-node)@[0-9a-f]{40}/g)!;
    const collect = (await load('collect.yml')).match(/uses: actions\/(?:checkout|setup-node)@[0-9a-f]{40}/g)!;
    expect(collect).toEqual(ingest);
  });
  it('gives the token to the check and collect steps only', async () => {
    const yml = await load('collect.yml');
    expect(yml.match(/GITHUB_TOKEN: \$\{\{ secrets\.INDEX_GH_TOKEN \}\}/g)!.length).toBe(2);
    expect(yml).toContain('::error::Add the INDEX_GH_TOKEN secret (see README)');
  });
  it('validates until and days, and builds collect args as an array', async () => {
    const yml = await load('collect.yml');
    expect(yml).toContain('UNTIL="${UNTIL_IN:-$(date -u +%F)}"');
    expect(yml).toContain('^[0-9]{4}-[0-9]{2}-[0-9]{2}$');
    expect(yml).toMatch(/\^\[1-9\]\[0-9\]\*\$/);
    expect(yml).toContain('npx tsx src/cli.ts "${args[@]}"');
    expect(yml).toContain('--exclude-manifest "$EXCLUDE"');
    expect(yml).toContain('github-api-${{ env.UNTIL }}');
  });
  it('commits the manifest with the retry loop and starts every batch of 250', async () => {
    const yml = await load('collect.yml');
    expect(yml).toMatch(/for attempt in 1 2 3 4 5; do/);
    expect(yml).toMatch(/git pull --rebase && git push/);
    expect(yml).toContain('gh workflow run run.yml --ref main -f manifest="$MANIFEST" -f batch="$b" -f date="$NAME"');
    expect(yml).toContain('(N - 1) / 250');
    expect(yml).toContain('GITHUB_STEP_SUMMARY');
  });
});

describe('run.yml ingest post-processing', () => {
  const ingestJob = async () => {
    const yml = await load('run.yml');
    return yml.slice(yml.indexOf('\n  ingest:'));
  };
  it('commits raw per-PR files first, without the derived files', async () => {
    const job = await ingestJob();
    const raw = job.slice(job.indexOf('name: Commit raw results'), job.indexOf('name: Aggregate'));
    const adds = raw.split('\n').filter((l) => /git add /.test(l));
    expect(adds).toEqual(['          git add "results/$DATE"/*.run.json "results/$DATE"/*.receipt.json']);
    expect(raw).not.toMatch(/aggregate\.json|pilot-check/);
    expect(raw).toMatch(/for attempt in 1 2 3 4 5; do/);
    expect(raw).toMatch(/git pull --rebase && git push/);
  });
  it('recomputes aggregate and checklist from the latest main after the raw push', async () => {
    const job = await ingestJob();
    const rawAt = job.indexOf('name: Commit raw results');
    const derivedAt = job.indexOf('name: Aggregate');
    expect(job.indexOf('src/cli.ts ingest')).toBeLessThan(rawAt);
    expect(derivedAt).toBeGreaterThan(rawAt);
    const derived = job.slice(derivedAt);
    expect(derived.indexOf('git reset --hard origin/main')).toBeLessThan(derived.indexOf('src/cli.ts aggregate --manifest "$MANIFEST" --date "$DATE"'));
    expect(derived).toContain('case "$DATE" in pilot-*) npx tsx src/cli.ts checklist --manifest "$MANIFEST" --date "$DATE" ;; esac');
    expect(derived).toContain('git add "results/$DATE/aggregate.json"');
    expect(derived).toMatch(/for attempt in 1 2 3 4 5; do/);
    expect(derived).toMatch(/git push/);
    expect(job).not.toMatch(/write different files/);
  });
  it('never puts inputs or secrets inside a run: script', async () => {
    const yml = await load('run.yml');
    const lines = yml.split('\n');
    let inRun = false;
    let indent = 0;
    const bad: string[] = [];
    for (const l of lines) {
      const m = /^(\s*)(?:- )?run:\s*(.*)$/.exec(l);
      if (m) {
        indent = m[1]!.length;
        inRun = m[2] === '|' || m[2] === '';
        if (/\$\{\{\s*(inputs|secrets)\./.test(m[2]!)) bad.push(l);
        continue;
      }
      if (inRun) {
        if (l.trim() !== '' && l.length - l.trimStart().length <= indent) inRun = false;
        else if (/\$\{\{\s*(inputs|secrets)\./.test(l)) bad.push(l);
      }
    }
    expect(bad).toEqual([]);
  });
  it('collect fails fast unless run from main', async () => {
    const yml = await load('collect.yml');
    expect(yml).toContain('GITHUB_REF" != "refs/heads/main"');
    expect(yml).toContain('::error::Run collect from main');
    expect(yml.indexOf('Run collect from main')).toBeLessThan(yml.indexOf('npm ci'));
  });
});

describe('all workflows', () => {
  it('never use the runner context in job-level env (GitHub rejects the file)', async () => {
    for (const f of ['run.yml', 'collect.yml', 'pages.yml', 'ci.yml']) {
      const lines = (await load(f)).split('\n');
      const bad: string[] = [];
      let inJobEnv = false;
      for (const l of lines) {
        if (/^ {4}env:\s*$/.test(l)) { inJobEnv = true; continue; }
        if (inJobEnv && !/^ {6,}\S/.test(l)) inJobEnv = false;
        if (inJobEnv && /\$\{\{\s*runner\./.test(l)) bad.push(l.trim());
      }
      expect({ f, bad }).toEqual({ f, bad: [] });
    }
  });
});

