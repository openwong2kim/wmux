import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { scheduleTokenFileReHarden, secureWriteTokenFile } from '../../shared/security';
import { DeviceAuditLog } from './deviceAudit';

/**
 * M3 — the per-device credential roster for `wmux web` (`devices.json`).
 *
 * Replaces "every paired phone shares the server-wide bearer token" with a
 * credential per device that can be revoked on its own. The credential is
 * `<deviceId>.<secret>`: the id is a public handle, the secret is 256 bits of
 * CSPRNG that exists in exactly two places — the phone, and (as a salted hash)
 * `devices.json`. Parsing that string and checking the server-wide OPERATOR
 * token belong to `WebTerminalServer`; this module only ever answers about a
 * device, and never learns the operator's secret.
 *
 * ── What is on disk, and what is not ───────────────────────────────────────
 * The secret is NEVER persisted. Each record carries a per-device salt and the
 * scrypt output for that secret, so the file is not a credential: an attacker
 * who reads it gains nothing usable, which is what lets the ACL hardening below
 * be deferred instead of blocking the write.
 *
 * ── Hashing parameters, and why they are deliberately modest ───────────────
 * scrypt, N=4096 (2^12), r=8, p=1, 32-byte key, 16-byte per-device salt,
 * parameters stored PER RECORD so they can be raised later without a flag day.
 *
 * N=4096 rather than the password-grade 2^14-2^17 because the input is not a
 * password: `mint` generates 32 CSPRNG bytes (256 bits), so guessing the secret
 * from the hash is infeasible at ANY work factor, and the thing scrypt actually
 * buys here is the per-device salt — no precomputation, no cross-device or
 * cross-file reuse of work.
 *
 * Against that, cost is a real liability. Derivation is `scryptSync`, so it
 * blocks the daemon's event loop — the same loop that pumps PTY bytes to every
 * pane — and anyone who can reach the port can force one derivation per request
 * by presenting a known device id with a wrong secret. 2^12 keeps that at
 * roughly 10-15ms / 4 MiB instead of the ~60-90ms / 16 MiB of 2^14, an order of
 * magnitude less stall per hostile request for no meaningful loss against a
 * 256-bit secret. (`scryptSync` over the async form on purpose: the async one
 * runs on libuv's 4-thread pool, which is shared with every fs operation the
 * daemon makes, so saturating it would stall session writes instead. Neither
 * form is a DEFENCE — request rate limiting at the HTTP layer is — but this one
 * fails in the more predictable direction.)
 *
 * The derived-key cache below removes the cost from LEGITIMATE traffic
 * entirely: a device pays one derivation per daemon boot, then a bare SHA-256.
 */

const STATE_FILE = 'devices.json';

/**
 * What `resolve` answers, and the shape `WebTerminalServer.WebDeviceResolver`
 * consumes STRUCTURALLY — the server deliberately does not import this module,
 * so the two are bound together only where the daemon injects one into the
 * other (`src/daemon/index.ts`), which is where tsc checks they still match.
 *
 * `unknown` and `revoked` are kept distinct so the phone can say "this device
 * was removed" instead of the generic 401 a mistyped credential earns. A wrong
 * SECRET on a known device is `unknown`, never `revoked`: the answer must not
 * tell a guesser which half of the credential was right.
 */
export type DeviceAuthResult =
  | { ok: true; deviceId: string; name?: string }
  | { ok: false; reason: 'unknown' | 'revoked' };

/**
 * The operator's roster view. Carries NO secret material — not the secret, not
 * its hash, not the salt — so it is safe for any surface that can already reach
 * the daemon control pipe.
 */
export interface DeviceSummary {
  deviceId: string;
  /** Operator-chosen label, required at pair time: a roster of UUIDs is unusable. */
  name: string;
  createdAt: number;
  /** Last successful auth (in memory always; persisted at most once a minute). */
  lastSeenAt: number;
  /** Set once, never cleared — revocation is permanent; a device re-pairs to return. */
  revokedAt?: number;
}

