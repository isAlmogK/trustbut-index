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

  it('extracts a model only when a marker names it, and only for claude-code PRs', () => {
    expect(extractModel(pr({ commitMessages: ['x\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>'] }), 'claude-code')).toBe('Claude Opus 4.8');
    expect(extractModel(pr({ commitMessages: ['x\n\nCo-Authored-By: Claude <noreply@anthropic.com>'] }), 'claude-code')).toBe('unknown');
    expect(extractModel(pr({ commitMessages: ['x\n\nCo-Authored-By: Claude Code <noreply@anthropic.com>'] }), 'claude-code')).toBe('unknown');
    expect(extractModel(pr({ commitMessages: ['x\n\nCo-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>'] }), 'cursor')).toBe('unknown');
    expect(extractModel(pr({ commitMessages: ['x\n\nCo-Authored-By: Claude Dupont <claude@example.org>'] }), 'claude-code')).toBe('unknown');
    expect(extractModel(pr({}), 'claude-code')).toBe('unknown');
  });

  it('requires the Anthropic noreply address in a Claude trailer', () => {
    expect(attribute(pr({ commitMessages: ['x\n\nCo-Authored-By: Claude Dupont <claude@example.org>'] }))).toBeNull();
    expect(hasAgentMarker(pr({ commitMessages: ['x\n\nCo-Authored-By: Claude Dupont <claude@example.org>'] }))).toBe(false);
    expect(attribute(pr({ commitMessages: ['x\n\nCo-authored-by: Claude Sonnet 4.5 <noreply@anthropic.com>'] }))).toEqual({
      agent: 'claude-code', evidence: ['trailer:Co-Authored-By: Claude'],
    });
  });

  it('matches author logins case-insensitively', () => {
    expect(attribute(pr({ author: 'copilot', authorType: 'Bot' }))).toEqual({ agent: 'copilot', evidence: ['author:copilot'] });
    expect(attribute(pr({ author: 'Claude[bot]', authorType: 'Bot' }))).toEqual({ agent: 'claude-code', evidence: ['author:Claude[bot]'] });
  });

  it('treats any agent marker or a bot author as marked', () => {
    expect(hasAgentMarker(pr({}))).toBe(false);
    expect(hasAgentMarker(pr({ author: 'renovate[bot]', authorType: 'Bot' }))).toBe(true);
    expect(hasAgentMarker(pr({ body: 'Generated with Claude Code' }))).toBe(true);
  });
});
