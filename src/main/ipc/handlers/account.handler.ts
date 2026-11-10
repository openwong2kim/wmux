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
import { copiesSettingsJson, provisionAccountDir } from '../../account/accountProvision';
import { envClaudeConfigDir } from '../../../shared/claudeConfigTargets';
import { claudeConfigDirEnv } from '../../hooks/claudeConfigDirProbe';
import { installHooksIntoNewAccount } from './hooksBridge.handler';
import { loadClaudeCredential, credentialFingerprint } from '../../claude/claudeCredential';
import { appAccountVault, type AccountVaultSetResult } from '../../account/accountVault';

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
  const accountsRoot = path.resolve(getWmuxDir(), 'accounts');
  // Onboarding hands out the realpath'd dir, so also accept the realpath'd root
  // (e.g. a symlinked home directory).
  let realRoot = accountsRoot;
  try { realRoot = fs.realpathSync.native(accountsRoot); } catch { /* root not created yet */ }
  const underAccountsRoot = [accountsRoot, realRoot].some((root) => {
    const rel = path.relative(root, canonical);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  });
  if (!registered && !underAccountsRoot) {
    throw new AccountError('invalid', 'config directory is not an account directory');
  }
  return canonical;
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
      const configDir = path.join(getWmuxDir(), 'accounts', `${args.vendor}-${randomUUID().slice(0, 8)}`);
      // An account that keeps Claude's settings.json shares from the folder
      // Claude itself reads:
      // CLAUDE_CONFIG_DIR when set, else ~/.claude.
      const sourceDir = copiesSettingsJson(args.vendor) ? envClaudeConfigDir(await claudeConfigDirEnv()).dir ?? undefined : undefined;
      const result = provisionAccountDir({ configDir, vendor: args.vendor, share, sourceDir });
      // wmux's hooks there too, when the primary folder has them (its copied
      // settings may predate them, or there was no copy at all).
      if (copiesSettingsJson(args.vendor)) {
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
      return {
        ...result,
        configDir: canonical,
        loginCommand: buildLoginCommand(args.vendor, canonical),
      };
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
  const knownAccount = (e: IpcMainInvokeEvent, v: unknown): string => {
    if (!isMainWindowSender(e, getWindow())) throw new AccountError('invalid', 'not allowed from this window');
    const id = assertSafeId(v, 'accountId');
    if (!getAccountStore().getAccount(id)) throw new AccountError('not-found', 'no such account');
    return id;
  };
  ipcMain.handle(IPC.ACCOUNT_VAULT_LIST, wrapHandler(IPC.ACCOUNT_VAULT_LIST,
    async (e, args: { accountId: unknown }) => ({ ok: true, entries: appAccountVault().list(knownAccount(e, args?.accountId)) })));

  // Clipboard → vault. The clipboard is cleared only if it still holds what
  // was saved, so text copied since is not lost.
  ipcMain.handle(IPC.ACCOUNT_VAULT_SAVE_CLIPBOARD, wrapHandler(IPC.ACCOUNT_VAULT_SAVE_CLIPBOARD,
    async (e, args: { accountId: unknown; name: unknown; expectPrefix?: unknown }): Promise<AccountVaultSetResult & { clipboardCleared?: boolean }> => {
      const accountId = knownAccount(e, args?.accountId);
      const value = (await clipboard.readText()).trim();
      if (typeof args?.expectPrefix === 'string' && args.expectPrefix && !value.startsWith(args.expectPrefix)) {
        return { ok: false, code: 'invalid_value', message: `The clipboard does not start with "${args.expectPrefix}", so nothing was saved.` };
      }
      const result = appAccountVault().set(accountId, args?.name, value);
      if (!result.ok) return result;
      let clipboardCleared = false;
      if ((await clipboard.readText()).trim() === value) {
        await clipboard.clear();
        clipboardCleared = true;
      }
      return { ...result, clipboardCleared };
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
