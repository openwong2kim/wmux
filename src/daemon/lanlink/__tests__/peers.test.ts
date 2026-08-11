import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PeerStore, isPeerFile, PEER_BURN_THRESHOLD, PEER_CAP, type PeerStoreOptions } from '../peers';
import type { PairResult } from '../pairing';

// Test seam: skip the win32 owner-DACL rewrite.
const seam: PeerStoreOptions = {
  reHarden: () => 'hardened',
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
          reHarden: () => (hardenOk ? 'hardened' : 'failed'),
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
          reHarden: () => (hardenOk ? 'hardened' : 'failed'),
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

  // ── HardenOutcome consumption in loadOrCreateMachineKey ─────────────────────
  // 'unchanged' is a VERIFIED owner-only claim (or a superseding write) — the
  // existing key must be TRUSTED, not regenerated. Regenerating invalidates
  // lanlink-peers.json's MAC and silently drops every pairing (review P1).
  describe('machine key vs HardenOutcome (win32)', () => {
    function plantKey(): string {
      const lanlinkDir = path.join(dir, 'lanlink');
      fs.mkdirSync(lanlinkDir, { recursive: true });
      const keyPath = path.join(lanlinkDir, 'peer-hmac-key');
      fs.writeFileSync(keyPath, 'ab'.repeat(32)); // valid 64-hex key
      return keyPath;
    }

    function onWin32(fn: () => void): void {
      const orig = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      try {
        fn();
      } finally {
        if (orig) Object.defineProperty(process, 'platform', orig);
      }
    }

    it("keeps the existing key on 'unchanged' (verified swap failure)", () => {
      onWin32(() => {
        plantKey();
        const secureWrite = vi.fn((p: string, d: string) => fs.writeFileSync(p, d));
        new PeerStore(dir, { reHarden: () => 'unchanged', secureWrite });
        // No regeneration: the planted key survives untouched.
        expect(secureWrite).not.toHaveBeenCalled();
        expect(fs.readFileSync(path.join(dir, 'lanlink', 'peer-hmac-key'), 'utf8')).toBe(
          'ab'.repeat(32),
        );
      });
    });

    it("discards and regenerates the key on 'failed' (fail-closed)", () => {
      onWin32(() => {
        const keyPath = plantKey();
        const secureWrite = vi.fn((p: string, d: string) => fs.writeFileSync(p, d));
        new PeerStore(dir, { reHarden: () => 'failed', secureWrite });
        // The untrustworthy key is replaced through the fail-closed secure write.
        expect(secureWrite).toHaveBeenCalledTimes(1);
        expect(secureWrite.mock.calls[0][0]).toBe(keyPath);
        const regenerated = fs.readFileSync(keyPath, 'utf8');
        expect(regenerated).toMatch(/^[0-9a-f]{64}$/);
        expect(regenerated).not.toBe('ab'.repeat(32));
      });
    });
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

  // ── #665: lastSeenAt must not persist per received record ──────────────────
  describe('noteSeen coalesces its writes', () => {
    /** reHarden runs exactly once per persist, so it doubles as a write counter. */
    function countingStore(over: PeerStoreOptions = {}): { s: PeerStore; writes: () => number } {
      let writes = 0;
      const s = new PeerStore(dir, {
        ...seam,
        reHarden: () => {
          writes += 1;
          return 'hardened';
        },
        ...over,
      });
      const base = writes; // discount the machine-key harden done in the constructor
      return { s, writes: () => writes - base };
    }

    it('does not write to disk per call, but updates memory', () => {
      const { s, writes } = countingStore();
      s.upsertPaired(mkResult('u1'));
      const afterPair = writes();
      const before = s.get('u1')!.lastSeenAt;
      for (let i = 0; i < 50; i++) s.noteSeen('u1');
      expect(writes()).toBe(afterPair); // 50 records, zero extra persists
      expect(s.get('u1')!.lastSeenAt).toBeGreaterThanOrEqual(before);
    });

    it('flushSeen writes the pending refresh exactly once', () => {
      const { s, writes } = countingStore();
      s.upsertPaired(mkResult('u1'));
      const afterPair = writes();
      s.noteSeen('u1');
      s.flushSeen();
      expect(writes()).toBe(afterPair + 1);
      s.flushSeen(); // nothing pending — no second write
      expect(writes()).toBe(afterPair + 1);
    });

    it('reaches disk only once flushed', () => {
      vi.useFakeTimers();
      try {
        const s = store();
        s.upsertPaired(mkResult('u1'));
        const paired = store().get('u1')!.lastSeenAt;
        vi.advanceTimersByTime(60_000);
        s.noteSeen('u1');
        expect(store().get('u1')!.lastSeenAt).toBe(paired); // still only in memory
        s.flushSeen();
        expect(store().get('u1')!.lastSeenAt).toBe(paired + 60_000);
      } finally {
        vi.useRealTimers();
      }
    });

    it('a durable persist settles the pending refresh', () => {
      const { s, writes } = countingStore();
      s.upsertPaired(mkResult('u1'));
      s.noteSeen('u1');
      const afterPair = writes();
      s.bumpHighWater('u1', 1); // writes the whole store, lastSeenAt included
      expect(writes()).toBe(afterPair + 1);
      s.flushSeen(); // already on disk — must not write again
      expect(writes()).toBe(afterPair + 1);
    });

    // A throw here would reach the server's pump() catch and kill the connection
    // over a lastSeenAt write — the #658 interaction called out in #665.
    it('never throws when the write fails, and the recovered write carries the refresh', () => {
      const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      vi.useFakeTimers();
      try {
        let hardenOk = true;
        const s = new PeerStore(dir, {
          reHarden: () => (hardenOk ? 'hardened' : 'failed'),
          secureWrite: (p, d) => fs.writeFileSync(p, d),
        });
        s.upsertPaired(mkResult('u1'));
        const paired = s.get('u1')!.lastSeenAt;
        vi.advanceTimersByTime(60_000);
        hardenOk = false; // persist() now unlinks the file + throws (C12)
        s.noteSeen('u1');
        expect(() => s.flushSeen()).not.toThrow();
        // Still pending — and the recovered write must carry the actual value, not
        // just leave a peer file that happens to exist.
        hardenOk = true;
        s.flushSeen();
        expect(new PeerStore(dir, seam).get('u1')!.lastSeenAt).toBe(paired + 60_000);
        s.dispose();
      } finally {
        vi.useRealTimers();
        if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
      }
    });

    it('retries a failed flush on a backoff instead of waiting for the next record', async () => {
      const origPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      try {
        let hardenOk = true;
        let writes = 0;
        const s = new PeerStore(dir, {
          reHarden: () => {
            writes += 1;
            return hardenOk ? 'hardened' : 'failed';
          },
          secureWrite: (p, d) => fs.writeFileSync(p, d),
          seenFlushMs: 5,
        });
        s.upsertPaired(mkResult('u1'));
        hardenOk = false;
        s.noteSeen('u1');
        s.flushSeen(); // fails, arms a backoff retry
        const afterFail = writes;
        hardenOk = true;
        // No further noteSeen and no dispose: the retry timer alone has to settle it.
        await new Promise((r) => setTimeout(r, 80));
        expect(writes).toBeGreaterThan(afterFail);
        expect(new PeerStore(dir, seam).get('u1')!.lastSeenAt).toBe(s.get('u1')!.lastSeenAt);
        s.dispose();
      } finally {
        if (origPlatform) Object.defineProperty(process, 'platform', origPlatform);
      }
    });

    it('a late noteSeen after dispose cannot arm a timer nobody flushes', () => {
      const { s, writes } = countingStore({ seenFlushMs: 5 });
      s.upsertPaired(mkResult('u1'));
      s.dispose();
      const afterDispose = writes();
      s.noteSeen('u1');
      expect(writes()).toBe(afterDispose);
      s.dispose(); // idempotent
      expect(writes()).toBe(afterDispose);
    });

    it('dispose flushes a pending refresh', () => {
      const { s, writes } = countingStore();
      s.upsertPaired(mkResult('u1'));
      const afterPair = writes();
      s.noteSeen('u1');
      s.dispose();
      expect(writes()).toBe(afterPair + 1);
    });

    it('the flush timer settles a refresh with no further traffic', async () => {
      const { s, writes } = countingStore({ seenFlushMs: 5 });
      s.upsertPaired(mkResult('u1'));
      const afterPair = writes();
      s.noteSeen('u1');
      s.noteSeen('u1'); // a second refresh must not arm a second timer
      await new Promise((r) => setTimeout(r, 30));
      expect(writes()).toBe(afterPair + 1);
      s.dispose();
    });
  });
});