/**
 * The one and only time a device secret exists outside the device. Never
 * persisted, never logged, never returned twice — a phone that loses it
 * re-pairs.
 *
 * NO EXPIRY, deliberately (contract §7): a TTL on a phone credential runs out
 * while the phone is in a pocket, with nobody at the desktop to re-pair — the
 * exact situation phone access exists for. Revocation is the whole mechanism.
 */
export interface MintedDevice {
  deviceId: string;
  deviceSecret: string;
  name: string;
  createdAt: number;
}

/** Outcome of `daemon.web.deviceRevoke`. Fail-closed: `ok` means PERSISTED. */
export interface DeviceRevokeResult {
  ok: boolean;
  reason?: 'not-found' | 'persist-failed';
}

/**
 * Separator between the public handle and the secret in `<deviceId>.<secret>`.
 * The server owns the parsing (it holds the private twin of this constant); the
 * store only needs it to refuse a minted or loaded id that would be ambiguous.
 */
const DEVICE_CREDENTIAL_SEPARATOR = '.';

/** 256 bits of CSPRNG. The reason the KDF work factor can stay modest. */
export const DEVICE_SECRET_BYTES = 32;
export const DEVICE_SALT_BYTES = 16;

export interface DeviceKdfParams {
  algo: 'scrypt';
  N: number;
  r: number;
  p: number;
  keylen: number;
}

/** Parameters NEW records are minted with. Existing records use their own. */
export const DEVICE_KDF: Readonly<DeviceKdfParams> = Object.freeze({
  algo: 'scrypt' as const,
  N: 4096,
  r: 8,
  p: 1,
  keylen: 32,
});

/**
 * scrypt needs 128*N*r bytes (4 MiB at our parameters); Node's default ceiling
 * is 32 MiB. Passed explicitly so a future parameter bump fails loudly at the
 * call site instead of throwing `memory limit exceeded` on a live auth.
 */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/**
 * How many REVOKED records ride along. Active devices are never pruned. Beyond
 * this many revocations the oldest tombstones drop, and a credential from one
 * of them resolves as `unknown` rather than `revoked` — a copy downgrade only;
 * the device is refused either way, and the audit log keeps the full history.
 */
export const REVOKED_HISTORY_CAP = 50;

/**
 * `lastSeenAt` is updated in memory on every successful auth but persisted at
 * most this often per device. Without the throttle a phone holding an SSE
 * stream open would rewrite the roster on every reconnect.
 */
export const LAST_SEEN_PERSIST_MS = 60_000;

/**
 * How long writes are batched before the deferred ACL re-harden runs.
 *
 * Each re-harden spawns PowerShell (or icacls), which costs 1.8-3.8s of
 * background work under AV. Without batching, a burst of writes — a pairing
 * followed by the new device's first `lastSeenAt`, or several devices
 * reconnecting at once — would spawn one per write. The debounce is
 * trailing-edge, so the LAST write of any burst is still hardened within this
 * window; it collapses the count, never skips the tightening.
 */
const HARDEN_DEBOUNCE_MS = 5_000;

/** Verified-secret cache bound. Far more than the devices any human pairs. */
const VERIFIED_CACHE_CAP = 64;

/** Roster labels are operator-facing, not identifiers; bound them. */
const DEVICE_NAME_MAX = 64;

/**
 * Label for a device paired without a name. Exported so the server and any
 * roster UI can recognise it rather than hard-coding the same string.
 */
export const UNNAMED_DEVICE = 'Unnamed device';

interface DeviceRecord {
  deviceId: string;
  name: string;
  /** Hex scrypt output. NOT a secret on its own — see the file header. */
  secretHash: string;
  /** Hex, per device. */
  salt: string;
  kdf: DeviceKdfParams;
  createdAt: number;
  lastSeenAt: number;
  revokedAt?: number;
}

export interface DevicePersistedState {
  version: 1;
  devices: DeviceRecord[];
}

export const EMPTY_DEVICE_STATE: Readonly<DevicePersistedState> = Object.freeze({
  version: 1 as const,
  devices: [] as DeviceRecord[],
});

