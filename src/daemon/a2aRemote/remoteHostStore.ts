import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJSONSync } from '../util/atomicWrite';
import { reHardenTokenFileAcl, secureWriteTokenFile, type HardenOutcome } from '../../shared/security';
import {
  A2A_REMOTE_RECORD_V,
  formatPeerCredential,
  isHostId,
  normalizeFingerprint256,
  parsePeerCredential,
  type A2aRemoteHostRecordV1,
  type CertFingerprint256,
  type HostId,
  type PeerCredential,
} from '../../shared/a2aRemote';
import { errMsg, isIsoString, isPlainObject, loadStore, sanitizeName, storeUnavailable, type StoreLog } from './storeFile';

/**
 * Joiner side of cross-host A2A pairing: the server hosts this machine paired
 * with, plus the peer credential each one issued (`remote-hosts.json`).
 *
 * The credential is a PLAINTEXT bearer, so it lives in a separate `secrets`
 * field of the same file (one atomic write, no two-file all-or-nothing) and
 * the file is only ever PUBLISHED owner-only:
 *   - Windows: `secureWriteTokenFile`, which writes into a hardened staging
 *     directory, applies the owner-only DACL, and only then swaps the file
 *     into place (the `src/main/remote/RemoteHostsStore.ts` precedent). There
 *     is no window where a broad-readable bearer sits at the real path.
 *   - POSIX: `atomicWriteJSONSync`, whose temp file is created 0600 before the
 *     rename; the rotated `.bak` is removed after every successful write.
 * On a failed Windows write both the primary and `.bak` are removed
 * best-effort, every host is dropped from memory too (so memory never claims
 * pairings the disk no longer holds), and the store goes UNAVAILABLE until
 * restart (every later mutation throws; nothing keeps writing next to a
 * bearer of unknown protection). `get` / `list` never carry the secret; only
 * `credentialFor` does.
 *
 * Load: the existing file is re-hardened first (`reHardenTokenFileAcl`:
 * chmod 0600 on POSIX; on Windows it verifies the DACL and rewrites through a
 * fresh owner-only inode when it is not). A Windows `failed` outcome means the
 * DACL could be neither verified nor fixed, so the file is NOT read and the
 * store is unavailable — the file is left in place, since the failure may be
 * transient.
 *
 * Corrupt file: FAIL-CLOSED. Any invalid record rejects the whole file; the
 * store starts empty (no credential is presented anywhere; re-pair) and the
 * original is kept as `remote-hosts.json.corrupt-<ts>`. An unreadable file
 * leaves the store unavailable and the original untouched.
 *
 * Write failure: `add` / `updateAddresses` / `updateFingerprint` roll memory
 * back and throw. `promoteAddress` (automatic, on reconnect) also rolls back
 * and throws, but never scrubs the store: a transient lock on the file must
 * not wipe every pairing over a dial-order optimisation. `remove` keeps the in-memory removal and throws (#658: a
 * removal that un-happens on a disk error would keep presenting a credential
 * the operator meant to drop).
 */

export const REMOTE_HOSTS_FILE = 'remote-hosts.json';

interface RemoteHostsFileV1 {
  v: 1;
  hosts: A2aRemoteHostRecordV1[];
  /** hostId -> peer secret. The peerId lives on the host record. */
  secrets: Record<string, string>;
}

/** What `add` takes; the store stamps `v` and `createdAt`. */
export type NewRemoteHost = Omit<A2aRemoteHostRecordV1, 'v' | 'createdAt' | 'lastSeenAt'>;

const UNNAMED_HOST = 'Unnamed host';
/** Addresses kept per host. */
export const ADDRESSES_MAX = 8;
// Same rules as the contract's invite parser (module-private there).
const IPV4_RE = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const HOSTNAME_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The addresses in the given order — the order is the dial order, best
 * first: the joiner saves the one that answered first and moves the ones
 * that failed to the end, and `promoteAddress` puts the one that last
 * answered first (a PC that roams between the office LAN and a tailnet must
 * not wait out an unreachable address on every reconnect). Trimmed,
 * duplicates removed case-insensitively, anything that is neither a valid
 * IPv4 nor a valid hostname dropped, at most `ADDRESSES_MAX` kept.
 */
