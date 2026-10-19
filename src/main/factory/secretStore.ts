// ─── The bot secret store — `<wmuxDir>/factory/secrets.json` ───────────────
//
// What the owner types into a bot's secret-request modal, kept as Electron
// safeStorage ciphertext (the OS keychain / DPAPI / the Linux secret
// service) in a 0600 file: `{version:1, secrets:[{name, cipher, label?,
// requestedBy?, createdAt, updatedAt, lastUsed?:{botId, at}}], retired?:
// [{name, cipher, at}], deleted?: [{name, at, bots, connector?}]}`
// (`retired`: replaced and deleted values, encrypted the same way, so they
// stay redacted across restarts; `deleted`: the names the owner deleted and
// the bots that asked for or last used each, so their wakes are told until
// the key is stored again). Main decrypts
// the values once, after the app is ready, and holds them in memory for the
// two uses it has: a worker spawn's env (secretGrants.ts) and redaction
// (secretRedaction.ts). Nothing here returns a value to a caller outside
// main: `list()` is names and use only.
//
// Storing is refused when encryption is unavailable or, on Linux, when the
// safeStorage backend is `basic_text` (a hard-coded key, not a keychain):
// the owner is told why, and nothing is written.

import fs from 'node:fs';
import path from 'node:path';
import { safeStorage } from 'electron';
import { BOT_SECRET_LIMITS, isBotSecretName, type BotSecretEntry } from '../../shared/botSecret';
import { CONNECTOR_ID_RE } from '../../shared/botConnector';
import { isRedactableSecretValue, secretForms, setRedactedSecrets } from './secretRedaction';

export const SECRETS_FILE_VERSION = 1 as const;

/** Why the store cannot encrypt, or 'ok'. */
export type SecretCryptoState = 'ok' | 'unavailable' | 'basic_text';

/** The encryption the store uses (Electron safeStorage in the app). */
export interface SecretCrypto {
  state(): SecretCryptoState;
  encrypt(plain: string): Buffer;
  decrypt(cipher: Buffer): string;
}

