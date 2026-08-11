// === LanLink per-peer store (PR-4, C9/C12/C13) ===
//
// Persists paired-peer identities (the deterministic pairing peerUuid + the
// shared long-term secret + a per-peer steady-state fail counter + a receive
// high-water mark). Fail-closed owner-DACL, HMAC-bound to this host, atomic-write
// + .bak recovery — mirrors the inbox/StateWriter persistence discipline.
//
// FAIL-CLOSED (C12): every persist does atomicWriteJSONSync THEN a synchronous
// reHardenTokenFileAcl; on win32 if the ACL cannot be applied the file is
// unlinked and the call throws (a long-term secret must NEVER sit broad-readable,
// mirroring secureWriteTokenFile). HMAC-bound (C12): the file carries an HMAC over
// its peers under a machine-local key, so a planted/divergent .bak from another
// host is rejected on load.
//
// Imports node:fs/path/crypto + atomicWrite + shared/security (reHarden) only —
// execute-wall clean, no src/main.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicReadJSONSync, atomicWriteJSONSync } from '../util/atomicWrite';
import { reHardenTokenFileAcl, secureWriteTokenFile, type HardenOutcome } from '../../shared/security';
import type { PairResult } from './pairing';

export const PEER_CAP = 64;
/** Per-peer steady-state (AEAD-authenticated) auth failures before the peer is burned. */
export const PEER_BURN_THRESHOLD = 5;

export interface PeerRecord {
  peerUuid: string;
  peerName: string;
  /** base64 of the 32-byte shared long-term secret. */
  longTermSecret: string;
  pairedAt: number;
  lastSeenAt: number;
  /** Steady-state AEAD-authenticated failures ONLY (NEVER unauth/pairing — C6). */
  pinFailCount: number;
  burned: boolean;
  /** Highest accepted senderSeq from this peer (C8 cross-connection dedup). */
  recvHighWater: number;
  /** Our own monotonic send counter TO this peer (C8 — the sender side of dedup). */
  sendSeq: number;
}

export interface PeerFile {
  version: 1;
  /** HMAC-SHA256(machineLocalKey, canonical(peers)) — binds the file to this host (C12). */
  mac: string;
  peers: PeerRecord[];
}

const RECORD_KEYS: readonly (keyof PeerRecord)[] = [
  'peerUuid',
  'peerName',
  'longTermSecret',
  'pairedAt',
  'lastSeenAt',
  'pinFailCount',
  'burned',
  'recvHighWater',
  'sendSeq',
];

/** Canonical, fixed-key-order projection used for the HMAC (deterministic bytes). */
function canonical(peers: PeerRecord[]): string {
  return JSON.stringify(
    peers.map((r) => ({
      peerUuid: r.peerUuid,
      peerName: r.peerName,
      longTermSecret: r.longTermSecret,
      pairedAt: r.pairedAt,
      lastSeenAt: r.lastSeenAt,
      pinFailCount: r.pinFailCount,
      burned: r.burned,
      recvHighWater: r.recvHighWater,
      sendSeq: r.sendSeq,
    })),
  );
}

/**
 * STRUCTURE validator (Array.isArray-first, exact-own-keys, types). The HMAC is
 * verified separately by PeerStore.load (it needs the machine-local key, which a
 * free function can't hold) — so a planted .bak passes this shape check but fails
 * the load-time HMAC and is skipped (C12).
 */
export function isPeerFile(v: unknown): v is PeerFile {
  if (Array.isArray(v)) return false; // #269 lesson: an array is NOT a healthy object file
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o['version'] !== 1) return false;
  if (typeof o['mac'] !== 'string' || o['mac'].length === 0) return false;
  if (!Array.isArray(o['peers'])) return false;
  for (const r of o['peers'] as unknown[]) {
    if (typeof r !== 'object' || r === null || Array.isArray(r)) return false;
    const rec = r as Record<string, unknown>;
    const keys = Object.keys(rec);
    if (keys.length !== RECORD_KEYS.length) return false; // reject extra keys (C20)
    for (const k of RECORD_KEYS) {
      if (!(k in rec)) return false;
    }
    if (typeof rec['peerUuid'] !== 'string' || rec['peerUuid'].length === 0) return false;
    if (typeof rec['peerName'] !== 'string') return false;
    if (typeof rec['longTermSecret'] !== 'string' || rec['longTermSecret'].length === 0) return false;
    for (const numKey of ['pairedAt', 'lastSeenAt', 'pinFailCount', 'recvHighWater', 'sendSeq'] as const) {
      const n = rec[numKey];
      if (typeof n !== 'number' || !Number.isFinite(n)) return false;
    }
    if (typeof rec['burned'] !== 'boolean') return false;
  }
  return true;
}

