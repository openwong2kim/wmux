// ─── The bots' Claude API key — `<wmuxDir>/factory/claude-api-key.json` ────
//
// Settings › Bots can run Claude (SDK) bots on a Claude API key instead of
// the owner's subscription (factory settings `claudeAuth`). The key the owner
// enters is kept here as Electron safeStorage ciphertext in a 0600 file:
// `{version:1, cipher?, last4?, updatedAt?, lastSeen?:{auth, source, at}}`.
// It is its own store, never a bot secret (secretStore.ts): a bot can list
// those and hand them to its workers, and this key goes to one place only,
// the bot's own SDK session env (ClaudeSdkAdapter, apiKey mode).
//
// Main decrypts it on first use and holds it in memory; it is redacted from
// what bots and stores see like a stored secret (secretRedaction.ts), and a
// key replaced or removed stays redacted for the rest of the run (a session
// started before may still hold it). The
// renderer gets whether one is saved and its last four characters, never
// the value (`status()`). Storing is refused when encryption is unavailable
// or, on Linux, the safeStorage backend is `basic_text`, as for bot secrets.
//
// `lastSeen` is the sign-in a bot's session actually ran on, from the SDK's
// `system/init` frame (`apiKeySource`): shown in Settings, so the owner sees
// what their bots really used.
//
// The check (`checkClaudeApiKey`) asks the Anthropic API for its model list
// with the stored key: authenticated, and it spends no tokens.

import fs from 'node:fs';
import path from 'node:path';
import { getWmuxDir } from '../../daemon/config';
import { botClaudeAuthMode, type FactorySettings } from '../../shared/factorySettings';
import { electronSecretCrypto, type SecretCrypto, type SecretCryptoState } from './secretStore';
import { setRedactedClaudeApiKey } from './secretRedaction';
import { getFactorySettings } from './factorySettings';

export const CLAUDE_API_KEY_FILE = 'claude-api-key.json';
const FILE_VERSION = 1 as const;
/** The env name the key reaches the bot's session as, and its redaction marker. */
export const CLAUDE_API_KEY_ENV = 'ANTHROPIC_API_KEY';
const KEY_MIN = 20;
const KEY_MAX = 512;
/** Printable ASCII, no spaces: what an API key is. */
const KEY_RE = /^[\x21-\x7e]+$/;
const SOURCE_RE = /^[A-Za-z0-9_.-]{1,40}$/;
/** Replaced and removed keys still redacted in this run. */
const RETIRED_MAX = 16;

/** Why a bot on the API key does not start: no key is saved here. */
export const CLAUDE_API_KEY_MISSING_MESSAGE =
  'Bots are set to run on a Claude API key, but no key is saved on this computer: add one in Settings › Bots, or switch Bots back to your Claude subscription';
/** Why it does not start: the saved key cannot be decrypted here. */
export const CLAUDE_API_KEY_UNREADABLE_MESSAGE =
  'Bots are set to run on a Claude API key, but the saved key cannot be decrypted on this computer: enter it again in Settings › Bots';

/** The sign-in a bot's session actually ran on. */
export interface ClaudeAuthSeen {
  auth: 'subscription' | 'apiKey';
  /** The SDK's own word for it (`apiKeySource`). */
  source: string;
  at: number;
}

/** What the renderer may know: never the key. */
export interface ClaudeApiKeyStatus {
  set: boolean;
  /** The key's last four characters, when one is saved. */
  last4?: string;
  updatedAt?: number;
  /** Why a key cannot be saved here now. */
  cannotStore?: { code: 'encryption_unavailable' | 'basic_text'; message: string };
  lastSeen?: ClaudeAuthSeen;
}

export type ClaudeApiKeySetResult =
  | { ok: true; status: ClaudeApiKeyStatus }
  | { ok: false; code: 'encryption_unavailable' | 'basic_text' | 'invalid_key' | 'write_failed'; message: string };

/** How a bot's session signs in this turn (ClaudeSdkAdapter `bot.auth`). */
export type BotClaudeAuth =
  | { mode: 'subscription' }
  | { mode: 'apiKey'; apiKey: string }
  | { mode: 'refused'; message: string };

interface StoredFile {
  version: typeof FILE_VERSION;
  cipher?: string;
  last4?: string;
  updatedAt?: number;
  lastSeen?: ClaudeAuthSeen;
}

/** The SDK's `apiKeySource` as the sign-in it means, or null for none
 *  given. `oauth` (and `none`, which older builds reported) is the
 *  subscription; any other source is an API key. Pure. */
export function authOfApiKeySource(source: unknown): ClaudeAuthSeen['auth'] | null {
  if (typeof source !== 'string' || !source) return null;
  return source === 'oauth' || source === 'none' ? 'subscription' : 'apiKey';
}

