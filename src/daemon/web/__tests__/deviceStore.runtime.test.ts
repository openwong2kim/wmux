import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeviceStore, UNNAMED_DEVICE, coerceDeviceState, getDeviceStatePath } from '../DeviceStore';
import {
  DeviceAuditLog,
  DEVICE_AUDIT_MAX_BYTES,
  AUTH_FAILURE_COALESCE_MS,
  getDeviceAuditPath,
} from '../deviceAudit';

// Disk-IO → `.runtime.test.ts` so it runs serially (vitest.runtime.config sets
// fileParallelism:false) and the tmp+rename dance never races another file.
// The first write per directory goes through secureWriteTokenFile, which shells
// out to icacls on Windows; that is the real path and it is fast (~50-100ms).

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-devices-'));
});
afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const store = (over: Partial<{ now: () => number }> = {}): DeviceStore =>
  new DeviceStore({ wmuxDir: dir, ...over });

/** Turn the roster file into a directory so every subsequent write fails. */
const breakWrites = (): void => {
  const target = getDeviceStatePath(dir);
  fs.rmSync(target, { force: true });
  fs.mkdirSync(target);
};

describe('DeviceStore — mint / verify round trip', () => {
  it('a minted secret authenticates, and only that secret does', async () => {
    const s = store();
    const minted = await s.mint({ name: 'Pixel 9' });

    expect(minted.deviceId).toBeTruthy();
    expect(minted.deviceSecret).toBeTruthy();
    expect(minted.name).toBe('Pixel 9');

    expect(s.resolve(minted.deviceId, minted.deviceSecret)).toEqual({
      ok: true,
      deviceId: minted.deviceId,
      name: 'Pixel 9',
    });
    expect(s.resolve(minted.deviceId, `${minted.deviceSecret}x`)).toEqual({
      ok: false,
      reason: 'unknown',
    });
  });

  it('never writes the secret — the file holds a salted hash and nothing else', async () => {
    const s = store();
    const minted = await s.mint({ name: 'iPhone' });
    const raw = fs.readFileSync(getDeviceStatePath(dir), 'utf-8');

    expect(raw).not.toContain(minted.deviceSecret);
    const parsed = JSON.parse(raw) as { devices: Array<Record<string, unknown>> };
    expect(parsed.devices).toHaveLength(1);
    expect(parsed.devices[0]).toMatchObject({ deviceId: minted.deviceId, name: 'iPhone' });
    expect(parsed.devices[0]['secretHash']).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed.devices[0]['salt']).toMatch(/^[0-9a-f]{32}$/);
    expect(parsed.devices[0]['kdf']).toMatchObject({ algo: 'scrypt' });
  });

  it('the roster survives a restart — a new store verifies the same secret', async () => {
    const minted = await store().mint({ name: 'Tablet' });

    const restarted = store();
    expect(restarted.resolve(minted.deviceId, minted.deviceSecret)).toMatchObject({ ok: true });
    // A cold instance has no cache, so this one really ran the KDF.
    expect(restarted.stats().derivations).toBe(1);
  });

  it('gives every device its own salt, so no work is ever shared between them', async () => {
    const s = store();
    await s.mint({ name: 'A' });
    await s.mint({ name: 'B' });
    const parsed = JSON.parse(fs.readFileSync(getDeviceStatePath(dir), 'utf-8')) as {
      devices: Array<{ salt: string }>;
    };
    expect(parsed.devices[0].salt).not.toBe(parsed.devices[1].salt);
  });
});

