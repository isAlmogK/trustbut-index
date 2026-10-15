import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export interface GitHubApi {
  get<T>(path: string): Promise<T>;
  paginate<T>(path: string, maxPages: number): Promise<T[]>;
  /** GraphQL query or search. `search: true` spaces uncached calls by the search interval. */
  graphql<T>(query: string, variables: Record<string, unknown>, opts?: { search?: boolean }): Promise<T>;
  /** Last seen remaining budget per API, for progress logs only. */
  rateRemaining?(): { rest?: number; graphql?: number };
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
/** Waits before retrying a GraphQL timeout or empty response. */
const TRANSIENT_BACKOFF_MS = [2000, 10_000, 30_000];

/** One API cache per collection (collect: the --until date; packets: the results date), so a later collection never reads stale answers. */
export function apiCacheDir(name: string): string {
  return join('cache', 'github', name);
}

export class GitHub implements GitHubApi {
  private readonly fetchFn: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private lastSearch = Number.NEGATIVE_INFINITY;
  private readonly rate = new Map<string, { remaining: number; reset: number }>();

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

  async graphql<T>(query: string, variables: Record<string, unknown>, opts: { search?: boolean } = {}): Promise<T> {
    const key = `POST /graphql ${query} ${JSON.stringify(variables)}`;
    const cached = await this.readCache(key);
    if (cached !== undefined) return cached as T;
    const max = this.opts.maxRetries ?? 5;
    let rateAttempts = 0;
    let transientAttempts = 0;
    for (;;) {
      if (opts.search) await this.throttleSearch();
      const res = (await this.request('/graphql', { query, variables })) as {
        data?: unknown;
        errors?: { type?: string; message: string }[];
      };
      const errors = res.errors ?? [];
      // A missing repo comes back as NOT_FOUND with the field set to null; that is an answer, not a failure.
      if (res.data !== undefined && errors.every((e) => e.type === 'NOT_FOUND')) {
        await this.writeCache(key, res.data);
        return res.data as T;
      }
      if (errors.some((e) => e.type === 'RATE_LIMITED') && rateAttempts < max) {
        rateAttempts++;
        const reset = this.rate.get('graphql')?.reset ?? 0;
        await this.sleep(reset > 0 ? Math.max(reset * 1000 - this.now(), 0) + 1000 : 60_000);
        continue;
      }
      // GitHub reports query timeouts as HTTP 200 with untyped errors, and sometimes sends an empty body.
      const transient =
        (res.data === undefined && errors.length === 0) ||
        (errors.length > 0 && errors.every((e) => !e.type)) ||
        errors.some((e) => /something went wrong|timeout/i.test(e.message));
      if (transient && transientAttempts < TRANSIENT_BACKOFF_MS.length) {
        await this.sleep(TRANSIENT_BACKOFF_MS[transientAttempts++]!);
        continue;
      }
      throw new Error(`GitHub GraphQL: ${errors.length > 0 ? errors.map((e) => e.message).join('; ') : 'no data'}`);
    }
  }

  rateRemaining(): { rest?: number; graphql?: number } {
    return { rest: this.rate.get('core')?.remaining, graphql: this.rate.get('graphql')?.remaining };
  }

  private async throttleSearch(): Promise<void> {
    const wait = this.lastSearch + (this.opts.searchIntervalMs ?? 1000) - this.now();
    if (wait > 0) await this.sleep(wait);
    this.lastSearch = this.now();
  }

  private async request(path: string, body?: unknown): Promise<unknown> {
    const max = this.opts.maxRetries ?? 5;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetchFn(`${API}${path}`, {
        ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(this.opts.token ? { authorization: `Bearer ${this.opts.token}` } : {}),
        },
      });
      this.noteRate(res);
      if (res.ok) return res.json();
      if (res.status === 404) throw new NotFoundError(path);
      const text = await res.text();
      const wait = this.retryWait(res, text, attempt);
      if (wait !== null && attempt < max) {
        await this.sleep(wait);
        continue;
      }
      throw new Error(`GitHub ${res.status} for ${path}: ${text}`);
    }
  }

  private noteRate(res: Response): void {
    const resource = res.headers.get('x-ratelimit-resource');
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (!resource || remaining === null || !Number.isFinite(Number(remaining))) return;
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    this.rate.set(resource, { remaining: Number(remaining), reset: Number.isFinite(reset) ? reset : 0 });
  }

  private retryWait(res: Response, body: string, attempt: number): number | null {
    const after = Number(res.headers.get('retry-after'));
    if (res.headers.get('retry-after') && Number.isFinite(after) && after >= 0) return after * 1000;
    if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
      return Math.max(reset - this.now(), 0) + 1000;
    }
    // Secondary rate limits come without usable headers; GitHub asks for at least a minute, then exponential backoff.
    if ((res.status === 403 || res.status === 429) && /secondary rate limit/i.test(body)) return 60_000 * 2 ** attempt;
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
