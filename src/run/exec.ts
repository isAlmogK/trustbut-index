import { execa } from 'execa';
import { TIMEOUT_EXIT } from './status.js';

/** SIGKILL every process in the group led by `pid`; a group that is already gone is fine. */
function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // ESRCH: no process left in the group
  }
}

/**
 * Runs `bash -c cmd`, streaming output to this process and also returning it (stdout and stderr interleaved).
 * A timeout reports exit 124, like coreutils `timeout`.
 *
 * bash runs in its own process group. On timeout, and as soon as bash exits, the whole group is killed:
 * otherwise a child or background process that still holds the output pipes keeps the call waiting past the budget.
 */
export async function runShell(cmd: string, cwd: string, timeoutMs: number): Promise<{ exit: number; ms: number; output: string }> {
  const start = Date.now();
  const sub = execa('bash', ['-c', cmd], {
    cwd, reject: false, stdin: 'ignore', detached: true,
    stdout: ['pipe', 'inherit'], stderr: ['pipe', 'inherit'], all: true,
  });
  let exited = false;
  let timedOut = false;
  const timer = setTimeout(() => {
    if (!exited) timedOut = true;
    killGroup(sub.pid);
  }, Math.max(timeoutMs, 1));
  sub.nodeChildProcess.once('exit', () => {
    exited = true;
    killGroup(sub.pid);
  });
  const r = await sub;
  clearTimeout(timer);
  const exit = timedOut ? TIMEOUT_EXIT : (r.exitCode ?? 1);
  return { exit, ms: Date.now() - start, output: typeof r.all === 'string' ? r.all : '' };
}
