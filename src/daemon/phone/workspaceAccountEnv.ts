import fs from 'node:fs';
import { DesktopPhoneError, type DesktopPhoneBridge } from './DesktopPhoneBridge';
import { PaneAccountRefusalError } from './paneAccount';
import { getAccountsPath, isAccessibleDir } from '../../main/account/accountStore';
import { getWmuxDir } from '../config';
import { DESKTOP_ACCOUNT_ENV_COMMAND, PANE_ACCOUNT_ENV_KEY, type PaneAccountVendor } from '../../shared/phonePaneAccount';

type AccountKey = 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME';
const KEYS: readonly AccountKey[] = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'];
type Desktop = Pick<DesktopPhoneBridge, 'available' | 'request'> & Partial<Pick<DesktopPhoneBridge, 'supports'>>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * The binding read straight from `accounts.json`, for a daemon with no desktop
 * attached (a headless host).
 *
 * Only a file that does not exist (ENOENT) means "never configured", and only
 * then does the pane run on the default credential like any unbound workspace.
 * Everything else that leaves the binding unknown refuses: a read error, bad
 * JSON, a schema this daemon does not know, or a binding that names no valid
 * account. The desktop's AccountStore loads such a file as empty, which is
 * right for its own spawns but here would quietly run a bound workspace on the
 * wrong account. The primary file is read directly, never its `.bak`: an older
 * snapshot can carry an older binding. A bound directory that is gone refuses
 * with the same 409 the desktop's typed answer gives.
 */
function resolveHeadlessAccountKeys(
  workspaceId: string, omitVendor: PaneAccountVendor | undefined, dir: string,
): Partial<Record<AccountKey, string>> {
  const unreadable = () => PaneAccountRefusalError.of(503, 'account-store-unreadable');
  let text: string;
  try {
    text = fs.readFileSync(getAccountsPath(dir), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw unreadable();
  }
  let file: unknown;
  try { file = JSON.parse(text); } catch { throw unreadable(); }
  if (!isRecord(file) || file.version !== 1 || !Array.isArray(file.accounts) || !isRecord(file.bindings)) throw unreadable();
  if (!Object.prototype.hasOwnProperty.call(file.bindings, workspaceId)) return {};
  const binding = file.bindings[workspaceId];
  if (!isRecord(binding)) throw unreadable();
  const out: Partial<Record<AccountKey, string>> = {};
  for (const vendor of ['claude', 'codex'] as const) {
    if (vendor === omitVendor || binding[vendor] === undefined) continue;
    const accountId = binding[vendor];
    const account = typeof accountId === 'string'
      ? file.accounts.find((a): a is Record<string, unknown> => isRecord(a) && a.id === accountId)
      : undefined;
    if (!account || account.vendor !== vendor || typeof account.configDir !== 'string' || !account.configDir
      || account.configDir.includes('\0')) {
      throw unreadable();
    }
    if (!isAccessibleDir(account.configDir)) throw PaneAccountRefusalError.of(409, 'workspace-account-missing');
    out[PANE_ACCOUNT_ENV_KEY[vendor]] = account.configDir;
  }
  return out;
}

/**
 * The workspace's bound account directories, from the main-owned binding.
 *
 * A desktop that announced `accounts.envForAccount` also answers
 * `accounts.env` in a typed form, which says when a bound directory is gone
 * (`workspace-account-missing`) and can leave out one vendor: a pane that runs
 * on a chosen account does not depend on the binding it replaces. An older
 * desktop gets the original request, which fails outright on a missing
 * directory. Every bridge failure is a `DesktopPhoneError`. With no desktop
 * attached at all, the binding is read from disk instead.
 */
export async function resolveWorkspaceAccountKeys(
  workspaceId: string, desktop: Desktop | null, omitVendor?: PaneAccountVendor, accountsDir: string = getWmuxDir(),
): Promise<Partial<Record<AccountKey, string>>> {
  if (!desktop?.available) return resolveHeadlessAccountKeys(workspaceId, omitVendor, accountsDir);
  const typed = desktop.supports?.(DESKTOP_ACCOUNT_ENV_COMMAND) === true;
  if (omitVendor && !typed) throw new DesktopPhoneError('desktop-unavailable');
  const raw = await desktop.request('accounts.env', typed ? { workspaceId, typed: true, ...(omitVendor ? { omitVendor } : {}) } : { workspaceId });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DesktopPhoneError('desktop-request-failed');
  let env = raw as Record<string, unknown>;
  if (typed) {
    if (env.ok === false && env.error === 'workspace-account-missing') throw PaneAccountRefusalError.of(409, 'workspace-account-missing');
    if (env.ok !== true || !env.env || typeof env.env !== 'object' || Array.isArray(env.env)) throw new DesktopPhoneError('desktop-request-failed');
    env = env.env as Record<string, unknown>;
  }
  const out: Partial<Record<AccountKey, string>> = {};
  for (const key of KEYS) {
    if (omitVendor && key === PANE_ACCOUNT_ENV_KEY[omitVendor]) continue;
    const value = env[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value || value.includes('\0')) throw new DesktopPhoneError('desktop-request-failed');
    out[key] = value;
  }
  return out;
}

/** Resolve the main-owned binding before spawning, never inherit another pane's account. */
export async function workspaceAccountEnv(
  env: Record<string, string>, workspaceId: string, desktop: Desktop | null, omitVendor?: PaneAccountVendor, accountsDir?: string,
): Promise<Record<string, string>> {
  const resolved = await resolveWorkspaceAccountKeys(workspaceId, desktop, omitVendor, accountsDir);
  const next = { ...env };
  for (const key of KEYS) delete next[key];
  return { ...next, ...resolved };
}
