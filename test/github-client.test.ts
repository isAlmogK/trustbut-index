import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GitHub, NotFoundError, apiCacheDir, readRepoFile } from '../src/github/client.js';

function fakeFetch(routes: (url: string) => Response) {
  const calls: string[] = [];
  const inits: (RequestInit | undefined)[] = [];
  const f = async (url: string, init?: RequestInit) => {
    calls.push(url);
    inits.push(init);
    return routes(url);
  };
  return { f, calls, inits };
}
const json = (v: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('GitHub client', () => {
  it('sends auth and caches successful GETs on disk', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'gh-'));
    const { f, calls, inits } = fakeFetch(() => json({ full_name: 'o/r' }));
    const gh = new GitHub({ token: 't', cacheDir, fetch: f });
    expect(await gh.get('/repos/o/r')).toEqual({ full_name: 'o/r' });
    const again = new GitHub({ token: 't', cacheDir, fetch: f });
    expect(await again.get('/repos/o/r')).toEqual({ full_name: 'o/r' });
    expect(calls).toEqual(['https://api.github.com/repos/o/r']);
    const headers = inits[0]?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer t');
    expect(headers.accept).toBe('application/vnd.github+json');
    expect(headers['x-github-api-version']).toBe('2022-11-28');
  });

  it('sends no authorization header when no token is set', async () => {
    const { f, inits } = fakeFetch(() => json({ ok: true }));
    await new GitHub({ fetch: f }).get('/x');
    const headers = inits[0]?.headers as Record<string, string>;
    expect(headers).not.toHaveProperty('authorization');
    expect(headers.accept).toBe('application/vnd.github+json');
  });

  it('throws NotFoundError on 404', async () => {
    const { f } = fakeFetch(() => json({ message: 'Not Found' }, 404));
    await expect(new GitHub({ fetch: f }).get('/repos/x/y')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('waits for the rate-limit reset and retries', async () => {
    let n = 0;
    const { f } = fakeFetch(() =>
      n++ === 0 ? json({}, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1010' }) : json({ ok: true }),
    );
    const sleeps: number[] = [];
    const gh = new GitHub({ fetch: f, now: () => 1_000_000, sleep: async (ms) => void sleeps.push(ms) });
    expect(await gh.get('/x')).toEqual({ ok: true });
    expect(sleeps).toEqual([11_000]); // (1010s - 1000s) + 1s
  });

  it('paginates until a short page', async () => {
    const { f, calls } = fakeFetch((url) =>
      json(url.endsWith('page=1') ? Array(100).fill(1) : [2, 2]),
    );
    const rows = await new GitHub({ fetch: f }).paginate<number>('/repos/o/r/pulls?state=closed', 5);
    expect(rows.length).toBe(102);
    expect(calls[1]).toBe('https://api.github.com/repos/o/r/pulls?state=closed&per_page=100&page=2');
  });

  it('reads base64 file contents and returns null for missing files', async () => {
    const { f } = fakeFetch((url) =>
      url.includes('package.json')
        ? json({ content: Buffer.from('{"a":1}').toString('base64'), encoding: 'base64' })
        : json({ message: 'Not Found' }, 404),
    );
    const gh = new GitHub({ fetch: f });
    expect(await readRepoFile(gh, 'o/r', 'package.json')).toBe('{"a":1}');
    expect(await readRepoFile(gh, 'o/r', 'pytest.ini')).toBeNull();
  });
});

describe('apiCacheDir', () => {
  it('gives each collection its own cache folder', () => {
    expect(apiCacheDir('2026-11-02')).toBe(join('cache', 'github', '2026-11-02'));
    expect(apiCacheDir('2026-11-02')).not.toBe(apiCacheDir('2026-12-01'));
  });

  it('backs off exponentially on a secondary rate limit without headers', async () => {
    let n = 0;
    const secondary = () => json({ message: 'You have exceeded a secondary rate limit. Please wait a few minutes.' }, 403);
    const { f } = fakeFetch(() => (n++ < 2 ? secondary() : json({ ok: true })));
    const sleeps: number[] = [];
    const gh = new GitHub({ fetch: f, sleep: async (ms) => void sleeps.push(ms) });
    expect(await gh.get('/x')).toEqual({ ok: true });
    expect(sleeps).toEqual([60_000, 120_000]);
  });

  it('does not retry a 403 that is not a rate limit', async () => {
    const { f, calls } = fakeFetch(() => json({ message: 'Resource not accessible by personal access token' }, 403));
    const sleeps: number[] = [];
    await expect(new GitHub({ fetch: f, sleep: async (ms) => void sleeps.push(ms) }).get('/x')).rejects.toThrow(/GitHub 403/);
    expect(calls.length).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('ignores a non-numeric retry-after header', async () => {
    let n = 0;
    const { f } = fakeFetch(() =>
      n++ === 0 ? json({ message: 'secondary rate limit' }, 429, { 'retry-after': 'soon' }) : json({ ok: true }),
    );
    const sleeps: number[] = [];
    await new GitHub({ fetch: f, sleep: async (ms) => void sleeps.push(ms) }).get('/x');
    expect(sleeps).toEqual([60_000]);
  });
});

describe('GitHub GraphQL', () => {
  const Q = 'query($x: Int) { a(x: $x) }';

  it('posts the query with auth and caches the data on disk', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'gh-'));
    const { f, calls, inits } = fakeFetch(() => json({ data: { a: 1 } }));
    expect(await new GitHub({ token: 't', cacheDir, fetch: f }).graphql(Q, { x: 1 })).toEqual({ a: 1 });
    expect(await new GitHub({ token: 't', cacheDir, fetch: f }).graphql(Q, { x: 1 })).toEqual({ a: 1 });
    expect(calls).toEqual(['https://api.github.com/graphql']);
    expect(inits[0]?.method).toBe('POST');
    expect(JSON.parse(String(inits[0]?.body))).toEqual({ query: Q, variables: { x: 1 } });
    const headers = inits[0]?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer t');
    expect(headers['content-type']).toBe('application/json');
  });

  it('caches per variables', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'gh-'));
    let n = 0;
    const { f, calls } = fakeFetch(() => json({ data: { n: ++n } }));
    const gh = new GitHub({ cacheDir, fetch: f });
    expect(await gh.graphql(Q, { x: 1 })).toEqual({ n: 1 });
    expect(await gh.graphql(Q, { x: 2 })).toEqual({ n: 2 });
    expect(calls.length).toBe(2);
  });

  it('waits for the GraphQL reset on a RATE_LIMITED error, then retries', async () => {
    let n = 0;
    const { f } = fakeFetch(() =>
      n++ === 0
        ? json({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }, 200, {
            'x-ratelimit-resource': 'graphql', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1010',
          })
        : json({ data: { ok: true } }),
    );
    const sleeps: number[] = [];
    const gh = new GitHub({ fetch: f, now: () => 1_000_000, sleep: async (ms) => void sleeps.push(ms) });
    expect(await gh.graphql(Q, {})).toEqual({ ok: true });
    expect(sleeps).toEqual([11_000]);
  });

  it('returns the data when every error is NOT_FOUND', async () => {
    const { f } = fakeFetch(() =>
      json({ data: { repository: null }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a Repository' }] }),
    );
    expect(await new GitHub({ fetch: f }).graphql(Q, {})).toEqual({ repository: null });
  });

  it('throws on any other error and does not cache it', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'gh-'));
    const { f, calls } = fakeFetch(() => json({ errors: [{ type: 'INVALID', message: 'Field x does not exist' }] }));
    await expect(new GitHub({ cacheDir, fetch: f }).graphql(Q, {})).rejects.toThrow('GitHub GraphQL: Field x does not exist');
    await expect(new GitHub({ cacheDir, fetch: f }).graphql(Q, {})).rejects.toThrow('GitHub GraphQL');
    expect(calls.length).toBe(2);
  });

  it('retries an untyped timeout error with backoff, then returns the data', async () => {
    let n = 0;
    const { f } = fakeFetch(() =>
      n++ === 0
        ? json({ errors: [{ message: 'Something went wrong while executing your query. This may be the result of a timeout' }] })
        : json({ data: { ok: true } }),
    );
    const sleeps: number[] = [];
    const gh = new GitHub({ fetch: f, sleep: async (ms) => void sleeps.push(ms) });
    expect(await gh.graphql(Q, {})).toEqual({ ok: true });
    expect(sleeps).toEqual([2000]);
  });

  it('gives up on a persistent untyped error after three retries', async () => {
    const { f, calls } = fakeFetch(() => json({ errors: [{ message: 'boom' }] }));
    const sleeps: number[] = [];
    const gh = new GitHub({ fetch: f, sleep: async (ms) => void sleeps.push(ms) });
    await expect(gh.graphql(Q, {})).rejects.toThrow('GitHub GraphQL: boom');
    expect(sleeps).toEqual([2000, 10_000, 30_000]);
    expect(calls.length).toBe(4);
  });

  it('retries a body with neither data nor errors and never caches it', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'gh-'));
    let n = 0;
    const { f } = fakeFetch(() => (n++ === 0 ? json({}) : json({ data: { ok: true } })));
    const sleeps: number[] = [];
    const gh = new GitHub({ cacheDir, fetch: f, sleep: async (ms) => void sleeps.push(ms) });
    expect(await gh.graphql(Q, {})).toEqual({ ok: true });
    expect(sleeps).toEqual([2000]);
    expect(await readdir(cacheDir)).toHaveLength(1);
  });

  it('waits at least a minute on RATE_LIMITED when no reset is known', async () => {
    let n = 0;
    const { f } = fakeFetch(() =>
      n++ === 0 ? json({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }) : json({ data: { ok: true } }),
    );
    const sleeps: number[] = [];
    const gh = new GitHub({ fetch: f, now: () => 1_000_000, sleep: async (ms) => void sleeps.push(ms) });
    expect(await gh.graphql(Q, {})).toEqual({ ok: true });
    expect(sleeps[0]).toBe(60_000);
  });

  it('spaces uncached search calls one second apart, and only search calls', async () => {
    const { f } = fakeFetch(() => json({ data: {} }));
    const sleeps: number[] = [];
    let t = 0;
    const gh = new GitHub({ fetch: f, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } });
    await gh.graphql(Q, { x: 1 }, { search: true });
    await gh.graphql(Q, { x: 2 }, { search: true });
    await gh.graphql(Q, { x: 3 });
    expect(sleeps).toEqual([1000]);
  });

  it('reports the remaining REST and GraphQL budgets from response headers', async () => {
    const { f } = fakeFetch((url) =>
      url.endsWith('/graphql')
        ? json({ data: {} }, 200, { 'x-ratelimit-resource': 'graphql', 'x-ratelimit-remaining': '4000', 'x-ratelimit-reset': '1' })
        : json({}, 200, { 'x-ratelimit-resource': 'core', 'x-ratelimit-remaining': '4990', 'x-ratelimit-reset': '1' }),
    );
    const gh = new GitHub({ fetch: f });
    expect(gh.rateRemaining()).toEqual({ rest: undefined, graphql: undefined });
    await gh.get('/x');
    await gh.graphql(Q, {});
    expect(gh.rateRemaining()).toEqual({ rest: 4990, graphql: 4000 });
  });
});
