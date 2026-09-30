import fs from 'node:fs';
import { ENV_KEYS } from '../../shared/constants';

const ACCOUNT_KEYS = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'] as const;
const PHONE_PANE_ID = /^web-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Wrapper shells whose `-lc` profile can export these keys and whose syntax `export K='v';` is. */
const POSIX_STEMS = new Set(['bash', 'zsh', 'sh', 'dash', 'ksh']);

/**
 * A phone-created workspace pane, whose account keys the desktop resolved
 * (the workspace binding, or the account chosen for this pane). Only these
 * panes are touched here; every other pane spawns exactly as before.
 */
function isPhoneWorkspacePane(id: string, env: Record<string, string>): boolean {
  return PHONE_PANE_ID.test(id) && !!env[ENV_KEYS.WORKSPACE_ID];
}

/**
 * Before a phone workspace pane (re)spawns, drop an account key whose
 * directory is gone, with a warning, the same way the desktop resolves a
 * binding whose directory went missing: the CLI falls back to its default
 * credential instead of creating a fresh, logged-out config at the old path.
 * A first spawn never gets here with a missing directory (the create refuses
 * `account-directory-missing`); this is the recovery path.
 */
export function dropMissingAccountDirs(id: string, env: Record<string, string>, warn: (message: string) => void): void {
  if (!isPhoneWorkspacePane(id, env)) return;
  for (const key of ACCOUNT_KEYS) {
    const dir = env[key];
    if (dir === undefined) continue;
    let ok = false;
    try { ok = fs.statSync(dir).isDirectory(); } catch { /* gone */ }
    if (!ok) {
      delete env[key];
      warn(`[phone] ${id}: ${key} directory is gone; the pane falls back to the default credential`);
    }
  }
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * An exec unit runs `$SHELL -lc '<command>'`, and a login profile may export
 * `CLAUDE_CONFIG_DIR` / `CODEX_HOME` over the pane's environment, so the agent
 * would run on another account than the one the pane was created on. For a
 * phone workspace pane under a POSIX wrapper shell, the resolved keys are
 * exported again after the profile, immediately before the command. The
 * persisted command is untouched; this applies to every (re)spawn.
 */
export function pinAccountEnv(id: string, shellPath: string, command: string, env: Record<string, string>): string {
  if (!isPhoneWorkspacePane(id, env)) return command;
  const stem = (shellPath.split(/[\\/]/).pop() ?? '').toLowerCase().replace(/^-/, '');
  if (!POSIX_STEMS.has(stem)) return command;
  const pins = ACCOUNT_KEYS
    .filter((key) => typeof env[key] === 'string' && env[key] !== '' && !env[key].includes('\0'))
    .map((key) => `${key}=${shellQuote(env[key])}`);
  return pins.length ? `export ${pins.join(' ')}; ${command}` : command;
}