export interface PeerStoreOptions {
  /** Lets the server protect a peer with a live connection from LRU eviction. */
  isLive?: (peerUuid: string) => boolean;
  /** Test seam: override the win32 owner-DACL re-harden. */
  reHarden?: (filePath: string) => HardenOutcome;
  /** Test seam: override the secure (owner-DACL) machine-key write. */
  secureWrite?: (filePath: string, data: string) => void;
  /** How long a `lastSeenAt` refresh may sit in memory before it is written (#665). */
  seenFlushMs?: number;
}

/** Coalescing window for `lastSeenAt` writes — see PeerStore.noteSeen (#665). */
export const SEEN_FLUSH_MS = 30_000;
/** Backoff attempts after a failed flush, before it waits for the next record. */
export const SEEN_FLUSH_MAX_RETRIES = 3;

export class PeerStore {
  private readonly dir: string;
  private readonly filePath: string;
  private readonly keyPath: string;
  private readonly machineKey: Buffer;
  private readonly isLive: (peerUuid: string) => boolean;
  private readonly reHarden: (filePath: string) => HardenOutcome;
  private readonly secureWrite: (filePath: string, data: string) => void;
  private readonly seenFlushMs: number;
  /** Map-backed (C20): lookups can never traverse the prototype chain. */
  private map = new Map<string, PeerRecord>();
  /** A `lastSeenAt` refresh is live in memory but not yet on disk (#665). */
  private seenDirty = false;
  private seenFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private seenRetries = 0;
  private disposed = false;

  constructor(baseDir: string, opts: PeerStoreOptions = {}) {
    this.dir = path.join(baseDir, 'lanlink');
    this.filePath = path.join(this.dir, 'lanlink-peers.json');
    this.keyPath = path.join(this.dir, 'peer-hmac-key');
    this.isLive = opts.isLive ?? (() => false);
    this.reHarden = opts.reHarden ?? reHardenTokenFileAcl;
    this.secureWrite = opts.secureWrite ?? secureWriteTokenFile;
    this.seenFlushMs = opts.seenFlushMs ?? SEEN_FLUSH_MS;
    fs.mkdirSync(this.dir, { recursive: true });
    this.machineKey = this.loadOrCreateMachineKey();
    this.load();
  }

  /** A paired/active record, or null if missing OR burned. */
  get(peerUuid: string): PeerRecord | null {
    if (typeof peerUuid !== 'string') return null;
    const r = this.map.get(peerUuid);
    if (!r || r.burned) return null;
    return r;
  }

  /** Insert/replace a paired peer (keyed by the deterministic pairing peerUuid). */
  upsertPaired(r: PairResult): PeerRecord {
    const now = nowMs();
    const rec: PeerRecord = {
      peerUuid: r.peerUuid,
      peerName: r.peerName,
      longTermSecret: r.longTermSecret.toString('base64'),
      pairedAt: now,
      lastSeenAt: now,
      pinFailCount: 0,
      burned: false,
      recvHighWater: 0,
      sendSeq: 0,
    };
    // The snapshot is DEEP because the other mutators edit records in place.
    const snapshot = this.snapshot();
    try {
      // Enforce the cap BEFORE committing a NEW peer (fail-closed): if the store is
      // full and there is no evictable slot, REJECT the pairing rather than overflow.
      if (!this.map.has(rec.peerUuid) && this.map.size >= PEER_CAP) {
        const victim = this.pickEvictable(rec.peerUuid);
        if (!victim) {
          throw new Error('LanLink peer store is full — revoke a peer before pairing a new one');
        }
        this.map.delete(victim.peerUuid);
      }
      this.map.set(rec.peerUuid, rec);
      this.persist();
    } catch (err) {
      this.map = snapshot;
      throw err;
    }
    return rec;
  }

