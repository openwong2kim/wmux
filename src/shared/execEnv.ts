// A process launched from the macOS GUI (Dock/Finder/Spotlight) inherits only
// launchd's minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) and does not inherit the
// Homebrew PATH (/opt/homebrew/bin, etc.) that ~/.zshrc·~/.zprofile set up — a
// well-known macOS-specific problem. Windows doesn't have this, because installing
// git registers PATH in the registry (system/user environment variables), which is
// inherited globally by every process.
//
// If execFile('git', …) runs seeing only this PATH, it can't find a Homebrew-installed
// git and fails quietly with ENOENT (callers treat "quiet absence" as a contract, so
// to the user the feature simply doesn't show up — owner-reported 2026-07-19, the cause
// of the branch-sync badge not appearing in the workspace sidebar on macOS).
//
// This is NOT git-specific: any external binary the GUI spawns (git, gh, npm,
// tailscale, …) hits the same wall. The same failure recurred with `tailscale`
// on 2026-07-27 because the fix lived here under a git-specific name and each
// new spawn site had to know to opt in. Hence the rule, stated once: EVERY
// execFile/spawn of an external binary from the GUI process passes
// `env: getExecEnv()`. Do not add a new spawn site without it.

import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { isLinux, isMac } from './platform';

/** Homebrew (Apple Silicon/Intel), per-user CLI installs, and system paths. */
const MAC_PATH_FALLBACKS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
];

let cachedEnv: NodeJS.ProcessEnv | null = null;

/**
 * Returns an env that corrects the case where passing `process.env` straight to
 * execFile is unsafe. On mac it appends the Homebrew/system paths; on mac and
 * Linux (a desktop session's PATH may not include what a shell rc adds) it
 * appends `~/.local/bin` (the conventional per-user CLI install dir) and
 * `~/.opencode/bin` (OpenCode's installer default). On Windows it returns
 * `process.env` as-is (no recompute).
 */
export function getExecEnv(): NodeJS.ProcessEnv {
  if (!isMac && !isLinux) return process.env;
  if (cachedEnv) return cachedEnv;
  cachedEnv = mergePath(process.env, []);
  return cachedEnv;
}

/** `first`, then the env's own PATH, then the static fallbacks (per-user ones
 *  under the env's own HOME); deduplicated. */
function mergePath(env: NodeJS.ProcessEnv, first: string[]): NodeJS.ProcessEnv {
  const home = env.HOME || os.homedir();
  const existing = (env.PATH || '').split(':').filter(Boolean);
  const merged = [...new Set([...first, ...existing, ...(isMac ? MAC_PATH_FALLBACKS : []), path.join(home, '.local', 'bin'),
    // OpenCode's official install script defaults to INSTALL_DIR=$HOME/.opencode/bin.
    path.join(home, '.opencode', 'bin')])];
  return { ...env, PATH: merged.join(':') };
}

// The static fallbacks cannot know a PATH entry that only the user's shell rc
// adds — e.g. an npm global prefix such as ~/.local/node/bin exported from
// ~/.zshrc, where `codex` is a `#!/usr/bin/env node` script that also needs the
// `node` living next to it. For agent launches only, the daemon asks the user's
// interactive login shell for its PATH. Deliberately NOT folded into
// getExecEnv(): that one is synchronous and backs every GUI spawn.
const LOGIN_PATH_MARK = '__WMUX_LOGIN_PATH__';
const LOGIN_SHELLS = new Set(['zsh', 'bash', 'sh']);
const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
export const LOGIN_PATH_TIMEOUT_MS = 5000;
export const LOGIN_PATH_RETRY_MS = 60_000;
let loginPath: string[] | null = null; // cached on success only
let loginTask: Promise<string[] | null> | null = null;
let loginFailedAt = -Infinity;

function loginShell(): string | undefined {
  let shell = process.env.SHELL;
  if (!shell) {
    try { shell = os.userInfo().shell ?? undefined; } catch { shell = undefined; }
  }
  return shell && path.isAbsolute(shell) && LOGIN_SHELLS.has(path.basename(shell)) ? shell : undefined;
}

/** The rc files run with only what a login needs: no tokens, WMUX_*, NODE_OPTIONS
 *  or ELECTRON_* reach whatever they start. */
function loginProbeEnv(shell: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: LAUNCHD_PATH, SHELL: shell, TERM: 'dumb' };
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && (['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG'].includes(key) || /^(LC|XDG)_/.test(key))) env[key] = value;
  }
  return env;
}

function probeLoginShell(shell: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    let out = '';
    let settled = false;
    // Own process group, so a timeout also takes down what the rc started.
    const child = spawn(shell, ['-ilc', `printf '${LOGIN_PATH_MARK}%s${LOGIN_PATH_MARK}' "$PATH"`],
      { env: loginProbeEnv(shell), stdio: ['ignore', 'pipe', 'ignore'], detached: true, windowsHide: true });
    const finish = (result: string[] | null, kill: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (kill && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
      }
      child.stdout?.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => finish(null, true), LOGIN_PATH_TIMEOUT_MS);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      out += chunk;
      // The markers separate PATH from whatever an interactive rc prints.
      const parts = out.split(LOGIN_PATH_MARK);
      if (parts.length >= 3) finish(parts[1].split(':').filter((dir) => path.isAbsolute(dir)), false);
      else if (out.length > 1024 * 1024) finish(null, true);
    });
    child.on('error', () => finish(null, false));
    // 'close' waits for stdout to drain; an rc child still holding it runs into the timeout.
    child.on('close', () => finish(null, false));
  });
}

/**
 * The interactive login shell's PATH (`$SHELL -ilc`), bounded by a timeout.
 * Only a success is cached for the process lifetime; after a failure (slow rc,
 * missing shell) the next call within LOGIN_PATH_RETRY_MS resolves null without
 * spawning, and a later one asks again. zsh/bash/sh only; any other shell
 * resolves to [] and the static fallbacks apply.
 */
export function resolveLoginShellPath(now: number = Date.now()): Promise<string[] | null> {
  if (loginPath) return Promise.resolve(loginPath);
  if (loginTask) return loginTask;
  if (!isMac && !isLinux) return Promise.resolve((loginPath = []));
  const shell = loginShell();
  if (!shell) return Promise.resolve((loginPath = []));
  if (now - loginFailedAt < LOGIN_PATH_RETRY_MS) return Promise.resolve(null);
  loginTask = probeLoginShell(shell).then((result) => {
    loginTask = null;
    if (result) loginPath = result;
    else loginFailedAt = now;
    return result;
  });
  return loginTask;
}

/**
 * `env` with its PATH set up for an agent-launch spawn: the login shell's PATH
 * first (what the user's terminal resolves `claude`/`codex`/`node` with), then
 * the env's own PATH, then the static fallbacks. Unlike getExecEnv() it keeps
 * the caller's env (a pane's, the Codex runtime's) instead of `process.env`.
 */
export async function agentExecEnv(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  if (!isMac && !isLinux) return env;
  return mergePath(env, (await resolveLoginShellPath()) ?? []);
}
