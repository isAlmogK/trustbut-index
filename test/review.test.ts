import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeJson, writeJsonl } from '../src/jsonl.js';
import { nextItem, startReview, type FinalLabel } from '../src/label/review.js';
import type { SampleItem } from '../src/label/sample.js';

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

    const bad = await fetch(`${srv.url}/api/label`, { method: 'POST', body: JSON.stringify({ key: 'o__r__0:0', label: 'maybe' }) });
    expect(bad.status).toBe(400);
    await fetch(`${srv.url}/api/label`, { method: 'POST', body: JSON.stringify({ key: 'o__r__0:0', label: 'real', note: '' }) });

    const second = await (await fetch(`${srv.url}/api/next`)).json();
    expect(second.item.key).toBe('o__r__1:0');
    expect(second.draft.label).toBe('false');
    expect(second.progress).toEqual({ done: 1, total: 2 });

    const finals = (await readFile(join(dir, 'final.jsonl'), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    expect(finals[0]).toMatchObject({ key: 'o__r__0:0', label: 'real', draftLabel: 'real', blind: true });
    expect(await (await fetch(srv.url)).text()).toContain('<title>trustbut-index review</title>');
  });
});
