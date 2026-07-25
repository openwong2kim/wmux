import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DeviceStore, UNNAMED_DEVICE, coerceDeviceState, getDeviceStatePath } from '../DeviceStore';
import { DeviceAuditLog, DEVICE_AUDIT_MAX_BYTES, getDeviceAuditPath } from '../deviceAudit';

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

    expect(audit.append({ event: 'auth-failure', deviceId: 'd1', reason: 'unknown' })).toBe(true);
    for (let i = 0; i < 50; i++) {
      expect(audit.append({ event: 'auth-failure', deviceId: 'd1', reason: 'unknown' })).toBe(false);
    }
    // A different device is its own key, and is not suppressed by the first.
    expect(audit.append({ event: 'auth-failure', deviceId: 'd2', reason: 'unknown' })).toBe(true);

    clock += 2_001;
    expect(audit.append({ event: 'auth-failure', deviceId: 'd1', reason: 'unknown' })).toBe(true);
    expect(audit.read()).toHaveLength(3);
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
