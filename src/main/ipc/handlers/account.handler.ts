// ─── Multi-Account — renderer → main IPC (registry CRUD + bindings) ──────────
//
// Renderer-only trust boundary (ipcMain.handle): main owns accounts.json and is
// the ONLY place spawn env is resolved. The renderer edits names/bindings and
// drives onboarding, but never sees or writes a token.

import { clipboard, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { isMainWindowSender } from '../mainWindowSender';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { IPC } from '../../../shared/constants';
import { wrapHandler } from '../wrapHandler';
import { getWmuxDir } from '../../../daemon/config';
import {
  getAccountStore,
  canonicalizeConfigDir,
  AccountError,
  isUnsafeKey,
  type Vendor,
  type Account,
} from '../../account/accountStore';
import { copiesSettingsJson, provisionAccountDir, type ProvisionResult } from '../../account/accountProvision';
import { envClaudeConfigDir } from '../../../shared/claudeConfigTargets';
import { claudeConfigDirEnv } from '../../hooks/claudeConfigDirProbe';
import { installHooksIntoNewAccount } from './hooksBridge.handler';
import { loadClaudeCredential, credentialFingerprint } from '../../claude/claudeCredential';
import { ACCOUNT_VAULT_PER_ACCOUNT_MAX, appAccountVault, vendorOfAuthName, type AccountVaultSetResult } from '../../account/accountVault';
import { markClaudeOnboardingDone } from '../../account/claudeOnboardingFlag';

/** The vault name a Claude account signs in with (`claude setup-token`). */
const CLAUDE_TOKEN_NAME = 'CLAUDE_CODE_OAUTH_TOKEN';
/** How a `claude setup-token` token starts. */
const CLAUDE_TOKEN_PREFIX = 'sk-ant-oat';
/** The vendor an account added from a token belongs to. */
const TOKEN_VENDOR: Vendor = 'claude';

function isVendor(v: unknown): v is Vendor {
  return v === 'claude' || v === 'codex';
}

function assertString(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v) throw new AccountError('invalid', `${field} is required`);
  return v;
}

/** workspaceId / accountId reach here from the renderer — reject prototype-
 *  pollution keys before they ever index the store's binding maps. */
function assertSafeId(v: unknown, field: string): string {
  const s = assertString(v, field);
  if (isUnsafeKey(s)) throw new AccountError('invalid', `invalid ${field}`);
  return s;
}

/**
 * Capability-bind a credential-status read: the configDir must be either a
 * registered account's dir OR under the wmux-owned `accounts/` root (an
 * onboarding-provisioned dir). Otherwise a compromised renderer could force
 * unbounded reads of arbitrary token-bearing files anywhere on disk (Codex
 * review P1). Returns the canonical dir, or throws.
 */
function assertReadableAccountDir(configDir: string): string {
  const canonical = path.resolve(configDir);
  const registered = getAccountStore().listAccounts().some((a) => a.configDir === canonical);
  if (!registered && !isUnderAccountsRoot(canonical)) {
    throw new AccountError('invalid', 'config directory is not an account directory');
  }
  return canonical;
}

