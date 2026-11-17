/**
 * The mark a spawn path puts on a pane's env for a bound account in WSL, and
 * the sign-in key such a pane reports (shared/wslAccountHome.ts has the rest).
 * No Node imports: the renderer reads the sign-in key too.
 */

export type AccountEnvKey = 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME';
export type AccountVendor = 'claude' | 'codex';

/**
 * Set by a spawn path on a pane's env: the account variables (comma-separated)
 * whose value came from an account (a workspace binding, a pane's chosen
 * account, a re-sign-in for an account). Only these get a Linux home in WSL; a
 * profile's or an inherited CLAUDE_CONFIG_DIR does not. It rides in the
 * persisted env, so a recovered pane keeps its Linux home.
 */
export const WSL_ACCOUNT_KEYS_ENV = 'WMUX_WSL_ACCOUNT_KEYS';

/** The distro a marked WSL pane runs in, set on its env by the WSL injection (never sent to Linux). */
export const WSL_ACCOUNT_DISTRO_ENV = 'WMUX_WSL_ACCOUNT_DISTRO';

export const ACCOUNT_ENV_KEYS: readonly AccountEnvKey[] = ['CLAUDE_CONFIG_DIR', 'CODEX_HOME'];

export const ACCOUNT_ENV_VENDOR: Record<AccountEnvKey, AccountVendor> = { CLAUDE_CONFIG_DIR: 'claude', CODEX_HOME: 'codex' };

export const ACCOUNT_VENDOR_ENV: Record<AccountVendor, AccountEnvKey> = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' };

/** The marked account variables, in a fixed order; anything unknown is ignored. */
export function parseWslAccountKeys(value: string | undefined): AccountEnvKey[] {
  const named = new Set((value ?? '').split(',').map((s) => s.trim()));
  return ACCOUNT_ENV_KEYS.filter((key) => named.has(key));
}

/**
 * Mark `keys` on `env` (in place) as account-sourced, or drop the marker when
 * none is left. Keys without a value in `env` are not marked.
 */
export function setWslAccountKeys(env: Record<string, string>, keys: Iterable<AccountEnvKey>): void {
  const wanted = new Set(keys);
  const marked = ACCOUNT_ENV_KEYS.filter((key) => wanted.has(key) && !!env[key]);
  if (marked.length) env[WSL_ACCOUNT_KEYS_ENV] = marked.join(',');
  else delete env[WSL_ACCOUNT_KEYS_ENV];
}

/**
 * The account variables of `env` that still hold the value `accountEnv` gave
 * them: a profile that set its own CLAUDE_CONFIG_DIR afterwards wins on Windows
 * and is not an account in WSL.
 */
export function accountSourcedKeys(env: Record<string, string>, accountEnv: Record<string, string> | undefined): AccountEnvKey[] {
  if (!accountEnv) return [];
  return ACCOUNT_ENV_KEYS.filter((key) => !!accountEnv[key] && env[key] === accountEnv[key]);
}

const WSL_AUTH_PREFIX = 'wsl:';
const DISTRO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * The sign-in key of an account a WSL pane runs on its Linux home: its distro
 * and its Windows folder, so it is told apart from the same account's Windows
 * panes (a working Windows pane says nothing about the Linux sign-in) and from
 * its home in another distro.
 */
export function wslAuthRef(distro: string, configDir: string): string {
  return `${WSL_AUTH_PREFIX}${distro}:${configDir}`;
}

export function parseWslAuthRef(value: string | null | undefined): { distro: string; configDir: string } | null {
  if (typeof value !== 'string' || !value.startsWith(WSL_AUTH_PREFIX)) return null;
  const rest = value.slice(WSL_AUTH_PREFIX.length);
  const colon = rest.indexOf(':');
  if (colon <= 0) return null;
  const distro = rest.slice(0, colon);
  const configDir = rest.slice(colon + 1);
  return DISTRO.test(distro) && configDir ? { distro, configDir } : null;
}

/**
 * The account `env` runs `key` on in WSL, as a sign-in key, or null when the
 * pane is not a marked WSL pane for it (the injection sets the distro only for
 * a WSL pane with a marked account).
 */
export function wslAccountAuthRef(env: Readonly<Record<string, string | undefined>> | undefined, key: AccountEnvKey): string | null {
  const dir = env?.[key]?.trim();
  const distro = env?.[WSL_ACCOUNT_DISTRO_ENV];
  if (!dir || !distro || !DISTRO.test(distro) || !parseWslAccountKeys(env?.[WSL_ACCOUNT_KEYS_ENV]).includes(key)) return null;
  return wslAuthRef(distro, dir);
}
