import crypto from 'node:crypto';
import path from 'node:path';
import { atomicWriteJSONSync } from '../util/atomicWrite';
import { scheduleTokenFileReHarden } from '../../shared/security';
import { DEVICE_KDF, DEVICE_SALT_BYTES, DEVICE_SECRET_BYTES, LAST_SEEN_PERSIST_MS, type DeviceKdfParams } from '../web/DeviceStore';
import {
  A2A_REMOTE_RECORD_V,
  formatPeerCredential,
  isHostId,
  parsePeerCredential,
  type A2aPeerRecordV1,
  type HostId,
} from '../../shared/a2aRemote';
import { promisify } from 'node:util';
import {
  errMsg,
  isIsoString,
  isNonEmptyString,
  isPlainObject,
  loadStore,
  sanitizeName,
  storeUnavailable,
  type StoreLog,
} from './storeFile';

/**
 * Server side of cross-host A2A pairing: the joiners this host issued a PEER
 * credential to (`peers.json`). Deliberately a different file and a different
 * class from `DeviceStore` — a peer is never a web device and never becomes a
 * `WebPrincipal`.
 *
 * Secrets are handled like DeviceStore's: 32 CSPRNG bytes handed out once,
 * and only a per-peer salted scrypt output (same `DEVICE_KDF` parameters,
 * stored per record) on disk. Verification is length-independent (scrypt
 * output is fixed-length) and constant-time, with the same SHA-256 cache so
 * legitimate traffic pays one derivation per daemon boot. Unlike DeviceStore,
 * the derivation is the ASYNC `crypto.scrypt` (a wrong secret must not stall
 * the event loop) and wrong secrets are rate-limited per peerId: past
 * `FAILURES_PER_WINDOW` failures in `FAILURE_WINDOW_MS`, `resolve` answers
 * `unknown` without deriving. Derivations are SERIALIZED per peerId, and
 * each one re-checks the cache and the budget once its turn comes, so N
 * concurrent wrong secrets cost at most the budget in derivations (not N in
 * parallel) and N concurrent right ones cost a single derivation.
 *
 * One live peer per hostId: `mint` refuses a hostId that already has an
 * unrevoked peer, so a joiner cannot quietly re-pair as (or over) a host the
 * operator already trusts — the operator revokes first.
 *
 * Corrupt file: FAIL-CLOSED. Any invalid record (including scrypt parameters
 * scrypt itself would reject) rejects the whole file, the store starts empty
 * (nobody authenticates; joiners re-pair), and the original is kept as
 * `peers.json.corrupt-<ts>`. An UNREADABLE file leaves the store unavailable
 * (nobody authenticates, `mint` throws) and the original untouched.
 *
 * Write failure: `mint` rolls back and throws (a secret nothing on disk knows
 * cannot be handed out). `revoke` keeps the in-memory revocation and throws
 * (#658). `touch` is best-effort.
 */

export const PEERS_FILE = 'peers.json';

/** What `resolve` answers. Consumed STRUCTURALLY by the web server's peer resolver. */
export type PeerAuthResult =
  | { ok: true; peerId: string; hostId: string; name: string }
  | { ok: false; reason: 'unknown' | 'revoked' };

interface StoredPeer extends A2aPeerRecordV1 {
  /** Hex scrypt output; not a credential on its own. */
  secretHash: string;
  /** Hex per-peer salt. */
  salt: string;
  kdf: DeviceKdfParams;
}

interface PeersFileV1 {
  v: 1;
  peers: StoredPeer[];
}

const UNNAMED_PEER = 'Unnamed host';
/** Revoked rows kept per host (newest first); older ones are dropped on the next revoke. */
export const REVOKED_KEPT_PER_HOST = 3;
/** Wrong-secret budget per peerId. */
export const FAILURE_WINDOW_MS = 1000;
export const FAILURES_PER_WINDOW = 5;
/** Same ceiling as DeviceStore: fail loudly at the call site on a parameter bump. */
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const VERIFIED_CACHE_CAP = 64;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const REJECT_UNKNOWN: PeerAuthResult = Object.freeze({ ok: false as const, reason: 'unknown' as const });
const REJECT_REVOKED: PeerAuthResult = Object.freeze({ ok: false as const, reason: 'revoked' as const });

