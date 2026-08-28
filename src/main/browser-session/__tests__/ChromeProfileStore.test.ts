import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChromeProfileStore, DEFAULT_CHROME_PROFILE } from '../ChromeProfileStore';

// Chrome-profile registry + workspace bindings (Phase 2.5). accountStore test
// idiom: real tmpdir, persistence proven via a fresh instance.

describe('ChromeProfileStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'wmux-chrome-profiles-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('always has the default profile and unbound workspaces resolve to it', () => {
    const store = new ChromeProfileStore(dir);
    expect(store.listProfiles()).toEqual([DEFAULT_CHROME_PROFILE]);
    expect(store.profileFor('ws-anything')).toBe(DEFAULT_CHROME_PROFILE);
    expect(store.profileFor(undefined)).toBe(DEFAULT_CHROME_PROFILE);
  });

  it('create + bind persist across a fresh instance; unbind falls back to default', async () => {
    const store = new ChromeProfileStore(dir);
    await store.create('youtube-a');
    await store.setBinding('ws-1', 'youtube-a');

    const fresh = new ChromeProfileStore(dir);
    expect(fresh.listProfiles()).toEqual([DEFAULT_CHROME_PROFILE, 'youtube-a']);
    expect(fresh.profileFor('ws-1')).toBe('youtube-a');

    await fresh.setBinding('ws-1', null);
    expect(new ChromeProfileStore(dir).profileFor('ws-1')).toBe(DEFAULT_CHROME_PROFILE);
  });

  it('rejects invalid names and bindings to unknown profiles', async () => {
    const store = new ChromeProfileStore(dir);
    await expect(store.create('../evil')).rejects.toThrow('Browser profile names');
    await expect(store.setBinding('ws-1', 'nope')).rejects.toThrow('unknown Chrome profile');
    await expect(store.setBinding('__proto__', 'default')).rejects.toThrow('invalid workspaceId');
  });

  it('load with knownWorkspaceIds lazily prunes orphan bindings', async () => {
    const store = new ChromeProfileStore(dir);
    await store.create('p1');
    await store.setBinding('ws-old', 'p1');

    const fresh = new ChromeProfileStore(dir);
    fresh.load(new Set(['ws-new']));
    expect(fresh.profileFor('ws-old')).toBe(DEFAULT_CHROME_PROFILE);
  });
});