export function getDeviceStatePath(wmuxDir: string): string {
  return path.join(wmuxDir, STATE_FILE);
}

/**
 * One entry of the in-memory derived-key cache. Never persisted, never logged,
 * and dropped on revoke or on any change to the stored hash.
 *
 * It holds SHA-256 of the secret that already verified, not the secret and not
 * the scrypt output: a later request can be accepted by hashing what it
 * presents (microseconds) and comparing constant-time against this, which is
 * only sound because the entry was created by a full scrypt verification in the
 * first place. `hashHex` pins it to the record it was proven against, so a
 * re-mint can never be authenticated by a stale entry.
 */
interface VerifiedSecret {
  secretDigest: Buffer;
  hashHex: string;
}

export interface DeviceStoreOptions {
  wmuxDir: string;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Clock seam, so tests can age `lastSeenAt` without sleeping. */
  now?: () => number;
}

export class DeviceStore {
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  private readonly audit: DeviceAuditLog;

  /** deviceId → record. A Map because auth MUST be a lookup, never a scan. */
  private readonly devices = new Map<string, DeviceRecord>();
  private readonly verified = new Map<string, VerifiedSecret>();
  private readonly lastSeenPersistedAt = new Map<string, number>();
  private hardenTimer: NodeJS.Timeout | null = null;

  // Observability for the tests: proof that the cache elides derivations, and
  // that a wrong secret is never short-circuited before one.
  private derivations = 0;
  private cacheHits = 0;

