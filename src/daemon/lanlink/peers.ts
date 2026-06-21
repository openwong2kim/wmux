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
import { reHardenTokenFileAcl, secureWriteTokenFile } from '../../shared/security';
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
  /** Test seam: override the (slow, win32 PowerShell) owner-DACL re-harden. */
  reHarden?: (filePath: string) => boolean;
  /** Test seam: override the secure (owner-DACL) machine-key write. */
  secureWrite?: (filePath: string, data: string) => void;
}

export class PeerStore {
  private readonly dir: string;
  private readonly filePath: string;
  private readonly keyPath: string;
  private readonly machineKey: Buffer;
  private readonly isLive: (peerUuid: string) => boolean;
  private readonly reHarden: (filePath: string) => boolean;
  private readonly secureWrite: (filePath: string, data: string) => void;
  /** Map-backed (C20): lookups can never traverse the prototype chain. */
  private map = new Map<string, PeerRecord>();

  constructor(baseDir: string, opts: PeerStoreOptions = {}) {
    this.dir = path.join(baseDir, 'lanlink');
    this.filePath = path.join(this.dir, 'lanlink-peers.json');
    this.keyPath = path.join(this.dir, 'peer-hmac-key');
    this.isLive = opts.isLive ?? (() => false);
    this.reHarden = opts.reHarden ?? reHardenTokenFileAcl;
    this.secureWrite = opts.secureWrite ?? secureWriteTokenFile;
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
    return rec;
  }

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

  noteSeen(peerUuid: string): void {
    const r = this.map.get(peerUuid);
    if (!r) return;
    r.lastSeenAt = nowMs();
    this.persist();
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
    const ok = this.reHarden(this.filePath);
    if (process.platform === 'win32' && !ok) {
      // Fail closed: never leave the long-term secrets broad-readable.
      try {
        fs.unlinkSync(this.filePath);
      } catch {
        /* best-effort */
      }
      throw new Error('LanLink peer store: could not apply owner-only ACL — refusing to persist secrets');
    }
    this.fsyncBestEffort();
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
        const ok = this.reHarden(this.keyPath);
        // Fail closed (codex P2): if the integrity key cannot be locked to owner-only
        // ACLs on win32, do NOT trust a broad-readable key (an attacker who reads it
        // could forge a planted peer file's HMAC). Discard it and fall through to
        // regenerate a fresh key with a clean owner-DACL via secureWrite.
        if (process.platform !== 'win32' || ok) {
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
