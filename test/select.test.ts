import { describe, expect, it } from 'vitest';
import { matchHumans, selectAgentPrs, toEntry, type BasicPull, type Candidate } from '../src/collect/select.js';
import type { AgentId, PrDetail } from '../src/types.js';
import { rngFor, shuffle } from '../src/rng.js';

const pr = (repo: string, number: number): PrDetail => ({
  repo, number, title: 't', author: 'a', authorType: 'User', mergedBy: 'm', mergedAt: '2026-10-01T00:00:00Z',
  baseRef: 'main', baseSha: 'b', headSha: 'h', branch: 'x', body: '', files: ['src/a.ts'], commitMessages: [],
});
const cand = (agent: AgentId, repo: string, n: number): Candidate => ({
  pr: pr(repo, n), agent, evidence: ['x'], model: 'unknown', repoStars: 5000, repoLanguage: 'TypeScript',
});

const keyOf = (c: Candidate) => `${c.pr.repo}#${c.pr.number}`;
const hitsOf = (cands: Candidate[]) => {
  const m = new Map<AgentId, Set<string>>();
  for (const c of cands) m.set(c.agent, (m.get(c.agent) ?? new Set()).add(keyOf(c)));
  return m;
};
const lookup = (cands: Candidate[]) => {
  const m = new Map(cands.map((c) => [keyOf(c), c]));
  return async (k: string) => m.get(k) ?? null;
};
const opts = { perAgent: 3, perRepo: 3, seed: 's' };

describe('selectAgentPrs', () => {
  it('caps per agent and per repo (across agents), deterministically', async () => {
    const cands = [
      ...Array.from({ length: 10 }, (_, i) => cand('copilot', `r${i % 2}/x`, i)),
      ...Array.from({ length: 4 }, (_, i) => cand('codex', 'r0/x', 100 + i)),
    ];
    const s1 = await selectAgentPrs(hitsOf(cands), lookup(cands), opts);
    const s2 = await selectAgentPrs(hitsOf([...cands].reverse()), lookup(cands), opts);
    expect(s1.map((c) => c.pr.number)).toEqual(s2.map((c) => c.pr.number));
    expect(s1.filter((c) => c.agent === 'copilot').length).toBe(3);
    expect(s1.filter((c) => c.pr.repo === 'r0/x').length).toBe(3);
    expect(s1.filter((c) => c.agent === 'codex').length).toBeGreaterThanOrEqual(1);
  });

  it("takes each agent's hits in the seeded order of its sorted keys", async () => {
    const cands = Array.from({ length: 8 }, (_, i) => cand('copilot', `r${i}/x`, i));
    const want = shuffle(cands.map(keyOf).sort(), rngFor('s:copilot')).slice(0, 3);
    const got = await selectAgentPrs(hitsOf(cands), lookup(cands), opts);
    expect(got.map(keyOf)).toEqual(want);
  });

  it('skips excluded hits and hits in a full repo without evaluating them', async () => {
    const cands = Array.from({ length: 5 }, (_, i) => cand('copilot', 'r0/x', i));
    const evaluated: string[] = [];
    const find = lookup(cands);
    const got = await selectAgentPrs(hitsOf(cands), async (k) => { evaluated.push(k); return find(k); }, {
      perAgent: 5, perRepo: 2, seed: 's', excludedPrs: new Set(['r0/x#0']),
    });
    expect(got.length).toBe(2);
    expect(evaluated.length).toBe(2);
    expect(evaluated).not.toContain('r0/x#0');
  });

  it('evaluates a PR found by two agents once and accepts it only for the agent it is attributed to', async () => {
    const c = cand('codex', 'o/r', 1);
    const hits = new Map<AgentId, Set<string>>([['copilot', new Set(['o/r#1'])], ['codex', new Set(['o/r#1'])]]);
    let n = 0;
    const examined: AgentId[] = [];
    const got = await selectAgentPrs(hits, async () => { n++; return c; }, opts, (a) => examined.push(a));
    expect(got).toEqual([c]);
    expect(n).toBe(1);
    expect(examined).toEqual(['copilot', 'codex']);
  });

  it('stops evaluating once the agent is full', async () => {
    const cands = Array.from({ length: 10 }, (_, i) => cand('copilot', `r${i}/x`, i));
    let n = 0;
    const find = lookup(cands);
    const got = await selectAgentPrs(hitsOf(cands), async (k) => { n++; return find(k); }, { ...opts, perAgent: 2 });
    expect(got.length).toBe(2);
    expect(n).toBe(2);
  });
});

describe('matchHumans', () => {
  it('takes as many accepted human PRs per repo as agent PRs, skipping rejects and agent PR numbers', async () => {
    const selected = [cand('copilot', 'o/r', 1), cand('codex', 'o/r', 2)];
    const pool: BasicPull[] = [1, 2, 3, 4, 5].map((n) => ({ number: n, author: 'h', authorType: 'User', mergedAt: '2026-10-01T00:00:00Z' }));
    pool.push({ number: 6, author: 'dependabot[bot]', authorType: 'Bot', mergedAt: '2026-10-01T00:00:00Z' });
    const seen: number[] = [];
    const { humans, shortfall } = await matchHumans(selected, new Map([['o/r', pool]]), async (repo, p) => {
      seen.push(p.number);
      return p.number === 3 ? null : pr(repo, p.number);
    }, 's');
    expect(humans.length).toBe(2);
    expect(shortfall).toBe(0);
    expect(humans.every((h) => [4, 5].includes(h.number))).toBe(true);
    expect(seen).not.toContain(1);
    expect(seen).not.toContain(6);
  });

  it('reports a shortfall when a repo has too few human PRs', async () => {
    const { humans, shortfall } = await matchHumans([cand('copilot', 'o/r', 1)], new Map(), async () => null, 's');
    expect(humans).toEqual([]);
    expect(shortfall).toBe(1);
  });
});

describe('toEntry', () => {
  it('builds a manifest line', () => {
    const e = toEntry(pr('o/r', 9), {
      group: 'human', agent: null, model: 'unknown', evidence: [], repoStars: 1200, repoLanguage: 'Python', selectedAt: '2026-11-01T00:00:00Z',
    });
    expect(e).toMatchObject({ id: 'o/r#9', repo: 'o/r', pr: 9, group: 'human', baseSha: 'b', headSha: 'h', repoStars: 1200 });
  });
});
