import { describe, expect, it } from 'vitest';
import type { GitHubApi } from '../src/github/client.js';
import { BATCH, prQuery, searchAgentPrs, splitWindow } from '../src/collect/search.js';

const W = { since: '2026-08-03', until: '2026-11-01' };
const COPILOT = 'author:app/copilot-swe-agent';
type Item = { q: string; repo: string; number: number };

/** PR search fake: returns the items whose agent query starts the search text and whose repo is a repo: token in it. */
function fakeSearch(items: Item[], count: (q: string) => number | undefined = () => undefined) {
  const seen: { q: string; after: string | null }[] = [];
  const gh = {
    graphql: async (_query: string, vars: Record<string, unknown>) => {
      const q = vars.q as string;
      const after = (vars.after as string | null) ?? null;
      seen.push({ q, after });
      const tokens = new Set(q.split(' '));
      const all = items
        .filter((i) => q.startsWith(`${i.q} is:pr`) && tokens.has(`repo:${i.repo}`))
        .map((i) => ({ number: i.number, repository: { nameWithOwner: i.repo } }));
      const start = after === null ? 0 : Number(after);
      return {
        search: {
          issueCount: count(q) ?? all.length,
          pageInfo: { hasNextPage: start + 100 < all.length, endCursor: String(start + 100) },
          nodes: all.slice(start, start + 100),
        },
      };
    },
  } as unknown as GitHubApi;
  return { gh, seen };
}
const reposIn = (q: string) => q.split(' ').filter((t) => t.startsWith('repo:')).map((t) => t.slice(5));
const mergedIn = (q: string) => /merged:(\S+)/.exec(q)![1];

describe('prQuery', () => {
  it('builds the search text for one agent query and a batch of repos', () => {
    expect(prQuery(COPILOT, ['a/b', 'c/d'], W)).toBe(
      'author:app/copilot-swe-agent is:pr is:merged merged:2026-08-03..2026-11-01 repo:a/b repo:c/d',
    );
  });
});

describe('splitWindow', () => {
  it('splits a window into two halves by days', () => {
    expect(splitWindow(W)).toEqual([
      { since: '2026-08-03', until: '2026-09-17' },
      { since: '2026-09-18', until: '2026-11-01' },
    ]);
    expect(splitWindow({ since: '2026-08-03', until: '2026-08-04' })).toEqual([
      { since: '2026-08-03', until: '2026-08-03' },
      { since: '2026-08-04', until: '2026-08-04' },
    ]);
  });
  it('throws on a one-day window', () => {
    expect(() => splitWindow({ since: '2026-08-03', until: '2026-08-03' })).toThrow(/one-day window 2026-08-03/);
  });
});

describe('searchAgentPrs', () => {
  it('runs every agent query over batches of 40 repos and keeps hits per agent', async () => {
    const repos = Array.from({ length: 85 }, (_, i) => `o/r${String(i).padStart(2, '0')}`);
    const { gh, seen } = fakeSearch([
      { q: COPILOT, repo: 'o/r00', number: 1 },
      { q: 'head:codex', repo: 'o/r84', number: 2 },
      { q: '"chatgpt.com/codex" in:body', repo: 'o/r84', number: 2 },
      { q: '"chatgpt.com/codex" in:body', repo: 'o/r84', number: 3 },
    ]);
    const hits = await searchAgentPrs(gh, repos, W);
    expect(BATCH).toBe(40);
    expect(seen.length).toBe(3 * 9);
    expect(seen.filter((s) => s.q.startsWith(COPILOT)).map((s) => reposIn(s.q).length)).toEqual([40, 40, 5]);
    expect([...hits.get('copilot')!]).toEqual(['o/r00#1']);
    expect([...hits.get('codex')!].sort()).toEqual(['o/r84#2', 'o/r84#3']);
    expect(hits.get('jules')!.size).toBe(0);
    expect([...hits.keys()]).toEqual(['copilot', 'codex', 'claude-code', 'cursor', 'devin', 'jules']);
  });

  it('splits a batch with more than 1,000 results in half until each part fits', async () => {
    const { gh, seen } = fakeSearch(
      [{ q: COPILOT, repo: 'a', number: 1 }, { q: COPILOT, repo: 'd', number: 2 }],
      (q) => (reposIn(q).length > 1 && reposIn(q).includes('a') ? 1001 : undefined),
    );
    const hits = await searchAgentPrs(gh, ['a', 'b', 'c', 'd'], W);
    expect(seen.filter((s) => s.q.startsWith(COPILOT)).map((s) => reposIn(s.q))).toEqual([
      ['a', 'b', 'c', 'd'], ['a', 'b'], ['a'], ['b'], ['c', 'd'],
    ]);
    expect([...hits.get('copilot')!].sort()).toEqual(['a#1', 'd#2']);
  });

  it('splits the window for a single repo with more than 1,000 results', async () => {
    const { gh, seen } = fakeSearch([{ q: COPILOT, repo: 'a', number: 1 }], (q) =>
      q.startsWith(COPILOT) && mergedIn(q) === '2026-08-03..2026-11-01' ? 1001 : undefined,
    );
    await searchAgentPrs(gh, ['a'], W);
    expect(seen.filter((s) => s.q.startsWith(COPILOT)).map((s) => mergedIn(s.q))).toEqual([
      '2026-08-03..2026-11-01', '2026-08-03..2026-09-17', '2026-09-18..2026-11-01',
    ]);
  });

  it('fails when one repo has more than 1,000 results on one day', async () => {
    const { gh } = fakeSearch([], () => 1001);
    await expect(searchAgentPrs(gh, ['a'], { since: '2026-08-03', until: '2026-08-03' })).rejects.toThrow(/one-day window 2026-08-03/);
  });

  it('pages through results by cursor', async () => {
    const items = Array.from({ length: 250 }, (_, i) => ({ q: COPILOT, repo: 'a', number: i + 1 }));
    const { gh, seen } = fakeSearch(items);
    const hits = await searchAgentPrs(gh, ['a'], W);
    expect(hits.get('copilot')!.size).toBe(250);
    expect(seen.filter((s) => s.q.startsWith(COPILOT)).map((s) => s.after)).toEqual([null, '100', '200']);
  });

  it('logs progress with the remaining GraphQL budget', async () => {
    const { gh } = fakeSearch([]);
    const lines: string[] = [];
    await searchAgentPrs(gh, ['a'], W, (m) => lines.push(m));
    expect(lines).toEqual([
      'searched batch 1/1: copilot 0, codex 0, claude-code 0, cursor 0, devin 0, jules 0; GraphQL remaining unknown',
    ]);
  });
});
