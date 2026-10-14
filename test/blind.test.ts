import { describe, expect, it } from 'vitest';
import { MARKER_WORDS, scrub } from '../src/label/blind.js';

describe('scrub', () => {
  it('removes every agent marker', () => {
    const text = [
      'Fixes #12', '', '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
      'Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>', 'Co-authored-by: Cursor Agent <cursoragent@cursor.com>',
      'Task: https://chatgpt.com/codex/tasks/abc', 'Opened by Copilot on branch copilot/fix-12', 'devin-ai-integration[bot] and google-labs-jules[bot]',
      'Session: https://app.devin.ai/sessions/1 and https://jules.google.com/task/2', 'branch codex/x and cursor/y',
    ].join('\n');
    const out = scrub(text).toLowerCase();
    for (const w of MARKER_WORDS) expect(out).not.toContain(w);
    expect(out).toContain('fixes #12');
  });
});

describe('scrub model and vendor names', () => {
  it.each([
    ['Claude Opus 4.5', '[agent]'],
    ['Claude Sonnet 4', '[agent]'],
    ['Claude Haiku 3.5', '[agent]'],
    ['Opus 4.8', '[agent]'],
    ['GPT-5', '[agent]'],
    ['gpt-4o', '[agent]'],
    ['cursoragent', '[agent]'],
    ['claudecode', '[agent]'],
    ['Claude Code', '[agent]'],
  ])('replaces the whole phrase %s', (input, expected) => {
    expect(scrub(input)).toBe(expected);
  });

  it.each(['Anthropic', 'OpenAI', 'Gemini 2.5 Pro', 'Aider', 'noreply@anthropic.com'])('leaves no vendor word in %s', (input) => {
    const out = scrub(input).toLowerCase();
    for (const w of ['anthropic', 'openai', 'gemini', 'aider']) expect(out).not.toContain(w);
  });

  it('removes model words from MARKER_WORDS checks', () => {
    for (const w of ['anthropic', 'openai', 'gemini', 'aider', 'opus', 'sonnet', 'haiku', 'gpt-']) expect(MARKER_WORDS).toContain(w);
  });
});

describe('scrub line drops', () => {
  it.each([
    '+Co-authored-by: Claude <noreply@anthropic.com>',
    '- Co-authored-by: Copilot',
    '> Co-authored-by: Cursor Agent',
    '   Co-authored-by: Devin',
    '> Generated with [Claude Code](https://claude.com/claude-code)',
    ' Generated with [Claude Code](https://claude.com/claude-code)',
    'Done. Generated with',
  ])('drops diff- or quote-prefixed line %s', (line) => {
    const out = scrub(`keep\n${line}\nalso keep`);
    expect(out.split('\n')).toEqual(['keep', '', 'also keep']);
  });

  it('keeps the line count and numbering of the source when lines are dropped', () => {
    const t = 'a\n\nCo-authored-by: Claude <x>\nb\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\nc';
    const out = scrub(t).split('\n');
    expect(out.length).toBe(t.split('\n').length);
    expect(out[3]).toBe('b');
    expect(out[5]).toBe('c');
  });
});

describe('scrub words joined by underscores', () => {
  it.each([
    ['src/cursor_rules.ts', 'src/[agent]_rules.ts'],
    ['copilot_helper', '[agent]_helper'],
    ['test_claude_flow', 'test_[agent]_flow'],
    ['my_codex_task.py', 'my_[agent]_task.py'],
    ['devin_bot', '[agent]_bot'],
    ['jules_2', '[agent]_2'],
  ])('replaces %s', (input, expected) => {
    expect(scrub(input)).toBe(expected);
  });

  it('still leaves longer words alone', () => {
    expect(scrub('cursory recursor codexes')).toBe('cursory recursor codexes');
  });
});
