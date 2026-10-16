/** Terminal colour and cursor codes. */
const ANSI = new RegExp(String.raw`\u001b\[[0-9;]*[A-Za-z]`, 'g');

/** The end of a command's output for run.json: the last `maxLines` lines and at most `maxChars` characters, without colour codes. */
export function tail(output: string, maxLines = 50, maxChars = 4000): string {
  const lines = output.replace(ANSI, '').replace(/\s+$/, '').split(/\r?\n/).slice(-maxLines);
  while (lines.length > 1 && lines.join('\n').length > maxChars) lines.shift();
  const text = lines.join('\n');
  return text.length > maxChars ? text.slice(-maxChars) : text;
}
