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

import { execFile } from 'node:child_process';
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

/** The env's own PATH first (a PATH that already resolves a binary keeps resolving
 *  it the same way), then `extra`, then the static fallbacks; deduplicated. */
function mergePath(env: NodeJS.ProcessEnv, extra: string[]): NodeJS.ProcessEnv {
  const existing = (env.PATH || '').split(':').filter(Boolean);
  const merged = [...new Set([...existing, ...extra, ...(isMac ? MAC_PATH_FALLBACKS : []), path.join(os.homedir(), '.local', 'bin'),
    // OpenCode's official install script defaults to INSTALL_DIR=$HOME/.opencode/bin.
    path.join(os.homedir(), '.opencode', 'bin')])];
  return { ...env, PATH: merged.join(':') };
}

// The static fallbacks cannot know a PATH entry that only the user's shell rc
// adds — e.g. an npm global prefix such as ~/.local/node/bin exported from
// ~/.zshrc, where `codex` is a `#!/usr/bin/env node` script that also needs the
// `node` living next to it. For agent launches only, the daemon asks the user's
// interactive login shell for its PATH once. Deliberately NOT folded into
// getExecEnv(): that one is synchronous and backs every GUI spawn.
const LOGIN_PATH_MARK = '__WMUX_LOGIN_PATH__';
const LOGIN_SHELLS = new Set(['zsh', 'bash', 'sh']);
let loginShellPath: string[] = [];
let loginShellPathTask: Promise<string[]> | null = null;

/**
 * Resolve the interactive login shell's PATH (`$SHELL -ilc`) once, bounded by a
 * timeout. Success and failure are both cached for the process lifetime, so a
 * slow or hanging rc file costs at most one timeout. Only zsh/bash/sh are
 * asked; any other shell resolves to [] and the static fallbacks apply.
 */
export function resolveLoginShellPath(): Promise<string[]> {
  if (loginShellPathTask) return loginShellPathTask;
  let shell = process.env.SHELL;
  if (!shell) {
    try { shell = os.userInfo().shell ?? undefined; } catch { shell = undefined; }
  }
  if ((!isMac && !isLinux) || !shell || !path.isAbsolute(shell) || !LOGIN_SHELLS.has(path.basename(shell))) {
    loginShellPathTask = Promise.resolve([]);
    return loginShellPathTask;
  }
  const loginShell = shell;
  loginShellPathTask = new Promise<string[]>((resolve) => {
    // The markers separate PATH from whatever an interactive rc prints.
    const child = execFile(loginShell, ['-ilc', `printf '${LOGIN_PATH_MARK}%s${LOGIN_PATH_MARK}' "$PATH"`],
      { env: process.env, timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        const parts = error ? [] : String(stdout).split(LOGIN_PATH_MARK);
        loginShellPath = parts.length >= 3 ? parts[1].split(':').filter((dir) => path.isAbsolute(dir)) : [];
        resolve(loginShellPath);
      });
    child.stdin?.end();
  });
  return loginShellPathTask;
}

/**
 * `env` with its PATH augmented for an agent-launch spawn: the env's own PATH,
 * then the login shell's PATH (once `resolveLoginShellPath()` has settled —
 * callers await it first), then the static fallbacks. Unlike getExecEnv() it
 * keeps the caller's env (a pane's, the Codex runtime's) instead of `process.env`.
 */
export function withAgentExecPath(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (!isMac && !isLinux) return env;
  return mergePath(env, loginShellPath);
}
