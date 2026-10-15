import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { addPaths, excludedPrIds, parsePositiveInt, parseYmd } from '../src/collect/command.js';
import { collect } from '../src/collect/index.js';
import { NotFoundError, type GitHubApi } from '../src/github/client.js';
import { writeJsonl } from '../src/jsonl.js';

const now = new Date('2026-11-01T00:00:00Z');
const COPILOT = 'author:app/copilot-swe-agent';
type Hit = { q: string; repo: string; number: number };

const repoNode = (name: string, stars: number) => ({
  nameWithOwner: name, stargazerCount: stars, isFork: false, isArchived: false,
  pushedAt: '2026-10-30T00:00:00Z', primaryLanguage: { name: 'TypeScript' },
});
const REPOS = [repoNode('big/repo', 5000), repoNode('tiny/repo', 3)];
const FACTS: Record<string, unknown> = {
  'big/repo': {
    workflows: { entries: [{ path: '.github/workflows/ci.yml', type: 'blob', object: { text: 'steps:\n  - run: npm test\n' } }] },
    packageJson: { text: JSON.stringify({ devDependencies: { vitest: '^3' } }) },
    defaultBranchRef: { target: { history: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: Array.from({ length: 12 }, (_, i) => ({ author: { email: null, user: { login: `dev${i}` } } })),
    } } },
  },
};

/** REST routes serve PR loads and human pools; GraphQL serves the repo list, the agent PR search (`hits`) and repo facts. */
function fakeApi(routes: Record<string, unknown>, hits: Hit[]) {
  const gets: string[] = [];
  const get = async <T>(path: string): Promise<T> => {
    gets.push(path);
    const k = path.split('?')[0]!;
    if (!(k in routes)) throw new NotFoundError(path);
    return routes[k] as T;
  };
  const graphql = async <T>(query: string, vars: Record<string, unknown>): Promise<T> => {
    const done = { hasNextPage: false, endCursor: null };
    if (query.includes('type: REPOSITORY')) return { search: { repositoryCount: REPOS.length, pageInfo: done, nodes: REPOS } } as T;
    if (query.includes('type: ISSUE')) {
      const q = vars.q as string;
      const tokens = new Set(q.split(' '));
      const nodes = hits
        .filter((h) => q.startsWith(`${h.q} is:pr`) && tokens.has(`repo:${h.repo}`))
        .map((h) => ({ number: h.number, repository: { nameWithOwner: h.repo } }));
      return { search: { issueCount: nodes.length, pageInfo: done, nodes } } as T;
    }
    return { repository: FACTS[`${vars.owner}/${vars.name}`] ?? null } as T;
  };
  const gh: GitHubApi = { get, paginate: get, graphql };
  return { gh, gets };
}

const pull = (n: number, p: Record<string, unknown>) => ({
  number: n, title: `PR ${n}`, user: { login: 'alice', type: 'User' }, merged_by: { login: 'maint' },
  merged_at: '2026-10-10T00:00:00Z', base: { ref: 'main', sha: `base${n}` }, head: { ref: `branch${n}`, sha: `head${n}` }, body: '', ...p,
});

