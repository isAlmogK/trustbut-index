import { describe, expect, it } from 'vitest';
import { buildRequest, customId, parseResult } from '../src/label/draft.js';
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
