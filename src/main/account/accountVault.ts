// ─── Account vault — `<wmuxDir>/accounts/vault.json` ───────────────────────
//
// Named secrets that belong to one account of the multi-account list
// (accountStore.ts). A pane created under a workspace bound to that account
// gets the entries marked `inject` in its process environment, through the
// daemon's spawn-only `secretEnv` (never meta.env, never persisted or
// replayed). Values are Electron safeStorage ciphertext in a 0600 file, as the
// bot secret store keeps them (factory/secretStore.ts); main decrypts them once
// and holds them in memory. Nothing here returns a value outside main: `list`
// is names and metadata only.
//
// What a pane does not get: a pane started by a bot, a fan-out task, another
// PC or a wmux.json exec unit; a pane the daemon starts itself (phone, continue
// on an account in the same pane, scheduled runs), since the daemon cannot
// decrypt; a pane recovered after a restart, since `secretEnv` is never
// replayed; a pane in non-daemon mode. The
// values follow the account the pane was created under. Redaction
// (secretRedaction.ts) covers the text bots see, not the pane's own screen.
// An agent pane does get them although "Withhold credentials from agent
// panes" is on: that setting strips what the pane would inherit, while a vault
// entry is one the owner marked for injection.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BOT_SECRET_LIMITS, isBotSecretName } from '../../shared/botSecret';
import { electronSecretCrypto, type SecretCrypto, type SecretCryptoState } from '../factory/secretStore';
import { getAccountStore, getAccountsPath, isAccessibleDir, VENDOR_ENV_KEYS, type Account } from './accountStore';
import { atomicReadJSONSync } from '../../daemon/util/atomicWrite';
import { isRedactableSecretValue, setRedactedAccountVault } from '../factory/secretRedaction';
import { agentRow } from '../../shared/agentIdentity';

export const ACCOUNT_VAULT_FILE_VERSION = 1 as const;

/** Most entries one account holds: a pane's spawn env carries at most
 *  NAMES_PER_FANOUT secrets, shared by its bound Claude and Codex accounts. */
export const ACCOUNT_VAULT_PER_ACCOUNT_MAX = 8;

/** What a caller outside main may see of an entry. */
export interface AccountVaultEntry {
  accountId: string;
  /** The env var it is injected as (isBotSecretName). */
  name: string;
  inject: boolean;
  length: number;
  createdAt: number;
  updatedAt: number;
  /** False when this machine cannot decrypt it (enter it again). */
  usable: boolean;
}

export type AccountVaultSetResult =
  | { ok: true; entry: AccountVaultEntry }
  | {
      ok: false;
      code: 'encryption_unavailable' | 'basic_text' | 'invalid_name' | 'invalid_value' | 'too_many' | 'write_failed' | 'store_unreadable';
      message: string;
    };

interface StoredEntry {
  accountId: string;
  name: string;
  cipher: string;
  inject: boolean;
  length: number;
  createdAt: number;
  updatedAt: number;
}

interface Held {
  record: StoredEntry;
  value: string | null;
}

export interface AccountVaultOptions {
  file: string;
  crypto: SecretCrypto;
  now?: () => number;
  log?: (message: string) => void;
}

const ACCOUNT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Sign-in variables each vendor's CLI reads (envFor). */
const VENDOR_AUTH_NAMES: ReadonlyMap<string, 'claude' | 'codex'> = new Map([
  ['ANTHROPIC_API_KEY', 'claude'],
  ['ANTHROPIC_AUTH_TOKEN', 'claude'],
  ['CLAUDE_CODE_OAUTH_TOKEN', 'claude'],
  ['OPENAI_API_KEY', 'codex'],
  ['CODEX_API_KEY', 'codex'],
]);

/** The vendor whose CLI reads this sign-in variable, if it is one. */
export function vendorOfAuthName(name: string): 'claude' | 'codex' | undefined {
  return VENDOR_AUTH_NAMES.get(name);
}

function keyOf(accountId: string, name: string): string {
  return `${accountId}\u0000${name}`;
}

function isStored(item: unknown): item is StoredEntry {
  const r = item as StoredEntry;
  return !!r && typeof r === 'object'
    && typeof r.accountId === 'string' && ACCOUNT_ID_RE.test(r.accountId)
    && isBotSecretName(r.name)
    && typeof r.cipher === 'string' && r.cipher.length > 0
    && typeof r.inject === 'boolean'
    && Number.isFinite(r.length) && Number.isFinite(r.createdAt) && Number.isFinite(r.updatedAt);
}

