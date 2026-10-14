import { describe, expect, it } from 'vitest';
import {
  ciRunsTests, detectJsTests, detectPyTests, isSourceFile, isTestPath, prReasons, repoMetaReasons, repoReasons,
  type RepoFacts,
} from '../src/collect/qualify.js';
import type { PrDetail } from '../src/types.js';

const now = new Date('2026-11-01T00:00:00Z');
const meta = { fullName: 'o/r', stars: 4200, fork: false, archived: false, pushedAt: '2026-10-30T00:00:00Z', language: 'TypeScript' };
const facts: RepoFacts = { ...meta, contributorsLastYear: 14, ciRunsTests: true, hasJsTests: true, hasPyTests: false };
const pr = (p: Partial<PrDetail> = {}): PrDetail => ({
  repo: 'o/r', number: 1, title: 't', author: 'Copilot', authorType: 'Bot', mergedBy: 'maint', mergedAt: '2026-10-15T00:00:00Z',
  baseRef: 'main', baseSha: 'b', headSha: 'h', branch: 'copilot/x', body: '', files: ['src/a.ts'], commitMessages: [], ...p,
});

describe('repo rules', () => {
  it('passes an established, active repo', () => {
    expect(repoReasons(facts, now, new Set())).toEqual([]);
  });
  it('lists every failed rule', () => {
    expect(repoMetaReasons({ ...meta, stars: 999, fork: true, archived: true, pushedAt: '2026-09-01T00:00:00Z' }, now, new Set(['o/r']))).toEqual([
      'excluded', 'stars<1000', 'fork', 'archived', 'stale',
    ]);
    expect(repoReasons({ ...facts, contributorsLastYear: 9, ciRunsTests: false, hasJsTests: false }, now, new Set())).toEqual([
      'contributors<10', 'no-ci-tests', 'no-test-setup',
    ]);
  });
});

describe('PR rules', () => {
  const window = { since: new Date('2026-08-03T00:00:00Z'), until: new Date('2026-11-01T00:00:00Z') };
  it('passes a merged, reviewed PR that changes source', () => {
    expect(prReasons(pr(), window)).toEqual([]);
  });
  it('rejects self-merged, unmerged, out-of-window and docs/test-only PRs', () => {
    expect(prReasons(pr({ mergedBy: 'Copilot' }), window)).toEqual(['self-merged']);
    expect(prReasons(pr({ mergedAt: null, mergedBy: null }), window)).toEqual(['not-merged']);
    expect(prReasons(pr({ mergedAt: '2026-07-01T00:00:00Z' }), window)).toEqual(['outside-window']);
    expect(prReasons(pr({ files: ['README.md', 'test/a.test.ts'] }), window)).toEqual(['no-source-change']);
  });
});

describe('path rules', () => {
  it('separates tests from source', () => {
    for (const p of ['test/a.ts', 'src/__tests__/a.ts', 'src/a.test.tsx', 'pkg/a.spec.mjs', 'tests/test_x.py', 'x/y_test.py', 'conftest.py'])
      expect(isTestPath(p)).toBe(true);
    for (const p of ['src/a.ts', 'lib/b.py', 'app/c.vue']) {
      expect(isTestPath(p)).toBe(false);
      expect(isSourceFile(p)).toBe(true);
    }
    for (const p of ['README.md', 'docs/a.ts', 'src/types.d.ts', 'examples/x.py', 'test/a.test.ts']) expect(isSourceFile(p)).toBe(false);
  });
});

describe('test setup detection', () => {
  it('finds CI test commands', () => {
    expect(ciRunsTests(['jobs:\n  t:\n    steps:\n      - run: pnpm test'])).toBe(true);
    expect(ciRunsTests(['- run: python -m pytest -q'])).toBe(true);
    expect(ciRunsTests(['- run: npm run lint'])).toBe(false);
  });
  it('does not match a runner name inside a longer word or a hyphenated package name', () => {
    for (const t of ['- run: npm i -D eslint-plugin-jest', '- run: npx jestify', '- run: npm i jest-junit', '- run: pip install pytest-cov-report', '- uses: foo/mocha-action@v1'])
      expect(ciRunsTests([t]), t).toBe(false);
    for (const t of ['- run: npx jest --ci', '- run: npm run test-ci', '- run: python -m pytest', '- run: yarn vitest run'])
      expect(ciRunsTests([t]), t).toBe(true);
  });
  it('finds make, turbo, recursive pnpm and nx test commands', () => {
    for (const t of ['- run: make test', '- run: turbo run test', '- run: npx turbo test', '- run: pnpm -r test', '- run: npx nx test app'])
      expect(ciRunsTests([t]), t).toBe(true);
  });
  it('detects JS test runners from package.json', () => {
    expect(detectJsTests({ devDependencies: { vitest: '^3' } })).toBe(true);
    expect(detectJsTests({ scripts: { test: 'node --test' } })).toBe(true);
    expect(detectJsTests({ scripts: { test: 'echo "Error: no test specified" && exit 1' } })).toBe(false);
    expect(detectJsTests(null)).toBe(false);
  });
  it('detects pytest from config and requirements', () => {
    expect(detectPyTests({ 'pytest.ini': '[pytest]' })).toBe(true);
    expect(detectPyTests({ 'pyproject.toml': '[project.optional-dependencies]\ntest = ["pytest>=8"]' })).toBe(true);
    expect(detectPyTests({ 'requirements.txt': 'flask\n' })).toBe(false);
  });
});