/** True when `dir` is strictly inside the wmux-owned `<wmuxDir>/accounts` root. */
function isUnderAccountsRoot(dir: string): boolean {
  const accountsRoot = path.resolve(getWmuxDir(), 'accounts');
  // Onboarding hands out the realpath'd dir, so also accept the realpath'd root
  // (e.g. a symlinked home directory).
  let realRoot = accountsRoot;
  try { realRoot = fs.realpathSync.native(accountsRoot); } catch { /* root not created yet */ }
  return [accountsRoot, realRoot].some((root) => {
    const rel = path.relative(root, dir);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
}

export interface CredentialStatus {
  loggedIn: boolean;
  /** claude only: subscription tier when known (pro/max/team). */
  subscriptionType?: string | null;
  /** why not logged in / unsupported, for the UI. */
  detail?: string;
  /** Non-secret fingerprint of the stored credential (first 16 hex of sha256
   *  over the raw blob, computed here in main). Changes whenever the credential
   *  is rewritten, so a re-login can detect a FRESH login instead of passing on
   *  the stale credential it replaces. null when not logged in. */
  stamp?: string | null;
}

/** Resolve login status + tier for one account's config dir. */
async function credentialStatus(vendor: Vendor, configDir: string): Promise<CredentialStatus> {
  if (vendor === 'codex') {
    // Codex has no public usage API in v1; login = auth.json presence in CODEX_HOME.
    let raw: string | null = null;
    try { raw = fs.readFileSync(path.join(configDir, 'auth.json'), 'utf8'); } catch { /* absent */ }
    return { loggedIn: raw !== null, stamp: raw !== null ? credentialFingerprint(raw) : null };
  }
  const res = await loadClaudeCredential(configDir);
  if (res.ok) {
    return { loggedIn: true, subscriptionType: res.credential.subscriptionType, stamp: res.credential.fingerprint ?? null };
  }
  return { loggedIn: false, detail: res.reason };
}

export interface AccountRow extends Account {
  status: CredentialStatus;
  /** Copy-able fallback for users who log in from their own terminal. */
  loginCommand: string;
  /** A Claude account whose vault holds a long-lived token: when it was saved,
   *  and whether this machine can decrypt it. Never the value. */
  tokenSignIn?: { createdAt: number; usable: boolean };
  /** How many values the account's vault holds (0 when it cannot be read). */
  vaultCount: number;
}

/** How many values an account's vault holds. */
function vaultCountOf(a: Account): number {
  try {
    return appAccountVault().list(a.id).length;
  } catch {
    return 0;
  }
}

/** The token sign-in metadata of a Claude account, if its vault holds one. */
function tokenSignInOf(a: Account): AccountRow['tokenSignIn'] {
  if (vendorOfAuthName(CLAUDE_TOKEN_NAME) !== a.vendor) return undefined;
  try {
    const entry = appAccountVault().list(a.id).find((e) => e.name === CLAUDE_TOKEN_NAME);
    return entry ? { createdAt: entry.createdAt, usable: entry.usable } : undefined;
  } catch {
    return undefined;
  }
}

/** Build the platform-correct, properly-escaped, process-scoped login command
 *  for a vendor + config dir (Codex/GLM review: was PowerShell-only + wrong
 *  codex subcommand + broke on quoted paths). Generated in MAIN because the
 *  renderer can't reliably see process.platform. */
function buildLoginCommand(vendor: Vendor, configDir: string): string {
  const win = process.platform === 'win32';
  if (win) {
    // PowerShell single-quote: escape ' by doubling it. Env set is scoped to
    // the current shell process, not persisted.
    const p = configDir.replace(/'/g, "''");
    return vendor === 'codex'
      ? `$env:CODEX_HOME='${p}'; codex login`
      : `$env:CLAUDE_CONFIG_DIR='${p}'; claude auth login`;
  }
  // POSIX: inline VAR=... prefix scopes the var to just this command. Escape '
  // by closing/reopening the quote.
  const p = configDir.replace(/'/g, `'\\''`);
  return vendor === 'codex'
    ? `CODEX_HOME='${p}' codex login`
    : `CLAUDE_CONFIG_DIR='${p}' claude auth login`;
}

export interface OnboardPrepareResult {
  configDir: string;
  linked: string[];
  copied: string[];
  loginCommand: string;
}

/**
 * Provision an isolated config dir for a NEW account (hybrid share when
 * `share`), with wmux's hooks installed, and return its canonical path: the
 * same string ACCOUNT_ADD stores. `created` (the folder's identity) is set
 * only when this call made the folder; a rollback leaves any other alone.
 */
async function provisionNewAccountDir(vendor: Vendor, share: boolean): Promise<{ provisioned: ProvisionResult; created: DirIdentity | null }> {
  const configDir = path.join(getWmuxDir(), 'accounts', `${vendor}-${randomUUID().slice(0, 8)}`);
  const existed = fs.existsSync(configDir);
  // An account that keeps Claude's settings.json shares from the folder
  // Claude itself reads:
  // CLAUDE_CONFIG_DIR when set, else ~/.claude.
  const sourceDir = copiesSettingsJson(vendor) ? envClaudeConfigDir(await claudeConfigDirEnv()).dir ?? undefined : undefined;
  const result = provisionAccountDir({ configDir, vendor, share, sourceDir });
  // wmux's hooks there too, when the primary folder has them (its copied
  // settings may predate them, or there was no copy at all).
  if (copiesSettingsJson(vendor)) {
    try {
      const hooks = await installHooksIntoNewAccount(configDir);
      if (hooks && !hooks.ok) console.warn(`[account] wmux hooks not installed in the new account: ${hooks.error}`);
    } catch (err) {
      console.warn('[account] wmux hooks not installed in the new account:', err);
    }
  }
  // Hand out the same canonical string ACCOUNT_ADD will store: the login
  // tab exports it as CLAUDE_CONFIG_DIR and the macOS keychain item is keyed
  // on that exact string, so every later read must use the identical path.
  const canonical = canonicalizeConfigDir(result.configDir);
  return { provisioned: { ...result, configDir: canonical }, created: existed ? null : dirIdentity(canonical) };
}

/** A directory's device and inode, read without following a link (bigint:
 *  Windows file ids exceed 2^53). Null when the path is not a real directory. */
type DirIdentity = { dev: bigint; ino: bigint };
function dirIdentity(dir: string): DirIdentity | null {
  try {
    const st = fs.lstatSync(dir, { bigint: true });
    return st.isDirectory() && !st.isSymbolicLink() ? { dev: st.dev, ino: st.ino } : null;
  } catch {
    return null;
  }
}

function sameDir(dir: string, expected: DirIdentity): boolean {
  const now = dirIdentity(dir);
  return !!now && now.dev === expected.dev && now.ino === expected.ino;
}

/** Remove a link itself, never its target. A directory link on Windows (a
 *  junction or directory symlink) is dropped with a non-recursive rmdir, which
 *  removes only the reparse point. */
function removeLinkOnly(p: string): void {
  if (process.platform === 'win32') {
    let pointsAtDir = false;
    try { pointsAtDir = fs.statSync(p).isDirectory(); } catch { /* dangling link */ }
    if (pointsAtDir) {
      fs.rmdirSync(p);
      return;
    }
  }
  fs.unlinkSync(p);
}

/**
 * Undo a folder provisionNewAccountDir created. Only what provisioning puts
 * there is removed: each link (the link only, never followed) and each plain
 * file directly inside, then the folder itself. Nothing is removed
 * recursively: a real subdirectory is left in place, so the folder stays and
 * a warning says so — a leftover folder is harmless, a deleted shared target
 * is not. Nothing outside `<wmuxDir>/accounts` is touched, and nothing at all
 * when the path is no longer the directory provisioning made (replaced by a
 * link, a junction or another folder): readdir would follow a link.
 */
function discardProvisionedDir(configDir: string, identity: DirIdentity): void {
  if (!isUnderAccountsRoot(configDir)) return;
  if (!sameDir(configDir, identity)) {
    console.warn(`[account] the unused account folder ${configDir} was replaced since it was made; left as it is`);
    return;
  }
  try {
    for (const entry of fs.readdirSync(configDir)) {
      const p = path.join(configDir, entry);
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) removeLinkOnly(p);
      else if (st.isFile()) fs.unlinkSync(p);
    }
    // Fails (and keeps the folder) when anything was left above.
    if (!sameDir(configDir, identity)) throw new Error('replaced while it was being emptied');
    fs.rmdirSync(configDir);
  } catch (err) {
    console.warn(`[account] could not remove the unused account folder ${configDir}: ${String(err)}`);
  }
}

type ClipboardRefusal = Extract<AccountVaultSetResult, { ok: false }>;

/** The clipboard's text, read here in main, or a refusal when it does not
 *  start with `expectPrefix` (when one is given). Never logged. */
async function readClipboardValue(expectPrefix: unknown): Promise<{ ok: true; value: string } | ClipboardRefusal> {
  const value = (await clipboard.readText()).trim();
  if (typeof expectPrefix === 'string' && expectPrefix && !value.startsWith(expectPrefix)) {
    return { ok: false, code: 'prefix_mismatch', message: `The clipboard does not start with "${expectPrefix}", so nothing was saved.` };
  }
  return { ok: true, value };
}

type VaultSaveResult = AccountVaultSetResult & { clipboardCleared?: boolean; clipboardCleanupFailed?: true; onboardingWarning?: string };

/**
 * Save a clipboard value to an account's vault. The clipboard is cleared only
 * if it still holds what was saved, so text copied since is not lost; a
 * failed clear is reported (`clipboardCleanupFailed`), never a failed save. A Claude
 * token is read only once first-run setup is marked done in the account's
 * folder; a refusal leaves the token saved and says why. `inject`, when
 * given, is saved in the same write (AccountVault.set's default otherwise).
 */
async function saveClipboardValue(accountId: string, name: unknown, value: string, inject?: boolean): Promise<VaultSaveResult> {
  const result = appAccountVault().set(accountId, name, value, inject === undefined ? {} : { inject });
  if (!result.ok) return result;
  let clipboardCleared = false;
  let clipboardCleanupFailed = false;
  try {
    if ((await clipboard.readText()).trim() === value) {
      await clipboard.clear();
      clipboardCleared = true;
    }
  } catch {
    clipboardCleanupFailed = true;
  }
  let onboardingWarning: string | undefined;
  const account = getAccountStore().getAccount(accountId);
  if (name === CLAUDE_TOKEN_NAME && account && tokenSignInOf(account)) {
    const flag = markClaudeOnboardingDone(account.configDir, path.resolve(getWmuxDir(), 'accounts'));
    if (!flag.ok) onboardingWarning = flag.message;
  }
  return {
    ...result,
    clipboardCleared,
    ...(clipboardCleanupFailed ? { clipboardCleanupFailed: true as const } : {}),
    ...(onboardingWarning ? { onboardingWarning } : {}),
  };
}

export type AddWithTokenResult =
  | { ok: true; account: Account; clipboardCleared: boolean; clipboardCleanupFailed?: true; onboardingWarning?: string; groupFailed?: boolean }
  | ClipboardRefusal;

export function registerAccountHandlers(getWindow: () => BrowserWindow | null = () => null): () => void {
  const channels = [
    IPC.ACCOUNT_LIST,
    IPC.ACCOUNT_ONBOARD_PREPARE,
    IPC.ACCOUNT_ADD,
    IPC.ACCOUNT_RENAME,
    IPC.ACCOUNT_SET_GROUP,
    IPC.ACCOUNT_REMOVE,
    IPC.ACCOUNT_SET_BINDING,
    IPC.ACCOUNT_CREDENTIAL_STATUS,
    IPC.ACCOUNT_VAULT_LIST,
    IPC.ACCOUNT_VAULT_SAVE_CLIPBOARD,
    IPC.ACCOUNT_VAULT_GENERATE,
    IPC.ACCOUNT_VAULT_SET_INJECT,
    IPC.ACCOUNT_VAULT_DELETE,
    IPC.ACCOUNT_ADD_WITH_TOKEN,
  ];
  for (const c of channels) ipcMain.removeHandler(c);

  // List accounts + bindings, each row annotated with live credential status.
  ipcMain.handle(IPC.ACCOUNT_LIST, wrapHandler(IPC.ACCOUNT_LIST, async () => {
    // No store.load() here: main is the single writer and mutate() keeps the
    // cache current, so a re-load would only risk reading a mid-write file and
    // momentarily reverting the cache (GLM review). Read the cached snapshot.
    const store = getAccountStore();
    const accounts = store.listAccounts();
    const rows: AccountRow[] = await Promise.all(
      accounts.map(async (a) => ({
        ...a,
        status: await credentialStatus(a.vendor, a.configDir),
        loginCommand: buildLoginCommand(a.vendor, a.configDir),
        tokenSignIn: tokenSignInOf(a),
        vaultCount: vaultCountOf(a),
      })),
    );
    return { accounts: rows, bindings: store.getBindings() };
  }));

  // Provision an isolated config dir for a NEW account (hybrid share by
  // default), returning the path the renderer points a login pane at. The
  // account is NOT registered yet — the renderer commits ACCOUNT_ADD after login.
  ipcMain.handle(IPC.ACCOUNT_ONBOARD_PREPARE, wrapHandler(IPC.ACCOUNT_ONBOARD_PREPARE,
    async (_e, args: { vendor: unknown; share?: unknown }): Promise<OnboardPrepareResult> => {
      if (!isVendor(args?.vendor)) throw new AccountError('invalid', 'invalid vendor');
      const share = args.share !== false; // default: hybrid share ON
      const { provisioned } = await provisionNewAccountDir(args.vendor, share);
      return { ...provisioned, loginCommand: buildLoginCommand(args.vendor, provisioned.configDir) };
    }));

  // Register an account (post-login). configDir is canonicalized + deduped in
  // the store.
  ipcMain.handle(IPC.ACCOUNT_ADD, wrapHandler(IPC.ACCOUNT_ADD,
    async (_e, args: { name: unknown; vendor: unknown; configDir: unknown }) => {
      const name = assertString(args?.name, 'name');
      if (!isVendor(args?.vendor)) throw new AccountError('invalid', 'invalid vendor');
      const configDir = assertString(args?.configDir, 'configDir');
      return getAccountStore().addAccount({ name, vendor: args.vendor, configDir });
    }));

  ipcMain.handle(IPC.ACCOUNT_RENAME, wrapHandler(IPC.ACCOUNT_RENAME,
    async (_e, args: { id: unknown; name: unknown }) => {
      await getAccountStore().renameAccount(assertString(args?.id, 'id'), assertString(args?.name, 'name'));
      return { ok: true };
    }));

  // '' moves the account out of its group; the store validates the name.
  ipcMain.handle(IPC.ACCOUNT_SET_GROUP, wrapHandler(IPC.ACCOUNT_SET_GROUP,
    async (_e, args: { id: unknown; group: unknown }) => {
      if (typeof args?.group !== 'string') throw new AccountError('invalid', 'group is required');
      await getAccountStore().setAccountGroup(assertString(args.id, 'id'), args.group);
      return { ok: true };
    }));

  // Remove = unregister only (never deletes the dir). Returns affected workspaces.
  ipcMain.handle(IPC.ACCOUNT_REMOVE, wrapHandler(IPC.ACCOUNT_REMOVE,
    async (_e, args: { id: unknown }) => {
      const id = assertString(args?.id, 'id');
      const affected = await getAccountStore().removeAccount(id);
      // Its vault goes with it; a failed write is dropped at the next load.
      try { appAccountVault().deleteAccount(id); } catch { /* best-effort */ }
      return { ok: true, affectedWorkspaceIds: affected };
    }));

  ipcMain.handle(IPC.ACCOUNT_SET_BINDING, wrapHandler(IPC.ACCOUNT_SET_BINDING,
    async (_e, args: { workspaceId: unknown; vendor: unknown; accountId?: unknown }) => {
      const workspaceId = assertSafeId(args?.workspaceId, 'workspaceId');
      if (!isVendor(args?.vendor)) throw new AccountError('invalid', 'invalid vendor');
      // Only `undefined`/absent means unbind. A present-but-non-string accountId
      // (null, number, object) is malformed and rejected — NOT silently treated
      // as an unbind that could clear an existing binding (Codex review P2).
      let accountId: string | undefined;
      if (args && 'accountId' in args && args.accountId !== undefined && args.accountId !== null) {
        accountId = assertSafeId(args.accountId, 'accountId');
      }
      await getAccountStore().setBinding(workspaceId, args.vendor, accountId);
      return { ok: true };
    }));

  // Poll target during onboarding (login-completion detection) + refresh rows.
  // configDir is capability-bound to account dirs (no arbitrary-file reads).
  ipcMain.handle(IPC.ACCOUNT_CREDENTIAL_STATUS, wrapHandler(IPC.ACCOUNT_CREDENTIAL_STATUS,
    async (_e, args: { vendor: unknown; configDir: unknown }): Promise<CredentialStatus> => {
      if (!isVendor(args?.vendor)) throw new AccountError('invalid', 'invalid vendor');
      const dir = assertReadableAccountDir(assertString(args?.configDir, 'configDir'));
      return credentialStatus(args.vendor, dir);
    }));

  // ── Account vault (accountVault.ts). No value crosses to the renderer:
  // the clipboard is read here, and replies carry names and metadata only.
  // Only the main window's top frame may touch the vault, as for bot secrets.
  const assertMainWindow = (e: IpcMainInvokeEvent): void => {
    if (!isMainWindowSender(e, getWindow())) throw new AccountError('invalid', 'not allowed from this window');
  };
  const knownAccount = (e: IpcMainInvokeEvent, v: unknown): string => {
    assertMainWindow(e);
    const id = assertSafeId(v, 'accountId');
    if (!getAccountStore().getAccount(id)) throw new AccountError('not-found', 'no such account');
    return id;
  };
  ipcMain.handle(IPC.ACCOUNT_VAULT_LIST, wrapHandler(IPC.ACCOUNT_VAULT_LIST,
    async (e, args: { accountId: unknown }) => {
      const vault = appAccountVault();
      const entries = vault.list(knownAccount(e, args?.accountId));
      // What the Settings list needs to say before a save is tried: the
      // per-account limit, and why nothing can be saved here, if so.
      return { ok: true, entries, max: ACCOUNT_VAULT_PER_ACCOUNT_MAX, cannotStore: vault.storeRefusal() };
    }));

  // Clipboard → vault (saveClipboardValue).
  ipcMain.handle(IPC.ACCOUNT_VAULT_SAVE_CLIPBOARD, wrapHandler(IPC.ACCOUNT_VAULT_SAVE_CLIPBOARD,
    async (e, args: { accountId: unknown; name: unknown; expectPrefix?: unknown; inject?: unknown }): Promise<VaultSaveResult> => {
      const accountId = knownAccount(e, args?.accountId);
      const inject = args?.inject;
      if (inject !== undefined && typeof inject !== 'boolean') throw new AccountError('invalid', 'inject must be a boolean');
      const read = await readClipboardValue(args?.expectPrefix);
      if (!read.ok) return read;
      return saveClipboardValue(accountId, args?.name, read.value, inject);
    }));

  // A new Claude account straight from a `claude setup-token` token, all or
  // nothing: the clipboard is checked before anything is created, and a failed
  // registration or vault save removes the account and the folder again.
  ipcMain.handle(IPC.ACCOUNT_ADD_WITH_TOKEN, wrapHandler(IPC.ACCOUNT_ADD_WITH_TOKEN,
    async (e, args: { name: unknown; share?: unknown; group?: unknown }): Promise<AddWithTokenResult> => {
      assertMainWindow(e);
      const name = assertString(args?.name, 'name');
      const read = await readClipboardValue(CLAUDE_TOKEN_PREFIX);
      if (!read.ok) return read;
      const store = getAccountStore();
      const { provisioned, created } = await provisionNewAccountDir(TOKEN_VENDOR, args?.share !== false);
      // Unregister first, so no account is left pointing at a removed folder;
      // if that fails, the folder stays.
      const rollBack = async (accountId: string | undefined): Promise<void> => {
        if (accountId) {
          try {
            await store.removeAccount(accountId);
          } catch (err) {
            console.warn('[account] could not remove the half-added account:', err);
            return;
          }
          // A token saved before a later step threw goes with the account.
          try { appAccountVault().deleteAccount(accountId); } catch { /* best-effort, as in ACCOUNT_REMOVE */ }
        }
        if (created) discardProvisionedDir(provisioned.configDir, created);
      };
      let account: Account | undefined;
      try {
        account = await store.addAccount({ name, vendor: TOKEN_VENDOR, configDir: provisioned.configDir });
        // As after a browser login: a group that does not stick is a warning.
        let groupFailed = false;
        if (typeof args?.group === 'string' && args.group) {
          try { await store.setAccountGroup(account.id, args.group); } catch { groupFailed = true; }
        }
        const saved = await saveClipboardValue(account.id, CLAUDE_TOKEN_NAME, read.value);
        if (!saved.ok) {
          await rollBack(account.id);
          return saved;
        }
        return {
          ok: true,
          account: store.getAccount(account.id) ?? account,
          clipboardCleared: saved.clipboardCleared ?? false,
          ...(saved.clipboardCleanupFailed ? { clipboardCleanupFailed: true as const } : {}),
          ...(saved.onboardingWarning ? { onboardingWarning: saved.onboardingWarning } : {}),
          ...(groupFailed ? { groupFailed } : {}),
        };
      } catch (err) {
        await rollBack(account?.id);
        throw err;
      }
    }));

  ipcMain.handle(IPC.ACCOUNT_VAULT_GENERATE, wrapHandler(IPC.ACCOUNT_VAULT_GENERATE,
    async (e, args: { accountId: unknown; name: unknown; length?: unknown }) =>
      appAccountVault().generate(knownAccount(e, args?.accountId), args?.name, typeof args?.length === 'number' ? args.length : undefined)));

  ipcMain.handle(IPC.ACCOUNT_VAULT_SET_INJECT, wrapHandler(IPC.ACCOUNT_VAULT_SET_INJECT,
    async (e, args: { accountId: unknown; name: unknown; inject: unknown }) => {
      if (typeof args?.inject !== 'boolean') throw new AccountError('invalid', 'inject must be a boolean');
      return { ok: appAccountVault().setInject(knownAccount(e, args?.accountId), assertString(args?.name, 'name'), args.inject) };
    }));

  ipcMain.handle(IPC.ACCOUNT_VAULT_DELETE, wrapHandler(IPC.ACCOUNT_VAULT_DELETE,
    async (e, args: { accountId: unknown; name: unknown }) =>
      ({ ok: appAccountVault().delete(knownAccount(e, args?.accountId), assertString(args?.name, 'name')) })));

  return () => {
    for (const c of channels) ipcMain.removeHandler(c);
  };
}