  constructor(opts: DeviceStoreOptions) {
    this.filePath = getDeviceStatePath(opts.wmuxDir);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => {});
    this.audit = new DeviceAuditLog(opts.wmuxDir, this.now, (level, msg) => this.log(level, msg));
    for (const record of loadDeviceState(this.filePath, this.log).devices) {
      this.devices.set(record.deviceId, record);
    }
  }

  // --- roster ---------------------------------------------------------------

  /** The operator's view. Never carries hashes or salts. */
  list(): DeviceSummary[] {
    return [...this.devices.values()]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((d) => ({
        deviceId: d.deviceId,
        name: d.name,
        createdAt: d.createdAt,
        lastSeenAt: d.lastSeenAt,
        ...(d.revokedAt !== undefined ? { revokedAt: d.revokedAt } : {}),
      }));
  }

  /**
   * Mint a credential. Persists BEFORE returning: a secret handed to a phone
   * that the roster forgot on restart is a device that can never authenticate
   * and cannot be revoked from the roster either, so the write failing has to
   * fail the pairing. This is the only path that ever produces a device secret.
   *
   * THROWS when the roster cannot be written, rather than returning a partial
   * result — there is no half-paired device, and `/pair` turns the throw into a
   * 500 without burning the operator's code.
   *
   * `async` for the caller's sake, not ours: the work inside is synchronous
   * (`secureWriteTokenFile` shells out to icacls and has no async twin), but the
   * HTTP handler awaits this, and a promise-returning signature leaves room to
   * move the write off the event loop later without touching that call site.
   */
  async mint(params: { name?: string } = {}): Promise<MintedDevice> {
    const name = params.name ?? '';
    const at = this.now();
    const secret = crypto.randomBytes(DEVICE_SECRET_BYTES).toString('base64url');
    const salt = crypto.randomBytes(DEVICE_SALT_BYTES);
    const kdf: DeviceKdfParams = { ...DEVICE_KDF };
    let deviceId = crypto.randomUUID();
    while (this.devices.has(deviceId)) deviceId = crypto.randomUUID();

    const record: DeviceRecord = {
      deviceId,
      name: sanitizeName(name),
      secretHash: derive(secret, salt, kdf).toString('hex'),
      salt: salt.toString('hex'),
      kdf,
      createdAt: at,
      lastSeenAt: at,
    };
    this.derivations += 1;

    this.devices.set(deviceId, record);
    if (!this.persist()) {
      // Roll the roster back so an in-memory-only device cannot authenticate
      // against a secret nothing on disk knows about.
      this.devices.delete(deviceId);
      throw new Error('could not persist the device roster; pairing refused');
    }
    // Seed the cache from the secret we just generated, so this device's very
    // first request costs a SHA-256 rather than the boot-time scrypt.
    this.rememberVerified(deviceId, sha256(Buffer.from(secret, 'utf8')), record.secretHash);
    // Seed the lastSeenAt throttle too: the record we just wrote already says
    // `lastSeenAt === createdAt`, so letting the device's first request rewrite
    // the whole roster would buy a timestamp that is already correct.
    this.lastSeenPersistedAt.set(deviceId, at);
    this.audit.append({ event: 'pair', deviceId, name: record.name });
    this.log('info', `[web] paired device "${record.name}" (${deviceId})`);
    return { deviceId, deviceSecret: secret, name: record.name, createdAt: at };
  }

  /**
   * Revoke a device. FAIL-CLOSED: `ok` is true only once the revocation is on
   * disk, because an operator who is told "revoked" will stop worrying about
   * that phone.
   *
   * A failed write keeps the in-memory revocation anyway — the device stops
   * working NOW, and the honest report is that the change may not survive a
   * restart. Reverting it would leave a device the operator just tried to kill
   * still serving traffic in the process that is running.
   */
  revoke(deviceId: string): DeviceRevokeResult {
    const record = this.devices.get(deviceId);
    if (!record) return { ok: false, reason: 'not-found' };
    if (record.revokedAt !== undefined) {
      // Already revoked (and already persisted) — idempotent success, so a
      // retry after a transient failure reports the truth.
      this.forgetVerified(deviceId);
      return { ok: true };
    }

    record.revokedAt = this.now();
    // Drop the cached verification FIRST: nothing may be able to authenticate
    // as this device between here and the notification, whatever the disk does.
    this.forgetVerified(deviceId);
    this.pruneRevoked();

    if (!this.persist()) {
      this.log('error', `[web] revoke of ${deviceId} could not be persisted; it is blocked in memory only`);
      return { ok: false, reason: 'persist-failed' };
    }
    this.audit.append({ event: 'revoke', deviceId, name: record.name });
    this.log('info', `[web] revoked device "${record.name}" (${deviceId})`);
    return { ok: true };
  }

  // --- authentication -------------------------------------------------------

  /**
   * Resolve one device credential. Total and never throws — an unanswerable
   * roster is an auth failure, never a 500 on the route behind it.
   *
   * The server splits `<deviceId>.<secret>` and checks the operator token
   * itself; this is only ever asked about a DEVICE. Order is deliberate:
   *
   *   1. Look the device up BY ID — a Map hit, never a scan over the roster.
   *      A miss is `unknown` with no derivation at all: the id is a public
   *      handle, so answering fast leaks nothing, and a garbage id must not be
   *      a lever for CPU work.
   *   2. Revoked → `revoked` WITHOUT verifying the secret. Verifying first
   *      would be strictly worse: a revoked phone reconnects in a loop, and
   *      every retry would force a full scrypt. The reason is only reachable by
   *      someone holding the 128-bit random id we handed to that device.
   *   3. Otherwise verify constant-time (see `verify`).
   *
   * A wrong secret on a KNOWN device answers `unknown`, not `revoked` — the
   * 401 body never tells a guesser which half of the credential was right.
   */
  resolve(deviceId: string, secret: string): DeviceAuthResult {
    const record = this.devices.get(deviceId);
    if (!record) {
      this.audit.append({ event: 'auth-failure', deviceId, reason: 'unknown' });
      return REJECT_UNKNOWN;
    }
    if (record.revokedAt !== undefined) {
      this.audit.append({ event: 'auth-failure', deviceId, reason: 'revoked' });
      return { ok: false, reason: 'revoked' };
    }
    if (!this.verify(record, secret)) {
      this.audit.append({ event: 'auth-failure', deviceId, reason: 'unknown' });
      return REJECT_UNKNOWN;
    }
    return { ok: true, deviceId, name: record.name };
  }

  /**
   * Constant-time verification of a presented secret against a stored record.
   *
   * There is NO branch on the presented secret's length anywhere on this path.
   * scrypt maps an input of any length to exactly `kdf.keylen` bytes, so the
   * comparison is fixed-length by construction and every wrong secret — empty,
   * one character, or a megabyte — costs the same derivation and reaches the
   * same `timingSafeEqual`. The one length check below is against the STORED
   * hash (a corrupt record), never against user input.
   */
  private verify(record: DeviceRecord, secret: string): boolean {
    const secretBuf = Buffer.from(secret, 'utf8');
    const digest = sha256(secretBuf);

    const cached = this.verified.get(record.deviceId);
    if (
      cached &&
      cached.hashHex === record.secretHash &&
      crypto.timingSafeEqual(digest, cached.secretDigest)
    ) {
      this.cacheHits += 1;
      return true;
    }

    let derived: Buffer;
    try {
      this.derivations += 1;
      derived = derive(secretBuf, Buffer.from(record.salt, 'hex'), record.kdf);
    } catch (err) {
      // Unusable parameters on a record we cannot verify against — refuse
      // rather than accept. Records are validated on load, so this is a
      // belt-and-braces path.
      this.log('warn', `[web] device ${record.deviceId} hash could not be derived: ${errMsg(err)}`);
      return false;
    }

    const expected = Buffer.from(record.secretHash, 'hex');
    if (expected.length !== derived.length) return false;
    const ok = crypto.timingSafeEqual(derived, expected);
    if (ok) this.rememberVerified(record.deviceId, digest, record.secretHash);
    return ok;
  }

  /**
   * Note a successful auth. Always in memory; on disk at most once a minute per
   * device, because `lastSeenAt` is a convenience for the roster UI and is not
   * worth a write per request.
   */
  touch(deviceId: string): void {
    const record = this.devices.get(deviceId);
    if (!record || record.revokedAt !== undefined) return;
    const at = this.now();
    record.lastSeenAt = at;
    const persistedAt = this.lastSeenPersistedAt.get(deviceId) ?? 0;
    if (at - persistedAt < LAST_SEEN_PERSIST_MS) return;
    this.lastSeenPersistedAt.set(deviceId, at);
    // Best-effort: a lost `lastSeenAt` costs a stale timestamp in the roster,
    // nothing more, so this one does not report failure to the caller.
    this.persist();
  }

  /** Test/diagnostic view of the KDF cache. Holds no secret material. */
  stats(): { derivations: number; cacheHits: number; cacheSize: number; devices: number } {
    return {
      derivations: this.derivations,
      cacheHits: this.cacheHits,
      cacheSize: this.verified.size,
      devices: this.devices.size,
    };
  }

  // --- internals ------------------------------------------------------------

  private rememberVerified(deviceId: string, secretDigest: Buffer, hashHex: string): void {
    this.verified.set(deviceId, { secretDigest, hashHex });
    if (this.verified.size > VERIFIED_CACHE_CAP) {
      const oldest = this.verified.keys().next();
      if (!oldest.done) this.verified.delete(oldest.value);
    }
  }

  private forgetVerified(deviceId: string): void {
    this.verified.delete(deviceId);
  }

  /** Keep every active device; keep only the newest revoked tombstones. */
  private pruneRevoked(): void {
    const revoked = [...this.devices.values()]
      .filter((d) => d.revokedAt !== undefined)
      .sort((a, b) => (b.revokedAt ?? 0) - (a.revokedAt ?? 0));
    for (const stale of revoked.slice(REVOKED_HISTORY_CAP)) {
      this.devices.delete(stale.deviceId);
      this.forgetVerified(stale.deviceId);
    }
  }

  /**
   * Write the roster. 0600 everywhere, plus a restrictive Windows DACL — but
   * NEVER a synchronous DACL rebuild on an existing file, which measured
   * 1.8-3.8s under AV (it shells out to PowerShell) and would land that stall
   * on a pairing, a revocation, or a `lastSeenAt` refresh.
   *
   *   - First creation → `secureWriteTokenFile`, which takes the fresh-file
   *     fast path (icacls, ~50-100ms) and fails CLOSED, deleting the file if it
   *     cannot lock it down. It happens once, on an operator-initiated pairing,
   *     never on the boot path (boot only reads).
   *   - Every later write → atomic tmp+rename at 0600, then
   *     `scheduleTokenFileReHarden` to tighten the new inode's DACL
   *     asynchronously.
   *
   * The deferred window is acceptable here in a way it would not be for a token
   * file: this file holds no secret. Salts and scrypt outputs are useless
   * without a 256-bit secret that is never written down, so a reader who wins
   * the race between rename and re-harden learns the roster, not a credential.
   *
   * Returns false instead of throwing; every caller decides for itself whether
   * a failed write is fatal (`mint` and `revoke` say yes, `touch` says no).
   */
  /**
   * Batch the deferred DACL re-harden (see HARDEN_DEBOUNCE_MS). Unref'd: a
   * permission tightening must never be the reason a process stays alive, and
   * the file it protects holds no secret material.
   */
  private scheduleHarden(): void {
    if (this.hardenTimer) return;
    this.hardenTimer = setTimeout(() => {
      this.hardenTimer = null;
      scheduleTokenFileReHarden(this.filePath);
    }, HARDEN_DEBOUNCE_MS);
    this.hardenTimer.unref?.();
  }

  private persist(): boolean {
    const state: DevicePersistedState = { version: 1, devices: [...this.devices.values()] };
    const payload = JSON.stringify(state, null, 2);
    const tmp = `${this.filePath}.tmp`;
    try {
      if (!fs.existsSync(this.filePath)) {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        secureWriteTokenFile(this.filePath, payload);
        return true;
      }
      fs.writeFileSync(tmp, payload, { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
      this.scheduleHarden();
      return true;
    } catch (err) {
      this.log('error', `[web] could not write the device roster: ${errMsg(err)}`);
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        /* ignore cleanup errors */
      }
      return false;
    }
  }
}

