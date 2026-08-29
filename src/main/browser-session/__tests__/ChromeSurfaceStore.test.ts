import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ChromeSurfaceStore,
  MAX_SURFACES_PER_PROFILE,
  RECORD_TTL_MS,
  getChromeSurfacesPath,
  type ChromeSurfaceRecord,
} from '../ChromeSurfaceStore';

// Stable chrome surface ids, persisted. ChromeProfileStore test idiom: real
// tmpdir, persistence proven through a FRESH instance rather than the cache.

function record(surfaceId: string, over: Partial<ChromeSurfaceRecord> = {}): ChromeSurfaceRecord {
  const now = Date.now();
  return {
    surfaceId,
    targetId: `tgt-${surfaceId}`,
    url: `https://${surfaceId}.test/`,
    createdAt: now,
    lastSeenAt: now,
    ...over,
  };
}

describe('ChromeSurfaceStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wmux-chrome-surfaces-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('an unwritten store is empty for every profile', () => {
    const store = new ChromeSurfaceStore(dir);
    expect(store.listForProfile('default')).toEqual([]);
    expect(store.listForProfile('anything')).toEqual([]);
  });

  it('saveNow round-trips a profile snapshot through a fresh instance', async () => {
    const store = new ChromeSurfaceStore(dir);
    await store.saveNow('default', [record('chrome-a', { workspaceId: 'ws-1' })]);
    await store.saveNow('other', [record('chrome-b')]);

    const fresh = new ChromeSurfaceStore(dir);
    expect(fresh.listForProfile('default')).toEqual([
      expect.objectContaining({ surfaceId: 'chrome-a', targetId: 'tgt-chrome-a', workspaceId: 'ws-1' }),
    ]);
    // Profiles are independent slots in one file — writing one must not
    // clobber another.
    expect(fresh.listForProfile('other').map((r) => r.surfaceId)).toEqual(['chrome-b']);
  });

  it('save() coalesces writes and flushSync commits the pending snapshot', () => {
    const store = new ChromeSurfaceStore(dir);
    store.save('default', [record('chrome-a')]);
    store.save('default', [record('chrome-a'), record('chrome-b')]);
    store.save('default', [record('chrome-a'), record('chrome-b'), record('chrome-c')]);

    // Nothing has hit the disk yet (the debounce timer has not fired).
    expect(new ChromeSurfaceStore(dir).listForProfile('default')).toEqual([]);
    // ...but the store answers from the pending snapshot, not stale disk.
    expect(store.listForProfile('default').map((r) => r.surfaceId)).toEqual([
      'chrome-a',
      'chrome-b',
      'chrome-c',
    ]);

    store.flushSync();
    expect(new ChromeSurfaceStore(dir).listForProfile('default').map((r) => r.surfaceId)).toEqual([
      'chrome-a',
      'chrome-b',
      'chrome-c',
    ]);
  });

  it('an unbound record (targetId null) survives the round trip', async () => {
    const store = new ChromeSurfaceStore(dir);
    await store.saveNow('default', [record('chrome-a', { targetId: null, missingSince: Date.now() })]);
    const [restored] = new ChromeSurfaceStore(dir).listForProfile('default');
    expect(restored?.targetId).toBeNull();
    expect(typeof restored?.missingSince).toBe('number');
  });

  it('corrupt JSON fails open to an empty store instead of throwing', () => {
    writeFileSync(getChromeSurfacesPath(dir), '{ not json at all', 'utf8');
    const store = new ChromeSurfaceStore(dir);
    expect(store.listForProfile('default')).toEqual([]);
  });

  it('malformed records are dropped, the rest of the profile survives', async () => {
    writeFileSync(
      getChromeSurfacesPath(dir),
      JSON.stringify({
        version: 1,
        profiles: {
          default: [
            { surfaceId: 'chrome-ok', targetId: 't1', url: 'https://ok.test/', createdAt: 1, lastSeenAt: Date.now() },
            { targetId: 't2', url: 'https://no-id.test/' },
            'not an object',
            { surfaceId: 'chrome-no-url' },
          ],
        },
      }),
      'utf8',
    );
    expect(new ChromeSurfaceStore(dir).listForProfile('default').map((r) => r.surfaceId)).toEqual(['chrome-ok']);
  });

  it('rejects prototype-polluting profile keys on both read and write', async () => {
    writeFileSync(
      getChromeSurfacesPath(dir),
      JSON.stringify({ version: 1, profiles: { __proto__: [record('chrome-evil')], safe: [record('chrome-ok')] } }),
      'utf8',
    );
    const store = new ChromeSurfaceStore(dir);
    expect(store.listForProfile('safe').map((r) => r.surfaceId)).toEqual(['chrome-ok']);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();

    await store.saveNow('__proto__', [record('chrome-evil')]);
    const raw = JSON.parse(readFileSync(getChromeSurfacesPath(dir), 'utf8')) as {
      profiles: Record<string, unknown>;
    };
    expect(Object.keys(raw.profiles)).toEqual(['safe']);
  });

  it('caps a profile at MAX_SURFACES_PER_PROFILE, keeping the most recently seen', async () => {
    const base = Date.now();
    const many = Array.from({ length: MAX_SURFACES_PER_PROFILE + 20 }, (_, i) =>
      record(`chrome-${i}`, { lastSeenAt: base - (MAX_SURFACES_PER_PROFILE + 20 - i) * 1000 }),
    );
    const store = new ChromeSurfaceStore(dir);
    await store.saveNow('default', many);

    const kept = new ChromeSurfaceStore(dir).listForProfile('default');
    expect(kept).toHaveLength(MAX_SURFACES_PER_PROFILE);
    // The 20 oldest lost; the newest survived.
    expect(kept.map((r) => r.surfaceId)).toContain(`chrome-${MAX_SURFACES_PER_PROFILE + 19}`);
    expect(kept.map((r) => r.surfaceId)).not.toContain('chrome-0');
  });

  it('records older than the TTL are pruned on load', () => {
    const stale = record('chrome-stale', { lastSeenAt: Date.now() - RECORD_TTL_MS - 1000 });
    const live = record('chrome-live');
    writeFileSync(
      getChromeSurfacesPath(dir),
      JSON.stringify({ version: 1, profiles: { default: [stale, live] } }),
      'utf8',
    );
    expect(new ChromeSurfaceStore(dir).listForProfile('default').map((r) => r.surfaceId)).toEqual(['chrome-live']);
  });

  it('an empty snapshot removes the profile entry', async () => {
    const store = new ChromeSurfaceStore(dir);
    await store.saveNow('default', [record('chrome-a')]);
    await store.dropProfile('default');
    expect(new ChromeSurfaceStore(dir).listForProfile('default')).toEqual([]);
  });

  it('returns copies — a caller mutating the result cannot corrupt the store', async () => {
    const store = new ChromeSurfaceStore(dir);
    await store.saveNow('default', [record('chrome-a')]);
    const first = store.listForProfile('default');
    for (const r of first) r.url = 'https://tampered/';
    expect(store.listForProfile('default')[0]?.url).toBe('https://chrome-a.test/');
  });
});