export class AccountVault {
  private readonly held = new Map<string, Held>();
  private unreadable = false;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(private readonly opts: AccountVaultOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.warn(`[account] vault: ${m}`));
  }

  private refusal(): Extract<AccountVaultSetResult, { ok: false }> | null {
    if (this.unreadable) {
      return { ok: false, code: 'store_unreadable', message: 'The account vault file cannot be read, so nothing is saved over it. Fix or remove accounts/vault.json.' };
    }
    let state: SecretCryptoState;
    try {
      state = this.opts.crypto.state();
    } catch {
      state = 'unavailable';
    }
    if (state === 'unavailable') return { ok: false, code: 'encryption_unavailable', message: 'This system offers no encrypted storage for wmux, so the value was not saved.' };
    if (state === 'basic_text') return { ok: false, code: 'basic_text', message: 'No keyring (such as GNOME Keyring or KWallet) is available, so wmux cannot encrypt the value and did not save it.' };
    return null;
  }

  /** Read and decrypt the file. Missing is empty; unreadable is logged, loads
   *  nothing and is never written over. Entries of accounts that no longer
   *  exist are dropped (and the file rewritten) when `liveAccountIds` says so. */
  load(liveAccountIds?: ReadonlySet<string>): void {
    this.held.clear();
    this.unreadable = false;
    let raw: unknown = null;
    let exists = true;
    try {
      raw = JSON.parse(fs.readFileSync(this.opts.file, 'utf8'));
    } catch (err) {
      exists = (err as NodeJS.ErrnoException)?.code !== 'ENOENT';
    }
    const readable = !!raw && typeof raw === 'object' && (raw as { version?: unknown }).version === ACCOUNT_VAULT_FILE_VERSION
      && Array.isArray((raw as { entries?: unknown }).entries);
    if (exists && !readable) {
      this.unreadable = true;
      this.log(`${path.basename(this.opts.file)} is unreadable or of another version; nothing is loaded or saved until it is fixed`);
    }
    let decryptable: boolean | undefined;
    let pruned = false;
    for (const item of readable ? (raw as { entries: unknown[] }).entries : []) {
      if (!isStored(item) || this.held.has(keyOf(item.accountId, item.name))) continue;
      if (liveAccountIds && !liveAccountIds.has(item.accountId)) {
        pruned = true;
        continue;
      }
      let value: string | null = null;
      // On macOS the first decrypt asks the keychain and blocks; an empty
      // vault never touches it.
      if ((decryptable ??= this.refusal() === null)) {
        try {
          value = this.opts.crypto.decrypt(Buffer.from(item.cipher, 'base64'));
        } catch {
          value = null;
        }
      }
      if (value === null) this.log(`${item.name} of account ${item.accountId} cannot be decrypted here; enter it again to use it`);
      this.held.set(keyOf(item.accountId, item.name), { record: { ...item }, value });
    }
    if (pruned) this.persist(this.held);
    this.publish();
  }

  /** One account's entries, never values; oldest first. */
  list(accountId: string): AccountVaultEntry[] {
    return [...this.held.values()]
      .filter((h) => h.record.accountId === accountId)
      .map((h) => entryOf(h))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Store (or replace) a value. A new entry is injected unless told not to;
   *  a replaced one keeps its setting. */
  set(accountId: string, name: unknown, value: unknown, opts: { inject?: boolean } = {}): AccountVaultSetResult {
    const refused = this.refusal();
    if (refused) return refused;
    if (!ACCOUNT_ID_RE.test(accountId) || !isBotSecretName(name)) {
      return { ok: false, code: 'invalid_name', message: 'The name must be an upper-case env var name that reads as a credential (such as GITHUB_TOKEN).' };
    }
    if (typeof value !== 'string' || value.length < BOT_SECRET_LIMITS.VALUE_MIN || value.length > BOT_SECRET_LIMITS.VALUE_MAX
      || value.includes('\0') || /[\r\n]/.test(value) || !isRedactableSecretValue(value)) {
      return { ok: false, code: 'invalid_value', message: `The value must be one line of ${BOT_SECRET_LIMITS.VALUE_MIN} to ${BOT_SECRET_LIMITS.VALUE_MAX} characters.` };
    }
    const key = keyOf(accountId, name);
    const prior = this.held.get(key);
    if (!prior && this.list(accountId).length >= ACCOUNT_VAULT_PER_ACCOUNT_MAX) {
      return { ok: false, code: 'too_many', message: `An account holds at most ${ACCOUNT_VAULT_PER_ACCOUNT_MAX} values.` };
    }
    let cipher: string;
    try {
      cipher = this.opts.crypto.encrypt(value).toString('base64');
    } catch {
      return { ok: false, code: 'encryption_unavailable', message: 'The value could not be encrypted, so it was not saved.' };
    }
    const at = this.now();
    const record: StoredEntry = {
      accountId,
      name,
      cipher,
      inject: prior ? prior.record.inject : opts.inject ?? true,
      length: value.length,
      createdAt: prior?.record.createdAt ?? at,
      updatedAt: at,
    };
    const next = new Map(this.held);
    next.set(key, { record, value });
    if (!this.persist(next)) return { ok: false, code: 'write_failed', message: 'The account vault file could not be written.' };
    this.replace(next);
    return { ok: true, entry: entryOf({ record, value }) };
  }

  /** A random value of `length` characters (url-safe), stored as `set` does. */
  generate(accountId: string, name: unknown, length = 40): AccountVaultSetResult {
    const n = Math.min(Math.max(Math.trunc(length) || 0, BOT_SECRET_LIMITS.VALUE_MIN), 256);
    return this.set(accountId, name, crypto.randomBytes(n).toString('base64url').slice(0, n));
  }

  setInject(accountId: string, name: string, inject: boolean): boolean {
    const key = keyOf(accountId, name);
    const held = this.held.get(key);
    if (!held || this.unreadable) return false;
    const next = new Map(this.held);
    next.set(key, { record: { ...held.record, inject, updatedAt: this.now() }, value: held.value });
    if (!this.persist(next)) return false;
    this.replace(next);
    return true;
  }

  delete(accountId: string, name: string): boolean {
    const key = keyOf(accountId, name);
    if (!this.held.has(key) || this.unreadable) return false;
    const next = new Map(this.held);
    next.delete(key);
    if (!this.persist(next)) return false;
    this.replace(next);
    return true;
  }

  /** Drop every entry of an account (the account was removed). */
  deleteAccount(accountId: string): void {
    const next = new Map([...this.held].filter(([, h]) => h.record.accountId !== accountId));
    if (next.size === this.held.size || this.unreadable) return;
    if (this.persist(next)) this.replace(next);
  }

  /** The injected values of these accounts, by env name. The first account
   *  listed wins a name both hold. A vendor's own sign-in variables come only
   *  from an account of that vendor, so a Codex account's vault cannot sign a
   *  Claude pane in elsewhere (or move its billing). */
  envFor(accounts: ReadonlyArray<{ id: string; vendor: 'claude' | 'codex' }>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const account of accounts) {
      for (const h of this.held.values()) {
        if (h.record.accountId !== account.id || !h.record.inject || h.value === null) continue;
        const owner = VENDOR_AUTH_NAMES.get(h.record.name);
        if (owner && owner !== account.vendor) continue;
        if (!(h.record.name in env)) env[h.record.name] = h.value;
      }
    }
    return env;
  }

  private replace(next: Map<string, Held>): void {
    this.held.clear();
    for (const [k, v] of next) this.held.set(k, v);
    this.publish();
  }

  private publish(): void {
    setRedactedAccountVault([...this.held.values()]
      .filter((h): h is Held & { value: string } => h.value !== null)
      .map((h) => ({ name: h.record.name, value: h.value })));
  }

  private persist(map: ReadonlyMap<string, Held>): boolean {
    const file = this.opts.file;
    const body = `${JSON.stringify({ version: ACCOUNT_VAULT_FILE_VERSION, entries: [...map.values()].map((h) => h.record) })}\n`;
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmp, file);
      try {
        fs.chmodSync(file, 0o600);
      } catch { /* Windows: ACLs, not modes */ }
      return true;
    } catch (err) {
      try { fs.unlinkSync(tmp); } catch { /* never written */ }
      this.log(`${path.basename(file)} not written: ${(err as NodeJS.ErrnoException)?.code ?? 'error'}`);
      return false;
    }
  }
}

