// ─── Multi-Account — renderer → main IPC (registry CRUD + bindings) ──────────
//
// Renderer-only trust boundary (ipcMain.handle): main owns accounts.json and is
// the ONLY place spawn env is resolved. The renderer edits names/bindings and
// drives onboarding, but never sees or writes a token.

import { ipcMain } from 'electron';
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
import { provisionAccountDir } from '../../account/accountProvision';
import { loadClaudeCredential, credentialFingerprint } from '../../claude/claudeCredential';

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

export function registerAccountHandlers(): () => void {
  const channels = [
    IPC.ACCOUNT_LIST,
    IPC.ACCOUNT_ONBOARD_PREPARE,
    IPC.ACCOUNT_ADD,
    IPC.ACCOUNT_RENAME,
    IPC.ACCOUNT_REMOVE,
    IPC.ACCOUNT_SET_BINDING,
    IPC.ACCOUNT_CREDENTIAL_STATUS,
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
      const result = provisionAccountDir({ configDir, vendor: args.vendor, share });
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

  // Remove = unregister only (never deletes the dir). Returns affected workspaces.
  ipcMain.handle(IPC.ACCOUNT_REMOVE, wrapHandler(IPC.ACCOUNT_REMOVE,
    async (_e, args: { id: unknown }) => {
      const affected = await getAccountStore().removeAccount(assertString(args?.id, 'id'));
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

  return () => {
    for (const c of channels) ipcMain.removeHandler(c);
  };
}