describe('DeviceStore — unknown vs revoked', () => {
  it('distinguishes the two, so the phone can show honest copy', async () => {
    const s = store();
    const keep = await s.mint({ name: 'Keeper' });
    const drop = await s.mint({ name: 'Doomed' });

    expect(s.revoke(drop.deviceId)).toEqual({ ok: true });

    // Revoked: the right secret still fails, and says WHY.
    expect(s.resolve(drop.deviceId, drop.deviceSecret)).toEqual({ ok: false, reason: 'revoked' });
    // Never paired at all: a different answer.
    expect(s.resolve('00000000-0000-4000-8000-000000000000', 'whatever')).toEqual({
      ok: false,
      reason: 'unknown',
    });
    // And the other device is untouched.
    expect(s.resolve(keep.deviceId, keep.deviceSecret)).toMatchObject({ ok: true });
  });

  it('a wrong secret on a known device is `unknown`, never `revoked`', async () => {
    const s = store();
    const d = await s.mint({ name: 'Phone' });
    // The 401 body must not tell a guesser which half of the credential was right.
    expect(s.resolve(d.deviceId, 'wrong')).toEqual({ ok: false, reason: 'unknown' });
  });

  it('revocation survives a restart', async () => {
    const s = store();
    const d = await s.mint({ name: 'Phone' });
    s.revoke(d.deviceId);

    expect(store().resolve(d.deviceId, d.deviceSecret)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('a revoked device never reaches the KDF — a retry loop cannot force work', async () => {
    const s = store();
    const d = await s.mint({ name: 'Phone' });
    s.revoke(d.deviceId);

    const before = s.stats().derivations;
    for (let i = 0; i < 5; i++) s.resolve(d.deviceId, d.deviceSecret);
    expect(s.stats().derivations).toBe(before);
  });

  it('revoking something that was never paired reports not-found', () => {
    expect(store().revoke('nope')).toEqual({ ok: false, reason: 'not-found' });
  });
});

describe('DeviceStore — revoke is fail-closed', () => {
  it('reports failure when the roster cannot be persisted', async () => {
    const s = store();
    const d = await s.mint({ name: 'Phone' });
    breakWrites();

    const result = s.revoke(d.deviceId);

    // The operator is told the truth: this did NOT make it to disk, so it must
    // not be believed to have survived a restart.
    expect(result).toEqual({ ok: false, reason: 'persist-failed' });
  });

  it('blocks the device in memory anyway, so it stops working NOW', async () => {
    const s = store();
    const d = await s.mint({ name: 'Phone' });
    breakWrites();
    s.revoke(d.deviceId);

    // Reverting the in-memory revocation on a write failure would leave a
    // device the operator just tried to kill still serving traffic.
    expect(s.resolve(d.deviceId, d.deviceSecret)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('a failed mint hands back no credential at all', async () => {
    const s = store();
    await s.mint({ name: 'First' });
    breakWrites();

    await expect(s.mint({ name: 'Second' })).rejects.toThrow(/persist/i);
    // And the half-created device is not left authenticating from memory.
    expect(s.stats().devices).toBe(1);
  });

  it('re-revoking an already-revoked device is idempotent success', async () => {
    const s = store();
    const d = await s.mint({ name: 'Phone' });
    expect(s.revoke(d.deviceId)).toEqual({ ok: true });
    expect(s.revoke(d.deviceId)).toEqual({ ok: true });
  });
});

describe('DeviceStore — malformed devices.json', () => {
  it('degrades to an empty roster instead of throwing', () => {
    fs.writeFileSync(getDeviceStatePath(dir), '{ this is not json', 'utf-8');

    let s: DeviceStore | null = null;
    expect(() => {
      s = store();
    }).not.toThrow();
    expect(s!.list()).toEqual([]);
    expect(s!.resolve('anything', 'anything')).toEqual({ ok: false, reason: 'unknown' });
  });

  it('keeps the good records and drops only the unusable ones', async () => {
    const good = await store().mint({ name: 'Good' });
    const parsed = JSON.parse(fs.readFileSync(getDeviceStatePath(dir), 'utf-8')) as {
      devices: unknown[];
    };
    parsed.devices.push(
      { deviceId: 'no-hash', name: 'Broken', salt: 'ab', createdAt: 1 },
      { deviceId: 'bad-kdf', secretHash: 'ab', salt: 'cd', kdf: { algo: 'md5' }, createdAt: 1 },
      'not even an object',
      null,
    );
    fs.writeFileSync(getDeviceStatePath(dir), JSON.stringify(parsed), 'utf-8');

    const s = store();
    expect(s.list().map((d) => d.name)).toEqual(['Good']);
    expect(s.resolve(good.deviceId, good.deviceSecret)).toMatchObject({ ok: true });
  });

  it('an unparseable revokedAt is read as REVOKED, not as active', () => {
    // Fail-closed: "this record may have been revoked" has exactly one safe reading.
    const state = coerceDeviceState({
      devices: [
        {
          deviceId: 'd1',
          name: 'x',
          secretHash: 'aabb',
          salt: 'ccdd',
          kdf: { algo: 'scrypt', N: 4096, r: 8, p: 1, keylen: 32 },
          createdAt: 5,
          revokedAt: 'yesterday',
        },
      ],
    });
    expect(state.devices[0].revokedAt).toBe(5);
  });

  it('drops duplicate ids so lookup-by-id can never be ambiguous', () => {
    const record = {
      deviceId: 'dupe',
      name: 'first',
      secretHash: 'aabb',
      salt: 'ccdd',
      kdf: { algo: 'scrypt', N: 4096, r: 8, p: 1, keylen: 32 },
      createdAt: 1,
    };
    const state = coerceDeviceState({ devices: [record, { ...record, name: 'second' }] });
    expect(state.devices).toHaveLength(1);
    expect(state.devices[0].name).toBe('first');
  });

  it('refuses an id carrying the credential separator', () => {
    const state = coerceDeviceState({
      devices: [
        {
          deviceId: 'has.dot',
          name: 'x',
          secretHash: 'aabb',
          salt: 'ccdd',
          kdf: { algo: 'scrypt', N: 4096, r: 8, p: 1, keylen: 32 },
          createdAt: 1,
        },
      ],
    });
    // `<deviceId>.<secret>` would be unsplittable, so the record is not usable.
    expect(state.devices).toEqual([]);
  });

  it('bounds hand-edited KDF parameters', () => {
    const state = coerceDeviceState({
      devices: [
        {
          deviceId: 'd1',
          name: 'x',
          secretHash: 'aabb',
          salt: 'ccdd',
          // An N this large would stall the daemon for minutes on one auth.
          kdf: { algo: 'scrypt', N: 2 ** 24, r: 8, p: 1, keylen: 32 },
          createdAt: 1,
        },
      ],
    });
    expect(state.devices).toEqual([]);
  });
});

describe('DeviceStore — timing shape', () => {
  it('does not branch on secret length before the constant-time compare', async () => {
    const s = store();
    const d = await s.mint({ name: 'Phone' });
    // mint seeds the cache from the secret it generated; a wrong secret can
    // never hit that entry, so each attempt below must run a full derivation.
    const lengths = ['', 'x', 'x'.repeat(31), 'x'.repeat(43), 'x'.repeat(200), 'x'.repeat(5000)];

    for (const secret of lengths) {
      const before = s.stats().derivations;
      // Identical answer for every length — no early "wrong size" refusal.
      expect(s.resolve(d.deviceId, secret)).toEqual({ ok: false, reason: 'unknown' });
      // And each one paid for a derivation: the compare is reached in all cases,
      // which is only possible if nothing short-circuited on length first.
      expect(s.stats().derivations).toBe(before + 1);
    }
  });

  it('an unknown device id costs no derivation at all', () => {
    const s = store();
    s.resolve('never-paired', 'x'.repeat(43));
    // The id is a public handle; answering fast leaks nothing, and a garbage id
    // must not be a lever for CPU work.
    expect(s.stats().derivations).toBe(0);
  });

  it('caches the derived key per device, so repeat auth costs one SHA-256', async () => {
    const minted = await store().mint({ name: 'Phone' });
    const s = store(); // cold: no cache

    expect(s.resolve(minted.deviceId, minted.deviceSecret)).toMatchObject({ ok: true });
    expect(s.stats()).toMatchObject({ derivations: 1, cacheHits: 0 });

    for (let i = 0; i < 10; i++) {
      expect(s.resolve(minted.deviceId, minted.deviceSecret)).toMatchObject({ ok: true });
    }
    expect(s.stats()).toMatchObject({ derivations: 1, cacheHits: 10 });
  });

  it('the cache is dropped on revoke, in memory as well as on disk', async () => {
    const s = store();
    const d = await s.mint({ name: 'Phone' });
    expect(s.stats().cacheSize).toBe(1);
    s.revoke(d.deviceId);
    expect(s.stats().cacheSize).toBe(0);
  });
});

describe('DeviceStore — roster housekeeping', () => {
  it('names the device, bounding and cleaning what the operator typed', async () => {
    const s = store();
    expect((await s.mint({ name: '  Living room  ' })).name).toBe('Living room');
    expect((await s.mint({ name: 'a b\nc' })).name).toBe('a b c');
    expect((await s.mint({ name: 'x'.repeat(200) })).name).toHaveLength(64);
    // Pairing must not fail over a label, so an empty one gets a placeholder
    // that reads as the anomaly it is in the roster.
    expect((await s.mint({})).name).toBe(UNNAMED_DEVICE);
    expect((await s.mint({ name: '   ' })).name).toBe(UNNAMED_DEVICE);
  });

  it('list() exposes no secret material', async () => {
    const s = store();
    await s.mint({ name: 'Phone' });
    const [row] = s.list();
    expect(Object.keys(row).sort()).toEqual(['createdAt', 'deviceId', 'lastSeenAt', 'name']);
  });

  it('throttles lastSeenAt writes but always updates in memory', async () => {
    let clock = 1_000_000;
    const s = store({ now: () => clock });
    const d = await s.mint({ name: 'Phone' });

    const writeCount = (): number => JSON.parse(fs.readFileSync(getDeviceStatePath(dir), 'utf-8'))
      .devices[0].lastSeenAt as number;
    const mintedAt = writeCount();

    clock += 1_000;
    s.touch(d.deviceId);
    // In memory immediately...
    expect(s.list()[0].lastSeenAt).toBe(clock);
    // ...but not yet on disk: a per-request write is not worth a timestamp.
    expect(writeCount()).toBe(mintedAt);

    clock += 60_001;
    s.touch(d.deviceId);
    expect(writeCount()).toBe(clock);
  });

  it('does not touch a revoked device back to life', async () => {
    const s = store();
    const d = await s.mint({ name: 'Phone' });
    s.revoke(d.deviceId);
    s.touch(d.deviceId);
    expect(s.resolve(d.deviceId, d.deviceSecret)).toEqual({ ok: false, reason: 'revoked' });
  });
});

describe('device audit log', () => {
  it('records pairing and revocation', async () => {
    const s = store();
    const d = await s.mint({ name: 'Pixel' });
    s.revoke(d.deviceId);

    const entries = new DeviceAuditLog(dir).read();
    expect(entries.map((e) => e.event)).toEqual(['pair', 'revoke']);
    expect(entries.every((e) => e.deviceId === d.deviceId)).toBe(true);
    expect(entries[0].name).toBe('Pixel');
    expect(entries[0].ts).toBeGreaterThan(0);
  });

  it('records auth failures with the reason', async () => {
    let clock = 1_000;
    const s = store({ now: () => clock });
    const d = await s.mint({ name: 'Pixel' });

    clock += 5_000;
    s.resolve(d.deviceId, 'wrong');
    clock += 5_000;
    s.revoke(d.deviceId);
    clock += 5_000;
    s.resolve(d.deviceId, d.deviceSecret);

    const failures = new DeviceAuditLog(dir).read().filter((e) => e.event === 'auth-failure');
    expect(failures.map((e) => e.reason)).toEqual(['unknown', 'revoked']);
  });

  it('coalesces repeated failures so a retry loop cannot spam the disk', () => {
    let clock = 1_000;
    const audit = new DeviceAuditLog(dir, () => clock);
    const key = (deviceId: string) => ({ coalesceKey: deviceId });

    expect(audit.append({ event: 'auth-failure', deviceId: 'd1', reason: 'unknown' }, key('d1'))).toBe(true);
    for (let i = 0; i < 50; i++) {
      expect(audit.append({ event: 'auth-failure', deviceId: 'd1', reason: 'unknown' }, key('d1'))).toBe(false);
    }
    // A different KNOWN device is its own key, and is not suppressed by the
    // first — two rostered devices failing is two distinct facts.
    expect(audit.append({ event: 'auth-failure', deviceId: 'd2', reason: 'unknown' }, key('d2'))).toBe(true);

    clock += 2_001;
    expect(audit.append({ event: 'auth-failure', deviceId: 'd1', reason: 'unknown' }, key('d1'))).toBe(true);
    expect(audit.read()).toHaveLength(3);
  });

  it('shares one bucket when the caller cannot vouch for the id', () => {
    const audit = new DeviceAuditLog(dir, () => 1_000);
    // No coalesceKey — the ids named nothing in the roster, so they are just
    // text the caller sent and must not each buy their own disk write.
    expect(audit.append({ event: 'auth-failure', deviceId: 'bogus-1', reason: 'unknown' })).toBe(true);
    for (let i = 2; i < 200; i++) {
      expect(audit.append({ event: 'auth-failure', deviceId: `bogus-${i}`, reason: 'unknown' })).toBe(false);
    }
    expect(audit.read()).toHaveLength(1);
  });

  it('never coalesces pair or revoke — every one is a distinct fact', () => {
    const audit = new DeviceAuditLog(dir, () => 1_000);
    expect(audit.append({ event: 'pair', deviceId: 'd1' })).toBe(true);
    expect(audit.append({ event: 'revoke', deviceId: 'd1' })).toBe(true);
    expect(audit.append({ event: 'revoke', deviceId: 'd1' })).toBe(true);
    expect(audit.read()).toHaveLength(3);
  });

  it('caps the file by size, keeping the newest entries', () => {
    let clock = 1_000;
    const audit = new DeviceAuditLog(dir, () => clock);
    // Long names so the cap is reached in a manageable number of appends.
    const filler = 'n'.repeat(200);

    for (let i = 0; i < 1500; i++) {
      clock += 1;
      audit.append({ event: 'pair', deviceId: `d${i}`, name: filler });
    }

    const size = fs.statSync(getDeviceAuditPath(dir)).size;
    expect(size).toBeLessThanOrEqual(DEVICE_AUDIT_MAX_BYTES);

    const entries = audit.read();
    // The newest survived; the oldest were dropped.
    expect(entries[entries.length - 1].deviceId).toBe('d1499');
    expect(entries.length).toBeLessThan(1500);
    // Compaction is line-aligned: every surviving line still parses.
    expect(entries.every((e) => e.event === 'pair' && e.name === filler)).toBe(true);
  });

  it('an unwritable audit file never breaks the operation it describes', async () => {
    fs.mkdirSync(getDeviceAuditPath(dir));
    const s = store();
    // The audit is a record OF the pairing, not a precondition for it.
    const d = await s.mint({ name: 'Phone' });
    expect(s.resolve(d.deviceId, d.deviceSecret)).toMatchObject({ ok: true });
  });
});

describe('DeviceStore — revocation durability', () => {
  it('a retry after a failed write does not report success', async () => {
    const s = store();
    const d = await s.mint({ name: 'Phone' });
    breakWrites();

    // First attempt: blocked in memory, honest about the disk.
    expect(s.revoke(d.deviceId)).toEqual({ ok: false, reason: 'persist-failed' });
    expect(s.resolve(d.deviceId, d.deviceSecret)).toMatchObject({ ok: false, reason: 'revoked' });

    // The retry used to take the "already revoked" shortcut and answer ok:true
    // about a tombstone that only existed in memory.
    expect(s.revoke(d.deviceId)).toEqual({ ok: false, reason: 'persist-failed' });

    // Once the disk works again the retry both writes and reports the truth.
    fs.rmSync(getDeviceStatePath(dir), { recursive: true, force: true });
    expect(s.revoke(d.deviceId)).toEqual({ ok: true });
    expect(new DeviceStore({ wmuxDir: dir }).resolve(d.deviceId, d.deviceSecret)).toMatchObject({
      ok: false,
      reason: 'revoked',
    });
  });
});

describe('DeviceStore — revokeAll (token rotation)', () => {
  it('revokes every active device and survives a restart', async () => {
    const s = store();
    const a = await s.mint({ name: 'Phone' });
    const b = await s.mint({ name: 'Tablet' });

    const out = s.revokeAll();
    expect(out.ok).toBe(true);
    expect(out.revoked.sort()).toEqual([a.deviceId, b.deviceId].sort());

    // Durable, not just in-memory: a fresh store reads the tombstones back.
    const reloaded = new DeviceStore({ wmuxDir: dir });
    expect(reloaded.resolve(a.deviceId, a.deviceSecret)).toMatchObject({ reason: 'revoked' });
    expect(reloaded.resolve(b.deviceId, b.deviceSecret)).toMatchObject({ reason: 'revoked' });
  });

  it('is idempotent and reports nothing to revoke on an empty roster', () => {
    const s = store();
    expect(s.revokeAll()).toEqual({ ok: true, revoked: [] });
  });

  it('fails closed when the roster cannot be written', async () => {
    const s = store();
    const d = await s.mint({ name: 'Phone' });
    breakWrites();

    const out = s.revokeAll();
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('persist-failed');
    // Blocked here and now regardless of the disk — the caller still cuts the
    // streams, and the RPC turns `ok:false` into a failed rotation.
    expect(s.resolve(d.deviceId, d.deviceSecret)).toMatchObject({ reason: 'revoked' });
  });
});

describe('DeviceStore — audit write amplification', () => {
  it('a rotating device id cannot drive one disk write per request', () => {
    let clock = 1_000;
    const s = store({ now: () => clock });
    const audit = getDeviceAuditPath(dir);

    // 500 requests, a fresh unguessable id each time, all inside one coalescing
    // window. Keying the throttle on the presented id gave each its own bucket,
    // so every one of these was a synchronous appendFileSync on the daemon's
    // event loop.
    for (let i = 0; i < 500; i++) {
      clock += 1; // still far inside AUTH_FAILURE_COALESCE_MS
      expect(s.resolve(`bogus-${i}`, 'nope')).toMatchObject({ ok: false, reason: 'unknown' });
    }

    const lines = fs.existsSync(audit)
      ? fs.readFileSync(audit, 'utf8').split('\n').filter(Boolean).length
      : 0;
    expect(lines).toBe(1);
  });

  it('still records a rotating id once per window, so the attempt is visible', () => {
    let clock = 1_000;
    const s = store({ now: () => clock });
    s.resolve('bogus-a', 'nope');
    clock += AUTH_FAILURE_COALESCE_MS + 1;
    s.resolve('bogus-b', 'nope');

    const lines = fs
      .readFileSync(getDeviceAuditPath(dir), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.event === 'auth-failure' && l.reason === 'unknown')).toBe(true);
  });

  it('a known device keeps its own bucket, so hammering one id is still visible', async () => {
    let clock = 1_000;
    const s = store({ now: () => clock });
    const a = await s.mint({ name: 'Phone' });
    const b = await s.mint({ name: 'Tablet' });
    const before = fs.readFileSync(getDeviceAuditPath(dir), 'utf8').split('\n').filter(Boolean).length;

    // Two DIFFERENT known devices failing in the same window are two distinct
    // facts; they must not collapse into each other.
    clock += 1;
    expect(s.resolve(a.deviceId, 'wrong')).toMatchObject({ ok: false, reason: 'unknown' });
    clock += 1;
    expect(s.resolve(b.deviceId, 'wrong')).toMatchObject({ ok: false, reason: 'unknown' });

    const after = fs.readFileSync(getDeviceAuditPath(dir), 'utf8').split('\n').filter(Boolean);
    expect(after.length - before).toBe(2);
    const failures = after.slice(before).map((l) => JSON.parse(l));
    expect(failures.map((f) => f.deviceId).sort()).toEqual([a.deviceId, b.deviceId].sort());
  });
});

describe('DeviceStore — push registration', () => {
  const TOKEN = 'a'.repeat(64);
  const KEY = Buffer.from(
    '8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a',
    'hex',
  ).toString('base64');

  it('registers, survives a restart, and lists as a push target', async () => {
    const s = store();
    const d = await s.mint({ name: 'Phone' });

    expect(s.registerPush(d.deviceId, { apnsToken: TOKEN, publicKey: KEY })).toEqual({ ok: true });
    expect(s.pushTargets()).toEqual([
      { deviceId: d.deviceId, name: 'Phone', push: expect.objectContaining({ apnsToken: TOKEN, publicKey: KEY }) },
    ]);

    // The whole point is surviving a restart — push exists for a phone that is
    // NOT currently connected.
    const reloaded = new DeviceStore({ wmuxDir: dir });
    expect(reloaded.pushTargets().map((t) => t.deviceId)).toEqual([d.deviceId]);
  });

  it('replaces wholesale, because a half-updated registration seals to a dead key', async () => {
    const s = store();
    const d = await s.mint({ name: 'Phone' });
    const KEY2 = Buffer.alloc(32, 7).toString('base64');
    s.registerPush(d.deviceId, { apnsToken: TOKEN, publicKey: KEY });
    s.registerPush(d.deviceId, { apnsToken: 'b'.repeat(64), publicKey: KEY2 });

    const [target] = s.pushTargets();
    expect(target.push.apnsToken).toBe('b'.repeat(64));
    expect(target.push.publicKey).toBe(KEY2);
  });

  it('refuses a revoked device — it must not keep itself reachable', async () => {
    const s = store();
    const d = await s.mint({ name: 'Phone' });
    s.registerPush(d.deviceId, { apnsToken: TOKEN, publicKey: KEY });
    s.revoke(d.deviceId);

    expect(s.registerPush(d.deviceId, { apnsToken: TOKEN, publicKey: KEY })).toEqual({
      ok: false,
      reason: 'revoked',
    });
    // …and it drops out of the target list without the caller filtering.
    expect(s.pushTargets()).toEqual([]);
  });

  it('validates both fields', async () => {
    const s = store();
    const d = await s.mint({ name: 'Phone' });
    expect(s.registerPush(d.deviceId, { apnsToken: 'nope', publicKey: KEY }).reason).toBe('bad-token');
    expect(s.registerPush(d.deviceId, { apnsToken: TOKEN, publicKey: 'nope' }).reason).toBe('bad-key');
    // A 31-byte key is the shape a truncation bug produces.
    expect(
      s.registerPush(d.deviceId, { apnsToken: TOKEN, publicKey: Buffer.alloc(31).toString('base64') }).reason,
    ).toBe('bad-key');
    expect(s.registerPush('no-such-device', { apnsToken: TOKEN, publicKey: KEY }).reason).toBe('not-found');
  });

  it('★ a dead-token removal that cannot be written reports failure', async () => {
    // Returning success would mean the dead token reappears on the next start
    // and gets sent again — precisely the traffic this exists to stop, and the
    // kind that gets a provider throttled.
    const s = store();
    const dev = await s.mint({ name: 'Phone' });
    s.registerPush(dev.deviceId, { apnsToken: TOKEN, publicKey: KEY });
    breakWrites();

    expect(s.forgetPush(dev.deviceId)).toBe(false);
    // Rolled back, so memory matches the disk rather than silently diverging.
    expect(s.pushTargets()).toHaveLength(1);
  });

  it('drops a registration Apple reported dead', async () => {
    const s = store();
    const d = await s.mint({ name: 'Phone' });
    s.registerPush(d.deviceId, { apnsToken: TOKEN, publicKey: KEY });
    expect(s.forgetPush(d.deviceId)).toBe(true);
    expect(s.pushTargets()).toEqual([]);
    expect(new DeviceStore({ wmuxDir: dir }).pushTargets()).toEqual([]);
  });

  it('a malformed persisted push block is dropped, not half-read', () => {
    const path = getDeviceStatePath(dir);
    fs.writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        devices: [{
          deviceId: 'd1', name: 'X', secretHash: 'ab', salt: 'cd',
          kdf: { algo: 'scrypt', N: 4096, r: 8, p: 1, keylen: 32 },
          createdAt: 1, lastSeenAt: 1,
          push: { apnsToken: TOKEN, publicKey: 'not-a-key' },
        }],
      }),
      'utf8',
    );
    const s = new DeviceStore({ wmuxDir: dir });
    // The device survives; only the unusable registration is gone.
    expect(s.list().map((d) => d.deviceId)).toEqual(['d1']);
    expect(s.pushTargets()).toEqual([]);
  });
});

describe('DeviceStore — APNs stage, per device', () => {
  const APNS_TOKEN = 'a'.repeat(64);
  const PUBLIC_KEY = Buffer.alloc(32, 7).toString('base64');

  it('★ stores the stage and hands it to the sender', async () => {
    const s = store();
    const minted = await s.mint({ name: 'TestFlight phone' });
    expect(
      s.registerPush(minted.deviceId, {
        apnsToken: APNS_TOKEN,
        publicKey: PUBLIC_KEY,
        apnsEnvironment: 'production',
      }),
    ).toEqual({ ok: true });
    expect(s.pushTargets()[0]?.push.apnsEnvironment).toBe('production');
  });

  it('★ a re-registration that names no stage clears the old one', async () => {
    // A registration replaces the record wholesale. Inheriting the previous
    // stage would keep routing a NEW token — minted by whichever build is
    // talking to us now — to the host the OLD build belonged to.
    const s = store();
    const minted = await s.mint({ name: 'Phone' });
    s.registerPush(minted.deviceId, {
      apnsToken: APNS_TOKEN, publicKey: PUBLIC_KEY, apnsEnvironment: 'development',
    });
    s.registerPush(minted.deviceId, { apnsToken: APNS_TOKEN, publicKey: PUBLIC_KEY });
    expect(s.pushTargets()[0]?.push.apnsEnvironment).toBeUndefined();
  });

  it('refuses a stage that is neither of Apple two words', async () => {
    const s = store();
    const minted = await s.mint({ name: 'Phone' });
    expect(
      s.registerPush(minted.deviceId, {
        apnsToken: APNS_TOKEN, publicKey: PUBLIC_KEY, apnsEnvironment: 'sandbox',
      }),
    ).toEqual({ ok: false, reason: 'bad-apns-environment' });
    // Nothing was written: a rejected registration must not half-land.
    expect(s.pushTargets()).toEqual([]);
  });
});
