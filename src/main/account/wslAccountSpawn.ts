// Which account variables of a WSL pane's resolved env an account decided,
// besides the workspace binding (shared/wslAccountMark accountSourcedKeys):
// a pane that names or rotates to an account (accountOverride), and a
// re-sign-in tab for an account a WSL pane reported signed out. Those panes
// run the account on its own home in the distro (shared/wslAccountHome.ts).

import { ACCOUNT_ENV_VENDOR, ACCOUNT_VENDOR_ENV, type AccountEnvKey } from '../../shared/wslAccountMark';
import { canonicalAccountFolder } from '../../shared/wslAccountHome';
import type { Account } from './accountStore';

const sameFolder = (a: string, b: string): boolean => canonicalAccountFolder(a) === canonicalAccountFolder(b);

export function paneAccountKeys(
  env: Readonly<Record<string, string>>,
  opts: {
    /** The account the pane runs on instead of the binding (named or rotated). */
    override?: Pick<Account, 'vendor' | 'configDir'>;
    /** The variable a re-sign-in tab asks to run as an account; unchecked input from the renderer. */
    requested?: unknown;
    /** The env the create supplied (the renderer's), which must name that account's folder. */
    supplied?: Readonly<Record<string, string>>;
    accounts: () => readonly Pick<Account, 'vendor' | 'configDir'>[];
  },
): AccountEnvKey[] {
  const keys: AccountEnvKey[] = [];
  const override = opts.override;
  if (override && env[ACCOUNT_VENDOR_ENV[override.vendor]] === override.configDir) keys.push(ACCOUNT_VENDOR_ENV[override.vendor]);
  const requested = opts.requested;
  if ((requested === 'CLAUDE_CONFIG_DIR' || requested === 'CODEX_HOME') && !keys.includes(requested)) {
    const dir = opts.supplied?.[requested];
    // Only a registered account's folder, and only while the pane still runs on it.
    if (dir && env[requested] === dir
      && opts.accounts().some((account) => account.vendor === ACCOUNT_ENV_VENDOR[requested] && sameFolder(account.configDir, dir))) {
      keys.push(requested);
    }
  }
  return keys;
}

/**
 * The refusal of a re-sign-in tab whose account cannot run on its own WSL home
 * (removed, or its folder no longer the pane's), or null. Opening it anyway
 * would land the sign-in in the distro's default home, for every unbound pane.
 */
export function requestedAccountRefusal(requested: unknown, keys: readonly AccountEnvKey[]): string | null {
  if (requested !== 'CLAUDE_CONFIG_DIR' && requested !== 'CODEX_HOME') return null;
  if (keys.includes(requested)) return null;
  return 'PTY_CREATE: this sign-in tab was not opened: its account is no longer registered here, so a sign-in in WSL would land in the distro\'s default account. Add the account again, then sign in.';
}
