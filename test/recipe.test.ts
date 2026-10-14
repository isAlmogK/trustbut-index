import { describe, expect, it } from 'vitest';
import { inferRecipe, memFiles, nodeVersion, pySatisfies, pythonVersion } from '../src/run/recipe.js';

const pkg = (p: object) => JSON.stringify({ devDependencies: { vitest: '^3' }, ...p });

describe('node recipe', () => {
  it('picks the version from .nvmrc, .node-version, volta or engines', () => {
    expect(nodeVersion(memFiles({ '.nvmrc': 'v20.11.0\n', 'package.json': pkg({}) }))).toBe('20.11.0');
    expect(nodeVersion(memFiles({ '.nvmrc': 'lts/*', 'package.json': pkg({}) }))).toBe('22');
    expect(nodeVersion(memFiles({ '.node-version': '18', 'package.json': pkg({}) }))).toBe('18');
    expect(nodeVersion(memFiles({ 'package.json': pkg({ volta: { node: '20.9.0' } }) }))).toBe('20.9.0');
    expect(nodeVersion(memFiles({ 'package.json': pkg({ engines: { node: '>=18 <21' } }) }))).toBe('20');
    expect(nodeVersion(memFiles({ 'package.json': pkg({ engines: { node: '>=18' } }) }))).toBe('24');
    expect(nodeVersion(memFiles({ 'package.json': pkg({}) }))).toBe('22');
  });

  it('chooses the package manager and a frozen install', () => {
    const r = (files: Record<string, string>) => inferRecipe(memFiles({ 'package.json': pkg({}), ...files }))!.node!;
    expect(r({ 'package-lock.json': '{}' })).toMatchObject({ pm: 'npm', install: 'npm ci' });
    expect(r({})).toMatchObject({ pm: 'npm', install: 'npm install' });
    expect(r({ 'pnpm-lock.yaml': '' })).toMatchObject({ pm: 'pnpm', install: 'pnpm install --frozen-lockfile' });
    expect(r({ 'yarn.lock': '' })).toMatchObject({ pm: 'yarn', install: 'yarn install --frozen-lockfile' });
    expect(r({ 'yarn.lock': '', '.yarnrc.yml': '' })).toMatchObject({ pm: 'yarn-berry', install: 'yarn install --immutable' });
    expect(r({ 'bun.lock': '' })).toMatchObject({ pm: 'bun', install: 'bun install --frozen-lockfile' });
    const viaField = inferRecipe(memFiles({ 'package.json': pkg({ packageManager: 'pnpm@9.1.0' }) }))!.node!;
    expect(viaField.pm).toBe('pnpm');
  });
});

describe('python recipe', () => {
  it('evaluates requires-python specifiers', () => {
    expect(pySatisfies('3.12', '>=3.9,<3.13')).toBe(true);
    expect(pySatisfies('3.13', '>=3.9,<3.13')).toBe(false);
    expect(pySatisfies('3.11', '~=3.10')).toBe(true);
    expect(pySatisfies('3.12', '==3.11.*')).toBe(false);
    expect(pySatisfies('3.12', '!=3.12')).toBe(false);
  });

  it('picks the version from .python-version or requires-python', () => {
    expect(pythonVersion(memFiles({ '.python-version': '3.11.6\n' }))).toBe('3.11.6');
    expect(pythonVersion(memFiles({ 'pyproject.toml': '[project]\nname="x"\nrequires-python=">=3.9,<3.12"\n' }))).toBe('3.11');
    expect(pythonVersion(memFiles({}))).toBe('3.12');
  });

  it('installs the project with test extras, groups and requirements, plus pytest', () => {
    const r = inferRecipe(memFiles({
      'pyproject.toml': '[project]\nname="x"\n[project.optional-dependencies]\ntest=["pytest"]\ndocs=["sphinx"]\n[dependency-groups]\ndev=["ruff"]\n',
      'requirements-dev.txt': 'pytest-cov\n',
    }))!;
    expect(r.node).toBeNull();
    expect(r.python!.install).toEqual([
      'uv pip install -e ".[test]"', 'uv pip install --group dev', 'uv pip install -r requirements-dev.txt', 'uv pip install pytest',
    ]);
  });
});

describe('no runner', () => {
  it('returns null when neither a JS nor a Python test setup is present', () => {
    expect(inferRecipe(memFiles({ 'package.json': JSON.stringify({ scripts: { build: 'tsc' } }) }))).toBeNull();
  });
});
