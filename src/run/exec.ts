import { execa } from 'execa';
import { TIMEOUT_EXIT } from './status.js';

/**
 * Runs `bash -c cmd`, streaming output to this process and also returning it (stdout and stderr interleaved).
 * A timeout reports exit 124, like coreutils `timeout`.
 */
export async function runShell(cmd: string, cwd: string, timeoutMs: number): Promise<{ exit: number; ms: number; output: string }> {
  const start = Date.now();
  const r = await execa('bash', ['-c', cmd], {
    cwd, timeout: Math.max(timeoutMs, 1), reject: false, stdin: 'ignore',
    stdout: ['pipe', 'inherit'], stderr: ['pipe', 'inherit'], all: true,
  });
  const exit = r.timedOut ? TIMEOUT_EXIT : (r.exitCode ?? 1);
  return { exit, ms: Date.now() - start, output: typeof r.all === 'string' ? r.all : '' };
}
