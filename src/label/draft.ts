import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { byCodeUnit } from '../rng.js';
import { LABELS, type Label } from '../types.js';
import type { Packet } from './packet.js';

export const DRAFT_MODEL = 'claude-opus-5-5';
export const PROMPT_VERSION = 'v1';

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['label', 'rationale', 'confidence'],
  properties: {
    label: { type: 'string', enum: [...LABELS] },
    rationale: { type: 'string' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
} as const;

export interface Draft {
  key: string;
  label: Label | null;
  rationale: string;
  confidence: 'low' | 'medium' | 'high' | null;
  model: string;
  promptVersion: string;
  error?: string;
}

export function customId(key: string): string {
  return `k${createHash('sha1').update(key).digest('hex').slice(0, 40)}`;
}

export function buildRequest(packet: Packet, prompt: string): { custom_id: string; params: Anthropic.Messages.MessageCreateParamsNonStreaming } {
  return {
    custom_id: customId(packet.key),
    params: {
      model: DRAFT_MODEL,
      max_tokens: 16000,
      system: prompt,
      messages: [{ role: 'user', content: JSON.stringify(packet) }],
      output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
    },
  };
}

const empty = (key: string, error: string): Draft => ({ key, label: null, rationale: '', confidence: null, model: DRAFT_MODEL, promptVersion: PROMPT_VERSION, error });

export function parseResult(key: string, result: Anthropic.Messages.Batches.MessageBatchIndividualResponse['result']): Draft {
  if (result.type !== 'succeeded') return empty(key, result.type);
  if (result.message.stop_reason === 'refusal') return empty(key, 'refusal');
  const text = result.message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  try {
    const j = JSON.parse(text) as { label?: string; rationale?: string; confidence?: string };
    if (!LABELS.includes(j.label as Label) || typeof j.rationale !== 'string') return empty(key, 'invalid-output');
    const confidence = ['low', 'medium', 'high'].includes(j.confidence ?? '') ? (j.confidence as Draft['confidence']) : null;
    return { key, label: j.label as Label, rationale: j.rationale, confidence, model: DRAFT_MODEL, promptVersion: PROMPT_VERSION };
  } catch {
    return empty(key, 'invalid-output');
  }
}

export async function submitBatch(client: Anthropic, packets: Packet[], prompt: string): Promise<{ batchId: string; ids: Record<string, string> }> {
  const requests = packets.map((p) => buildRequest(p, prompt));
  const batch = await client.messages.batches.create({ requests });
  return { batchId: batch.id, ids: Object.fromEntries(packets.map((p) => [customId(p.key), p.key])) };
}

export async function collectBatch(
  client: Anthropic,
  batchId: string,
  ids: Record<string, string>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<Draft[]> {
  for (;;) {
    const b = await client.messages.batches.retrieve(batchId);
    if (b.processing_status === 'ended') break;
    console.error(`batch ${batchId}: ${b.processing_status}, processing ${b.request_counts.processing}`);
    await sleep(60_000);
  }
  const drafts: Draft[] = [];
  for await (const r of await client.messages.batches.results(batchId)) {
    const key = ids[r.custom_id];
    if (key) drafts.push(parseResult(key, r.result));
  }
  return drafts.sort((a, b) => byCodeUnit(a.key, b.key));
}