/**
 * Frozen so the shared instance cannot be mutated by a caller into something
 * that reads as a success.
 */
const REJECT_UNKNOWN: DeviceAuthResult = Object.freeze({
  ok: false as const,
  reason: 'unknown' as const,
});

function derive(secret: string | Buffer, salt: Buffer, kdf: DeviceKdfParams): Buffer {
  return crypto.scryptSync(secret, salt, kdf.keylen, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: SCRYPT_MAXMEM,
  });
}

function sha256(input: Buffer): Buffer {
  return crypto.createHash('sha256').update(input).digest();
}

/**
 * Operator-supplied labels are display text, not identifiers: trim, drop
 * control characters (this string is echoed into JSONL audit lines and an HTTP
 * response), and bound the length. An empty name would produce exactly the
 * roster-of-UUIDs the naming requirement exists to prevent, so it gets a
 * placeholder rather than being rejected — pairing must not fail on a label.
 *
 * The placeholder reads as the anomaly it is, so an operator scanning the
 * roster can tell "I never named this" apart from a real label. It is only
 * reachable from the pre-M3 pairing paths (a code minted by the lazy
 * regeneration in `handlePair`, or by `pairRefresh`, carries no pending name);
 * `daemon.web.pairStart` refuses an empty name outright.
 */
