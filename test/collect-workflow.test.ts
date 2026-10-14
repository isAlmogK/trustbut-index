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
    expect(uses.length).toBe(3);
    for (const u of uses) expect(u).toMatch(/^uses: actions\/(checkout|setup-node|cache)@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
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
  it('aggregates after ingest and writes the checklist for pilot dates, before the commit', async () => {
    const yml = await load('run.yml');
    const job = yml.slice(yml.indexOf('\n  ingest:'));
    const ingestAt = job.indexOf('src/cli.ts ingest');
    const aggAt = job.indexOf('src/cli.ts aggregate --manifest "$MANIFEST" --date "$DATE"');
    const commitAt = job.indexOf('name: Commit results');
    expect(ingestAt).toBeGreaterThan(0);
    expect(aggAt).toBeGreaterThan(ingestAt);
    expect(commitAt).toBeGreaterThan(aggAt);
    expect(job).toContain('case "$DATE" in pilot-*) npx tsx src/cli.ts checklist --manifest "$MANIFEST" --date "$DATE" ;; esac');
    expect(job).toMatch(/for attempt in 1 2 3 4 5; do/);
  });
});
