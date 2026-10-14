import { mkdtemp } from 'node:fs/promises';
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

  it('searches issues, maps repo and number, and throttles', async () => {
    const { f } = fakeFetch(() =>
      json({ items: [{ number: 7, repository_url: 'https://api.github.com/repos/o/r' }] }),
    );
    const sleeps: number[] = [];
    let t = 0;
    const gh = new GitHub({ fetch: f, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } });
    expect(await gh.search('is:pr a')).toEqual([{ repo: 'o/r', number: 7 }]);
    await gh.search('is:pr b');
    expect(sleeps).toEqual([2100]);
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
});
