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

  it('rejects a new pairing when the store is full and nothing is evictable (fail-closed)', () => {
    const live = new Set<string>();
    const s = new PeerStore(dir, { ...seam, isLive: (u) => live.has(u) });
    for (let i = 0; i < PEER_CAP; i++) {
      s.upsertPaired(mkResult('u' + i, (i % 250) + 1));
      live.add('u' + i); // every paired peer holds a live connection
    }
    expect(() => s.upsertPaired(mkResult('uNEW'))).toThrow(/full/i);
  });

  it('LRU eviction at cap never drops a burned peer', () => {
    const s = store();
    s.upsertPaired(mkResult('u0'));
    for (let i = 0; i < PEER_BURN_THRESHOLD; i++) s.noteSteadyStateAuthFail('u0');
    for (let i = 1; i <= PEER_CAP + 5; i++) s.upsertPaired(mkResult('u' + i, (i % 250) + 1));
    expect(store().list().some((p) => p.peerUuid === 'u0')).toBe(true);
  });

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
