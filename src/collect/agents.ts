import type { AgentId, PrDetail } from '../types.js';

export type PrFacts = Pick<PrDetail, 'author' | 'authorType' | 'branch' | 'body' | 'commitMessages'>;

export interface AgentDef {
  id: AgentId;
  /** GitHub issue-search qualifiers that find candidate PRs (checked again with `evidence`). */
  queries: string[];
  /** Marker evidence found on the PR, e.g. "author:Copilot". Empty when none match. */
  evidence(pr: PrFacts): string[];
}

const authorIn = (pr: PrFacts, logins: string[]) => (logins.includes(pr.author) ? [`author:${pr.author}`] : []);
const branchPrefix = (pr: PrFacts, prefix: string) => (pr.branch.startsWith(prefix) ? [`branch:${prefix}`] : []);
const bodyHas = (pr: PrFacts, re: RegExp, label: string) => (re.test(pr.body) ? [`body:${label}`] : []);
const trailer = (pr: PrFacts, re: RegExp, label: string) =>
  pr.commitMessages.some((m) => re.test(m)) ? [`trailer:${label}`] : [];

export const AGENTS: AgentDef[] = [
  {
    id: 'copilot',
    queries: ['author:app/copilot-swe-agent'],
    evidence: (p) => [...authorIn(p, ['Copilot', 'copilot-swe-agent[bot]']), ...branchPrefix(p, 'copilot/')],
  },
  {
    id: 'codex',
    queries: ['"chatgpt.com/codex" in:body', 'head:codex'],
    evidence: (p) => [
      ...authorIn(p, ['chatgpt-codex-connector[bot]']),
      ...branchPrefix(p, 'codex/'),
      ...bodyHas(p, /chatgpt\.com\/codex/i, 'chatgpt.com/codex'),
    ],
  },
  {
    id: 'claude-code',
    queries: ['"Generated with Claude Code" in:body', 'author:app/claude'],
    evidence: (p) => [
      ...authorIn(p, ['claude[bot]']),
      ...bodyHas(p, /Generated with \[?Claude Code/i, 'Generated with Claude Code'),
      ...trailer(p, /^Co-Authored-By:\s*Claude\b/im, 'Co-Authored-By: Claude'),
    ],
  },
  {
    id: 'cursor',
    queries: ['head:cursor', '"Cursor Agent" in:body'],
    evidence: (p) => [
      ...authorIn(p, ['cursor[bot]']),
      ...branchPrefix(p, 'cursor/'),
      ...trailer(p, /^Co-authored-by:\s*Cursor Agent\b/im, 'Co-authored-by: Cursor Agent'),
    ],
  },
  {
    id: 'devin',
    queries: ['author:app/devin-ai-integration'],
    evidence: (p) => authorIn(p, ['devin-ai-integration[bot]']),
  },
  {
    id: 'jules',
    queries: ['author:app/google-labs-jules'],
    evidence: (p) => authorIn(p, ['google-labs-jules[bot]']),
  },
];

export function attribute(pr: PrFacts): { agent: AgentId; evidence: string[] } | { ambiguous: AgentId[] } | null {
  const hits = AGENTS.map((a) => ({ agent: a.id, evidence: a.evidence(pr) })).filter((h) => h.evidence.length > 0);
  if (hits.length === 0) return null;
  if (hits.length > 1) return { ambiguous: hits.map((h) => h.agent) };
  return hits[0]!;
}

export function extractModel(pr: PrFacts): string {
  for (const m of pr.commitMessages) {
    const match = /^Co-Authored-By:\s*(Claude[^<\n]*?)\s*</im.exec(m);
    if (match && match[1]!.trim() !== 'Claude') return match[1]!.trim();
  }
  return 'unknown';
}

export function hasAgentMarker(pr: PrFacts): boolean {
  return pr.authorType === 'Bot' || AGENTS.some((a) => a.evidence(pr).length > 0);
}
