import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export interface SearchItem {
  repo: string;
  number: number;
}
export interface GitHubApi {
  get<T>(path: string): Promise<T>;
  paginate<T>(path: string, maxPages: number): Promise<T[]>;
  search(q: string, maxPages?: number): Promise<SearchItem[]>;
}
export interface GitHubOptions {
  token?: string;
  cacheDir?: string;
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  searchIntervalMs?: number;
  maxRetries?: number;
}

export class NotFoundError extends Error {
  constructor(readonly path: string) {
    super(`GitHub 404: ${path}`);
  }
}

const API = 'https://api.github.com';

/** One API cache per collection (collect: the --until date; packets: the results date), so a later collection never reads stale answers. */
export function apiCacheDir(name: string): string {
  return join('cache', 'github', name);
}

export class GitHub implements GitHubApi {
  private readonly fetchFn: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private lastSearch = Number.NEGATIVE_INFINITY;

  constructor(private readonly opts: GitHubOptions = {}) {
    this.fetchFn = opts.fetch ?? ((u, i) => fetch(u, i));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  async get<T>(path: string): Promise<T> {
    const cached = await this.readCache(path);
    if (cached !== undefined) return cached as T;
    const body = await this.request(path);
    await this.writeCache(path, body);
    return body as T;
  }

  async paginate<T>(path: string, maxPages: number): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= maxPages; page++) {
      const rows = await this.get<T[]>(`${path}${sep}per_page=100&page=${page}`);
      out.push(...rows);
      if (rows.length < 100) break;
    }
    return out;
  }

  async search(q: string, maxPages = 10): Promise<SearchItem[]> {
    const out: SearchItem[] = [];
    for (let page = 1; page <= maxPages; page++) {
      const path = `/search/issues?q=${encodeURIComponent(q)}&per_page=100&page=${page}`;
      let res = (await this.readCache(path)) as { items: { number: number; repository_url: string }[] } | undefined;
      if (res === undefined) {
        await this.throttleSearch();
        res = (await this.request(path)) as { items: { number: number; repository_url: string }[] };
        await this.writeCache(path, res);
      }
      for (const it of res.items) out.push({ repo: it.repository_url.replace(`${API}/repos/`, ''), number: it.number });
      if (res.items.length < 100) break;
    }
    return out;
  }

  private async throttleSearch(): Promise<void> {
    const wait = this.lastSearch + (this.opts.searchIntervalMs ?? 2100) - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastSearch = this.now();
  }

  private async request(path: string): Promise<unknown> {
    const max = this.opts.maxRetries ?? 5;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchFn(`${API}${path}`, {
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
        },
      });
      if (res.ok) return res.json();
      if (res.status === 404) throw new NotFoundError(path);
      const wait = this.retryWait(res);
      if (wait !== null && attempt < max) {
        await this.sleep(wait);
        continue;
      }
      throw new Error(`GitHub ${res.status} for ${path}: ${await res.text()}`);
    }
  }

  private retryWait(res: Response): number | null {
    const after = res.headers.get('retry-after');
    if (after) return Number(after) * 1000;
    if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
      return Math.max(reset - this.now(), 0) + 1000;
    }
    if (res.status >= 500) return 2000;
    return null;
  }

  private cachePath(path: string): string | null {
    if (!this.opts.cacheDir) return null;
    return join(this.opts.cacheDir, `${createHash('sha1').update(path).digest('hex')}.json`);
  }

  private async readCache(path: string): Promise<unknown | undefined> {
    const file = this.cachePath(path);
    if (!file) return undefined;
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch {
      return undefined;
    }
  }

  private async writeCache(path: string, body: unknown): Promise<void> {
    const file = this.cachePath(path);
    if (!file) return;
    await mkdir(this.opts.cacheDir!, { recursive: true });
    await writeFile(file, JSON.stringify(body));
  }
}

/** File contents at `ref` (default branch when omitted), or null when the file doesn't exist. */
export async function readRepoFile(gh: GitHubApi, repo: string, path: string, ref?: string): Promise<string | null> {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  const q = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  try {
    const res = await gh.get<{ content?: string } | unknown[]>(`/repos/${repo}/contents/${encoded}${q}`);
    if (Array.isArray(res) || typeof res.content !== 'string') return null;
    return Buffer.from(res.content, 'base64').toString('utf8');
  } catch (e) {
    if (e instanceof NotFoundError) return null;
    throw e;
  }
}
