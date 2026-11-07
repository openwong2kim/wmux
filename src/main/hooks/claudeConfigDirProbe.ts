import { spawn } from 'node:child_process';

/**
 * CLAUDE_CONFIG_DIR as a `claude` started from the user's shell sees it.
 *
 * The CLI and a pane inherit the shell's env, so they read it directly. The
 * app may not: a macOS or Linux GUI app is launched without the login shell's
 * profile, where most people set it. So main asks the login shell once per
 * boot, in the background: no TTY, stdin closed, a bounded wait, and only one
 * marked stdout line is read, so rc-file noise can't leak in. Windows apps
 * inherit the user's environment, so there is nothing to ask there.
 */

export const PROBE_TIMEOUT_MS = 2000;
const MARK = '__WMUX_CLAUDE_CONFIG_DIR__=';

/** The value on the last marked line, or undefined when there is none or it is empty. */
export function parseProbeOutput(stdout: string): string | undefined {
  let value: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith(MARK)) value = line.slice(MARK.length).trim();
  }
  return value ? value : undefined;
}

export type ProbeRunner = (shell: string, args: string[], timeoutMs: number) => Promise<string>;

/** Runs the login shell with stdin closed and stderr dropped; resolves with stdout, '' on any failure. */
const runShell: ProbeRunner = (shell, args, timeoutMs) => new Promise((resolve) => {
  let out = '';
  let settled = false;
  const done = (value: string) => { if (!settled) { settled = true; resolve(value); } };
  try {
    const child = spawn(shell, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } done(''); }, timeoutMs);
    timer.unref?.();
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { if (out.length < 64 * 1024) out += chunk; });
    child.on('error', () => { clearTimeout(timer); done(''); });
    child.on('close', () => { clearTimeout(timer); done(out); });
  } catch {
    done('');
  }
});

let probe: Promise<string | undefined> | null = null;
let probed: string | undefined;

/**
 * CLAUDE_CONFIG_DIR for the app's own writes: this process's env when set,
 * else (macOS, Linux) the login shell's, asked once and cached. Never rejects;
 * resolves within the probe bound.
 */
export function claudeConfigDirEnv(runner: ProbeRunner = runShell): Promise<string | undefined> {
  const own = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (own) return Promise.resolve(own);
  if (process.platform === 'win32') return Promise.resolve(undefined);
  probe ??= (async () => {
    const shell = process.env.SHELL || '/bin/sh';
    const stdout = await runner(shell, ['-lic', `printf '\\n${MARK}%s\\n' "$CLAUDE_CONFIG_DIR"`], PROBE_TIMEOUT_MS);
    probed = parseProbeOutput(stdout);
    return probed;
  })();
  return probe;
}

/** Starts the probe at boot without waiting on it. */
export function startClaudeConfigDirProbe(): void {
  void claudeConfigDirEnv();
}

/** What is known right now, without waiting: this process's env, else a finished probe's answer. */
export function knownClaudeConfigDirEnv(): string | undefined {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || probed;
}

/** Tests only. */
export function resetClaudeConfigDirProbe(): void {
  probe = null;
  probed = undefined;
}