function cleanSeen(raw: unknown): ClaudeAuthSeen | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if ((r.auth !== 'subscription' && r.auth !== 'apiKey') || typeof r.source !== 'string' || !SOURCE_RE.test(r.source) || typeof r.at !== 'number') return undefined;
  return { auth: r.auth, source: r.source, at: r.at };
}

export interface ClaudeApiKeyStoreOptions {
  file: string;
  crypto: SecretCrypto;
  now?: () => number;
  log?: (msg: string) => void;
}

export class ClaudeApiKeyStore {
  private stored: StoredFile = { version: FILE_VERSION };
  /** undefined: not decrypted yet; null: cannot be decrypted here. */
  private value: string | null | undefined = undefined;
  /** Keys replaced or removed in this run: still redacted, since a bot
   *  session started before keeps the old one. Memory only (never written). */
  private retired: string[] = [];
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(private readonly opts: ClaudeApiKeyStoreOptions) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.warn(`[factory] claude api key: ${m}`));
  }

  /** Read the file. Nothing is decrypted until a bot needs the key: on
   *  macOS the first safeStorage call blocks on the keychain. A missing or
   *  unreadable file is no key (an unreadable one is replaced on save). */
  load(): void {
    this.value = undefined;
    this.publish();
    let raw: unknown = null;
    try {
      raw = JSON.parse(fs.readFileSync(this.opts.file, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') this.log(`${path.basename(this.opts.file)} is unreadable; no key is loaded`);
    }
    const r = raw && typeof raw === 'object' && (raw as { version?: unknown }).version === FILE_VERSION ? (raw as Record<string, unknown>) : {};
    const cipher = typeof r.cipher === 'string' && r.cipher ? r.cipher : undefined;
    this.stored = {
      version: FILE_VERSION,
      ...(cipher ? { cipher } : {}),
      ...(cipher && typeof r.last4 === 'string' && r.last4.length <= 4 ? { last4: r.last4 } : {}),
      ...(cipher && typeof r.updatedAt === 'number' ? { updatedAt: r.updatedAt } : {}),
      ...(cleanSeen(r.lastSeen) ? { lastSeen: cleanSeen(r.lastSeen) } : {}),
    };
  }

  /** Why a key cannot be saved now, or null. */
  private refusal(): Extract<ClaudeApiKeySetResult, { ok: false }> | null {
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

  status(): ClaudeApiKeyStatus {
    const set = !!this.stored.cipher;
    const refusal = this.refusal();
    return {
      set,
      ...(set && this.stored.last4 ? { last4: this.stored.last4 } : {}),
      ...(set && this.stored.updatedAt !== undefined ? { updatedAt: this.stored.updatedAt } : {}),
      ...(refusal && (refusal.code === 'encryption_unavailable' || refusal.code === 'basic_text') ? { cannotStore: { code: refusal.code, message: refusal.message } } : {}),
      ...(this.stored.lastSeen ? { lastSeen: { ...this.stored.lastSeen } } : {}),
    };
  }

  /** The key (main only: a bot's session env), decrypted on first use; null
   *  when none is saved or it cannot be decrypted here. */
  key(): string | null {
    if (!this.stored.cipher) return null;
    if (this.value !== undefined) return this.value;
    let value: string | null = null;
    if (this.refusal() === null) {
      try {
        value = this.opts.crypto.decrypt(Buffer.from(this.stored.cipher, 'base64'));
      } catch {
        value = null;
      }
    }
    if (value === null) this.log('the saved key cannot be decrypted here; enter it again to use it');
    this.value = value;
    this.publish();
    return value;
  }

  /** Whether a key is saved and decrypts here. */
  usable(): boolean {
    return this.key() !== null;
  }

  /** Save (or replace) the key. */
  set(input: unknown): ClaudeApiKeySetResult {
    const key = typeof input === 'string' ? input.trim() : '';
    if (key.length < KEY_MIN || key.length > KEY_MAX || !KEY_RE.test(key)) {
      return { ok: false, code: 'invalid_key', message: 'That does not look like an API key: paste the whole key, with no spaces.' };
    }
    const refusal = this.refusal();
    if (refusal) return refusal;
    let cipher: string;
    try {
      cipher = this.opts.crypto.encrypt(key).toString('base64');
    } catch {
      return { ok: false, code: 'encryption_unavailable', message: 'The key could not be encrypted, so it was not saved.' };
    }
    const next: StoredFile = { ...this.stored, cipher, last4: key.slice(-4), updatedAt: this.now() };
    if (!this.persist(next)) return { ok: false, code: 'write_failed', message: 'The key could not be written to disk.' };
    this.stored = next;
    if (this.value && this.value !== key) this.retire(this.value);
    this.value = key;
    this.publish();
    return { ok: true, status: this.status() };
  }

  /** Forget the key. False when the write failed. Bots set to the API key
   *  stop starting until one is saved again. */
  remove(): boolean {
    const next: StoredFile = { version: FILE_VERSION, ...(this.stored.lastSeen ? { lastSeen: this.stored.lastSeen } : {}) };
    if (!this.persist(next)) return false;
    this.stored = next;
    if (this.value) this.retire(this.value);
    this.value = undefined;
    this.publish();
    return true;
  }

  /** Record the sign-in a bot's session ran on (its `apiKeySource`). Best effort. */
  recordSeen(source: unknown): void {
    const auth = authOfApiKeySource(source);
    if (!auth || typeof source !== 'string') return;
    const seen: ClaudeAuthSeen = { auth, source: SOURCE_RE.test(source) ? source : 'other', at: this.now() };
    const next: StoredFile = { ...this.stored, lastSeen: seen };
    // Shown even when the write fails.
    this.stored = next;
    this.persist(next);
  }

  /** Keep redacting a key a running session may still hold (the newest
   *  kept, one entry per key). */
  private retire(key: string): void {
    this.retired = [...this.retired.filter((k) => k !== key), key].slice(-RETIRED_MAX);
  }

  /** The values redacted now: the current key and the retired ones. */
  private publish(): void {
    const values = [...this.retired, ...(this.value ? [this.value] : [])];
    setRedactedClaudeApiKey(values.map((value) => ({ name: CLAUDE_API_KEY_ENV, value })));
  }

  private persist(body: StoredFile): boolean {
    const file = this.opts.file;
    const tmp = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, `${JSON.stringify(body)}\n`, { encoding: 'utf8', mode: 0o600 });
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

let current: ClaudeApiKeyStore | null = null;

/** The app's store, created and read on first use (after the app is ready:
 *  an IPC call or a bot spawn). */
export function getClaudeApiKeyStore(): ClaudeApiKeyStore {
  if (!current) {
    current = new ClaudeApiKeyStore({ file: path.join(getWmuxDir(), 'factory', CLAUDE_API_KEY_FILE), crypto: electronSecretCrypto() });
    current.load();
  }
  return current;
}

/** Tests only. */
export function __setClaudeApiKeyStoreForTesting(store: ClaudeApiKeyStore | null): void {
  current = store;
}

/** How a Claude (SDK) bot signs in now: the subscription, the saved key, or
 *  a refusal when the API key is chosen and none is usable here. Read on
 *  every turn, so a change in Settings applies to the bot's next turn. */
export function resolveBotClaudeAuth(
  settings: () => Pick<FactorySettings, 'claudeAuth'> = getFactorySettings,
  store: () => Pick<ClaudeApiKeyStore, 'status' | 'key'> = getClaudeApiKeyStore,
): BotClaudeAuth {
  if (botClaudeAuthMode(settings()) !== 'apiKey') return { mode: 'subscription' };
  const s = store();
  if (!s.status().set) return { mode: 'refused', message: CLAUDE_API_KEY_MISSING_MESSAGE };
  const apiKey = s.key();
  return apiKey ? { mode: 'apiKey', apiKey } : { mode: 'refused', message: CLAUDE_API_KEY_UNREADABLE_MESSAGE };
}

/** Record what a bot's session signed in with. Never throws. */
export function recordBotAuthSource(source: unknown): void {
  try {
    getClaudeApiKeyStore().recordSeen(source);
  } catch { /* status only */ }
}

// ── Check connection ──────────────────────────────────────────────────────

export const CLAUDE_API_MODELS_URL = 'https://api.anthropic.com/v1/models?limit=1';
export const CLAUDE_API_VERSION = '2023-06-01';
const CHECK_TIMEOUT_MS = 10_000;

export type ClaudeApiKeyCheck =
  | { ok: true }
  | { ok: false; code: 'no_key' | 'invalid_key' | 'network' | 'error'; status?: number };

/** An HTTP status of the model list as the check's answer: 2xx works, 401
 *  and 403 are a key the API refuses, anything else is the API's error. Pure. */
export function claudeKeyCheckOfStatus(status: number): ClaudeApiKeyCheck {
  if (status >= 200 && status < 300) return { ok: true };
  if (status === 401 || status === 403) return { ok: false, code: 'invalid_key', status };
  return { ok: false, code: 'error', status };
}

/** One authenticated, token-free request with `key`. Never throws, and no
 *  answer carries the key. */
export async function checkClaudeApiKey(
  key: string | null,
  fetchFn: typeof fetch = fetch,
  timeoutMs: number = CHECK_TIMEOUT_MS,
): Promise<ClaudeApiKeyCheck> {
  if (!key) return { ok: false, code: 'no_key' };
  try {
    const res = await fetchFn(CLAUDE_API_MODELS_URL, {
      method: 'GET',
      headers: { 'x-api-key': key, 'anthropic-version': CLAUDE_API_VERSION },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    // The body is not needed; let the connection go.
    try { await res.body?.cancel(); } catch { /* already closed */ }
    return claudeKeyCheckOfStatus(res.status);
  } catch {
    return { ok: false, code: 'network' };
  }
}