function entryOf(h: Held): AccountVaultEntry {
  const r = h.record;
  return { accountId: r.accountId, name: r.name, inject: r.inject, length: r.length, createdAt: r.createdAt, updatedAt: r.updatedAt, usable: h.value !== null };
}

/** Who may get an account's vault: a pane created on this computer for its
 *  workspace. Never a bot worker, a fan-out task or a pane another PC started
 *  (scheduled runs start in the daemon and never reach here). Pure. */
export function vaultEligibleCreate(options: {
  workspaceId?: string;
  ignoreAccountBinding?: boolean;
  fanoutTaskOf?: unknown;
  remoteSpawnOf?: unknown;
} | undefined, botWorker: unknown): boolean {
  if (!options?.workspaceId || options.ignoreAccountBinding === true) return false;
  return !botWorker && !options.fanoutTaskOf && !options.remoteSpawnOf;
}

/**
 * The account a create names for itself (`accountId`): it stands in for the
 * workspace's bound account of its vendor, for the folder env and the vault
 * (vaultAccountsForCreate). Only the id of a registered Claude or Codex
 * account whose folder exists; anything else refuses the create, so it never
 * starts on another account. The caller names an id, never env. Undefined
 * when the create names none. `missingFolder: 'skip'` (a rotated launch, whose
 * account was picked with its folder present) leaves the pane on the bound
 * account, as before rotation named one, when the folder went since.
 */