  /**
   * Persist a pairing and retain an exact snapshot for a rollback attempt during
   * the narrow window before the responder hands its confirmation frame to the
   * socket. Calling the established upsert API preserves its failure semantics
   * and test seam while the snapshot also captures an evicted or replaced peer.
   */
  commitPaired(r: PairResult): { record: PeerRecord; rollback: () => void } {
    const snapshot = this.snapshot();
    const record = this.upsertPaired(r);
    let rolledBack = false;
    return {
      record,
      rollback: () => {
        if (rolledBack) return;
        // Keep the restored in-memory state even if persistence fails: retaining a
        // newly granted pairing in memory would fail open. The caller logs a
        // persistence failure because disk recovery can then require intervention.
        this.map = snapshot;
        this.persist();
        rolledBack = true;
      },
    };
  }

  private snapshot(): Map<string, PeerRecord> {
    const snapshot = new Map<string, PeerRecord>();
    for (const [uuid, existing] of this.map) snapshot.set(uuid, { ...existing });
    return snapshot;
  }

  // NOTE: pairing commits roll back because granting access is the one direction
  // where memory running ahead of disk is dangerous. The other mutators must NOT
  // roll back: restoring revoke/burn/high-water state could reopen access or replay
  // gates after a persistence failure.

  /**
   * Reserve the next monotonic send sequence for a peer (sender side of C8 dedup).
   * RESERVED IMMEDIATELY (not after an ACK) so two concurrent sends to the same
   * peer get DISTINCT senderSeqs — otherwise the receiver's high-water dedup would
   * silently drop the second message (codex P1: message loss is worse than a retry
   * duplicate). A failed/retried send therefore takes a fresh seq (at-least-once);
   * the receiver's high-water + the deterministic record id keep a genuine network
   * replay idempotent.
   */
  nextSendSeq(peerUuid: string): number {
    const r = this.map.get(peerUuid);
    if (!r) throw new Error(`nextSendSeq: unknown peer ${peerUuid}`);
    r.sendSeq += 1;
    this.persist();
    return r.sendSeq;
  }

  /** ++pinFailCount on an AEAD-authenticated failure; burn at the threshold (C6). */
  noteSteadyStateAuthFail(peerUuid: string): void {
    const r = this.map.get(peerUuid);
    if (!r) return;
    r.pinFailCount += 1;
    if (r.pinFailCount >= PEER_BURN_THRESHOLD) r.burned = true;
    this.persist();
  }

  /**
   * Refresh `lastSeenAt` IN MEMORY and arm a coalescing flush (#665).
   *
   * This is on the per-record receive path, so it must not persist per call: a
   * persist is a whole-store atomicWrite + a synchronous owner-DACL re-harden
   * (on win32 a whoami.exe + powershell.exe shell-out, measured at 1.8-3.8s per
   * process under AV — and execFileSync blocks the daemon event loop, not just
   * lanlink). At MAX_RECORDS_PER_SEC a single peer could drive 50 of those a
   * second and stall the control pipe.
   *
   * `lastSeenAt` does not need per-message durability: it only feeds LRU
   * eviction (pickEvictable) and lanlink.peers.list, both of which read the
   * in-memory map. The worst a crash before the flush costs is a stale eviction
   * hint, bounded by the flush delay.
   *
   * Call this BEFORE any durable mutator that runs on the same record (the
   * receive path's bumpHighWater): that persist then carries the fresh timestamp
   * out with it, so the record costs one write instead of two and leaves nothing
   * pending for connection teardown to flush.
   */
  noteSeen(peerUuid: string): void {
    if (this.disposed) return;
    const r = this.map.get(peerUuid);
    if (!r) return;
    r.lastSeenAt = nowMs();
    this.seenDirty = true;
    this.armSeenFlush();
  }