/** Electron safeStorage. Call only after the app is ready. */
export function electronSecretCrypto(): SecretCrypto {
  return {
    state() {
      if (!safeStorage?.isEncryptionAvailable?.()) return 'unavailable';
      if (process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text') return 'basic_text';
      return 'ok';
    },
    encrypt: (plain) => safeStorage.encryptString(plain),
    decrypt: (cipher) => safeStorage.decryptString(cipher),
  };
}

interface StoredSecret {
  name: string;
  /** base64 of the safeStorage ciphertext. */
  cipher: string;
  label?: string;
  requestedBy?: string;
  /** The connection the key was entered for (shared/botConnector.ts): a
   *  connection's key, never handed to a worker as a plain secret. */
  connectorId?: string;
  createdAt: number;
  updatedAt: number;
  lastUsed?: { botId: string; at: number };
}

interface Held {
  record: StoredSecret;
  /** null: the ciphertext could not be decrypted on this machine/user. */
  value: string | null;
}

export type SecretSetResult =
  | { ok: true; entry: BotSecretEntry }
  | { ok: false; code: 'encryption_unavailable' | 'basic_text' | 'invalid_name' | 'invalid_value' | 'too_many' | 'write_failed' | 'not_loaded' | 'store_unreadable'; message: string };

export interface SecretStoreOptions {
  /** `<wmuxDir>/factory/secrets.json` */
  file: string;
  crypto: SecretCrypto;
  now?: () => number;
  log?: (msg: string) => void;
  /** Told after every change (the BOT_EVENT `secrets-changed` push). */
  onChange?: () => void;
}

const BOT_ID_MAX = 128;
/** Replaced or deleted values still redacted (workers started before may hold them). */
const RETIRED_MAX = 64;
/** A retired value stays redacted this long after it was replaced. */
const RETIRED_KEEP_MS = 30 * 24 * 3600_000;

/** `value` null: not decryptable in this run; its ciphertext is kept for a
 *  run that can read it. */
interface Retired { name: string; value: string | null; cipher: string; at: number }

function isStoredRetired(raw: unknown): raw is { name: string; cipher: string; at: number } {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  return isBotSecretName(r.name) && typeof r.cipher === 'string' && r.cipher.length > 0 && typeof r.at === 'number';
}
const LABEL_MAX = BOT_SECRET_LIMITS.LABEL_MAX;

/** A key the owner deleted: its name only, the bots told about it, and
 *  whether it was a connection's key (entered again in its connection, not
 *  through secret_request). */
interface Deleted { name: string; at: number; bots: string[]; connector?: true }
/** Deleted keys remembered for the bots' wakes (only ones a bot used), the
 *  oldest dropped first. */
const DELETED_MAX = 32;

/** A deleted key as a bot's wake reads it. */
export interface DeletedKey { name: string; connector?: true }

function isStoredDeleted(raw: unknown): raw is Deleted {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  return isBotSecretName(r.name) && typeof r.at === 'number' && Array.isArray(r.bots) && r.bots.length > 0 && r.bots.length <= 8
    && r.bots.every((b) => typeof b === 'string' && b.length > 0 && b.length <= BOT_ID_MAX)
    && (r.connector === undefined || r.connector === true);
}

function isStored(raw: unknown): raw is StoredSecret {
  if (!raw || typeof raw !== 'object') return false;
  const r = raw as Record<string, unknown>;
  return isBotSecretName(r.name) && typeof r.cipher === 'string' && r.cipher.length > 0 &&
    typeof r.createdAt === 'number' && typeof r.updatedAt === 'number';
}

function cleanRecord(r: StoredSecret): StoredSecret {
  const lastUsed = r.lastUsed && typeof r.lastUsed.botId === 'string' && typeof r.lastUsed.at === 'number'
    ? { botId: r.lastUsed.botId.slice(0, BOT_ID_MAX), at: r.lastUsed.at }
    : undefined;
  return {
    name: r.name,
    cipher: r.cipher,
    ...(typeof r.label === 'string' && r.label ? { label: r.label.slice(0, LABEL_MAX) } : {}),
    ...(typeof r.requestedBy === 'string' && r.requestedBy ? { requestedBy: r.requestedBy.slice(0, BOT_ID_MAX) } : {}),
    ...(typeof r.connectorId === 'string' && CONNECTOR_ID_RE.test(r.connectorId) ? { connectorId: r.connectorId } : {}),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    ...(lastUsed ? { lastUsed } : {}),
  };
}

function entryOf(r: StoredSecret): BotSecretEntry {
  return {
    name: r.name,
    ...(r.label ? { label: r.label } : {}),
    ...(r.requestedBy ? { requestedBy: r.requestedBy } : {}),
    ...(r.connectorId ? { connectorId: r.connectorId } : {}),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    ...(r.lastUsed ? { lastUsed: { ...r.lastUsed } } : {}),
  };
}

export class SecretStore {
  private held = new Map<string, Held>();
  private loaded = false;
  /** Values replaced or deleted: still redacted, since a worker started
   *  before keeps them in its environment. Kept (encrypted) in the file. */
  private retired: Retired[] = [];
  /** Keys the owner deleted, for the wakes of the bots that used them. */
  private deleted: Deleted[] = [];
  /** The file exists but could not be read: nothing is written over it. */
  private unreadable = false;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: SecretStoreOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.warn(`[factory] secrets: ${m}`));
  }

  /** Why storing is refused now, or null. */
  storeRefusal(): Extract<SecretSetResult, { ok: false }> | null {
    if (this.unreadable) {
      return { ok: false, code: 'store_unreadable', message: 'The saved keys file cannot be read, so nothing is saved over it. Fix or remove factory/secrets.json.' };
    }
    let state: SecretCryptoState;
    try {
      state = this.opts.crypto.state();
    } catch {
      state = 'unavailable';
    }
    if (state === 'unavailable') {
      return { ok: false, code: 'encryption_unavailable', message: 'This system offers no encrypted storage for wmux, so the key was not saved.' };
    }
    if (state === 'basic_text') {
      return { ok: false, code: 'basic_text', message: 'No keyring (such as GNOME Keyring or KWallet) is available, so wmux cannot encrypt the key and did not save it.' };
    }
    return null;
  }

  /** Read and decrypt the file (after the app is ready). A missing file is
   *  an empty store; an unreadable one is logged and treated as empty (and
   *  is not overwritten until a change is made). */
  load(): void {
    this.held.clear();
    this.retired = [];
    this.deleted = [];
    this.unreadable = false;
    let raw: unknown = null;
    let exists = true;
    try {
      raw = JSON.parse(fs.readFileSync(this.opts.file, 'utf8'));
    } catch (err) {
      exists = (err as NodeJS.ErrnoException)?.code !== 'ENOENT';
    }
    const readable = raw && typeof raw === 'object' && (raw as { version?: unknown }).version === SECRETS_FILE_VERSION
      && Array.isArray((raw as { secrets?: unknown }).secrets);
    if (exists && !readable) {
      // Never written over: the owner recovers or removes the file.
      this.unreadable = true;
      this.log(`${path.basename(this.opts.file)} is unreadable or of another version; no secrets are loaded and none are saved until it is fixed`);
    }
    const list = readable ? (raw as { secrets: unknown[] }).secrets : [];
    // Asked only once there is a value to decrypt: on macOS the first
    // safeStorage call goes to the keychain and blocks the main thread while
    // it answers, so a store with nothing in it never touches it at startup.
    let decryptable: boolean | undefined;
    const canDecrypt = () => (decryptable ??= this.storeRefusal() === null);
    for (const item of Array.isArray(list) ? list : []) {
      if (!isStored(item) || this.held.has(item.name)) continue;
      const record = cleanRecord(item);
      let value: string | null = null;
      if (canDecrypt()) {
        try {
          value = this.opts.crypto.decrypt(Buffer.from(record.cipher, 'base64'));
        } catch {
          value = null;
        }
      }
      if (value === null) this.log(`${record.name} cannot be decrypted here; enter it again to use it`);
      this.held.set(record.name, { record, value });
      if (this.held.size >= BOT_SECRET_LIMITS.STORED_MAX) break;
    }
    const retired = readable ? (raw as { retired?: unknown }).retired : undefined;
    const since = this.now() - RETIRED_KEEP_MS;
    for (const item of Array.isArray(retired) ? retired.slice(-RETIRED_MAX) : []) {
      if (!isStoredRetired(item) || item.at < since) continue;
      let value: string | null = null;
      if (canDecrypt()) {
        try {
          value = this.opts.crypto.decrypt(Buffer.from(item.cipher, 'base64'));
        } catch {
          value = null;
        }
      }
      this.retired.push({ name: item.name, value, cipher: item.cipher, at: item.at });
    }
    const deleted = readable ? (raw as { deleted?: unknown }).deleted : undefined;
    for (const item of Array.isArray(deleted) ? deleted.slice(-DELETED_MAX) : []) {
      if (!isStoredDeleted(item) || this.held.has(item.name)) continue;
      this.deleted.push({ name: item.name, at: item.at, bots: [...item.bots], ...(item.connector ? { connector: true as const } : {}) });
    }
    this.loaded = true;
    this.publish(false);
  }

  get isLoaded(): boolean {
    return this.loaded;
  }

  /** Names and use, never values; oldest first. */
  list(): BotSecretEntry[] {
    return [...this.held.values()].map((h) => entryOf(h.record)).sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Entered for a connection (its record names one). */
  isConnectorKey(name: string): boolean {
    return !!this.held.get(name)?.record.connectorId;
  }

  /** Stored and usable (decrypted) here. */
  has(name: string): boolean {
    return this.held.get(name)?.value != null;
  }

  /** Store (or replace) one value. */
  set(name: unknown, value: unknown, meta: { label?: string; requestedBy?: string; connectorId?: string } = {}): SecretSetResult {
    if (!this.loaded) return { ok: false, code: 'not_loaded', message: 'The key store is not running yet.' };
    if (!isBotSecretName(name)) {
      return { ok: false, code: 'invalid_name', message: 'The name must be an upper-case env name that reads as a credential (for example NPM_TOKEN or OPENAI_API_KEY).' };
    }
    if (typeof value !== 'string' || value.length < BOT_SECRET_LIMITS.VALUE_MIN || value.length > BOT_SECRET_LIMITS.VALUE_MAX
      || value.includes('\0') || !isRedactableSecretValue(value)) {
      return { ok: false, code: 'invalid_value', message: `The value must be ${BOT_SECRET_LIMITS.VALUE_MIN} to ${BOT_SECRET_LIMITS.VALUE_MAX} characters.` };
    }
    const refusal = this.storeRefusal();
    if (refusal) return refusal;
    const prior = this.held.get(name);
    if (!prior && this.held.size >= BOT_SECRET_LIMITS.STORED_MAX) {
      return { ok: false, code: 'too_many', message: `At most ${BOT_SECRET_LIMITS.STORED_MAX} keys are kept; delete one first.` };
    }
    let cipher: string;
    try {
      cipher = this.opts.crypto.encrypt(value).toString('base64');
    } catch {
      return { ok: false, code: 'encryption_unavailable', message: 'The key could not be encrypted, so it was not saved.' };
    }
    const at = this.now();
    // A label that holds the value itself is dropped, never kept in clear.
    const forms = secretForms(value);
    const labelOf = (l: string | undefined) => (l && !forms.some((f) => l.includes(f)) ? l : undefined);
    const label = labelOf(meta.label) ?? labelOf(prior?.record.label);
    const record = cleanRecord({
      name,
      cipher,
      ...(label ? { label } : {}),
      ...(meta.requestedBy ? { requestedBy: meta.requestedBy } : prior?.record.requestedBy ? { requestedBy: prior.record.requestedBy } : {}),
      ...(meta.connectorId ? { connectorId: meta.connectorId } : prior?.record.connectorId ? { connectorId: prior.record.connectorId } : {}),
      createdAt: prior?.record.createdAt ?? at,
      updatedAt: at,
      ...(prior?.record.lastUsed ? { lastUsed: prior.record.lastUsed } : {}),
    });
    const next = new Map(this.held);
    next.set(name, { record, value });
    const retired = prior && prior.value !== value ? this.retiring(name, prior.value, prior.record.cipher) : this.retired;
    // Stored again: no longer a deleted key.
    const deleted = this.deleted.filter((d) => d.name !== name);
    if (!this.persist(next, retired, deleted)) return { ok: false, code: 'write_failed', message: 'The key could not be written to disk.' };
    this.retired = retired;
    this.deleted = deleted;
    this.held = next;
    this.publish(true);
    return { ok: true, entry: entryOf(record) };
  }

  /** Delete one secret. False when it was not stored or the write failed. */
  delete(name: string): boolean {
    if (!this.loaded || this.unreadable || !this.held.has(name)) return false;
    const prior = this.held.get(name);
    const next = new Map(this.held);
    next.delete(name);
    const retired = prior ? this.retiring(name, prior.value, prior.record.cipher) : this.retired;
    // Told to the bots that used it until it is stored again; a key no bot
    // used is not remembered.
    const bots = this.botsOf(name);
    const kept = this.deleted.filter((d) => d.name !== name);
    const deleted = bots.length > 0
      ? [...kept, { name, at: this.now(), bots, ...(prior?.record.connectorId ? { connector: true as const } : {}) }].slice(-DELETED_MAX)
      : kept;
    if (!this.persist(next, retired, deleted)) return false;
    this.retired = retired;
    this.deleted = deleted;
    this.held = next;
    this.publish(true);
    return true;
  }

  /** The bots that asked for or last used `name`: whom its deletion is told
   *  to. Empty when it is not stored. */
  botsOf(name: string): string[] {
    const r = this.held.get(name)?.record;
    return [...new Set([r?.requestedBy, r?.lastUsed?.botId].filter((b): b is string => !!b))];
  }

  /** The keys the owner deleted that `botId` asked for or last used, oldest
   *  first: names only. */
  deletedFor(botId: string): DeletedKey[] {
    return this.deleted.filter((d) => d.bots.includes(botId)).map((d) => ({ name: d.name, ...(d.connector ? { connector: true as const } : {}) }));
  }

  /** The values of `names` (for a worker spawn), or the names missing. */
  values(names: readonly string[]): { ok: true; env: Record<string, string> } | { ok: false; missing: string[] } {
    const env: Record<string, string> = {};
    const missing: string[] = [];
    for (const n of names) {
      const v = this.held.get(n)?.value;
      if (v == null) missing.push(n);
      else env[n] = v;
    }
    return missing.length > 0 ? { ok: false, missing } : { ok: true, env };
  }

  /** Record that a bot's worker received `names`. Best effort. */
  markUsed(names: readonly string[], botId: string): void {
    if (!this.loaded || this.unreadable) return;
    const at = this.now();
    const next = new Map(this.held);
    let changed = false;
    for (const n of names) {
      const h = next.get(n);
      if (!h) continue;
      next.set(n, { ...h, record: { ...h.record, lastUsed: { botId: botId.slice(0, BOT_ID_MAX), at } } });
      changed = true;
    }
    if (!changed || !this.persist(next)) return;
    this.held = next;
    this.publish(true);
  }

  /** The retired list with one more value (the newest kept, one entry per
   *  value). */
  private retiring(name: string, value: string | null, cipher: string): Retired[] {
    const since = this.now() - RETIRED_KEEP_MS;
    const same = (r: Retired) => r.cipher === cipher || (value !== null && r.value === value);
    const next = [...this.retired.filter((r) => !same(r) && r.at >= since), { name, value, cipher, at: this.now() }];
    return next.slice(-RETIRED_MAX);
  }

  private publish(changed: boolean): void {
    const entries: Array<{ name: string; value: string }> = [];
    for (const r of this.retired) if (r.value != null) entries.push({ name: r.name, value: r.value });
    for (const [name, h] of this.held) if (h.value != null) entries.push({ name, value: h.value });
    setRedactedSecrets(entries);
    if (changed) {
      try {
        this.opts.onChange?.();
      } catch { /* a listener never fails a store write */ }
    }
  }

  private persist(map: ReadonlyMap<string, Held>, retired: readonly Retired[] = this.retired, deleted: readonly Deleted[] = this.deleted): boolean {
    const file = this.opts.file;
    const body = `${JSON.stringify({
      version: SECRETS_FILE_VERSION,
      secrets: [...map.values()].map((h) => h.record),
      ...(retired.length > 0 ? { retired: retired.map((r) => ({ name: r.name, cipher: r.cipher, at: r.at })) } : {}),
      ...(deleted.length > 0 ? { deleted: deleted.map((d) => ({ name: d.name, at: d.at, bots: d.bots, ...(d.connector ? { connector: true } : {}) })) } : {}),
    })}\n`;
    const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
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

let current: SecretStore | null = null;

/** The running app's store (set by the secrets module's start), or null. */
export function getSecretStore(): SecretStore | null {
  return current;
}

export function setSecretStore(next: SecretStore | null): void {
  current = next;
  if (!next) setRedactedSecrets([]);
}