function sanitizeName(name: unknown): string {
  const raw = typeof name === 'string' ? name : '';
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return UNNAMED_DEVICE;
  return cleaned.length > DEVICE_NAME_MAX ? cleaned.slice(0, DEVICE_NAME_MAX) : cleaned;
}

/**
 * Read the roster. Any failure — missing, unreadable, malformed JSON, wrong
 * types — degrades to an EMPTY roster rather than throwing: a corrupt file must
 * never keep the daemon from booting, and "no device is paired" is the safe
 * direction for a credential store. The operator re-pairs; nothing is granted.
 */
export function loadDeviceState(
  filePath: string,
  log: (level: 'info' | 'warn' | 'error', msg: string) => void = () => {},
): DevicePersistedState {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return { version: 1, devices: [] };
  }
  try {
    const parsed: unknown = JSON.parse(raw, (key, value) => {
      // Prototype pollution guard (mirrors config.ts / webStateStore).
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
      return value;
    });
    const state = coerceDeviceState(parsed);
    if (state.devices.length === 0 && raw.trim()) {
      log('warn', `[web] ${path.basename(filePath)} held no usable device records; roster is empty`);
    }
    return state;
  } catch {
    log('warn', `[web] ${path.basename(filePath)} is malformed; starting with an empty roster`);
    return { version: 1, devices: [] };
  }
}

