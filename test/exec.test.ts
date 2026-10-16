import { describe, expect, it } from 'vitest';
import { runShell } from '../src/run/exec.js';

describe('runShell', () => {
  it('returns the exit code', async () => {
    expect((await runShell('exit 3', process.cwd(), 5000)).exit).toBe(3);
    expect((await runShell('true', process.cwd(), 5000)).exit).toBe(0);
  });
  it('maps a timeout to 124', async () => {
    expect((await runShell('sleep 5', process.cwd(), 200)).exit).toBe(124);
  });
  it('returns the output it streamed, stdout and stderr', async () => {
    const r = await runShell('echo out; echo err >&2; exit 1', process.cwd(), 5000);
    expect(r.exit).toBe(1);
    expect(r.output).toContain('out');
    expect(r.output).toContain('err');
  });
});
