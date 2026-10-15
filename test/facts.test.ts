import { describe, expect, it } from 'vitest';
import type { GitHubApi } from '../src/github/client.js';
import { loadFacts } from '../src/collect/facts.js';
import type { RepoMeta } from '../src/collect/qualify.js';

const now = new Date('2026-11-01T00:00:00Z');
const meta: RepoMeta = { fullName: 'big/repo', stars: 5000, fork: false, archived: false, pushedAt: '2026-10-30T00:00:00Z', language: 'TypeScript' };
const commits = (logins: string[], next: string | null) => ({
  pageInfo: { hasNextPage: next !== null, endCursor: next },
  nodes: logins.map((l) => ({ author: { email: `${l}@x.dev`, user: { login: l } } })),
});
const wf = (path: string, text: string) => ({ path, type: 'blob', object: { text } });
const repo = (p: Record<string, unknown> = {}) => ({
  workflows: { entries: [wf('.github/workflows/ci.yml', 'steps:\n  - run: npm test\n')] },
  packageJson: { text: JSON.stringify({ devDependencies: { vitest: '^3' } }) },
  defaultBranchRef: { target: { history: commits(Array.from({ length: 12 }, (_, i) => `dev${i}`), null) } },
  ...p,
});

/** Facts fake: the first query returns `repository`; history pages are looked up by their `after` cursor. */
function fakeFacts(repository: unknown, pages: Record<string, ReturnType<typeof commits>> = {}) {
  const calls: Record<string, unknown>[] = [];
  const gh = {
    graphql: async (_q: string, vars: Record<string, unknown>) => {
      calls.push(vars);
      if (vars.after) return { repository: { defaultBranchRef: { target: { history: pages[vars.after as string] } } } };
      return { repository };
    },
  } as unknown as GitHubApi;
  return { gh, calls };
}

describe('loadFacts', () => {
  it('reads CI, the test setup and contributors in one query', async () => {
    const { gh, calls } = fakeFacts(repo());
    expect(await loadFacts(gh, meta, now)).toEqual({ ...meta, contributorsLastYear: 12, ciRunsTests: true, hasJsTests: true, hasPyTests: false });
    expect(calls).toEqual([{ owner: 'big', name: 'repo', since: '2025-11-01T00:00:00Z' }]);
  });

  it('uses the same query variables for any time on the same UTC day', async () => {
    const a = fakeFacts(repo());
    const b = fakeFacts(repo());
    await loadFacts(a.gh, meta, new Date('2026-11-01T00:00:00.000Z'));
    await loadFacts(b.gh, meta, new Date('2026-11-01T23:59:59.999Z'));
    expect(b.calls).toEqual(a.calls);
  });

  it('detects a pytest setup when there is no JS test setup', async () => {
    const { gh } = fakeFacts(repo({ packageJson: null, py0: { text: '[pytest]\n' } }));
    expect(await loadFacts(gh, meta, now)).toMatchObject({ hasJsTests: false, hasPyTests: true });
  });

  it('reads only the first 10 workflow YAML files, in tree order', async () => {
    const quiet = Array.from({ length: 10 }, (_, i) => wf(`.github/workflows/a${i}.yml`, 'run: echo hi'));
    const extra = [
      wf('.github/workflows/README.md', 'npm test'),
      { path: '.github/workflows/sub', type: 'tree', object: {} },
    ];
    const late = { gh: fakeFacts(repo({ workflows: { entries: [...extra, ...quiet, wf('.github/workflows/zz.yml', 'npm test')] } })).gh };
    expect(await loadFacts(late.gh, meta, now)).toMatchObject({ ciRunsTests: false });
    const early = { gh: fakeFacts(repo({ workflows: { entries: [...extra, ...quiet.slice(1), wf('.github/workflows/zz.yml', 'npm test')] } })).gh };
    expect(await loadFacts(early.gh, meta, now)).toMatchObject({ ciRunsTests: true });
  });

  it('pages commit history until 10 distinct authors are seen', async () => {
    const first = commits(Array.from({ length: 100 }, (_, i) => `dev${i % 3}`), 'c1');
    const { gh, calls } = fakeFacts(repo({ defaultBranchRef: { target: { history: first } } }), {
      c1: commits(Array.from({ length: 100 }, (_, i) => `p${i % 20}`), 'c2'),
      c2: commits(['late'], null),
    });
    expect(await loadFacts(gh, meta, now)).toMatchObject({ contributorsLastYear: 23 });
    expect(calls.length).toBe(2);
    expect(calls[1]).toEqual({ owner: 'big', name: 'repo', since: '2025-11-01T00:00:00Z', after: 'c1' });
  });

  it('stops after 300 commits', async () => {
    const same = (next: string) => commits(Array.from({ length: 100 }, () => 'solo'), next);
    const { gh, calls } = fakeFacts(repo({ defaultBranchRef: { target: { history: same('c1') } } }), { c1: same('c2'), c2: same('c3'), c3: same('c4') });
    expect(await loadFacts(gh, meta, now)).toMatchObject({ contributorsLastYear: 1 });
    expect(calls.length).toBe(3);
  });

  it('uses the commit email when the author has no GitHub user', async () => {
    const history = {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [{ author: { email: 'a@x.dev', user: null } }, { author: { email: 'b@x.dev', user: null } }, { author: null }],
    };
    const { gh } = fakeFacts(repo({ defaultBranchRef: { target: { history } } }));
    expect(await loadFacts(gh, meta, now)).toMatchObject({ contributorsLastYear: 2 });
  });

  it('returns null for a repo that no longer resolves', async () => {
    const { gh } = fakeFacts(null);
    expect(await loadFacts(gh, meta, now)).toBeNull();
  });
});