/**
 * Per-record coercion. Unlike webStateStore's per-FIELD fallback, a record
 * missing or mangling ANY field that authentication depends on — id, hash,
 * salt, KDF parameters — is DROPPED, the discipline approvalStore uses: there
 * is no safe default for "what secret does this device hold", and a record we
 * cannot verify against correctly would reject the real device anyway while
 * occupying its id. Dropping makes it honestly `unknown`.
 */
export function coerceDeviceState(parsed: unknown): DevicePersistedState {
  if (typeof parsed !== 'object' || parsed === null) return { version: 1, devices: [] };
  const o = parsed as Record<string, unknown>;
  const rawList = Array.isArray(o['devices']) ? o['devices'] : [];
  const devices: DeviceRecord[] = [];
  const seen = new Set<string>();
  for (const raw of rawList) {
    const record = coerceDevice(raw);
    // A duplicate id would make lookup-by-id ambiguous. First occurrence wins.
    if (!record || seen.has(record.deviceId)) continue;
    seen.add(record.deviceId);
    devices.push(record);
  }
  return { version: 1, devices };
}

function coerceDevice(raw: unknown): DeviceRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const deviceId = typeof o['deviceId'] === 'string' ? o['deviceId'] : '';
  const secretHash = typeof o['secretHash'] === 'string' ? o['secretHash'] : '';
  const salt = typeof o['salt'] === 'string' ? o['salt'] : '';
  const kdf = coerceKdf(o['kdf']);
  const createdAt =
    typeof o['createdAt'] === 'number' && Number.isFinite(o['createdAt']) ? o['createdAt'] : NaN;
  // An id carrying the separator could never be presented unambiguously.
  if (
    !deviceId ||
    deviceId.includes(DEVICE_CREDENTIAL_SEPARATOR) ||
    !isHex(secretHash) ||
    !isHex(salt) ||
    !kdf ||
    !Number.isFinite(createdAt)
  ) {
    return null;
  }

  const record: DeviceRecord = {
    deviceId,
    name: sanitizeName(o['name']),
    secretHash,
    salt,
    kdf,
    createdAt,
    lastSeenAt:
      typeof o['lastSeenAt'] === 'number' && Number.isFinite(o['lastSeenAt'])
        ? o['lastSeenAt']
        : createdAt,
  };
  // Any truthy finite revokedAt keeps the device refused. A malformed one is
  // treated as REVOKED rather than active: fail-closed is the only safe read of
  // "this record may have been revoked".
  if ('revokedAt' in o && o['revokedAt'] !== undefined && o['revokedAt'] !== null) {
    record.revokedAt =
      typeof o['revokedAt'] === 'number' && Number.isFinite(o['revokedAt'])
        ? o['revokedAt']
        : createdAt;
  }
  return record;
}

function coerceKdf(raw: unknown): DeviceKdfParams | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o['algo'] !== 'scrypt') return null;
  const N = positiveInt(o['N']);
  const r = positiveInt(o['r']);
  const p = positiveInt(o['p']);
  const keylen = positiveInt(o['keylen']);
  if (!N || !r || !p || !keylen) return null;
  // Bound what we will hand scrypt: a hand-edited record must not be able to
  // ask for a derivation that stalls the daemon or blows past maxmem.
  if (N > 1 << 20 || r > 32 || p > 16 || keylen > 128) return null;
  return { algo: 'scrypt', N, r, p, keylen };
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function isHex(value: string): boolean {
  return value.length > 0 && value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
