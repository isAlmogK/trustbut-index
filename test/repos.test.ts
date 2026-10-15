import { describe, expect, it } from 'vitest';
import type { GitHubApi } from '../src/github/client.js';
import { listRepos, repoQuery, splitRange } from '../src/collect/repos.js';

const now = new Date('2026-11-01T00:00:00Z');
const node = (name: string, p: { stars?: number; pushedAt?: string } = {}) => ({
  nameWithOwner: name, stargazerCount: p.stars ?? 5000, isFork: false, isArchived: false,
  pushedAt: p.pushedAt ?? '2026-10-30T00:00:00Z', primaryLanguage: { name: 'TypeScript' },
});

/** Repo search fake: `slices` maps the stars expression (">=2000", "1000..1999") to its repos; `counts` overrides repositoryCount. */
function fakeSearch(slices: Record<string, ReturnType<typeof node>[]>, counts: Record<string, number> = {}) {
  const queries: { q: string; after: string | null }[] = [];
  const gh = {
    graphql: async (_query: string, vars: Record<string, unknown>) => {
      const q = vars.q as string;
      const after = (vars.after as string | null) ?? null;
      queries.push({ q, after });
      const stars = /stars:(\S+)/.exec(q)![1]!;
      const all = slices[stars] ?? [];
      const start = after === null ? 0 : Number(after);
      return {
        search: {
          repositoryCount: counts[stars] ?? all.length,
          pageInfo: { hasNextPage: start + 100 < all.length, endCursor: String(start + 100) },
          nodes: all.slice(start, start + 100),
        },
      };
    },
  } as unknown as GitHubApi;
  return { gh, queries };
}

describe('splitRange', () => {
  it('splits an open range at twice its floor and a closed range in half', () => {
    expect(splitRange({ lo: 1000, hi: null })).toEqual([{ lo: 1000, hi: 1999 }, { lo: 2000, hi: null }]);
    expect(splitRange({ lo: 1000, hi: 1999 })).toEqual([{ lo: 1000, hi: 1499 }, { lo: 1500, hi: 1999 }]);
  });
  it('throws when a single star count has too many repos to list', () => {
    expect(() => splitRange({ lo: 1200, hi: 1200 })).toThrow(/exactly 1200 stars/);
  });
});

describe('repoQuery', () => {
  it('builds the repo search text', () => {
    expect(repoQuery({ lo: 1000, hi: null }, '2026-10-02')).toBe(
      'is:public stars:>=1000 pushed:>=2026-10-02 fork:false archived:false language:TypeScript language:JavaScript language:Python language:Vue language:Svelte',
    );
    expect(repoQuery({ lo: 1000, hi: 1999 }, '2026-10-02')).toContain(' stars:1000..1999 ');
  });
});

describe('listRepos', () => {
  it('splits star ranges over 1,000, pages by cursor, dedupes, applies the meta rules and sorts', async () => {
    const many = Array.from({ length: 150 }, (_, i) => node(`o/r${String(i).padStart(3, '0')}`, { stars: 1500 }));
    const { gh, queries } = fakeSearch(
      {
        '>=1000': [],
        '1000..1999': [...many, node('z/stale', { stars: 1100, pushedAt: '2026-09-01T00:00:00Z' })],
        '>=2000': [node('a/big', { stars: 9000 }), node('o/r000', { stars: 2001 }), node('bad/excluded')],
      },
      { '>=1000': 1001 },
    );
    const repos = await listRepos(gh, { now, excluded: new Set(['bad/excluded']) });
    expect(queries.map((x) => [/stars:(\S+)/.exec(x.q)![1], x.after])).toEqual([
      ['>=1000', null], ['1000..1999', null], ['1000..1999', '100'], ['>=2000', null],
    ]);
    expect(queries[0]!.q).toContain('pushed:>=2026-10-02');
    const names = repos.map((r) => r.fullName);
    expect(names.length).toBe(151);
    expect(names).not.toContain('z/stale');
    expect(names).not.toContain('bad/excluded');
    expect(names).toEqual([...names].sort());
    expect(repos[0]).toEqual({
      fullName: 'a/big', stars: 9000, fork: false, archived: false, pushedAt: '2026-10-30T00:00:00Z', language: 'TypeScript',
    });
    expect(repos.find((r) => r.fullName === 'o/r000')!.stars).toBe(2001);
  });

  it('drops repos whose primary language is outside the list or missing', async () => {
    const { gh } = fakeSearch({
      '>=1000': [
        node('o/ts'),
        { ...node('o/go'), primaryLanguage: { name: 'Go' } },
        { ...node('o/none'), primaryLanguage: null },
      ] as ReturnType<typeof node>[],
    });
    const repos = await listRepos(gh, { now, excluded: new Set() });
    expect(repos.map((r) => r.fullName)).toEqual(['o/ts']);
  });
});
