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
  | { ok: true; deviceId: string; name?: string; allowInput: boolean }
  | { ok: false; reason: 'unknown' | 'revoked' };

export type DeviceBatchRevocationCause =
  | 'token-rotation'
  | 'transport-change'
  | 'operator-stop';

interface PendingRevocationAudit {
  name?: string;
  reason?: DeviceBatchRevocationCause;
}

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
  /** Resolved input grant — what this device can actually do right now. */
  allowInput: boolean;
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
  /** The grant this device was minted with, echoed so the pairing surface can confirm it. */
  allowInput: boolean;
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
 * APNs device tokens are 32 bytes of hex today; Apple reserves the right to
 * grow them. Same bound the relay applies, so a token this store accepts cannot
 * be one the relay refuses.
 */
const APNS_TOKEN_PATTERN = /^[0-9a-f]{64,200}$/;

/** X25519 public key size. Mirrors PUSH_X25519_KEY_BYTES in pushEnvelope. */
const PUSH_PUBLIC_KEY_BYTES = 32;

/**
 * Label for a device paired without a name. Exported so the server and any
 * roster UI can recognise it rather than hard-coding the same string.
 */
export const UNNAMED_DEVICE = 'Unnamed device';

/**
 * What a device registers so the daemon can push to it. NEITHER FIELD IS A
 * SECRET, which is the whole reason push works this way.
 *
 * The APNs token is a routing handle Apple hands out and rotates; the public key
 * is the public half of a pair whose private half never leaves the phone's
 * Keychain. So adding these keeps the header's claim intact — someone who reads
 * `devices.json` still gains nothing usable, and the deferred ACL hardening
 * stays defensible. Storing a shared push secret here instead would have voided
 * both.
 */
export interface DevicePushRegistration {
  /** APNs device token, lowercase hex. Rotates; a re-register replaces it. */
  apnsToken: string;
  /** X25519 public key, base64 of 32 raw bytes. */
  publicKey: string;
  /** When the device last told us these. */
  registeredAt: number;
  /**
   * Which APNs stage minted `apnsToken`, as the app read it out of its own
   * embedded provisioning profile's `aps-environment`.
   *
   * PER DEVICE, because the alternative does not work. A token does not say
   * which stage it came from and the two Apple hosts reject each other's, so a
   * relay configured with one answer for the whole deployment means a
   * TestFlight build and a cable-installed build on the same tailnet take turns
   * silently breaking each other's push — the symptom is a `BadDeviceToken`
   * that traces back to nothing.
   *
   * ABSENT IS NOT A DEFAULT TO FILL IN. It means the build could not name its
   * own stage (the simulator has no profile) or predates the field, and a stage
   * sent on a hunch routes the token to the wrong host. Absent is carried
   * through as absent, and the relay then uses whatever it was configured with,
   * which is exactly what happened before this field existed.
   */
  apnsEnvironment?: 'development' | 'production';
}

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
  /**
   * Whether this device may type, spawn/close panes, toggle the permission
   * gate, and approve tool permissions — the one grant `--allow-input` used to
   * hand out server-wide.
   *
   * OPTIONAL, and absent means GRANTED. Every record minted since this field
   * existed writes it explicitly, so `undefined` can only be a roster written
   * before it did — a device that has been typing all along under the server
   * flag. Defaulting those to read-only would silently mute every paired phone
   * on upgrade, which is a data-loss-shaped surprise for a field nobody chose.
   * The server flag is still the ceiling, so grandfathering cannot grant more
   * than the operator already had switched on.
   */
  allowInput?: boolean;
  push?: DevicePushRegistration;
}