export function orderAddresses(addresses: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of addresses) {
    if (typeof raw !== 'string') continue;
    const a = raw.trim();
    const key = a.toLowerCase();
    if (!a || seen.has(key)) continue;
    const isIp = IPV4_RE.test(a);
    if (!isIp && (/^[\d.]+$/.test(a) || !HOSTNAME_RE.test(a))) continue;
    seen.add(key);
    out.push(a);
  }
  return out.slice(0, ADDRESSES_MAX);
}

/**
 * A pinned client's `onConnected` for `hostId`: put the address that answered
 * first in the saved record (best effort — a failed write is logged and the
 * connect goes on).
 */
export function addressPromoter(
  store: { promoteAddress?(hostId: HostId, address: string): boolean },
  hostId: HostId,
  log: StoreLog,
): (address: string) => void {
  return (address) => {
    try {
      if (store.promoteAddress?.(hostId, address)) log('info', `[a2a-remote] ${hostId}: reached at ${address}; dialling it first from now on`);
    } catch (err) {
      log('warn', `[a2a-remote] ${hostId}: could not move ${address} to the front of its addresses: ${errMsg(err)}`);
    }
  };
}

export interface RemoteHostStoreOptions {
  /** Directory holding the store, e.g. `<wmux data dir>/a2a/`. */
  dir: string;
  now?: () => number;
  log?: StoreLog;
  /** Test seam; defaults to `secureWriteTokenFile` on Windows, `atomicWriteJSONSync` elsewhere. */
  write?: (filePath: string, data: unknown) => void;
  /** Test seam; defaults to the synchronous `reHardenTokenFileAcl` (load-time). */
  reHarden?: (filePath: string) => HardenOutcome;
  /** Test seam; defaults to `fs.rmSync(p, { force: true })`. */
  remove?: (filePath: string) => void;
  /** Test seam; defaults to `process.platform === 'win32'`. */
  win32?: boolean;
}

export class RemoteHostStore {
  readonly filePath: string;
  private readonly now: () => number;
  private readonly log: StoreLog;
  private readonly write: (filePath: string, data: unknown) => void;
  private readonly reHarden: (filePath: string) => HardenOutcome;
  private readonly win32: boolean;
  private readonly remove_: (filePath: string) => void;
  private writable = true;
  private readonly hosts = new Map<HostId, A2aRemoteHostRecordV1>();
  private readonly secrets = new Map<HostId, string>();

  constructor(opts: RemoteHostStoreOptions) {
    this.filePath = path.join(opts.dir, REMOTE_HOSTS_FILE);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((): void => undefined);
    this.win32 = opts.win32 ?? process.platform === 'win32';
    this.write =
      opts.write ??
      (this.win32
        ? (p, d): void => secureWriteTokenFile(p, JSON.stringify(d, null, 2))
        : (p, d): void => atomicWriteJSONSync(p, d));
    this.reHarden = opts.reHarden ?? reHardenTokenFileAcl;
    this.remove_ = opts.remove ?? ((p): void => fs.rmSync(p, { force: true }));
    this.load();
  }

  get(hostId: HostId): A2aRemoteHostRecordV1 | undefined {
    const rec = this.hosts.get(hostId);
    return rec ? structuredClone(rec) : undefined;
  }

  /** Display view. Never carries a secret. */
  list(): A2aRemoteHostRecordV1[] {
    return [...this.hosts.values()].map((r) => structuredClone(r));
  }

  /** The credential to present to `hostId`, or null when not paired. */
  credentialFor(hostId: HostId): PeerCredential | null {
    const rec = this.hosts.get(hostId);
    const secret = this.secrets.get(hostId);
    return rec && secret ? { peerId: rec.peerId, secret } : null;
  }

  /** Record a pairing. Re-pairing with a known hostId replaces it. */
  add(input: NewRemoteHost, credential: PeerCredential): A2aRemoteHostRecordV1 {
    this.assertWritable();
    const rec = buildRecord(input, new Date(this.now()).toISOString());
    if (typeof rec === 'string') throw new Error(`remote host: ${rec}`);
    if (!credential || credential.peerId !== rec.peerId || !parsePeerCredential(formatPeerCredential(credential))) {
      throw new Error('remote host: invalid credential');
    }
    this.mutate(rec.hostId, () => {
      this.hosts.set(rec.hostId, rec);
      this.secrets.set(rec.hostId, credential.secret);
    });
    return structuredClone(rec);
  }

