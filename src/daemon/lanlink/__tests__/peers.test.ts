import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PeerStore, isPeerFile, PEER_BURN_THRESHOLD, PEER_CAP, type PeerStoreOptions } from '../peers';
import type { PairResult } from '../pairing';

// Test seam: skip the slow win32 PowerShell ACL shell-out.
const seam: PeerStoreOptions = {
  reHarden: () => true,
  secureWrite: (p, d) => fs.writeFileSync(p, d),
};

function mkResult(uuid: string, secretByte = 1): PairResult {
  return { peerUuid: uuid, peerName: 'P-' + uuid, longTermSecret: Buffer.alloc(32, secretByte) };
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanlink-peers-'));
});
afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

function store(): PeerStore {
  return new PeerStore(dir, seam);
}

describe('peers — per-peer store', () => {
  it('upsert + persist + reload preserves the record and secret', () => {
    const s = store();
    const res = mkResult('u1');
    s.upsertPaired(res);
    expect(s.get('u1')?.peerUuid).toBe('u1');
    const s2 = store();
    expect(s2.get('u1')?.peerUuid).toBe('u1');
    expect(s2.secretOf('u1')!.equals(res.longTermSecret)).toBe(true);
  });

  it('burns after the threshold and stays burned across a reload', () => {
    const s = store();
    s.upsertPaired(mkResult('u1'));
    for (let i = 0; i < PEER_BURN_THRESHOLD; i++) s.noteSteadyStateAuthFail('u1');
    expect(s.get('u1')).toBeNull();
    expect(store().get('u1')).toBeNull(); // survives restart (fsync'd)
  });

  it('revoke removes the peer durably', () => {
    const s = store();
    s.upsertPaired(mkResult('u1'));
    s.revoke('u1');
    expect(s.get('u1')).toBeNull();
    expect(store().get('u1')).toBeNull();
  });

  it('high-water persists; nextSendSeq reserves a DISTINCT monotonic seq per call (C8)', () => {
    const s = store();
    s.upsertPaired(mkResult('u1'));
    s.bumpHighWater('u1', 5);
    expect(s.highWater('u1')).toBe(5);
    expect(store().highWater('u1')).toBe(5);
    // reserved immediately + distinct (concurrent sends never collide on one seq)
    expect(s.nextSendSeq('u1')).toBe(1);
    expect(s.nextSendSeq('u1')).toBe(2);
    expect(store().nextSendSeq('u1')).toBe(3); // persisted across reload
  });

  // ── #658: a pairing that cannot be saved must not survive in memory ─────────
  describe('upsertPaired is atomic', () => {
    it('keeps no peer when the ACL fail-closed branch throws', () => {
      const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      try {
        let hardenOk = true;
        const s = new PeerStore(dir, {
          reHarden: () => hardenOk,
          secureWrite: (p, d) => fs.writeFileSync(p, d),
        });
        hardenOk = false; // now persist() unlinks the file and throws (C12)
        expect(() => s.upsertPaired(mkResult('u1'))).toThrow(/owner-only ACL/);
        // listPeers reads THIS map — the half-pair in #658 was memory saying yes
        // over a file that had just been deleted.
        expect(s.get('u1')).toBeNull();
        expect(s.list()).toEqual([]);
      } finally {
        if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
      }
    });

    // POSIX-only: the failure is induced with a read-only directory, and Windows
    // ignores the POSIX mode bits, so there the write simply succeeds. The ACL
    // test above covers the rollback on both platforms (it stubs the platform);
    // this one exists to show the rollback holds for a DIFFERENT persist() branch
    // — a failed atomic write, which leaves no primary file at all because the
    // previous one was already renamed to .bak.
    it.skipIf(process.platform === 'win32')('keeps no peer when the atomic write itself throws', () => {
      const s = store();
      const peerDir = path.join(dir, 'lanlink');
      fs.chmodSync(peerDir, 0o500); // r-x: no temp file can be created
      try {
        expect(() => s.upsertPaired(mkResult('u1'))).toThrow();
        expect(s.list()).toEqual([]);
      } finally {
        fs.chmodSync(peerDir, 0o700);
      }
    });

    it('does NOT roll back a revoke or a burn — that direction is fail-open', () => {
      const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      try {
        let hardenOk = true;
        const s = new PeerStore(dir, {
          reHarden: () => hardenOk,
          secureWrite: (p, d) => fs.writeFileSync(p, d),
        });
        s.upsertPaired(mkResult('u1'));
        s.upsertPaired(mkResult('u2'));
        hardenOk = false;
        // Restoring these would keep delivering to a peer the user just removed,
        // and would stop a burn from ever reaching the threshold.
        expect(() => s.revoke('u1')).toThrow(/owner-only ACL/);
        expect(s.get('u1')).toBeNull();
        for (let i = 0; i < PEER_BURN_THRESHOLD; i++) {
          expect(() => s.noteSteadyStateAuthFail('u2')).toThrow(/owner-only ACL/);
        }
        expect(s.get('u2')).toBeNull(); // burned
      } finally {
        if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
      }
    });
  });

  it('get(__proto__) is null (Map-backed, C20)', () => {
    expect(store().get('__proto__')).toBeNull();
    expect(store().get('constructor')).toBeNull();
  });

  it('isPeerFile is Array.isArray-first and rejects extra/missing keys', () => {
    expect(isPeerFile([])).toBe(false);
    expect(isPeerFile({ version: 1, mac: 'x', peers: 'no' })).toBe(false);
    expect(isPeerFile({ version: 1, mac: 'x', peers: [{ peerUuid: 'a' }] })).toBe(false); // missing keys
    expect(isPeerFile({ version: 2, mac: 'x', peers: [] })).toBe(false);
  });

  it('rejects a file whose HMAC does not verify (planted/tampered) (C12)', () => {
    const s = store();
    s.upsertPaired(mkResult('u1'));
    const fp = path.join(dir, 'lanlink', 'lanlink-peers.json');
    const obj = JSON.parse(fs.readFileSync(fp, 'utf8'));
    obj.mac = 'deadbeef';
    fs.writeFileSync(fp, JSON.stringify(obj));
    for (const ext of ['.bak', '.bak.1', '.bak.2', '.bak.3']) {
      try {
        fs.unlinkSync(fp + ext);
      } catch {
        /* none */
      }
    }
    expect(store().get('u1')).toBeNull(); // HMAC failed -> fresh empty store
  });

  // Both cap-loop tests below drive PEER_CAP (64) real pairings, and every
  // upsertPaired persists the whole store: an atomic temp-write + rename with
  // rotation, followed by an fsync. That is ~64 forced disk flushes per test —
  // legitimately slow I/O, not a hang. They run in ~0.3-0.4s on a warm dev box
  // but have timed out at vitest's 5s default on loaded CI runners (three times
  // in one day, on Windows where AV scanning taxes every write). Raised here,
  // per-test, rather than globally: the other nine tests in this file finish in
  // under 30ms and should keep the strict default.
  const CAP_LOOP_TIMEOUT_MS = 30_000;

  it('rejects a new pairing when the store is full and nothing is evictable (fail-closed)', () => {
    const live = new Set<string>();
    const s = new PeerStore(dir, { ...seam, isLive: (u) => live.has(u) });
    for (let i = 0; i < PEER_CAP; i++) {
      s.upsertPaired(mkResult('u' + i, (i % 250) + 1));
      live.add('u' + i); // every paired peer holds a live connection
    }
    expect(() => s.upsertPaired(mkResult('uNEW'))).toThrow(/full/i);
  }, CAP_LOOP_TIMEOUT_MS);

  it('LRU eviction at cap never drops a burned peer', () => {
    const s = store();
    s.upsertPaired(mkResult('u0'));
    for (let i = 0; i < PEER_BURN_THRESHOLD; i++) s.noteSteadyStateAuthFail('u0');
    for (let i = 1; i <= PEER_CAP + 5; i++) s.upsertPaired(mkResult('u' + i, (i % 250) + 1));
    expect(store().list().some((p) => p.peerUuid === 'u0')).toBe(true);
  }, CAP_LOOP_TIMEOUT_MS);

  it('list() never leaks the long-term secret', () => {
    const s = store();
    s.upsertPaired(mkResult('u1'));
    const row = s.list()[0] as Record<string, unknown>;
    expect('longTermSecret' in row).toBe(false);
    expect(row['peerUuid']).toBe('u1');
  });

  it('a symlink at the store path leaves the pointee unmodified', () => {
    const target = path.join(dir, 'secret.txt');
    fs.writeFileSync(target, 'IMPORTANT');
    fs.mkdirSync(path.join(dir, 'lanlink'), { recursive: true });
    const link = path.join(dir, 'lanlink', 'lanlink-peers.json');
    try {
      fs.symlinkSync(target, link);
    } catch {
      return; // no symlink perms on this platform/run — skip
    }
    const s = new PeerStore(dir, seam);
    s.upsertPaired(mkResult('u1'));
    // atomicWrite renames a fresh tmp inode over the path, never writes through the link.
    expect(fs.readFileSync(target, 'utf8')).toBe('IMPORTANT');
  });
});