export interface PeerStoreOptions {
  /** Directory holding the store, e.g. `<wmux data dir>/a2a/`. */
  dir: string;
  now?: () => number;
  log?: StoreLog;
  /** Test seam; defaults to `atomicWriteJSONSync`. */
  write?: (filePath: string, data: unknown) => void;
  /** Test seam; defaults to the deferred owner-only re-harden. */
  scheduleHarden?: (filePath: string) => void;
}

export class PeerStore {
  readonly filePath: string;
  private readonly now: () => number;
  private readonly log: StoreLog;
  private readonly write: (filePath: string, data: unknown) => void;
  private readonly scheduleHarden: (filePath: string) => void;
  private readonly peers = new Map<string, StoredPeer>();
  private readonly verified = new Map<string, { secretDigest: Buffer; hashHex: string }>();
  private readonly lastSeenPersistedAt = new Map<string, number>();
  private readonly failures = new Map<string, { windowStart: number; count: number }>();
  /** Tail of each peerId's derivation queue; absent when nothing is queued. */
  private readonly kdfChains = new Map<string, Promise<void>>();
  private writable = true;
  private derivations = 0;

  constructor(opts: PeerStoreOptions) {
    this.filePath = path.join(opts.dir, PEERS_FILE);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((): void => undefined);
    this.write = opts.write ?? ((p, d): void => atomicWriteJSONSync(p, d));
    this.scheduleHarden = opts.scheduleHarden ?? scheduleTokenFileReHarden;
    this.load();
  }

  /** Display view. Never carries the hash, salt or KDF parameters. */
  list(): A2aPeerRecordV1[] {
    return [...this.peers.values()].map(project);
  }

  /** Every peer (revoked included) issued to `hostId`. */
  listByHost(hostId: HostId): A2aPeerRecordV1[] {
    return [...this.peers.values()].filter((r) => r.hostId === hostId).map(project);
  }

  /**
   * Issue a peer credential. Persists BEFORE returning; throws (after rolling
   * back) when the roster cannot be written. Refuses a hostId that already has
   * an unrevoked peer.
   */
  async mint(params: { hostId: HostId; name: string }): Promise<{ peerId: string; secret: string }> {
    if (!this.writable) throw storeUnavailable(PEERS_FILE);
    if (!isHostId(params.hostId)) throw new Error('peer: invalid hostId');
    this.assertHostFree(params.hostId);
    const secret = crypto.randomBytes(DEVICE_SECRET_BYTES).toString('base64url');
    const salt = crypto.randomBytes(DEVICE_SALT_BYTES);
    const kdf: DeviceKdfParams = { ...DEVICE_KDF };
    const secretHash = (await derive(secret, salt, kdf)).toString('hex');
    // Everything from here is synchronous; re-check after the await so two
    // concurrent mints for one host cannot both land.
    if (!this.writable) throw storeUnavailable(PEERS_FILE);
    this.assertHostFree(params.hostId);
    let peerId = crypto.randomUUID();
    while (this.peers.has(peerId)) peerId = crypto.randomUUID();
    const at = this.now();
    const rec: StoredPeer = {
      v: A2A_REMOTE_RECORD_V,
      peerId,
      hostId: params.hostId,
      name: sanitizeName(params.name, UNNAMED_PEER),
      createdAt: new Date(at).toISOString(),
      secretHash,
      salt: salt.toString('hex'),
      kdf,
    };
    this.peers.set(peerId, rec);
    try {
      this.persist();
    } catch (err) {
      this.peers.delete(peerId);
      throw err;
    }
    this.rememberVerified(peerId, sha256(Buffer.from(secret, 'utf8')), rec.secretHash);
    this.lastSeenPersistedAt.set(peerId, at);
    return { peerId, secret };
  }

