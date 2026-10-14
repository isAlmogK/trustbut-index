import { describe, expect, it } from 'vitest';
import { collect, weekSlices } from '../src/collect/index.js';
import { NotFoundError, type GitHubApi, type SearchItem } from '../src/github/client.js';

const b64 = (s: string) => ({ content: Buffer.from(s).toString('base64'), encoding: 'base64' });
const now = new Date('2026-11-01T00:00:00Z');

function fakeApi(routes: Record<string, unknown>, search: (q: string) => SearchItem[]): GitHubApi {
  const get = async <T>(path: string): Promise<T> => {
    const k = path.split('?')[0]!;
    if (!(k in routes)) throw new NotFoundError(path);
    return routes[k] as T;
  };
  return { get, paginate: get, search: async (q) => search(q) };
}

const pull = (n: number, p: Record<string, unknown>) => ({
  number: n, title: `PR ${n}`, user: { login: 'alice', type: 'User' }, merged_by: { login: 'maint' },
  merged_at: '2026-10-10T00:00:00Z', base: { ref: 'main', sha: `base${n}` }, head: { ref: `branch${n}`, sha: `head${n}` }, body: '', ...p,
});

const routes: Record<string, unknown> = {
  '/repos/big/repo': { full_name: 'big/repo', stargazers_count: 5000, fork: false, archived: false, pushed_at: '2026-10-30T00:00:00Z', language: 'TypeScript' },
  '/repos/tiny/repo': { full_name: 'tiny/repo', stargazers_count: 3, fork: false, archived: false, pushed_at: '2026-10-30T00:00:00Z', language: 'TypeScript' },
  '/repos/big/repo/commits': Array.from({ length: 12 }, (_, i) => ({ author: { login: `dev${i}` } })),
  '/repos/big/repo/contents/.github/workflows': [{ name: 'ci.yml', path: '.github/workflows/ci.yml', type: 'file' }],
  '/repos/big/repo/contents/.github/workflows/ci.yml': b64('steps:\n  - run: npm test\n'),
  '/repos/big/repo/contents/package.json': b64(JSON.stringify({ devDependencies: { vitest: '^3' } })),
  '/repos/big/repo/pulls/1': pull(1, { user: { login: 'Copilot', type: 'Bot' }, head: { ref: 'copilot/fix', sha: 'head1' } }),
  '/repos/big/repo/pulls/1/files': [{ filename: 'src/a.ts' }],
  '/repos/big/repo/pulls/1/commits': [{ commit: { message: 'fix' } }],
  '/repos/big/repo/pulls': [
    { number: 1, user: { login: 'Copilot', type: 'Bot' }, merged_at: '2026-10-10T00:00:00Z' },
    { number: 5, user: { login: 'alice', type: 'User' }, merged_at: '2026-10-11T00:00:00Z' },
    { number: 6, user: { login: 'bob', type: 'User' }, merged_at: null },
  ],
  '/repos/big/repo/pulls/5': pull(5, {}),
  '/repos/big/repo/pulls/5/files': [{ filename: 'src/b.ts' }],
  '/repos/big/repo/pulls/5/commits': [{ commit: { message: 'feat: b' } }],
};

describe('collect', () => {
  it('slices the window into weeks', () => {
    expect(weekSlices(new Date('2026-10-01T00:00:00Z'), new Date('2026-10-20T00:00:00Z'))).toEqual([
      ['2026-10-01', '2026-10-07'], ['2026-10-08', '2026-10-14'], ['2026-10-15', '2026-10-20'],
    ]);
  });

  it('selects qualifying agent PRs plus matched human PRs from the same repos', async () => {
    const gh = fakeApi(routes, (q) =>
      q.startsWith('author:app/copilot-swe-agent') ? [{ repo: 'big/repo', number: 1 }, { repo: 'tiny/repo', number: 2 }] : [],
    );
    const { entries, summary } = await collect(gh, {
      until: now, days: 90, perAgent: 80, perRepo: 3, seed: 's', now, excluded: new Set(), minPerAgent: 30,
    });
    expect(entries.map((e) => [e.id, e.group, e.agent])).toEqual([
      ['big/repo#1', 'agent', 'copilot'],
      ['big/repo#5', 'human', null],
    ]);
    expect(entries[0]).toMatchObject({ baseSha: 'base1', headSha: 'head1', repoStars: 5000, repoLanguage: 'TypeScript' });
    expect(entries[0]!.attribution.evidence).toEqual(['author:Copilot', 'branch:copilot/']);
    expect(summary).toMatchObject({ uniqueRepos: 2, reposQualified: 1, humansSelected: 1, humanShortfall: 0 });
    expect(summary.selected.copilot).toBe(1);
    expect(summary.insufficient).toContain('copilot');
  });
});
