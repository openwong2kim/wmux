import fs from 'node:fs';
import { ENV_KEYS } from '../../shared/constants';
import { PANE_ACCOUNT_ENV_KEY, type PaneAccountVendor } from '../../shared/phonePaneAccount';
import { pwshQuote, type ResumeShell } from '../chat/v2/handoff';

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
const pinnable = (value: string | undefined): value is string => typeof value === 'string' && value !== '' && !value.includes('\0');

/**
 * `chat/launch` types the agent into the pane's interactive shell, whose rc
 * files may export another account over the pane's environment. For a pane
 * created with a chosen account (`paneAccount`), the launch of that vendor's
 * agent carries the account's key as a one-command assignment prefix
 * (`KEY='dir' claude …`), which zsh, bash and sh (the only shells a launch is
 * typed into) apply to the agent alone. Every other pane, and the other
 * vendor's agent, is typed exactly as before.
 */
export function withChosenAccountEnv(
  command: string,
  meta: { env: Record<string, string>; paneAccount?: { vendor: PaneAccountVendor } },
  agent: PaneAccountVendor,
  shell: ResumeShell = 'posix',
): string {
  if (meta.paneAccount?.vendor !== agent) return command;
  const key = PANE_ACCOUNT_ENV_KEY[agent];
  const dir = meta.env[key];
  if (shell === 'posix') return pinnable(dir) ? `${key}=${shellQuote(dir)} ${command}` : command;
  if (!pinnable(dir)) return command;
  // PowerShell has no one-command prefix, so the key is set in the shell first. A control
  // character would end the typed line early, so such a folder cannot be pinned at all.
  // eslint-disable-next-line no-control-regex -- refusing controls is the point
  if (/[\x00-\x1f\x7f]/.test(dir)) throw new Error('Unpinnable account folder');
  return `$env:${key} = ${pwshQuote(dir)}; ${command}`;
}

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
    .filter((key) => pinnable(env[key]))
    .map((key) => `${key}=${shellQuote(env[key])}`);
  return pins.length ? `export ${pins.join(' ')}; ${command}` : command;
}
