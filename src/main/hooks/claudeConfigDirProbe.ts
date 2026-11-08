import { spawn } from 'node:child_process';

/**
 * CLAUDE_CONFIG_DIR as a `claude` started from the user's shell sees it.
 *
 * The CLI and a pane inherit the shell's env, so they read it directly. The
 * app may not: a macOS or Linux GUI app is launched without the login shell's
 * profile, where most people set it. So main asks the login shell, in the
 * background: no TTY, stdin closed, a bounded wait, and only one marked stdout
 * line is read, so rc-file noise can't leak in. Windows apps inherit the
 * user's environment, so there is nothing to ask there.
 */

/** The background (boot) bound. */
export const PROBE_TIMEOUT_MS = 2000;
/**
 * The bound for a user-started Install. A heavy rc file (nvm, conda,
 * oh-my-zsh) competing with the app for CPU can take longer than the boot
 * bound, and a missed answer there writes the wrong folder.
 */
export const INSTALL_PROBE_TIMEOUT_MS = 5000;
const MARK = '__WMUX_CLAUDE_CONFIG_DIR__=';

/** Lines ended by a newline: a line still being written is not read. */
function completeLines(stdout: string): string[] {
  const lines = stdout.split(/\r?\n/);
  lines.pop();
  return lines;
}

/**
 * The shell's answer. `marked` is true when a complete line starts with the
 * mark; `value` is that line's value (the last one), undefined when empty.
 * No mark means the shell never answered (the bound, a crash), which is not
 * the same as answering "unset".
 */
export function parseProbeOutput(stdout: string): { marked: boolean; value: string | undefined } {
  let marked = false;
  let value: string | undefined;
  for (const line of completeLines(stdout)) {
    if (!line.startsWith(MARK)) continue;
    marked = true;
    value = line.slice(MARK.length).trim() || undefined;
  }
  return { marked, value };
}

export type ProbeRunner = (shell: string, args: string[], timeoutMs: number) => Promise<string>;

/**
 * Runs the login shell in its own session (detached: no controlling terminal,
 * so an interactive shell cannot take the tty's foreground from wmux), with
 * stdin closed and stderr dropped. Resolves with stdout as soon as a marked
 * line is complete (the same test parseProbeOutput uses), so an rc-spawned
 * agent that keeps the pipe open cannot hold the answer back; at the bound
 * with whatever came. Then the whole process group is killed.
 */
const runShell: ProbeRunner = (shell, args, timeoutMs) => new Promise((resolve) => {
  let out = '';
  let settled = false;
  let child: ReturnType<typeof spawn> | null = null;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    // Even after the shell exits: a job its rc files started in the background
    // stays in its group.
    if (child?.pid !== undefined) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    }
    resolve(out);
  };
  const timer = setTimeout(finish, timeoutMs);
  timer.unref?.();
  try {
    child = spawn(shell, args, { stdio: ['ignore', 'pipe', 'ignore'], detached: true, windowsHide: true });
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (out.length < 64 * 1024) out += chunk;
      if (parseProbeOutput(out).marked) finish();
    });
    child.on('error', finish);
    child.on('close', finish);
  } catch {
    finish();
  }
});

/**
 * `read` is false only when the login shell was asked and never answered:
 * then `value` is unknown, not unset.
 */
export interface ClaudeConfigDirRead {
  value: string | undefined;
  read: boolean;
}

/** An answer, kept for the session. A probe that got none is not kept. */
let answered: ClaudeConfigDirRead | null = null;
let inFlight: Promise<ClaudeConfigDirRead> | null = null;

function probeShell(runner: ProbeRunner, timeoutMs: number): Promise<ClaudeConfigDirRead> {
  const shell = process.env.SHELL || '/bin/sh';
  const run = (async (): Promise<ClaudeConfigDirRead> => {
    let stdout = '';
    try {
      stdout = await runner(shell, ['-lic', `printf '\\n${MARK}%s\\n' "$CLAUDE_CONFIG_DIR"`], timeoutMs);
    } catch { /* no answer */ }
    const { marked, value } = parseProbeOutput(stdout);
    if (marked) answered = { value, read: true };
    return { value, read: marked };
  })();
  inFlight = run;
  void run.finally(() => { if (inFlight === run) inFlight = null; });
  return run;
}

/**
 * CLAUDE_CONFIG_DIR for the app's own writes, with whether it could be read:
 * this process's env when set, else (macOS, Linux) the login shell's. A shell
 * answer is kept for the session; no answer within `timeoutMs` is not, so the
 * next caller asks again. A caller that finds a probe running waits for it,
 * and asks again with its own bound when that one got no answer. Never
 * rejects.
 */
export async function readClaudeConfigDirEnv(
  { runner = runShell, timeoutMs = PROBE_TIMEOUT_MS }: { runner?: ProbeRunner; timeoutMs?: number } = {},
): Promise<ClaudeConfigDirRead> {
  const own = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (own) return { value: own, read: true };
  if (process.platform === 'win32') return { value: undefined, read: true };
  if (answered) return answered;
  if (inFlight) {
    const shared = await inFlight;
    if (shared.read) return shared;
    if (answered) return answered;
  }
  return probeShell(runner, timeoutMs);
}

/** The value alone, within the background bound (undefined when unread). */
export async function claudeConfigDirEnv(runner?: ProbeRunner): Promise<string | undefined> {
  return (await readClaudeConfigDirEnv({ runner })).value;
}

/** Tests only. */
export function resetClaudeConfigDirProbe(): void {
  answered = null;
  inFlight = null;
}