export function createAccountOverride(
  options: { accountId?: unknown; ignoreAccountBinding?: boolean } | undefined,
  deps: { account?: (id: string) => Account | undefined; dirOk?: (dir: string) => boolean; missingFolder?: 'refuse' | 'skip' } = {},
): Account | undefined {
  if (options?.accountId === undefined) return undefined;
  const id = options.accountId;
  if (typeof id !== 'string' || !ACCOUNT_ID_RE.test(id)) throw new Error('PTY_CREATE: invalid account id');
  // An agent-setup pane signs in to the default folder, so it takes no account.
  if (options.ignoreAccountBinding === true) throw new Error('PTY_CREATE: this pane takes no account');
  const account = (deps.account ?? ((i: string) => getAccountStore().getAccount(i)))(id);
  if (!account || !Object.hasOwn(VENDOR_ENV_KEYS, account.vendor)) throw new Error('PTY_CREATE: unknown account');
  if (!(deps.dirOk ?? isAccessibleDir)(account.configDir)) {
    if (deps.missingFolder === 'skip') return undefined;
    throw new Error('PTY_CREATE: the account folder is missing');
  }
  return account;
}

/**
 * `env` with the account's folder key set over any value of it (any case:
 * Windows env names are case-insensitive), as a rotated launch sets it: the
 * pane env is applied after the bound account and the workspace profile, so
 * a profile's own folder cannot take the pane to another account. Pure.
 */
export function withAccountFolderEnv(env: Record<string, string> | undefined, account: Pick<Account, 'vendor' | 'configDir'>): Record<string, string> {
  const key = VENDOR_ENV_KEYS[account.vendor];
  const next = Object.fromEntries(Object.entries(env ?? {}).filter(([name]) => name.toUpperCase() !== key));
  next[key] = account.configDir;
  return next;
}

/** A sign-in variable of the vendor whose conversation can move between
 *  accounts (its agent row's `continueOnAccount`: Claude), so one a pane
 *  spawned with keeps it on its account over a same-pane move. */
function isContinueSignInName(name: string): boolean {
  return agentRow(VENDOR_AUTH_NAMES.get(name))?.continueOnAccount === true;
}

/** Panes of this main run whose spawn got a Claude sign-in value from a vault. */
const vaultSignInPanes = new Set<string>();

/** Record that `sessionId` spawned with these vault names (values are not looked at). */
export function noteVaultSignInPane(sessionId: string, names: Iterable<string>): void {
  for (const name of names) {
    if (isContinueSignInName(name)) {
      vaultSignInPanes.add(sessionId);
      return;
    }
  }
}

/** Whether `sessionId` spawned with a Claude sign-in value from a vault, in this main run. */
export function paneHasVaultSignIn(sessionId: string): boolean {
  return vaultSignInPanes.has(sessionId);
}

/** Whether these entries hold a Claude sign-in variable a pane gets (injected, decryptable). Pure. */
export function holdsClaudeSignIn(entries: ReadonlyArray<Pick<AccountVaultEntry, 'name' | 'inject' | 'usable'>>): boolean {
  return entries.some((e) => isContinueSignInName(e.name) && e.inject && e.usable);
}

