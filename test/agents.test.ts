import { describe, expect, it } from 'vitest';
import { attribute, extractModel, hasAgentMarker, type PrFacts } from '../src/collect/agents.js';

const pr = (p: Partial<PrFacts>): PrFacts => ({
  author: 'alice', authorType: 'User', branch: 'fix-bug', body: '', commitMessages: ['fix bug'], ...p,
});

describe('agent attribution', () => {
  it('recognises each agent by its markers', () => {
    expect(attribute(pr({ author: 'Copilot', authorType: 'Bot', branch: 'copilot/fix-1' }))).toEqual({
      agent: 'copilot', evidence: ['author:Copilot', 'branch:copilot/'],
    });
    expect(attribute(pr({ branch: 'codex/add-x', body: 'https://chatgpt.com/codex/tasks/abc' }))).toEqual({
      agent: 'codex', evidence: ['branch:codex/', 'body:chatgpt.com/codex'],
    });
    expect(attribute(pr({ body: '🤖 Generated with [Claude Code](https://claude.com/claude-code)' }))).toEqual({
      agent: 'claude-code', evidence: ['body:Generated with Claude Code'],
    });
    expect(attribute(pr({ commitMessages: ['x\n\nCo-Authored-By: Claude <noreply@anthropic.com>'] }))).toEqual({
      agent: 'claude-code', evidence: ['trailer:Co-Authored-By: Claude'],
    });
    expect(attribute(pr({ branch: 'cursor/fix', commitMessages: ['x\n\nCo-authored-by: Cursor Agent <cursoragent@cursor.com>'] }))).toEqual({
      agent: 'cursor', evidence: ['branch:cursor/', 'trailer:Co-authored-by: Cursor Agent'],
    });
    expect(attribute(pr({ author: 'devin-ai-integration[bot]', authorType: 'Bot' }))).toEqual({
      agent: 'devin', evidence: ['author:devin-ai-integration[bot]'],
    });
    expect(attribute(pr({ author: 'google-labs-jules[bot]', authorType: 'Bot' }))).toEqual({
      agent: 'jules', evidence: ['author:google-labs-jules[bot]'],
    });
  });

  it('returns null for an unmarked human PR and flags PRs with two agents as ambiguous', () => {
    expect(attribute(pr({}))).toBeNull();
    expect(attribute(pr({ branch: 'codex/x', body: 'Generated with Claude Code' }))).toEqual({
      ambiguous: ['codex', 'claude-code'],
    });
  });

  it('extracts a model only when a marker names it', () => {
    expect(extractModel(pr({ commitMessages: ['x\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>'] }))).toBe('Claude Opus 4.8');
    expect(extractModel(pr({ commitMessages: ['x\n\nCo-Authored-By: Claude <noreply@anthropic.com>'] }))).toBe('unknown');
    expect(extractModel(pr({}))).toBe('unknown');
  });

  it('treats any agent marker or a bot author as marked', () => {
    expect(hasAgentMarker(pr({}))).toBe(false);
    expect(hasAgentMarker(pr({ author: 'renovate[bot]', authorType: 'Bot' }))).toBe(true);
    expect(hasAgentMarker(pr({ body: 'Generated with Claude Code' }))).toBe(true);
  });
});
