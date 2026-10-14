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
