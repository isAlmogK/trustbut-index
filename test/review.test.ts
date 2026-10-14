import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { writeJson, writeJsonl } from '../src/jsonl.js';
import { REVIEW_PAGE, nextItem, startReview, type FinalLabel } from '../src/label/review.js';
import type { SampleItem } from '../src/label/sample.js';

const JSON_TYPE = { 'content-type': 'application/json' };
const post = (url: string, body: unknown) => fetch(`${url}/api/label`, { method: 'POST', headers: JSON_TYPE, body: JSON.stringify(body) });

/** A raw POST with full control of the headers (fetch cannot set Host). */
function rawPost(url: string, headers: Record<string, string>, body: string): Promise<number> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path: '/api/label', method: 'POST', headers }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on('error', reject);
    req.end(body);
  });
}

const item = (order: number, blind: boolean): SampleItem => ({
  key: `o__r__${order}:0`, prId: `o/r#${order}`, fileId: `o__r__${order}`, group: 'agent', agent: 'copilot', findingIndex: 0,
  finding: { id: 'escape-added', severity: 'warn', title: 'cast to any' }, family: 'escapes', order, blind,
});

describe('nextItem', () => {
  it('returns the lowest-order unlabeled item', () => {
    const s = [item(0, true), item(1, false)];
    expect(nextItem(s, [])!.order).toBe(0);
    expect(nextItem(s, [{ key: 'o__r__0:0' } as FinalLabel])!.order).toBe(1);
    expect(nextItem(s, [{ key: 'o__r__0:0' }, { key: 'o__r__1:0' }] as FinalLabel[])).toBeNull();
  });
});

describe('review server', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => close?.());

  it('hides drafts for blind items and appends labels', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'review-'));
    await writeJsonl(join(dir, 'sample.jsonl'), [item(0, true), item(1, false)]);
    await writeJsonl(join(dir, 'drafts.jsonl'), [
      { key: 'o__r__0:0', label: 'real', rationale: 'r0', confidence: 'high', model: 'm', promptVersion: 'v1' },
      { key: 'o__r__1:0', label: 'false', rationale: 'r1', confidence: 'low', model: 'm', promptVersion: 'v1' },
    ]);
    await writeJson(join(dir, 'packets', 'o__r__0_0.json'), { key: 'o__r__0:0' });
    await writeJson(join(dir, 'packets', 'o__r__1_0.json'), { key: 'o__r__1:0' });
    const srv = await startReview(dir, 0);
    close = srv.close;

    const first = await (await fetch(`${srv.url}/api/next`)).json();
    expect(first.item.key).toBe('o__r__0:0');
    expect(first.item).not.toHaveProperty('group');
    expect(first.item).not.toHaveProperty('agent');
    expect(first.draft).toBeNull();
    expect(first.packet).toEqual({ key: 'o__r__0:0' });

    const bad = await post(srv.url, { key: 'o__r__0:0', label: 'maybe' });
    expect(bad.status).toBe(400);
    await post(srv.url, { key: 'o__r__0:0', label: 'real', note: '' });

    const second = await (await fetch(`${srv.url}/api/next`)).json();
    expect(second.item.key).toBe('o__r__1:0');
    expect(second.draft.label).toBe('false');
    expect(second.progress).toEqual({ done: 1, total: 2 });

    const finals = (await readFile(join(dir, 'final.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(finals[0]).toMatchObject({ key: 'o__r__0:0', label: 'real', draftLabel: 'real', blind: true });
    expect(await (await fetch(srv.url)).text()).toContain('<title>trustbut-index review</title>');
  });

  async function setup() {
    const dir = await mkdtemp(join(tmpdir(), 'review-'));
    await writeJsonl(join(dir, 'sample.jsonl'), [item(0, true), item(1, false)]);
    const srv = await startReview(dir, 0);
    close = srv.close;
    return { dir, url: srv.url, port: new URL(srv.url).port };
  }

  it('counts progress by unique labeled keys, so a relabel does not count twice', async () => {
    const { url } = await setup();
    await post(url, { key: 'o__r__0:0', label: 'real' });
    await post(url, { key: 'o__r__0:0', label: 'false' });
    const next = await (await fetch(`${url}/api/next`)).json();
    expect(next.progress).toEqual({ done: 1, total: 2 });
    await post(url, { key: 'o__r__1:0', label: 'unclear' });
    expect((await (await fetch(`${url}/api/next`)).json()).progress).toEqual({ done: 2, total: 2 });
  });

  it('accepts a label POST only as JSON to a local Host, and rejects malformed JSON', async () => {
    const { dir, url, port } = await setup();
    const ok = JSON.stringify({ key: 'o__r__0:0', label: 'real' });
    expect(await rawPost(url, { 'content-type': 'text/plain', host: `127.0.0.1:${port}` }, ok)).toBe(403);
    expect(await rawPost(url, { host: `127.0.0.1:${port}` }, ok)).toBe(403);
    expect(await rawPost(url, { 'content-type': 'application/json', host: `evil.example:${port}` }, ok)).toBe(403);
    expect(await rawPost(url, { 'content-type': 'application/json', host: '127.0.0.1:1' }, ok)).toBe(403);
    expect(await rawPost(url, { 'content-type': 'application/json', host: `127.0.0.1:${port}` }, '{not json')).toBe(400);
    expect(await rawPost(url, { 'content-type': 'application/json; charset=utf-8', host: `localhost:${port}` }, ok)).toBe(200);
    expect(await rawPost(url, { 'content-type': 'application/json', host: `127.0.0.1:${port}` }, ok)).toBe(200);
    const lines = (await readFile(join(dir, 'final.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('serves a page whose label POST sends a JSON content type', () => {
    expect(REVIEW_PAGE).toMatch(/fetch\('\/api\/label',\{method:'POST',headers:\{'content-type':'application\/json'\}/);
  });
});

