import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import semver from 'semver';
import { parse as parseToml } from 'smol-toml';
import { PY_TEST_FILES, detectJsTests, detectPyTests } from '../collect/qualify.js';
import type { NodeRecipe, PythonRecipe, Recipe } from '../types.js';

export interface RepoFiles {
  read(path: string): string | null;
}
export const memFiles = (files: Record<string, string>): RepoFiles => ({ read: (p) => files[p] ?? null });
export const fsFiles = (root: string): RepoFiles => ({
  read: (p) => {
    try {
      return readFileSync(join(root, p), 'utf8');
    } catch {
      return null;
    }
  },
});

const NODE_MAJORS = ['24', '22', '20', '18'];
const PY_MINORS = ['3.13', '3.12', '3.11', '3.10', '3.9'];
const PY_EXTRAS = ['test', 'tests', 'testing', 'dev'];
const REQ_FILES = ['requirements.txt', 'requirements-dev.txt', 'requirements-test.txt', 'test-requirements.txt', 'dev-requirements.txt'];

function json(files: RepoFiles, path: string): Record<string, unknown> | null {
  const t = files.read(path);
  if (t === null) return null;
  try {
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const VERSION_OK = /^[0-9][0-9A-Za-z.+-]*$/;

export function nodeVersion(files: RepoFiles): string {
  for (const f of ['.nvmrc', '.node-version']) {
    const v = files.read(f)?.trim().replace(/^v/, '');
    if (v) return VERSION_OK.test(v) ? v : '22';
  }
  const pkg = json(files, 'package.json') ?? {};
  const volta = (pkg.volta as { node?: string } | undefined)?.node;
  if (volta) return VERSION_OK.test(volta) ? volta : '22';
  const range = (pkg.engines as { node?: string } | undefined)?.node;
  if (range && semver.validRange(range)) {
    const hit = NODE_MAJORS.find((m) => semver.satisfies(`${m}.0.0`, range));
    if (hit) return hit;
  }
  return '22';
}

function nodeRecipe(files: RepoFiles): NodeRecipe | null {
  const pkg = json(files, 'package.json');
  if (!pkg || !detectJsTests(pkg)) return null;
  const field = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : null;
  const has = (p: string) => files.read(p) !== null;
  let pm: NodeRecipe['pm'] = 'npm';
  if (field === 'pnpm' || has('pnpm-lock.yaml')) pm = 'pnpm';
  else if (field === 'bun' || has('bun.lock') || has('bun.lockb')) pm = 'bun';
  else if (field === 'yarn' || has('yarn.lock')) {
    const berry = has('.yarnrc.yml') || (typeof pkg.packageManager === 'string' && !pkg.packageManager.startsWith('yarn@1'));
    pm = berry ? 'yarn-berry' : 'yarn';
  }
  const install = {
    npm: has('package-lock.json') ? 'npm ci' : 'npm install',
    pnpm: 'pnpm install --frozen-lockfile',
    yarn: 'yarn install --frozen-lockfile',
    'yarn-berry': 'yarn install --immutable',
    bun: 'bun install --frozen-lockfile',
  }[pm];
  return { version: nodeVersion(files), pm, install };
}

const cmp = (a: number[], b: number[]) => (a[0]! - b[0]!) || ((a[1] ?? 0) - (b[1] ?? 0));

/** Minor-level check of a PEP 440 specifier set such as ">=3.9,<3.13". */
export function pySatisfies(version: string, spec: string): boolean {
  const v = version.split('.').map(Number);
  return spec.split(',').map((s) => s.trim()).filter(Boolean).every((clause) => {
    const m = /^(~=|==|!=|>=|<=|>|<)\s*([\d.]+)(\.\*)?$/.exec(clause);
    if (!m) return true;
    const [, op, raw] = m;
    const t = raw!.split('.').map(Number);
    const c = cmp(v, t);
    switch (op) {
      case '>=': return c >= 0;
      case '>': return c > 0;
      case '<=': return c <= 0;
      case '<': return c < 0;
      case '==': return c === 0;
      case '!=': return c !== 0;
      case '~=': return c >= 0 && v[0] === t[0];
      default: return true;
    }
  });
}

function pyproject(files: RepoFiles): Record<string, any> | null {
  const t = files.read('pyproject.toml');
  if (t === null) return null;
  try {
    return parseToml(t) as Record<string, any>;
  } catch {
    return null;
  }
}

export function pythonVersion(files: RepoFiles): string {
  const pinned = files.read('.python-version')?.split('\n')[0]?.trim();
  if (pinned && VERSION_OK.test(pinned)) return pinned;
  const spec = pyproject(files)?.project?.['requires-python'];
  if (typeof spec === 'string') {
    const hit = PY_MINORS.find((m) => pySatisfies(m, spec));
    if (hit) return hit;
  }
  return '3.12';
}

function pythonRecipe(files: RepoFiles): PythonRecipe | null {
  const contents: Record<string, string | null> = {};
  for (const f of PY_TEST_FILES) contents[f] = files.read(f);
  if (!detectPyTests(contents)) return null;
  const toml = pyproject(files);
  const install: string[] = [];
  if (toml?.project || toml?.tool?.poetry || files.read('setup.py') !== null) {
    const extras = Object.keys(toml?.project?.['optional-dependencies'] ?? {}).filter((k) => PY_EXTRAS.includes(k));
    install.push(extras.length ? `uv pip install -e ".[${extras.join(',')}]"` : 'uv pip install -e .');
  }
  for (const g of Object.keys(toml?.['dependency-groups'] ?? {}).filter((k) => PY_EXTRAS.includes(k))) install.push(`uv pip install --group ${g}`);
  for (const f of REQ_FILES) if (files.read(f) !== null) install.push(`uv pip install -r ${f}`);
  install.push('uv pip install pytest');
  return { version: pythonVersion(files), install };
}

export function inferRecipe(files: RepoFiles): Recipe | null {
  const node = nodeRecipe(files);
  const python = pythonRecipe(files);
  return node || python ? { node, python } : null;
}
