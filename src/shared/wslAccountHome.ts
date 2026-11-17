/**
 * A bound workspace's agent account inside WSL.
 *
 * On Windows a pane in a bound workspace runs its agent on the account's own
 * folder (CLAUDE_CONFIG_DIR / CODEX_HOME). A WSL pane cannot use that folder:
 * it holds Windows-only hooks, MCP servers and notify commands that fail on
 * every Linux start, and its files are world-readable through DrvFs. So each
 * account gets its own home inside the distro, `~/.wmux<suffix>/accounts/
 * <vendor>-<key>`, created on first use and signed in there once. A sign-in in
 * one bound pane then changes that account only, never the distro's default
 * `~/.claude` / `~/.codex` that unbound WSL panes keep using.
 *
 * The key is derived from the account's Windows folder, which every spawn path
 * holds (the phone/web create has the folder, never the account id): the same
 * account gets the same Linux home from every path and after recovery. A moved
 * or renamed account folder therefore gets a new Linux home.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ACCOUNT_VENDOR_ENV, WSL_ACCOUNT_KEYS_ENV, parseWslAccountKeys, type AccountVendor } from './wslAccountMark';

export {
  ACCOUNT_ENV_KEYS, ACCOUNT_ENV_VENDOR, WSL_ACCOUNT_DISTRO_ENV, WSL_ACCOUNT_KEYS_ENV, accountSourcedKeys, parseWslAccountKeys, setWslAccountKeys,
  type AccountEnvKey, type AccountVendor,
} from './wslAccountMark';

/**
 * What an account folder shares with the vendor's default folder when it was
 * created with sharing on: linked directories (live) and copied files
 * (snapshot). provisionAccountDir uses it on Windows; the WSL bootstrap uses it
 * for a new Linux home, from the distro's own default folder.
 */
export const ACCOUNT_SHARE_MANIFEST: Record<AccountVendor, { linkDirs: readonly string[]; copyFiles: readonly string[] }> = {
  claude: { linkDirs: ['commands', 'skills', 'agents', 'plugins'], copyFiles: ['settings.json', 'CLAUDE.md'] },
  // Codex keeps settings and MCP servers in config.toml; its login (auth.json)
  // is never shared.
  codex: { linkDirs: ['prompts'], copyFiles: ['config.toml', 'AGENTS.md'] },
};

/** The Linux home's key for an account folder: 16 hex digits of its SHA-256, case- and separator-insensitive like Windows paths. */
export function wslAccountHomeKey(configDir: string): string {
  const canonical = path.win32.normalize(configDir.trim()).replace(/[\\/]+$/, '').toLowerCase();
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/** A data suffix that can be part of a Linux folder name (`.wmux<suffix>`). */
export function isWslSafeSuffix(suffix: string): boolean {
  return /^[A-Za-z0-9._-]{0,64}$/.test(suffix) && !suffix.includes('..');
}

/**
 * The Linux home of `env`'s account for `vendor` in a pane running as `user`,
 * or null when the pane has none (not marked, no folder, or a name that cannot
 * be a path). Mirrors the bootstrap's `$HOME/.wmux$WMUX_DATA_SUFFIX/accounts`,
 * with the same /home/<user> (or /root) the other WSL path rules assume.
 */
export function wslAccountLinuxHome(
  env: Readonly<Record<string, string | undefined>> | undefined,
  vendor: AccountVendor,
  user: string | undefined,
): string | null {
  const key = ACCOUNT_VENDOR_ENV[vendor];
  const dir = env?.[key];
  if (!env || !dir || !parseWslAccountKeys(env[WSL_ACCOUNT_KEYS_ENV]).includes(key)) return null;
  if (typeof user !== 'string' || !user || user.includes('/') || user === '.' || user === '..') return null;
  const suffix = env.WMUX_DATA_SUFFIX ?? '';
  if (!isWslSafeSuffix(suffix)) return null;
  return `${user === 'root' ? '/root' : `/home/${user}`}/.wmux${suffix}/accounts/${vendor}-${wslAccountHomeKey(dir)}`;
}

/**
 * Whether the account folder was created with sharing on: one of the vendor's
 * shared directories is a link (a junction on Windows) there, which is what
 * provisionAccountDir leaves. Accounts store no share flag of their own.
 */
export function accountFolderShares(configDir: string, vendor: AccountVendor): boolean {
  return ACCOUNT_SHARE_MANIFEST[vendor].linkDirs.some((name) => {
    try {
      return fs.lstatSync(path.join(configDir, name)).isSymbolicLink();
    } catch {
      return false;
    }
  });
}