  updateAddresses(hostId: HostId, addresses: string[]): A2aRemoteHostRecordV1 {
    const rec = this.require(hostId);
    const ordered = orderAddresses(addresses);
    if (ordered.length === 0) throw new Error('remote host: no usable address');
    const next = { ...rec, addresses: ordered };
    this.mutate(hostId, () => this.hosts.set(hostId, next));
    return structuredClone(next);
  }

  /**
   * A connect to `hostId` got through at `address` (its pin already checked):
   * dial it first next time. Writes only when the order changes; false when
   * nothing changed (already first, or not one of the host's addresses — a
   * connect never adds an address).
   *
   * Runs on its own during a background reconnect and is only an
   * optimisation, so a failed write does NOT take the fail-closed path of the
   * other mutations (scrubbing every pairing on Windows): the previous order
   * is restored in memory, the store stays usable, and the error is thrown
   * for the caller to log.
   */
  promoteAddress(hostId: HostId, address: string): boolean {
    const rec = this.hosts.get(hostId);
    if (!rec || !this.writable) return false;
    const i = rec.addresses.findIndex((a) => a.toLowerCase() === address.toLowerCase());
    if (i <= 0) return false;
    this.hosts.set(hostId, { ...rec, addresses: [rec.addresses[i], ...rec.addresses.filter((_, j) => j !== i)] });
    try {
      this.persist({ scrubOnFailure: false });
    } catch (err) {
      this.hosts.set(hostId, rec);
      throw err;
    }
    return true;
  }

  /** Re-pin after a certificate rotation. hostId (and so every link) is unchanged. */
  updateFingerprint(hostId: HostId, fingerprint: string): A2aRemoteHostRecordV1 {
    const rec = this.require(hostId);
    const fp: CertFingerprint256 | null = normalizeFingerprint256(fingerprint);
    if (!fp) throw new Error('remote host: invalid fingerprint');
    const next = { ...rec, fingerprint256: fp };
    this.mutate(hostId, () => this.hosts.set(hostId, next));
    return structuredClone(next);
  }

  /** Forget a host and its credential. Returns false when unknown. */
  remove(hostId: HostId): boolean {
    if (!this.hosts.has(hostId)) return false;
    this.hosts.delete(hostId);
    this.secrets.delete(hostId);
    try {
      this.assertWritable();
      this.persist();
    } catch (err) {
      this.log('error', `[a2a-remote] remote host ${hostId} is removed in memory but could not be persisted`);
      throw err;
    }
    return true;
  }

  // --- internals --------------------------------------------------------------

  private require(hostId: HostId): A2aRemoteHostRecordV1 {
    this.assertWritable();
    const rec = this.hosts.get(hostId);
    if (!rec) throw new Error(`remote host ${hostId}: unknown host`);
    return rec;
  }

  /** Apply `change` for one host; restore that host's record and secret if the write fails. */
  private mutate(hostId: HostId, change: () => void): void {
    const prevRec = this.hosts.get(hostId);
    const prevSecret = this.secrets.get(hostId);
    change();
    try {
      this.persist();
    } catch (err) {
      // A failed Windows write already emptied memory and disabled the store.
      if (!this.writable) throw err;
      if (prevRec) this.hosts.set(hostId, prevRec);
      else this.hosts.delete(hostId);
      if (prevSecret !== undefined) this.secrets.set(hostId, prevSecret);
      else this.secrets.delete(hostId);
      throw err;
    }
  }

  private assertWritable(): void {
    if (!this.writable) throw storeUnavailable(REMOTE_HOSTS_FILE);
  }

  private persist({ scrubOnFailure = true }: { scrubOnFailure?: boolean } = {}): void {
    const file: RemoteHostsFileV1 = {
      v: A2A_REMOTE_RECORD_V,
      hosts: [...this.hosts.values()],
      secrets: Object.fromEntries(this.secrets),
    };
    try {
      this.write(this.filePath, file);
    } catch (err) {
      if (this.win32 && scrubOnFailure) this.scrubAfterFailedWrite();
      throw err;
    }
    // POSIX: the write rotated the previous generation to `.bak`. This store
    // never reads it, and it may still hold a bearer the operator just removed.
    try {
      this.remove_(`${this.filePath}.bak`);
    } catch (err) {
      this.log('warn', `[a2a-remote] could not remove ${REMOTE_HOSTS_FILE}.bak: ${errMsg(err)}`);
    }
  }

