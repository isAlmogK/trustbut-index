import type { PrDetail } from '../types.js';

export interface RepoMeta {
  fullName: string;
  stars: number;
  fork: boolean;
  archived: boolean;
  pushedAt: string;
  language: string | null;
}
export interface RepoFacts extends RepoMeta {
  contributorsLastYear: number;
  ciRunsTests: boolean;
  hasJsTests: boolean;
  hasPyTests: boolean;
}

const DAY = 86_400_000;

/** Cheap checks on /repos/<o>/<r> alone; run these before any further API call. */
export function repoMetaReasons(m: RepoMeta, now: Date, excluded: Set<string>): string[] {
  const r: string[] = [];
  if (excluded.has(m.fullName.toLowerCase()) || excluded.has(m.fullName)) r.push('excluded');
  if (m.stars < 1000) r.push('stars<1000');
  if (m.fork) r.push('fork');
  if (m.archived) r.push('archived');
  if (now.getTime() - new Date(m.pushedAt).getTime() > 30 * DAY) r.push('stale');
  return r;
}

export function repoReasons(f: RepoFacts, now: Date, excluded: Set<string>): string[] {
  const r = repoMetaReasons(f, now, excluded);
  if (f.contributorsLastYear < 10) r.push('contributors<10');
  if (!f.ciRunsTests) r.push('no-ci-tests');
  if (!f.hasJsTests && !f.hasPyTests) r.push('no-test-setup');
  return r;
}

export function prReasons(pr: PrDetail, window: { since: Date; until: Date }): string[] {
  if (!pr.mergedAt) return ['not-merged'];
  const r: string[] = [];
  const t = new Date(pr.mergedAt).getTime();
  if (t < window.since.getTime() || t > window.until.getTime()) r.push('outside-window');
  if (!pr.mergedBy || pr.mergedBy === pr.author) r.push('self-merged');
  if (!pr.files.some(isSourceFile)) r.push('no-source-change');
  return r;
}

const CODE_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts|vue|svelte|py)$/;

export function isTestPath(p: string): boolean {
  return (
    /(^|\/)(tests?|__tests__|spec|__mocks__|fixtures?)\//.test(p) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) ||
    /(^|\/)test_[^/]*\.py$/.test(p) ||
    /_test\.py$/.test(p) ||
    /(^|\/)conftest\.py$/.test(p)
  );
}

export function isSourceFile(p: string): boolean {
  return CODE_EXT.test(p) && !p.endsWith('.d.ts') && !isTestPath(p) && !/(^|\/)(docs?|examples?)\//.test(p);
}

const CI_TEST =
  /\b(npm (run )?test|pnpm (run )?test|yarn (run )?test|bun (run )?test|vitest|jest|mocha|node --test|pytest|tox|nox)\b/;

export function ciRunsTests(workflowTexts: string[]): boolean {
  return workflowTexts.some((t) => CI_TEST.test(t));
}

const JS_RUNNERS = ['vitest', 'jest', 'mocha'];

export function detectJsTests(pkg: unknown): boolean {
  if (!pkg || typeof pkg !== 'object') return false;
  const p = pkg as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const deps = { ...p.dependencies, ...p.devDependencies };
  if (JS_RUNNERS.some((r) => r in deps)) return true;
  const test = p.scripts?.test ?? '';
  return /\b(vitest|jest|mocha|node --test)\b/.test(test);
}

/** Files read (when present) to decide whether a repo uses pytest. */
export const PY_TEST_FILES = [
  'pytest.ini', 'pyproject.toml', 'setup.cfg', 'tox.ini', 'requirements.txt', 'requirements-dev.txt',
  'requirements-test.txt', 'test-requirements.txt', 'dev-requirements.txt',
];

export function detectPyTests(files: Record<string, string | null>): boolean {
  if (files['pytest.ini'] != null) return true;
  return Object.values(files).some((t) => t != null && /\bpytest\b/.test(t));
}
