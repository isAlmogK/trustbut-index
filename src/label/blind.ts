/** Words that must not survive blinding (checked case-insensitively by the tests). */
export const MARKER_WORDS = [
  'claude', 'copilot', 'codex', 'cursor', 'devin', 'jules', 'chatgpt', 'generated with', 'co-authored-by', '🤖',
  'anthropic', 'openai', 'gemini', 'aider', 'opus', 'sonnet', 'haiku', 'gpt-',
];

// A line may start with indentation, then optionally a diff marker (+, -, space) or a quote marker (>).
const LINE_START = String.raw`^[ \t]*(?:[+\->][ \t]*)?`;
// Each dropped line keeps its newline, so line counts and numbering are preserved.
const LINE_DROPS = [
  new RegExp(`${LINE_START}.*co-authored-by\\b.*$`, 'gim'),
  new RegExp(`${LINE_START}.*\\bgenerated with\\b.*$`, 'gim'),
];
const URL_DROPS = [
  /https?:\/\/\S*(chatgpt\.com|claude\.(ai|com)|cursor\.(com|sh)|devin\.ai|jules\.google|anthropic\.com|openai\.com|aider\.chat|gemini\.google)\S*/gi,
];

// Alphanumeric boundaries instead of \b, so words joined by "_" (cursor_rules.ts, copilot_helper) still match.
const START = '(?<![A-Za-z0-9])';
const END = '(?![A-Za-z0-9])';
// Trailing version and model tokens that belong to a model name, e.g. " Opus 4.5" or " Code".
const TAIL = String.raw`(?:[ \t-]+(?:code|opus|sonnet|haiku|v?\d+(?:\.\d+)*)${END})*`;
const WORDS = new RegExp(
  `${START}(?:` +
    [
      String.raw`google-labs-jules${END}`,
      String.raw`claude[ \t-]*code${END}${TAIL}`,
      String.raw`claude${TAIL}`,
      String.raw`opus${TAIL}`,
      String.raw`sonnet${TAIL}`,
      String.raw`haiku${TAIL}`,
      String.raw`gpt(?:-?\d+(?:\.\d+)?[a-z0-9-]*|-[a-z0-9-]*)`,
      String.raw`cursor(?:[ \t-]*agent)?${END}`,
      String.raw`copilot(?:-swe-agent)?${END}`,
      String.raw`devin(?:-ai-integration)?${END}`,
      String.raw`(?:codex|jules|chatgpt|anthropic|openai|gemini|aider|co-authored-by)${END}`,
    ].join('|') +
    String.raw`)(?:\[bot\])?`,
  'gi',
);

export function scrub(text: string): string {
  let out = text;
  for (const re of LINE_DROPS) out = out.replace(re, '');
  for (const re of URL_DROPS) out = out.replace(re, '[link]');
  out = out.replace(/🤖/g, '');
  out = out.replace(WORDS, '[agent]');
  return out;
}