  /**
   * Resolve a peer credential. Total; never throws.
   *   1. Unknown id → `unknown`, no derivation (a garbage id is no CPU lever).
   *   2. Revoked → `revoked` WITHOUT verifying the secret (DeviceStore rule).
   *      This does tell whoever holds a revoked peerId that it was revoked —
   *      accepted, as in DeviceStore: verifying first would let a revoked
   *      joiner's reconnect loop force a derivation per retry, and the id is a
   *      128-bit random handle only that joiner ever held.
   *   3. Over the wrong-secret budget → `unknown` without deriving.
   *   4. A secret outside the contract's shape (`SECRET_RE`, 32-128 base64url
   *      chars, checked through `parsePeerCredential`) → `unknown` without
   *      deriving.
   *   5. Otherwise constant-time verify; a wrong secret is `unknown`, never
   *      revealing which half of the credential was right.
   */
  async resolve(
    peerId: string,
    secret: string,
  ): Promise<{ ok: true; peerId: string; hostId: string; name: string } | { ok: false; reason: 'unknown' | 'revoked' }> {
    const rec = typeof peerId === 'string' ? this.peers.get(peerId) : undefined;
    if (!rec) return REJECT_UNKNOWN;
    if (rec.revokedAt !== undefined) return REJECT_REVOKED;
    if (this.overBudget(rec.peerId)) return REJECT_UNKNOWN;
    if (typeof secret !== 'string' || !parsePeerCredential(formatPeerCredential({ peerId: rec.peerId, secret }))) {
      this.noteFailure(rec.peerId);
      return REJECT_UNKNOWN;
    }
    // `verify` records its own failures inside the per-peer queue, so the next
    // queued attempt already sees them.
    if (!(await this.verify(rec, secret))) return REJECT_UNKNOWN;
    // Revoked while the derivation was in flight.
    if (rec.revokedAt !== undefined || this.peers.get(rec.peerId) !== rec) return REJECT_REVOKED;
    return { ok: true, peerId: rec.peerId, hostId: rec.hostId, name: rec.name };
  }

  /** Note a successful auth: always in memory, on disk at most once per `LAST_SEEN_PERSIST_MS`. */
  touch(peerId: string): void {
    const rec = this.peers.get(peerId);
    if (!rec || rec.revokedAt !== undefined) return;
    const at = this.now();
    rec.lastSeenAt = new Date(at).toISOString();
    if (!this.writable || at - (this.lastSeenPersistedAt.get(peerId) ?? 0) < LAST_SEEN_PERSIST_MS) return;
    try {
      this.persist();
      // Only a write that landed resets the throttle, so a failed one is retried next time.
      this.lastSeenPersistedAt.set(peerId, at);
    } catch (err) {
      // A lost timestamp costs a stale roster line, nothing more.
      this.log('warn', `[a2a-remote] could not persist lastSeenAt for peer ${peerId}: ${errMsg(err)}`);
    }
  }

  /**
   * Revoke a peer. Returns false when it is unknown or already revoked. On a
   * failed write the revocation STAYS in memory (the peer is refused until
   * restart) and the error is rethrown.
   *
   * Every re-pair revokes the host's previous peer, so revoked rows would pile
   * up per host: only the `REVOKED_KEPT_PER_HOST` most recent revoked rows of
   * that host are kept. A pruned peerId then answers `unknown` instead of
   * `revoked` — still at once, without a derivation.
   */
  revoke(peerId: string): boolean {
    if (!this.writable) throw storeUnavailable(PEERS_FILE);
    const rec = this.peers.get(peerId);
    if (!rec || rec.revokedAt !== undefined) return false;
    rec.revokedAt = new Date(this.now()).toISOString();
    this.verified.delete(peerId);
    this.pruneRevoked(rec.hostId);
    try {
      this.persist();
    } catch (err) {
      this.log('error', `[a2a-remote] peer ${peerId} is revoked in memory but could not be persisted`);
      throw err;
    }
    return true;
  }

  /** Test/diagnostic view (DeviceStore precedent). Holds no secret material. */
  stats(): { derivations: number; peers: number } {
    return { derivations: this.derivations, peers: this.peers.size };
  }