const routes: Record<string, unknown> = {
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

const base = { until: now, days: 90, perAgent: 80, perRepo: 3, seed: 's', now, excluded: new Set<string>(), minPerAgent: 30 };

describe('collect', () => {
  it('selects qualifying agent PRs plus matched human PRs from the same repos', async () => {
    const { gh } = fakeApi(routes, [{ q: COPILOT, repo: 'big/repo', number: 1 }, { q: COPILOT, repo: 'tiny/repo', number: 2 }]);
    const { entries, summary } = await collect(gh, base);
    expect(entries.map((e) => [e.id, e.group, e.agent])).toEqual([
      ['big/repo#1', 'agent', 'copilot'],
      ['big/repo#5', 'human', null],
    ]);
    expect(entries[0]).toMatchObject({ baseSha: 'base1', headSha: 'head1', repoStars: 5000, repoLanguage: 'TypeScript' });
    expect(entries[0]!.attribution.evidence).toEqual(['author:Copilot', 'branch:copilot/']);
    expect(summary).toMatchObject({
      window: { since: '2026-08-03', until: '2026-11-01' },
      reposListed: 1, uniqueHits: 1, reposChecked: 1, reposQualified: 1, ambiguous: 0, humansSelected: 1, humanShortfall: 0,
    });
    expect(summary.searchHits.copilot).toBe(1);
    expect(summary.examined.copilot).toBe(1);
    expect(summary.selected.copilot).toBe(1);
    expect(summary.insufficient).toContain('copilot');
  });

  it('stops loading agent PRs once the agent has enough', async () => {
    const r = {
      ...routes,
      '/repos/big/repo/pulls/3': pull(3, { user: { login: 'Copilot', type: 'Bot' }, head: { ref: 'copilot/other', sha: 'head3' } }),
      '/repos/big/repo/pulls/3/files': [{ filename: 'src/c.ts' }],
      '/repos/big/repo/pulls/3/commits': [{ commit: { message: 'fix' } }],
    };
    const { gh, gets } = fakeApi(r, [1, 3].map((number) => ({ q: COPILOT, repo: 'big/repo', number })));
    const { summary } = await collect(gh, { ...base, perAgent: 1 });
    expect(summary.selected.copilot).toBe(1);
    expect(summary.examined.copilot).toBe(1);
    expect(gets.filter((p) => /^\/repos\/big\/repo\/pulls\/[13]$/.test(p)).length).toBe(1);
  });

  it('logs each phase', async () => {
    const { gh } = fakeApi(routes, [{ q: COPILOT, repo: 'big/repo', number: 1 }]);
    const lines: string[] = [];
    await collect(gh, { ...base, log: (m) => lines.push(m) });
    expect(lines[0]).toMatch(/^listed 1 repos/);
    expect(lines.some((l) => l.startsWith('searched batch 1/1:'))).toBe(true);
    expect(lines).toContain('selected 1 agent PRs; matching human PRs in 1 repos');
    expect(lines).toContain('matched 1 human PRs (shortfall 0)');
  });

  it('skips PRs listed in an excluded (pilot) manifest, as candidates and as human matches', async () => {
    const { gh } = fakeApi(routes, [{ q: COPILOT, repo: 'big/repo', number: 1 }]);
    const noHuman = await collect(gh, { ...base, excludedPrs: new Set(['big/repo#5']) });
    expect(noHuman.entries.map((e) => e.id)).toEqual(['big/repo#1']);
    expect(noHuman.summary.humanShortfall).toBe(1);
    const noAgent = await collect(gh, { ...base, excludedPrs: new Set(['big/repo#1']) });
    expect(noAgent.entries).toEqual([]);
  });
});

describe('excluded manifests', () => {
  it('accepts --exclude-manifest repeated or comma-separated', () => {
    expect(addPaths('a.jsonl,b.jsonl', ['p.jsonl'])).toEqual(['p.jsonl', 'a.jsonl', 'b.jsonl']);
    expect(addPaths(' c.jsonl ', [])).toEqual(['c.jsonl']);
  });
  it('reads the PR ids of every excluded manifest, and fails on a missing one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'excl-'));
    await writeJsonl(join(dir, 'pilot.jsonl'), [{ id: 'o/r#1' }, { id: 'o/r#2' }]);
    expect([...(await excludedPrIds([join(dir, 'pilot.jsonl')]))]).toEqual(['o/r#1', 'o/r#2']);
    await expect(excludedPrIds([join(dir, 'nope.jsonl')])).rejects.toThrow(/does not exist/);
  });
});


describe('collect edge cases', () => {
  it('counts a PR with markers of two agents as ambiguous and does not select it', async () => {
    const r = {
      ...routes,
      '/repos/big/repo/pulls/2': pull(2, { head: { ref: 'codex/fix', sha: 'head2' }, body: 'Generated with Claude Code' }),
      '/repos/big/repo/pulls/2/files': [{ filename: 'src/c.ts' }],
      '/repos/big/repo/pulls/2/commits': [{ commit: { message: 'fix' } }],
    };
    const { gh } = fakeApi(r, [{ q: 'head:codex', repo: 'big/repo', number: 2 }]);
    const { entries, summary } = await collect(gh, base);
    expect(summary.ambiguous).toBe(1);
    expect(entries).toEqual([]);
    expect(summary.examined.codex).toBe(1);
    expect(summary.selected.codex).toBe(0);
    expect(summary.selected['claude-code']).toBe(0);
  });

  it('rejects a User-authored PR on a codex/ branch from the human pool', async () => {
    const r = {
      ...routes,
      '/repos/big/repo/pulls': [
        { number: 1, user: { login: 'Copilot', type: 'Bot' }, merged_at: '2026-10-10T00:00:00Z' },
        { number: 7, user: { login: 'carol', type: 'User' }, merged_at: '2026-10-12T00:00:00Z' },
      ],
      '/repos/big/repo/pulls/7': pull(7, { user: { login: 'carol', type: 'User' }, head: { ref: 'codex/tweak', sha: 'head7' } }),
      '/repos/big/repo/pulls/7/files': [{ filename: 'src/d.ts' }],
      '/repos/big/repo/pulls/7/commits': [{ commit: { message: 'tweak' } }],
    };
    const { gh } = fakeApi(r, [{ q: COPILOT, repo: 'big/repo', number: 1 }]);
    const { entries, summary } = await collect(gh, base);
    expect(entries.map((e) => e.id)).toEqual(['big/repo#1']);
    expect(summary.humansSelected).toBe(0);
    expect(summary.humanShortfall).toBe(1);
  });
});

describe('collect option validation', () => {
  it('accepts positive integers only for --days, --per-agent and --per-repo', () => {
    expect(parsePositiveInt('--days')('90')).toBe(90);
    expect(parsePositiveInt('--per-repo')('3')).toBe(3);
    for (const bad of ['0', '-1', '1.5', '', 'abc', '1e3', ' 7', '90days']) expect(() => parsePositiveInt('--days')(bad), bad).toThrow(/--days/);
  });
  it('accepts --until only as a real YYYY-MM-DD date', () => {
    expect(parseYmd('2026-11-02')).toBe('2026-11-02');
    for (const bad of ['2026-11-2', '2026/11/02', '2026-02-31', '2026-13-01', '../x', '2026-11-02x', '']) expect(() => parseYmd(bad), bad).toThrow(/--until/);
  });
});