/**
 * Without the wmux daemon a pane gets no vault value (the spawn-only field is
 * the daemon's, as for a worker's secrets), so a Claude launch on an account
 * that signs in only from its vault would start signed out. The name of the
 * first of `accounts` (vaultAccountsForCreate's) whose vault holds a Claude
 * sign-in the pane would get while its folder has no login of its own, or null.
 */
export async function vaultOnlyClaudeAccount(
  accounts: ReadonlyArray<{ id: string; vendor: 'claude' | 'codex' }>,
  deps: {
    entries: (accountId: string) => ReadonlyArray<AccountVaultEntry>;
    account: (accountId: string) => Pick<Account, 'name' | 'configDir'> | undefined;
    folderSignedIn: (configDir: string) => Promise<boolean>;
  },
): Promise<string | null> {
  for (const a of accounts) {
    const own = deps.entries(a.id).filter((e) => vendorOfAuthName(e.name) === a.vendor);
    if (!holdsClaudeSignIn(own)) continue;
    const account = deps.account(a.id);
    if (account && !(await deps.folderSignedIn(account.configDir).catch(() => false))) return account.name;
  }
  return null;
}

/** The accounts whose vault a create gets: the workspace's bound Claude and
 *  Codex accounts, with `override` in place of the one of its vendor. None
 *  for a create vaultEligibleCreate refuses. Pure. */
export function vaultAccountsForCreate(
  options: Parameters<typeof vaultEligibleCreate>[0],
  botWorker: unknown,
  binding: (workspaceId: string, vendor: 'claude' | 'codex') => string | undefined,
  override?: Pick<Account, 'id' | 'vendor'>,
): Array<{ id: string; vendor: 'claude' | 'codex' }> {
  const workspaceId = options?.workspaceId;
  if (!vaultEligibleCreate(options, botWorker) || !workspaceId) return [];
  return (['claude', 'codex'] as const)
    .map((vendor) => ({ id: override?.vendor === vendor ? override.id : binding(workspaceId, vendor), vendor }))
    .filter((a): a is { id: string; vendor: 'claude' | 'codex' } => typeof a.id === 'string');
}

/**
 * The spawn-only secret env of a create: the bot grant and gateway values
 * (`secretEnv`) win a name clash, and vault names past the daemon's limit are
 * left out with their names, so the pane still starts. Null when empty. Pure.
 */
export function mergeVaultSecretEnv(
  secretEnv: Record<string, string> | undefined | null,
  vaultEnv: Record<string, string>,
): { env: Record<string, string> | null; dropped: string[] } {
  const env: Record<string, string> = { ...(secretEnv ?? {}) };
  const dropped: string[] = [];
  for (const [name, value] of Object.entries(vaultEnv)) {
    if (name in env) continue;
    if (Object.keys(env).length >= BOT_SECRET_LIMITS.NAMES_PER_FANOUT) {
      dropped.push(name);
      continue;
    }
    env[name] = value;
  }
  return { env: Object.keys(env).length > 0 ? env : null, dropped };
}

let current: AccountVault | null = null;

/**
 * The running app's vault, created and loaded on first use (main, after the
 * app is ready: safeStorage needs it). `liveAccountIds` drops the entries of
 * removed accounts at that load.
 */
export function getAccountVault(init?: { file: string; crypto: () => SecretCrypto; liveAccountIds: () => ReadonlySet<string> | undefined }): AccountVault | null {
  if (!current && init) {
    current = new AccountVault({ file: init.file, crypto: init.crypto() });
    current.load(init.liveAccountIds());
  }
  return current;
}

export function setAccountVault(next: AccountVault | null): void {
  current = next;
}

/** The app's vault at `<wmuxDir>/accounts/vault.json`, beside accounts.json. */
export function appAccountVault(): AccountVault {
  return getAccountVault({
    file: path.join(path.dirname(getAccountsPath()), 'accounts', 'vault.json'),
    crypto: electronSecretCrypto,
    liveAccountIds: readableAccountIds,
  }) as AccountVault;
}

/**
 * The ids of the account list, only when accounts.json (or its backup) reads
 * as a list: the account store opens an unreadable file as empty, and pruning
 * against that would delete every vault entry.
 */
function readableAccountIds(): ReadonlySet<string> | undefined {
  try {
    const raw = atomicReadJSONSync<{ accounts?: unknown }>(getAccountsPath());
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.accounts)) return undefined;
  } catch {
    return undefined;
  }
  return new Set(getAccountStore().listAccounts().map((a) => a.id));
}