  // --- internals --------------------------------------------------------------

  private pruneRevoked(hostId: HostId): void {
    const revoked = [...this.peers.values()]
      .filter((r) => r.hostId === hostId && r.revokedAt !== undefined)
      .sort((a, b) => (b.revokedAt ?? '').localeCompare(a.revokedAt ?? '') || b.createdAt.localeCompare(a.createdAt));
    for (const old of revoked.slice(REVOKED_KEPT_PER_HOST)) {
      this.peers.delete(old.peerId);
      this.verified.delete(old.peerId);
      this.lastSeenPersistedAt.delete(old.peerId);
      this.failures.delete(old.peerId);
    }
  }

  private assertHostFree(hostId: HostId): void {
    const live = [...this.peers.values()].find((r) => r.hostId === hostId && r.revokedAt === undefined);
    if (live) throw new Error(`peer: host ${hostId} is already paired as ${live.peerId}; revoke it first`);
  }

  private overBudget(peerId: string): boolean {
    const f = this.failures.get(peerId);
    return f !== undefined && this.now() - f.windowStart < FAILURE_WINDOW_MS && f.count >= FAILURES_PER_WINDOW;
  }

  private noteFailure(peerId: string): void {
    const at = this.now();
    const f = this.failures.get(peerId);
    if (!f || at - f.windowStart >= FAILURE_WINDOW_MS) this.failures.set(peerId, { windowStart: at, count: 1 });
    else f.count += 1;
  }

  /**
   * Constant-time; no branch on the presented secret's length (see
   * DeviceStore.verify). A cache hit answers at once; a miss waits its turn in
   * the peer's derivation queue, then re-checks the cache (an earlier turn may
   * have verified this very secret) and the failure budget (earlier turns may
   * have spent it) before deriving. Failures are recorded inside the turn.
   */
  private async verify(rec: StoredPeer, secret: string): Promise<boolean> {
    const secretBuf = Buffer.from(secret, 'utf8');
    const digest = sha256(secretBuf);
    if (this.cacheHit(rec, digest)) return true;
    return this.serializeKdf(rec.peerId, async () => {
      if (this.cacheHit(rec, digest)) return true;
      if (this.overBudget(rec.peerId)) return false;
      let derived: Buffer;
      try {
        this.derivations += 1;
        derived = await derive(secretBuf, Buffer.from(rec.salt, 'hex'), rec.kdf);
      } catch (err) {
        this.log('warn', `[a2a-remote] peer ${rec.peerId} hash could not be derived: ${errMsg(err)}`);
        this.noteFailure(rec.peerId);
        return false;
      }
      const expected = Buffer.from(rec.secretHash, 'hex');
      const ok = expected.length === derived.length && crypto.timingSafeEqual(derived, expected);
      if (ok) this.rememberVerified(rec.peerId, digest, rec.secretHash);
      else this.noteFailure(rec.peerId);
      return ok;
    });
  }

  private cacheHit(rec: StoredPeer, digest: Buffer): boolean {
    const cached = this.verified.get(rec.peerId);
    return cached !== undefined && cached.hashHex === rec.secretHash && crypto.timingSafeEqual(digest, cached.secretDigest);
  }

