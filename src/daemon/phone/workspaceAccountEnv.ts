import { DesktopPhoneError, type DesktopPhoneBridge } from './DesktopPhoneBridge';
import { PaneAccountRefusalError } from './paneAccount';
import { DESKTOP_ACCOUNT_ENV_COMMAND, PANE_ACCOUNT_ENV_KEY, type PaneAccountVendor } from '../../shared/phonePaneAccount';

type AccountKey = 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME';
const KEYS: readonly AccountKey[] = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'];
type Desktop = Pick<DesktopPhoneBridge, 'available' | 'request'> & Partial<Pick<DesktopPhoneBridge, 'supports'>>;

/**
 * The workspace's bound account directories, from the main-owned binding.
 *
 * A desktop that announced `accounts.envForAccount` also answers
 * `accounts.env` in a typed form, which says when a bound directory is gone
 * (`workspace-account-missing`) and can leave out one vendor: a pane that runs
 * on a chosen account does not depend on the binding it replaces. An older
 * desktop gets the original request, which fails outright on a missing
 * directory. Every bridge failure is a `DesktopPhoneError`.
 */
export async function resolveWorkspaceAccountKeys(
  workspaceId: string, desktop: Desktop | null, omitVendor?: PaneAccountVendor,
): Promise<Partial<Record<AccountKey, string>>> {
  if (!desktop?.available) throw new DesktopPhoneError('desktop-unavailable');
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
  env: Record<string, string>, workspaceId: string, desktop: Desktop | null, omitVendor?: PaneAccountVendor,
): Promise<Record<string, string>> {
  const resolved = await resolveWorkspaceAccountKeys(workspaceId, desktop, omitVendor);
  const next = { ...env };
  for (const key of KEYS) delete next[key];
  return { ...next, ...resolved };
}