  /**
   * A Windows bearer write failed: whatever is left at the primary or `.bak`
   * is of unknown protection. Remove both, forget every host in memory to
   * match, and stop writing until restart.
   */
  private scrubAfterFailedWrite(): void {
    for (const p of [this.filePath, `${this.filePath}.bak`]) {
      try {
        this.remove_(p);
      } catch (err) {
        this.log('error', `[a2a-remote] could not remove ${p} after a failed credential write: ${errMsg(err)}`);
      }
    }
    this.hosts.clear();
    this.secrets.clear();
    this.writable = false;
    this.log('error', `[a2a-remote] credential write failed; ${REMOTE_HOSTS_FILE} removed, every remote host must be re-paired; store is unavailable until restart`);
  }

  private load(): void {
    if (fs.existsSync(this.filePath)) {
      const outcome = this.reHarden(this.filePath);
      if (this.win32 && outcome === 'failed') {
        this.writable = false;
        this.log('error', `[a2a-remote] ${REMOTE_HOSTS_FILE} could not be verified owner-only; not loaded, store is unavailable`);
        return;
      }
    }
    const { value, writable } = loadStore({
      filePath: this.filePath,
      fileName: REMOTE_HOSTS_FILE,
      coerce: coerceFile,
      now: this.now,
      log: this.log,
      level: 'error',
      emptyMeans: 'no remote host is paired until re-paired',
    });
    this.writable = writable;
    if (!value) return;
    for (const rec of value.hosts) this.hosts.set(rec.hostId, rec);
    for (const [hostId, secret] of Object.entries(value.secrets)) this.secrets.set(hostId, secret);
  }
}

/** A clean record, or a string naming what is wrong. */
function buildRecord(input: NewRemoteHost, createdAt: string): A2aRemoteHostRecordV1 | string {
  if (!isPlainObject(input)) return 'invalid record';
  if (!isHostId(input.hostId)) return 'invalid hostId';
  if (typeof input.name !== 'string') return 'invalid name';
  if (!Array.isArray(input.addresses)) return 'invalid addresses';
  const addresses = orderAddresses(input.addresses);
  if (addresses.length === 0) return 'no usable address';
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) return 'invalid port';
  const fingerprint256 = normalizeFingerprint256(input.fingerprint256);
  if (!fingerprint256) return 'invalid fingerprint';
  if (typeof input.peerId !== 'string' || !UUID_RE.test(input.peerId)) return 'invalid peerId';
  return {
    v: A2A_REMOTE_RECORD_V,
    hostId: input.hostId,
    name: sanitizeName(input.name, UNNAMED_HOST),
    addresses,
    port: input.port,
    fingerprint256,
    peerId: input.peerId,
    createdAt,
  };
}

/** Whole-file validation (fail-closed): every host needs a valid record AND a valid secret. */
function coerceFile(raw: unknown): { hosts: A2aRemoteHostRecordV1[]; secrets: Record<string, string> } | null {
  if (!isPlainObject(raw) || raw['v'] !== 1 || !Array.isArray(raw['hosts']) || !isPlainObject(raw['secrets'])) return null;
  const secretsIn = raw['secrets'];
  const hosts: A2aRemoteHostRecordV1[] = [];
  const secrets: Record<string, string> = {};
  for (const r of raw['hosts']) {
    if (!isPlainObject(r) || r['v'] !== 1 || !isIsoString(r['createdAt'])) return null;
    const rec = buildRecord(r as unknown as NewRemoteHost, r['createdAt']);
    if (typeof rec === 'string' || Object.hasOwn(secrets, rec.hostId)) return null;
    const lastSeenAt = r['lastSeenAt'];
    if (lastSeenAt !== undefined) {
      if (!isIsoString(lastSeenAt)) return null;
      rec.lastSeenAt = lastSeenAt;
    }
    const secret = Object.hasOwn(secretsIn, rec.hostId) ? secretsIn[rec.hostId] : undefined;
    if (typeof secret !== 'string' || !parsePeerCredential(formatPeerCredential({ peerId: rec.peerId, secret }))) return null;
    secrets[rec.hostId] = secret;
    hosts.push(rec);
  }
  // A secret with no host record is something we cannot account for.
  if (Object.keys(secretsIn).length !== hosts.length) return null;
  return { hosts, secrets };
}