  /** Run `fn` after every earlier queued derivation for `peerId` has settled. */
  private serializeKdf<T>(peerId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.kdfChains.get(peerId) ?? Promise.resolve();
    const run = prev.then(fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.kdfChains.set(peerId, tail);
    void tail.then(() => {
      if (this.kdfChains.get(peerId) === tail) this.kdfChains.delete(peerId);
    });
    return run;
  }

  private rememberVerified(peerId: string, secretDigest: Buffer, hashHex: string): void {
    this.verified.set(peerId, { secretDigest, hashHex });
    if (this.verified.size > VERIFIED_CACHE_CAP) {
      const oldest = this.verified.keys().next();
      if (!oldest.done) this.verified.delete(oldest.value);
    }
  }

  private persist(): void {
    const file: PeersFileV1 = { v: A2A_REMOTE_RECORD_V, peers: [...this.peers.values()] };
    this.write(this.filePath, file);
    // The file holds no secret (salted scrypt outputs of 256-bit secrets), so
    // the deferred owner-only re-harden is enough — DeviceStore's reasoning.
    this.scheduleHarden(this.filePath);
  }

  private load(): void {
    const { value, writable } = loadStore({
      filePath: this.filePath,
      fileName: PEERS_FILE,
      coerce: coerceFile,
      now: this.now,
      log: this.log,
      level: 'error',
      emptyMeans: 'no peer can authenticate until re-paired',
    });
    this.writable = writable;
    for (const rec of value ?? []) this.peers.set(rec.peerId, rec);
  }
}

function project(r: StoredPeer): A2aPeerRecordV1 {
  return {
    v: 1,
    peerId: r.peerId,
    hostId: r.hostId,
    name: r.name,
    createdAt: r.createdAt,
    ...(r.lastSeenAt !== undefined ? { lastSeenAt: r.lastSeenAt } : {}),
    ...(r.revokedAt !== undefined ? { revokedAt: r.revokedAt } : {}),
  };
}

const scryptAsync = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

function derive(secret: string | Buffer, salt: Buffer, kdf: DeviceKdfParams): Promise<Buffer> {
  return scryptAsync(secret, salt, kdf.keylen, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: SCRYPT_MAXMEM });
}

function sha256(input: Buffer): Buffer {
  return crypto.createHash('sha256').update(input).digest();
}


/** Whole-file validation (fail-closed): any record we cannot verify against rejects the file. */
function coerceFile(raw: unknown): StoredPeer[] | null {
  if (!isPlainObject(raw) || raw['v'] !== 1 || !Array.isArray(raw['peers'])) return null;
  const out: StoredPeer[] = [];
  const seen = new Set<string>();
  for (const r of raw['peers']) {
    if (!isPlainObject(r) || r['v'] !== 1) return null;
    const { peerId, hostId, name, createdAt, lastSeenAt, revokedAt, secretHash, salt } = r;
    const kdf = coerceKdf(r['kdf']);
    if (typeof peerId !== 'string' || !UUID_RE.test(peerId) || seen.has(peerId)) return null;
    if (!isHostId(hostId) || !isNonEmptyString(name) || !isIsoString(createdAt)) return null;
    if (lastSeenAt !== undefined && !isIsoString(lastSeenAt)) return null;
    if (revokedAt !== undefined && !isIsoString(revokedAt)) return null;
    if (!isHex(secretHash) || !isHex(salt) || !kdf || secretHash.length !== kdf.keylen * 2) return null;
    seen.add(peerId);
    out.push({
      v: 1,
      peerId,
      hostId,
      name: sanitizeName(name, UNNAMED_PEER),
      createdAt,
      ...(lastSeenAt !== undefined ? { lastSeenAt } : {}),
      ...(revokedAt !== undefined ? { revokedAt } : {}),
      secretHash,
      salt,
      kdf,
    });
  }
  return out;
}

/**
 * DeviceStore's bounds (a hand-edited record must not be a CPU/memory lever)
 * plus what scrypt itself requires — N a power of two above 1 — and a key
 * long enough to mean something. A violation rejects the whole file.
 */
function coerceKdf(raw: unknown): DeviceKdfParams | null {
  if (!isPlainObject(raw) || raw['algo'] !== 'scrypt') return null;
  const N = positiveInt(raw['N']);
  const r = positiveInt(raw['r']);
  const p = positiveInt(raw['p']);
  const keylen = positiveInt(raw['keylen']);
  if (!N || !r || !p || !keylen) return null;
  if (N < 2 || (N & (N - 1)) !== 0 || N > 1 << 20) return null;
  if (r > 32 || p > 16 || keylen < 16 || keylen > 128) return null;
  if (128 * N * r > SCRYPT_MAXMEM) return null;
  return { algo: 'scrypt', N, r, p, keylen };
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function isHex(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value);
}