  /**
   * Write out a pending `lastSeenAt` refresh, if any. Called on the flush timer,
   * on connection teardown, and on dispose.
   *
   * NEVER throws: unlike the security-critical mutators, a failed lastSeenAt
   * write must not propagate. On the receive path a throw here would take down
   * the connection through the server's pump() catch (#658).
   *
   * Swallowing is NOT harmless, though, and the log says so: on win32 a persist
   * that cannot re-apply the owner-only DACL unlinks the peer file before it
   * throws (C12), so the failure this catches can be "the pairings, burns and
   * high-water marks are no longer on disk", not merely "the timestamp is
   * stale". Hence the bounded retry below rather than a silent give-up.
   */
  flushSeen(): void {
    this.clearSeenFlush();
    if (!this.seenDirty) return;
    try {
      this.persist(); // clears seenDirty + seenRetries on success
    } catch (err) {
      console.error(
        '[LanLinkPeerStore] failed to flush lastSeenAt — on win32 the peer file may have been removed by the fail-closed ACL branch:',
        err,
      );
      // seenDirty is still set (persist clears it only on success). Retry on a
      // backoff so a quiet peer's refresh — and a store file that C12 deleted —
      // is not left waiting for the next inbound record. Bounded: a permanently
      // broken ACL must not log on a timer forever.
      if (this.seenRetries < SEEN_FLUSH_MAX_RETRIES) {
        this.seenRetries += 1;
        this.armSeenFlush(this.seenFlushMs * 2 ** this.seenRetries);
      }
    }
  }

  private armSeenFlush(delayMs = this.seenFlushMs): void {
    if (this.seenFlushTimer || this.disposed) return;
    this.seenFlushTimer = setTimeout(() => {
      this.seenFlushTimer = null;
      this.flushSeen();
    }, delayMs);
    // Never hold the daemon open for a lastSeenAt write.
    this.seenFlushTimer.unref?.();
  }

  private clearSeenFlush(): void {
    if (!this.seenFlushTimer) return;
    clearTimeout(this.seenFlushTimer);
    this.seenFlushTimer = null;
  }

  /**
   * Flush a pending lastSeenAt and stop the timer. Idempotent, and final: a late
   * noteSeen from a socket still draining must not arm a timer nobody will flush.
   */
  dispose(): void {
    if (this.disposed) return;
    this.flushSeen();
    this.disposed = true;
    this.clearSeenFlush();
  }

  bumpHighWater(peerUuid: string, senderSeq: number): void {
    const r = this.map.get(peerUuid);
    if (!r) return;
    if (senderSeq > r.recvHighWater) {
      r.recvHighWater = senderSeq;
      this.persist();
    }
  }

  highWater(peerUuid: string): number {
    return this.map.get(peerUuid)?.recvHighWater ?? 0;
  }

  /** Revoke: delete + persist. The server separately destroys live connections (C13). */
  revoke(peerUuid: string): void {
    if (this.map.delete(peerUuid)) this.persist();
  }

  /** No secrets — for lanlink.peers.list. */
  list(): Array<Omit<PeerRecord, 'longTermSecret'>> {
    return [...this.map.values()].map((r) => {
      const { longTermSecret: _secret, ...rest } = r;
      void _secret;
      return rest;
    });
  }

