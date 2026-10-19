import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatPeerCredential, parsePeerCredential } from '../../../shared/a2aRemote';
import { atomicWriteJSONSync } from '../../util/atomicWrite';
import { LAST_SEEN_PERSIST_MS } from '../../web/DeviceStore';
import {
  FAILURES_PER_WINDOW,
  FAILURE_WINDOW_MS,
  PEERS_FILE,
  PeerStore,
  REVOKED_KEPT_PER_HOST,
  type PeerStoreOptions,
} from '../peerStore';

const HOST = '11111111-1111-4111-8111-111111111111';
const HOST2 = '22222222-2222-4222-8222-222222222222';

let dir: string;
let fail = false;
let writes = 0;
let clock = 1_700_000_000_000;
const flakyWrite = (p: string, d: unknown): void => {
  writes += 1;
  if (fail) throw new Error('disk full');
  atomicWriteJSONSync(p, d);
};
const make = (o: Partial<PeerStoreOptions> = {}): PeerStore =>
  new PeerStore({ dir, now: () => clock, scheduleHarden: () => undefined, write: flakyWrite, ...o });

beforeEach(() => {
  fail = false;
  writes = 0;
  clock = 1_700_000_000_000;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-peers-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('PeerStore', () => {
  it('mint issues a credential the contract parser accepts', async () => {
    const s = make();
    const c = await s.mint({ hostId: HOST, name: 'Desk PC' });
    expect(parsePeerCredential(formatPeerCredential(c))).toEqual(c);
    expect(Buffer.from(c.secret, 'base64url')).toHaveLength(32);
  });

  it('never writes the secret to disk', async () => {
    const s = make();
    const c = await s.mint({ hostId: HOST, name: 'Desk PC' });
    const raw = fs.readFileSync(path.join(dir, PEERS_FILE), 'utf-8');
    expect(raw).not.toContain(c.secret);
    expect(JSON.parse(raw)).toMatchObject({ v: 1, peers: [{ v: 1, peerId: c.peerId, hostId: HOST }] });
  });

  it('resolves the right secret, and a fresh instance (no cache) does too', async () => {
    const s = make();
    const c = await s.mint({ hostId: HOST, name: 'Desk PC' });
    const want = { ok: true, peerId: c.peerId, hostId: HOST, name: 'Desk PC' };
    expect(await s.resolve(c.peerId, c.secret)).toEqual(want);
    expect(await make().resolve(c.peerId, c.secret)).toEqual(want);
  });

  it('a wrong secret is unknown (cached and uncached)', async () => {
    const s = make();
    const c = await s.mint({ hostId: HOST, name: 'a' });
    const wrong = `${c.secret.slice(0, -1)}${c.secret.endsWith('A') ? 'B' : 'A'}`;
    expect(await s.resolve(c.peerId, wrong)).toEqual({ ok: false, reason: 'unknown' });
    expect(await make().resolve(c.peerId, wrong)).toEqual({ ok: false, reason: 'unknown' });
    expect(await s.resolve(c.peerId, '')).toEqual({ ok: false, reason: 'unknown' });
  });

  it('a secret outside the contract shape is unknown without deriving', async () => {
    const s = make();
    const c = await s.mint({ hostId: HOST, name: 'a' });
    const t = make();
    for (const bad of ['short', 'x'.repeat(129), `${c.secret.slice(0, 40)}.~!`, '']) {
      expect(await t.resolve(c.peerId, bad)).toEqual({ ok: false, reason: 'unknown' });
    }
    expect(t.stats().derivations).toBe(0);
    // A well-formed wrong secret does derive (and is still refused).
    expect(await t.resolve(c.peerId, 'x'.repeat(43))).toEqual({ ok: false, reason: 'unknown' });
    expect(t.stats().derivations).toBe(1);
  });

  it("another peer's secret is unknown", async () => {
    const s = make();
    const a = await s.mint({ hostId: HOST, name: 'a' });
    const b = await s.mint({ hostId: HOST2, name: 'b' });
    expect(await s.resolve(a.peerId, b.secret)).toEqual({ ok: false, reason: 'unknown' });
    expect(await s.resolve(b.peerId, a.secret)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('an unknown peerId is unknown', async () => {
    const c = await make().mint({ hostId: HOST, name: 'a' });
    expect(await make().resolve('33333333-3333-4333-8333-333333333333', c.secret)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('revoked answers revoked — even with a wrong secret — and survives a restart', async () => {
    const s = make();
    const c = await s.mint({ hostId: HOST, name: 'a' });
    expect(s.revoke(c.peerId)).toBe(true);
    expect(s.revoke(c.peerId)).toBe(false);
    expect(await s.resolve(c.peerId, c.secret)).toEqual({ ok: false, reason: 'revoked' });
    expect(await s.resolve(c.peerId, 'wrong')).toEqual({ ok: false, reason: 'revoked' });
    expect(await make().resolve(c.peerId, c.secret)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('keeps only the newest revoked rows per host; a pruned id still answers at once', async () => {
    const s = make();
    const other = await s.mint({ hostId: HOST2, name: 'other' });
    s.revoke(other.peerId);
    const issued: Array<{ peerId: string; secret: string }> = [];
    for (let i = 0; i < REVOKED_KEPT_PER_HOST + 2; i++) {
      clock += 1000;
      const c = await s.mint({ hostId: HOST, name: `round ${i}` });
      issued.push(c);
      clock += 1000;
      s.revoke(c.peerId);
    }
    const kept = s.listByHost(HOST).map((r) => r.peerId);
    expect(kept).toHaveLength(REVOKED_KEPT_PER_HOST);
    expect(kept.sort()).toEqual(issued.slice(-REVOKED_KEPT_PER_HOST).map((c) => c.peerId).sort());
    // Another host's revoked row is untouched, and the file matches memory.
    expect(s.listByHost(HOST2)).toHaveLength(1);
    expect(make().listByHost(HOST)).toHaveLength(REVOKED_KEPT_PER_HOST);
    const derivations = s.stats().derivations;
    expect(await s.resolve(issued[0].peerId, issued[0].secret)).toEqual({ ok: false, reason: 'unknown' });
    expect(await s.resolve(issued.at(-1)!.peerId, issued.at(-1)!.secret)).toEqual({ ok: false, reason: 'revoked' });
    expect(s.stats().derivations).toBe(derivations);
  });

  it('list never exposes hash, salt or kdf', async () => {
    const s = make();
    const c = await s.mint({ hostId: HOST, name: '  Desk\u0007PC  ' });
    expect(s.list()).toEqual([
      { v: 1, peerId: c.peerId, hostId: HOST, name: 'Desk PC', createdAt: new Date(clock).toISOString() },
    ]);
  });

  it('touch updates lastSeenAt in memory and persists at most once per window', async () => {
    const s = make();
    const c = await s.mint({ hostId: HOST, name: 'a' });
    const base = writes;
    clock += 1000;
    s.touch(c.peerId);
    expect(writes).toBe(base);
    expect(s.list()[0].lastSeenAt).toBe(new Date(clock).toISOString());
    clock += LAST_SEEN_PERSIST_MS;
    s.touch(c.peerId);
    expect(writes).toBe(base + 1);
    expect(make().list()[0].lastSeenAt).toBe(new Date(clock).toISOString());
  });

  it('touch swallows a write failure', async () => {
    const s = make();
    const c = await s.mint({ hostId: HOST, name: 'a' });
    fail = true;
    clock += LAST_SEEN_PERSIST_MS;
    expect(() => s.touch(c.peerId)).not.toThrow();
  });

  it('mint rolls back and throws when the write fails', async () => {
    const s = make();
    fail = true;
    await expect(s.mint({ hostId: HOST, name: 'a' })).rejects.toThrow('disk full');
    expect(s.list()).toEqual([]);
  });

  it('revoke keeps the in-memory revocation when the write fails', async () => {
    const s = make();
    const c = await s.mint({ hostId: HOST, name: 'a' });
    fail = true;
    expect(() => s.revoke(c.peerId)).toThrow('disk full');
    expect(await s.resolve(c.peerId, c.secret)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('refuses a second live peer for one hostId until the first is revoked', async () => {
    const s = make();
    const a = await s.mint({ hostId: HOST, name: 'a' });
    await expect(s.mint({ hostId: HOST, name: 'impostor' })).rejects.toThrow(/revoke it first/);
    // Concurrent mints for one host: exactly one lands.
    const both = await Promise.allSettled([s.mint({ hostId: HOST2, name: 'x' }), s.mint({ hostId: HOST2, name: 'y' })]);
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    s.revoke(a.peerId);
    const b = await s.mint({ hostId: HOST, name: 're-paired' });
    expect(s.listByHost(HOST).map((p) => [p.peerId, p.revokedAt !== undefined])).toEqual([
      [a.peerId, true],
      [b.peerId, false],
    ]);
    expect(s.listByHost(HOST2)).toHaveLength(1);
  });

  it('rate-limits wrong secrets per peerId without blocking other peers', async () => {
    const s = make();
    const a = await s.mint({ hostId: HOST, name: 'a' });
    const b = await s.mint({ hostId: HOST2, name: 'b' });
    for (let i = 0; i < FAILURES_PER_WINDOW; i++) await s.resolve(a.peerId, 'wrong-secret');
    // Over budget: even the right secret is refused inside the window.
    expect(await s.resolve(a.peerId, a.secret)).toEqual({ ok: false, reason: 'unknown' });
    expect(await s.resolve(b.peerId, b.secret)).toMatchObject({ ok: true });
    clock += FAILURE_WINDOW_MS;
    expect(await s.resolve(a.peerId, a.secret)).toMatchObject({ ok: true });
  });

  it('concurrent wrong secrets for one peer derive at most the budget', async () => {
    const c = await make().mint({ hostId: HOST, name: 'a' });
    const t = make(); // fresh instance: no verified cache
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => t.resolve(c.peerId, `${'w'.repeat(42)}${String.fromCharCode(65 + i)}`)),
    );
    expect(results.every((r) => !r.ok && r.reason === 'unknown')).toBe(true);
    expect(t.stats().derivations).toBe(FAILURES_PER_WINDOW);
    // The budget is spent, so even the right secret is refused inside the window.
    expect(await t.resolve(c.peerId, c.secret)).toEqual({ ok: false, reason: 'unknown' });
    expect(t.stats().derivations).toBe(FAILURES_PER_WINDOW);
  });

  it('concurrent right secrets for one peer cost a single derivation', async () => {
    const c = await make().mint({ hostId: HOST, name: 'a' });
    const t = make();
    const results = await Promise.all(Array.from({ length: 10 }, () => t.resolve(c.peerId, c.secret)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(t.stats().derivations).toBe(1);
  });

  it('a failed lastSeenAt write is retried on the next touch', async () => {
    const s = make();
    const c = await s.mint({ hostId: HOST, name: 'a' });
    clock += LAST_SEEN_PERSIST_MS;
    fail = true;
    s.touch(c.peerId);
    fail = false;
    clock += 1;
    const before = writes;
    s.touch(c.peerId);
    expect(writes).toBe(before + 1);
    expect(make().list()[0].lastSeenAt).toBe(new Date(clock).toISOString());
  });

  it('rejects an invalid hostId', async () => {
    await expect(make().mint({ hostId: 'nope', name: 'a' })).rejects.toThrow();
  });

  describe('corrupt file is fail-closed', () => {
    it('malformed JSON: nobody authenticates, original kept, error logged', async () => {
      const c = await make().mint({ hostId: HOST, name: 'a' });
      const file = path.join(dir, PEERS_FILE);
      fs.writeFileSync(file, '{"v":1,"peers":[');
      const log = vi.fn();
      const s = make({ log });
      expect(await s.resolve(c.peerId, c.secret)).toEqual({ ok: false, reason: 'unknown' });
      expect(s.list()).toEqual([]);
      expect(fs.existsSync(`${file}.corrupt-${clock}`)).toBe(true);
      expect(log).toHaveBeenCalledWith('error', expect.stringContaining('corrupt'));
    });

    it('one bad record rejects every record, and .bak is not resurrected', async () => {
      const s = make();
      const a = await s.mint({ hostId: HOST, name: 'a' });
      await s.mint({ hostId: HOST2, name: 'b' }); // leaves a .bak holding peer a
      const file = path.join(dir, PEERS_FILE);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      parsed.peers[1].kdf.N = 1 << 30; // out of bounds
      fs.writeFileSync(file, JSON.stringify(parsed));
      const t = make();
      expect(await t.resolve(a.peerId, a.secret)).toEqual({ ok: false, reason: 'unknown' });
    });

    it.each([
      ['N not a power of two', { N: 3000 }],
      ['N of 1', { N: 1 }],
      ['r out of range', { r: 64 }],
      ['p out of range', { p: 32 }],
      ['keylen too short', { keylen: 8 }],
      ['algo not scrypt', { algo: 'pbkdf2' }],
    ])('invalid scrypt parameters (%s) reject the whole file', async (_label, patch) => {
      const s = make();
      const a = await s.mint({ hostId: HOST, name: 'a' });
      await s.mint({ hostId: HOST2, name: 'b' });
      const file = path.join(dir, PEERS_FILE);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      Object.assign(parsed.peers[1].kdf, patch);
      fs.writeFileSync(file, JSON.stringify(parsed));
      expect(await make().resolve(a.peerId, a.secret)).toEqual({ ok: false, reason: 'unknown' });
    });

    it('a hash whose length does not match keylen rejects the file', async () => {
      const a = await make().mint({ hostId: HOST, name: 'a' });
      const file = path.join(dir, PEERS_FILE);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      parsed.peers[0].secretHash = parsed.peers[0].secretHash.slice(2);
      fs.writeFileSync(file, JSON.stringify(parsed));
      expect(await make().resolve(a.peerId, a.secret)).toEqual({ ok: false, reason: 'unknown' });
    });

    it('an unreadable file: nobody authenticates, mint refused, file untouched', async () => {
      if (process.platform === 'win32') return;
      fs.mkdirSync(path.join(dir, PEERS_FILE));
      const s = make();
      await expect(s.mint({ hostId: HOST, name: 'a' })).rejects.toThrow(/unavailable/);
      expect(fs.readdirSync(dir)).toEqual([PEERS_FILE]);
    });

    it('a malformed revokedAt rejects the file rather than reviving the peer', async () => {
      const s = make();
      const a = await s.mint({ hostId: HOST, name: 'a' });
      s.revoke(a.peerId);
      const file = path.join(dir, PEERS_FILE);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      parsed.peers[0].revokedAt = 'not a date';
      fs.writeFileSync(file, JSON.stringify(parsed));
      expect(await make().resolve(a.peerId, a.secret)).toEqual({ ok: false, reason: 'unknown' });
    });
  });
});
