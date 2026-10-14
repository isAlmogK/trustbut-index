import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { buildRequest, collectBatch, customId, parseResult, submitBatch } from '../src/label/draft.js';
import type { Packet } from '../src/label/packet.js';

const packet = { key: 'o__r__1:0', family: 'proof-gap' } as Packet;

describe('draft requests', () => {
  it('uses a valid, stable custom id', () => {
    expect(customId('o__r__1:0')).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(customId('o__r__1:0')).toBe(customId('o__r__1:0'));
    expect(customId('o__r__1:0')).not.toBe(customId('o__r__1:1'));
  });

  it('builds a structured-output request on the draft model', () => {
    const r = buildRequest(packet, 'PROMPT');
    expect(r.params.model).toBe('claude-opus-5-5');
    expect(r.params.system).toBe('PROMPT');
    expect(r.params.output_config).toMatchObject({ effort: 'high', format: { type: 'json_schema' } });
    expect(JSON.parse((r.params.messages[0]!.content as string))).toMatchObject({ key: 'o__r__1:0' });
  });
});

describe('parseResult', () => {
  it('parses a succeeded JSON answer', () => {
    const d = parseResult('k', {
      type: 'succeeded',
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"label":"real","rationale":"line 3 shows…","confidence":"high"}' }] },
    } as never);
    expect(d).toMatchObject({ key: 'k', label: 'real', confidence: 'high', model: 'claude-opus-5-5', promptVersion: 'v1' });
  });
  it('records refusals and errors without a label', () => {
    expect(parseResult('k', { type: 'succeeded', message: { stop_reason: 'refusal', content: [] } } as never)).toMatchObject({ label: null, error: 'refusal' });
    expect(parseResult('k', { type: 'errored', error: { type: 'error', error: { type: 'api_error', message: 'x' } } } as never)).toMatchObject({ label: null, error: 'errored' });
    expect(parseResult('k', { type: 'succeeded', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"label":"maybe"}' }] } } as never)).toMatchObject({ label: null, error: 'invalid-output' });
  });
});

describe('batch round trip', () => {
  const ok = (id: string, label: string) => ({
    custom_id: id,
    result: { type: 'succeeded', message: { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ label, rationale: 'r', confidence: 'low' }) }] } },
  });
  function fake(results: unknown[]) {
    const created: Array<{ custom_id: string }> = [];
    let polls = 0;
    const client = {
      messages: {
        batches: {
          create: async (a: { requests: Array<{ custom_id: string }> }) => { created.push(...a.requests); return { id: 'b1' }; },
          retrieve: async () => ({ processing_status: ++polls === 1 ? 'in_progress' : 'ended', request_counts: { processing: 1 } }),
          results: async () => (async function* () { for (const r of results) yield r; })(),
        },
      },
    } as unknown as Anthropic;
    return { client, created, polls: () => polls };
  }
  const packets = [{ key: 'b:1' }, { key: 'a:2' }, { key: 'c:0' }] as Packet[];

  it('submitBatch maps custom ids to keys', async () => {
    const f = fake([]);
    const { batchId, ids } = await submitBatch(f.client, packets, 'P');
    expect(batchId).toBe('b1');
    expect(ids).toEqual({ [customId('b:1')]: 'b:1', [customId('a:2')]: 'a:2', [customId('c:0')]: 'c:0' });
    expect(f.created.map((r) => r.custom_id)).toEqual(packets.map((p) => customId(p.key)));
  });

  it('collectBatch maps out-of-order results, sorts, polls with sleep, ignores unknown ids', async () => {
    const ids = { [customId('b:1')]: 'b:1', [customId('a:2')]: 'a:2', [customId('c:0')]: 'c:0' };
    const f = fake([ok(customId('c:0'), 'false'), ok('unknown', 'real'), ok(customId('b:1'), 'unclear'), ok(customId('a:2'), 'real')]);
    const sleep = vi.fn(async () => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const drafts = await collectBatch(f.client, 'b1', ids, sleep);
    err.mockRestore();
    expect(drafts.map((d) => [d.key, d.label])).toEqual([['a:2', 'real'], ['b:1', 'unclear'], ['c:0', 'false']]);
    expect(f.polls()).toBe(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});