  /** The decoded 32-byte secret for an active peer (server use only). */
  secretOf(peerUuid: string): Buffer | null {
    const r = this.get(peerUuid);
    return r ? Buffer.from(r.longTermSecret, 'base64') : null;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** LRU eviction candidate: NEVER a burned peer (can't reset a burn, C9), a peer
   *  with a live connection, or the one being upserted. null if none evictable. */
  private pickEvictable(keep: string): PeerRecord | null {
    let victim: PeerRecord | null = null;
    for (const r of this.map.values()) {
      if (r.peerUuid === keep || r.burned || this.isLive(r.peerUuid)) continue;
      if (!victim || r.lastSeenAt < victim.lastSeenAt) victim = r;
    }
    return victim;
  }

  private computeMac(peers: PeerRecord[]): string {
    return crypto.createHmac('sha256', this.machineKey).update(canonical(peers)).digest('hex');
  }

  private verifyMac(file: PeerFile): boolean {
    const expected = this.computeMac(file.peers);
    const a = Buffer.from(file.mac, 'hex');
    const b = Buffer.from(expected, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  private persist(): void {
    const peers = [...this.map.values()];
    const file: PeerFile = { version: 1, mac: this.computeMac(peers), peers };
    atomicWriteJSONSync(this.filePath, file, { validate: isPeerFile, rotationEnabled: true });
    const outcome = this.reHarden(this.filePath);
    // 'unchanged' is a VERIFIED claim (see HardenOutcome): the harden either
    // read the file's DACL back and confirmed it owner-only, or was superseded
    // by a newer write. A swap failure on a file that could NOT be verified
    // owner-only — e.g. the fresh inode atomicWriteJSONSync just renamed in,
    // which still carries inherited ACEs — reports 'failed' and takes this
    // fail-closed branch. Destroying the peer store on a mere transient rename
    // collision (retried, then verified) is what this distinction prevents.
    if (process.platform === 'win32' && outcome === 'failed') {
      // Fail closed: never leave the long-term secrets broad-readable.
      try {
        fs.unlinkSync(this.filePath);
      } catch (unlinkErr) {
        // Secrets are on disk under an ACL we could neither tighten nor remove.
        // upsertPaired rolls its in-memory copy back, so this file now holds a
        // record memory does not — and it returns on the next start. Nothing here
        // can fix that; make sure it is not silent.
        console.error(
          '[LanLinkPeerStore] could not remove an un-hardened peer file — secrets remain on disk:',
          unlinkErr,
        );
      }
      throw new Error('LanLink peer store: could not apply owner-only ACL — refusing to persist secrets');
    }
    this.fsyncBestEffort();
    // A persist writes the WHOLE store, so it also settles any pending lastSeenAt
    // refresh — but only once the write actually succeeded, so a failed persist
    // still leaves the flush timer to retry (#665).
    this.seenDirty = false;
    this.seenRetries = 0;
    this.clearSeenFlush();
  }

  private load(): void {
    this.map = new Map();
    let loaded: PeerFile | null = null;
    try {
      loaded = atomicReadJSONSync<PeerFile>(this.filePath, {
        validate: (v): v is PeerFile => isPeerFile(v) && this.verifyMac(v),
      });
    } catch (err) {
      console.error('[LanLinkPeerStore] Failed to load peer store:', err);
    }
    if (loaded) {
      for (const r of loaded.peers) this.map.set(r.peerUuid, r);
    }
  }

  private loadOrCreateMachineKey(): Buffer {
    try {
      const existing = fs.readFileSync(this.keyPath, 'utf8').trim();
      // Require exactly 32 bytes of hex — a malformed/truncated key would silently
      // weaken every peer-file HMAC, so a bad value is discarded + regenerated.
      if (existing && /^[0-9a-fA-F]{64}$/.test(existing)) {
        const outcome = this.reHarden(this.keyPath);
        // Fail closed (codex P2): if the integrity key cannot be locked to owner-only
        // ACLs on win32, do NOT trust a broad-readable key (an attacker who reads it
        // could forge a planted peer file's HMAC). Discard it and fall through to
        // regenerate a fresh key with a clean owner-DACL via secureWrite.
        //
        // ONLY on 'failed'. An 'unchanged' outcome is VERIFIED, not assumed: the
        // harden read the key's on-disk DACL back (icacls /save) and confirmed it
        // owner-only, or a newer secureWrite superseded it. On an upgrade boot with
        // a genuinely loose legacy ACL, a failed swap reports 'failed' — and this
        // branch correctly discards the key. Regenerating on anything less than
        // 'failed' would change the machine key, invalidate lanlink-peers.json's
        // MAC (verifyMac) and silently drop every paired peer on the load() that
        // follows in this same constructor.
        if (process.platform !== 'win32' || outcome !== 'failed') {
          return Buffer.from(existing, 'hex');
        }
        try {
          fs.unlinkSync(this.keyPath);
        } catch {
          /* best-effort — secureWrite below overwrites + re-hardens anyway */
        }
      }
    } catch {
      /* missing — create below */
    }
    const key = crypto.randomBytes(32);
    this.secureWrite(this.keyPath, key.toString('hex')); // 0o600 + owner DACL, fail-closed
    return key;
  }

  private fsyncBestEffort(): void {
    try {
      const fd = fs.openSync(this.filePath, 'r+');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      /* best-effort — atomic rename already provides atomicity */
    }
  }
}

function nowMs(): number {
  return Date.now();
}