/** Resolve a record's grant, applying the grandfather rule in one place. */
function recordAllowsInput(record: DeviceRecord): boolean {
  return record.allowInput ?? true;
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
  /**
   * Revocations blocked in memory but not yet known to be durable. The map also
   * retains their audit metadata across a failed write: `persist()` writes the
   * whole roster, then flushes every entry only after all tombstones land.
   *
   * Without this, a retry after a transient failure could report success while
   * losing the original batch cause from the audit trail.
   */
  private readonly pendingRevocationAudits = new Map<string, PendingRevocationAudit>();

  // Observability for the tests: proof that the cache elides derivations, and
  // that a wrong secret is never short-circuited before one.
  private derivations = 0;
  private cacheHits = 0;

  constructor(opts: DeviceStoreOptions) {
    this.filePath = getDeviceStatePath(opts.wmuxDir);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((): void => undefined);
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
        // RESOLVED, not the raw field: the roster UI must show what the device
        // can actually do, and a legacy record's absent field means granted.
        allowInput: recordAllowsInput(d),
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
  async mint(params: { name?: string; allowInput?: boolean } = {}): Promise<MintedDevice> {
    const name = params.name ?? '';
    // Written EXPLICITLY on every new record, never left absent. That is what
    // keeps an absent field meaning "roster predates this field" rather than
    // "a recent pairing that happened not to say" — the only way the
    // grandfather rule above stays sound.
    //
    // Defaults to FALSE, which is deliberately NOT the grandfather default.
    // Those are two different questions: a record already on disk belongs to a
    // device that has been typing all along, while a fresh mint with no stated
    // grant is a caller who did not decide. Read-only is the recoverable
    // outcome — the operator grants it from the roster — where a keyboard
    // handed out by omission is not noticed until something has been typed.
    const allowInput = params.allowInput === true;
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
      allowInput,
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
    this.log(
      'info',
      `[web] paired device "${record.name}" (${deviceId}) — input ${allowInput ? 'ALLOWED' : 'read-only'}`,
    );
    return { deviceId, deviceSecret: secret, name: record.name, createdAt: at, allowInput };
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
      this.forgetVerified(deviceId);
      // Idempotent — but only report success once the tombstone is DURABLE. If
      // an earlier write failed, retry it here rather than answering `ok` for a
      // revocation that a restart would undo.
      if (this.pendingRevocationAudits.size > 0 && !this.persist()) {
        return { ok: false, reason: 'persist-failed' };
      }
      return { ok: true };
    }

    record.revokedAt = this.now();
    // Drop the cached verification FIRST: nothing may be able to authenticate
    // as this device between here and the notification, whatever the disk does.
    this.forgetVerified(deviceId);
    this.pendingRevocationAudits.set(deviceId, { name: record.name });
    this.pruneRevoked();

    if (!this.persist()) {
      this.log('error', `[web] revoke of ${deviceId} could not be persisted; it is blocked in memory only`);
      return { ok: false, reason: 'persist-failed' };
    }
    this.log('info', `[web] revoked device "${record.name}" (${deviceId})`);
    return { ok: true };
  }

  /**
   * Change one device's input grant.
   *
   * Fail-closed on the same terms as `revoke`: `ok` only once the change is on
   * disk, because an operator told "read-only now" will stop worrying about
   * that phone, and a grant that a restart resurrects is exactly the lie the
   * revoke path already refuses to tell.
   *
   * The in-memory record is updated FIRST and kept even when the write fails.
   * The two directions fail in opposite ways and only one of them is safe:
   * REVOKING input must take effect immediately whatever the disk does (the
   * next request is gated on the record, so the device stops typing now, and
   * `ok:false` tells the operator to retry before a restart). GRANTING input
   * that fails to persist is the same shape, and it is fine — the extra
   * capability evaporates on restart rather than outliving the roster.
   *
   * No cache invalidation: `verified` caches the SECRET derivation, which this
   * does not touch, and the grant is read from the record on every request.
   */
  setInput(deviceId: string, allowInput: boolean): { ok: boolean; reason?: 'not-found' | 'revoked' | 'persist-failed' } {
    const record = this.devices.get(deviceId);
    if (!record) return { ok: false, reason: 'not-found' };
    // A tombstone has no capabilities to adjust. Silently "granting" input to a
    // revoked device would put a row on screen claiming a power it cannot use.
    if (record.revokedAt !== undefined) return { ok: false, reason: 'revoked' };

    if (recordAllowsInput(record) === allowInput) {
      // Already there. Still force the field to exist, so a legacy record stops
      // depending on the grandfather rule the moment the operator touches it.
      if (record.allowInput === undefined) {
        record.allowInput = allowInput;
        if (!this.persist()) return { ok: false, reason: 'persist-failed' };
      }
      return { ok: true };
    }

    record.allowInput = allowInput;
    if (!this.persist()) {
      this.log(
        'error',
        `[web] input grant for ${deviceId} could not be persisted; it is ${allowInput ? 'granted' : 'blocked'} in memory only`,
      );
      return { ok: false, reason: 'persist-failed' };
    }
    this.log('info', `[web] device "${record.name}" (${deviceId}) input ${allowInput ? 'ALLOWED' : 'set read-only'}`);
    return { ok: true };
  }

  /**
   * Revoke EVERY device still active. Backs `wmux web --new-token`, whose CLI
   * help promises exactly this ("Mint a fresh access token, revoking every
   * device already paired"), encrypted/plaintext transport transitions, and
   * explicit stop. The caller-supplied cause keeps those paths distinct in the
   * audit trail.
   *
   * That promise used to hold for free: before per-device credentials every
   * phone authenticated with the operator's own token, so rotating it locked
   * all of them out in one step. Once a device could authenticate on its own
   * `deviceId.secret`, rotation stopped touching them and the help text became
   * false — the operator was told the phones were revoked while every one of
   * them stayed authorized. This method is what makes it true again.
   *
   * ONE persist for the whole batch, not one per device: the roster is written
   * whole, and a per-device write would turn a 20-phone rotation into 20
   * synchronous writes on the daemon's event loop for no added durability.
   *
   * Fail-closed the same way `revoke` is: `ok` means the tombstones reached
   * disk. The devices are blocked in memory either way, so the caller can cut
   * their streams regardless of what the disk did.
   */
  revokeAll(
    cause: DeviceBatchRevocationCause = 'token-rotation',
  ): { ok: boolean; revoked: string[]; reason?: 'persist-failed' } {
    const at = this.now();
    const revoked: string[] = [];
    for (const record of this.devices.values()) {
      if (record.revokedAt !== undefined) continue;
      record.revokedAt = at;
      this.forgetVerified(record.deviceId);
      revoked.push(record.deviceId);
      this.pendingRevocationAudits.set(record.deviceId, { reason: cause });
    }
    if (revoked.length === 0 && this.pendingRevocationAudits.size === 0) {
      return { ok: true, revoked };
    }

    this.pruneRevoked();
    if (!this.persist()) {
      this.log(
        'error',
        `[web] revoked ${revoked.length} device(s) in memory but could not persist the roster; ` +
          'they will come back on the next daemon start',
      );
      return { ok: false, revoked, reason: 'persist-failed' };
    }
    if (revoked.length > 0) {
      this.log('info', `[web] revoked ${revoked.length} paired device(s) on ${cause}`);
    }
    return { ok: true, revoked };
  }

  /**
   * Record where to push to this device, and the key to seal for it.
   *
   * Replaces wholesale rather than merging: APNs rotates tokens and the app may
   * regenerate its key pair (a Keychain reset, a reinstall), and a half-updated
   * registration would seal to a key the phone no longer holds — a notification
   * that arrives and cannot be read, which looks exactly like a bug in the
   * extension.
   *
   * Refuses on an unknown or revoked device: a revoked phone must not be able to
   * keep itself reachable.
   */
  registerPush(
    deviceId: string,
    input: { apnsToken: string; publicKey: string; apnsEnvironment?: unknown },
  ): {
    ok: boolean;
    reason?: 'not-found' | 'revoked' | 'bad-token' | 'bad-key' | 'bad-apns-environment' | 'persist-failed';
  } {
    const record = this.devices.get(deviceId);
    if (!record) return { ok: false, reason: 'not-found' };
    if (record.revokedAt !== undefined) return { ok: false, reason: 'revoked' };

    const apnsToken = typeof input?.apnsToken === 'string' ? input.apnsToken.trim().toLowerCase() : '';
    if (!APNS_TOKEN_PATTERN.test(apnsToken)) return { ok: false, reason: 'bad-token' };

    const publicKey = typeof input?.publicKey === 'string' ? input.publicKey.trim() : '';
    if (!isBase64Bytes(publicKey, PUSH_PUBLIC_KEY_BYTES)) return { ok: false, reason: 'bad-key' };

    // Rejected rather than dropped when it is neither of Apple's two words: a
    // silently ignored stage is a token routed to the wrong host, and the app
    // omits the field entirely when it cannot name its own stage — so anything
    // present and unrecognised is a client bug worth saying out loud.
    const rawEnv = input?.apnsEnvironment;
    if (rawEnv !== undefined && rawEnv !== 'development' && rawEnv !== 'production') {
      return { ok: false, reason: 'bad-apns-environment' };
    }

    const previous = record.push;
    record.push = {
      apnsToken,
      publicKey,
      registeredAt: this.now(),
      // A re-registration replaces the record wholesale, so an omitted stage
      // clears a previously known one rather than inheriting it. That is the
      // honest reading: the build now talking to us is the one whose token this
      // is, and it did not name a stage.
      ...(rawEnv ? { apnsEnvironment: rawEnv } : {}),
    };
    if (!this.persist()) {
      // Roll back rather than push to a token that a restart forgets: the app
      // would believe it is registered and silently receive nothing.
      if (previous) record.push = previous;
      else delete record.push;
      return { ok: false, reason: 'persist-failed' };
    }
    this.log('info', `[web] push registration updated for "${record.name}" (${deviceId})`);
    return { ok: true };
  }

  /**
   * Every device that can currently be pushed to. Revoked devices are excluded
   * here rather than filtered by the caller — a revocation that still reached a
   * phone would be the same failure as one that left its stream open.
   */
  pushTargets(): Array<{ deviceId: string; name: string; push: DevicePushRegistration }> {
    const out: Array<{ deviceId: string; name: string; push: DevicePushRegistration }> = [];
    for (const record of this.devices.values()) {
      if (record.revokedAt !== undefined || !record.push) continue;
      out.push({ deviceId: record.deviceId, name: record.name, push: { ...record.push } });
    }
    return out;
  }

  /**
   * Drop a registration whose APNs token Apple reported as dead (a 410).
   *
   * Keeping it would mean re-sending to a token Apple has already told us is
   * gone, which is exactly the traffic that gets a provider throttled.
   */
  forgetPush(deviceId: string): boolean {
    const record = this.devices.get(deviceId);
    if (!record?.push) return false;
    const previous = record.push;
    delete record.push;
    if (!this.persist()) {
      // Same failure shape as a revoke that could not be written: reporting
      // success here would mean the dead token reappears on the next start and
      // gets sent again — which is precisely the traffic this method exists to
      // stop, and the kind that gets a provider throttled. Roll back so the
      // in-memory view matches the disk rather than silently diverging.
      record.push = previous;
      this.log('error', `[web] could not persist the dead-token removal for ${deviceId}`);
      return false;
    }
    this.log('info', `[web] dropped a dead push registration for ${deviceId}`);
    return true;
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
      // No `coalesceKey`: the id matched nothing, so it is caller-chosen text
      // and every distinct one shares a single throttling bucket. See
      // UNKNOWN_SUBJECT_KEY — keying on it is what let a rotating id turn each
      // request into a synchronous write.
      this.audit.append({ event: 'auth-failure', deviceId, reason: 'unknown' });
      return REJECT_UNKNOWN;
    }
    // Past this point the id names a real record, so the bucket is bounded by
    // the roster and per-device throttling is both safe and more useful.
    if (record.revokedAt !== undefined) {
      this.audit.append({ event: 'auth-failure', deviceId, reason: 'revoked' }, { coalesceKey: deviceId });
      return { ok: false, reason: 'revoked' };
    }
    if (!this.verify(record, secret)) {
      this.audit.append({ event: 'auth-failure', deviceId, reason: 'unknown' }, { coalesceKey: deviceId });
      return REJECT_UNKNOWN;
    }
    return { ok: true, deviceId, name: record.name, allowInput: recordAllowsInput(record) };
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

  private flushPendingRevocationAudits(): void {
    for (const [deviceId, entry] of this.pendingRevocationAudits) {
      this.audit.append({ event: 'revoke', deviceId, ...entry });
    }
    this.pendingRevocationAudits.clear();
  }

  private persist(): boolean {
    const state: DevicePersistedState = { version: 1, devices: [...this.devices.values()] };
    const payload = JSON.stringify(state, null, 2);
    const tmp = `${this.filePath}.tmp`;
    try {
      if (!fs.existsSync(this.filePath)) {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        secureWriteTokenFile(this.filePath, payload);
        this.flushPendingRevocationAudits();
        return true;
      }
      fs.writeFileSync(tmp, payload, { encoding: 'utf-8', mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
      this.flushPendingRevocationAudits();
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
    // eslint-disable-next-line no-control-regex -- matching control characters is the point
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
  log: (level: 'info' | 'warn' | 'error', msg: string) => void = (): void => undefined,
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
  // A malformed push block is DROPPED, not defaulted: the device simply stops
  // being pushable until it re-registers, which it does on every launch. The
  // alternative — keeping a half-read registration — would seal to a key the
  // phone may not hold and deliver a notification it cannot open.
  const push = coercePush(o['push']);
  if (push) record.push = push;
  // Only a real boolean survives. ABSENT is meaningful here and must stay
  // absent — it is what marks a record written before per-device grants
  // existed, which `recordAllowsInput` reads as granted. Coercing anything
  // else (a string, a null from some future serializer) to `false` would mute
  // a device on a malformed field; leaving it absent grandfathers it instead,
  // which matches how every other optional field on this record fails.
  if (typeof o['allowInput'] === 'boolean') record.allowInput = o['allowInput'];
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

function coercePush(raw: unknown): DevicePushRegistration | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const apnsToken = typeof o['apnsToken'] === 'string' ? o['apnsToken'].toLowerCase() : '';
  const publicKey = typeof o['publicKey'] === 'string' ? o['publicKey'] : '';
  if (!APNS_TOKEN_PATTERN.test(apnsToken) || !isBase64Bytes(publicKey, PUSH_PUBLIC_KEY_BYTES)) {
    return null;
  }
  const registeredAt =
    typeof o['registeredAt'] === 'number' && Number.isFinite(o['registeredAt'])
      ? o['registeredAt']
      : 0;
  // Restored, not re-derived. `persist` writes this field, so a loader that
  // dropped it would lose every device's stage on the first daemon restart and
  // silently put the whole roster back on the relay's single `APNS_ENV` — the
  // exact BadDeviceToken this field exists to prevent, reappearing at a moment
  // nobody connects to a registration.
  //
  // Anything that is not one of Apple's two words is IGNORED rather than
  // rejected: a hand-edited or half-written record must degrade to "stage
  // unknown" (which the relay already handles) instead of taking the whole
  // registration down with it, and `registerPush` is where a live client is
  // told its value was wrong.
  const rawEnv = o['apnsEnvironment'];
  const apnsEnvironment = rawEnv === 'development' || rawEnv === 'production' ? rawEnv : undefined;
  return { apnsToken, publicKey, registeredAt, ...(apnsEnvironment ? { apnsEnvironment } : {}) };
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

/** Canonical base64 decoding to exactly `bytes` bytes. */
function isBase64Bytes(value: string, bytes: number): boolean {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) return false;
  const buf = Buffer.from(value, 'base64');
  // Re-encode: `Buffer.from` ignores junk, so length alone is not enough.
  return buf.length === bytes && buf.toString('base64') === value;
}

function isHex(value: string): boolean {
  return value.length > 0 && value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
