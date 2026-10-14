/** Words that must not survive blinding (checked case-insensitively by the tests). */
export const MARKER_WORDS = ['claude', 'copilot', 'codex', 'cursor', 'devin', 'jules', 'chatgpt', 'generated with', 'co-authored-by', '🤖'];

const LINE_DROPS = [/^\s*co-authored-by:.*$/gim, /^.*generated with .*$/gim];
const URL_DROPS = [/https?:\/\/\S*(chatgpt\.com|claude\.(ai|com)|cursor\.(com|sh)|devin\.ai|jules\.google)\S*/gi];
const WORDS = /\b(claude(\s+code)?|copilot(-swe-agent)?|codex|cursor(\s+agent)?|devin(-ai-integration)?|jules|chatgpt|google-labs-jules)\b(\[bot\])?/gi;

export function scrub(text: string): string {
  let out = text;
  for (const re of LINE_DROPS) out = out.replace(re, '');
  for (const re of URL_DROPS) out = out.replace(re, '[link]');
  out = out.replace(/🤖/g, '');
  out = out.replace(WORDS, '[agent]');
  return out;
}
