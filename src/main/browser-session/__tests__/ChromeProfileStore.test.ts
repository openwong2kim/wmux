import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ChromeProfileStore,
  DEFAULT_CHROME_PROFILE,
  LIVE_CHROME_PROFILE,
  getChromeProfilesPath,
  reconcilePaneBindingsFromMirror,
} from '../ChromeProfileStore';
import { WorkspaceMirror } from '../../workspace/WorkspaceMirror';

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

  it("the reserved 'live' profile binds without create, and create('live') is rejected (Phase 3)", async () => {
    const store = new ChromeProfileStore(dir);
    await expect(store.create(LIVE_CHROME_PROFILE)).rejects.toThrow('reserved');
    await store.setBinding('ws-1', LIVE_CHROME_PROFILE);
    // Survives reload/sanitize despite not being in profiles[].
    expect(new ChromeProfileStore(dir).profileFor('ws-1')).toBe(LIVE_CHROME_PROFILE);
  });

  it('load with knownWorkspaceIds lazily prunes orphan bindings', async () => {
    const store = new ChromeProfileStore(dir);
    await store.create('p1');
    await store.setBinding('ws-old', 'p1');

    const fresh = new ChromeProfileStore(dir);
    fresh.load(new Set(['ws-new']));
    expect(fresh.profileFor('ws-old')).toBe(DEFAULT_CHROME_PROFILE);
  });

  // ── v2: per-pane bindings ────────────────────────────────────────────────

  it('a v1 file loads unchanged, and the next write is v2 with paneBindings', async () => {
    writeFileSync(
      getChromeProfilesPath(dir),
      JSON.stringify({ version: 1, profiles: ['default', 'p1', 'p2'], bindings: { 'ws-1': 'p1' } }),
    );
    const store = new ChromeProfileStore(dir);
    expect(store.listProfiles()).toEqual(['default', 'p1', 'p2']);
    expect(store.profileFor('ws-1')).toBe('p1');
    expect(store.getPaneBindings()).toEqual({});
    expect(store.hasPaneBindings('ws-1')).toBe(false);

    await store.setPaneBinding('pane-a', 'ws-1', 'p2');
    const raw = JSON.parse(readFileSync(getChromeProfilesPath(dir), 'utf8'));
    expect(raw.version).toBe(2);
    expect(raw.bindings).toEqual({ 'ws-1': 'p1' });
    expect(raw.paneBindings).toEqual({ 'pane-a': { workspaceId: 'ws-1', profile: 'p2' } });
  });

  it('the pane binding wins in its own workspace only; unbinding falls back to the workspace', async () => {
    const store = new ChromeProfileStore(dir);
    await store.create('ws-prof');
    await store.create('pane-prof');
    await store.setBinding('ws-1', 'ws-prof');
    await store.setPaneBinding('pane-a', 'ws-1', 'pane-prof');

    const fresh = new ChromeProfileStore(dir);
    expect(fresh.profileFor('ws-1', 'pane-a')).toBe('pane-prof');
    expect(fresh.profileFor('ws-1', 'pane-b')).toBe('ws-prof');
    expect(fresh.profileFor('ws-1')).toBe('ws-prof');
    // The pane moved to another workspace: its binding does not follow it.
    expect(fresh.profileFor('ws-2', 'pane-a')).toBe(DEFAULT_CHROME_PROFILE);
    expect(fresh.hasPaneBindings('ws-1')).toBe(true);
    expect(fresh.hasPaneBindings('ws-2')).toBe(false);
    expect(fresh.isPaneBound('pane-prof')).toBe(true);
    expect(fresh.isPaneBound('ws-prof')).toBe(false);

    await fresh.setPaneBinding('pane-a', 'ws-1', null);
    expect(new ChromeProfileStore(dir).profileFor('ws-1', 'pane-a')).toBe('ws-prof');
  });

  it('refuses every profile that is not exclusively the pane\'s', async () => {
    const store = new ChromeProfileStore(dir);
    await store.create('shared');
    await store.create('mine');
    await store.setBinding('ws-1', 'shared');
    await store.setPaneBinding('pane-a', 'ws-1', 'mine');

    await expect(store.setPaneBinding('pane-b', 'ws-1', DEFAULT_CHROME_PROFILE)).rejects.toThrow('cannot be bound to a single pane');
    await expect(store.setPaneBinding('pane-b', 'ws-1', LIVE_CHROME_PROFILE)).rejects.toThrow('cannot be bound to a single pane');
    await expect(store.setPaneBinding('pane-b', 'ws-1', 'shared')).rejects.toThrow('bound to a workspace');
    await expect(store.setPaneBinding('pane-b', 'ws-1', 'mine')).rejects.toThrow('bound to another pane');
    await expect(store.setPaneBinding('pane-b', 'ws-1', 'nope')).rejects.toThrow('unknown Chrome profile');
    await expect(store.setPaneBinding('__proto__', 'ws-1', 'mine')).rejects.toThrow('invalid paneId');
    // Re-binding the same pane to its own profile is not a conflict.
    await expect(store.setPaneBinding('pane-a', 'ws-1', 'mine')).resolves.toBeUndefined();
    // And the reverse direction: a pane's profile cannot become a workspace's.
    await expect(store.setBinding('ws-2', 'mine')).rejects.toThrow('bound to a pane');
    expect(store.getPaneBindings()).toEqual({ 'pane-a': { workspaceId: 'ws-1', profile: 'mine' } });
  });

  it('a hand-edited conflict loads deterministically: workspace first, then the first pane', () => {
    writeFileSync(
      getChromeProfilesPath(dir),
      JSON.stringify({
        version: 2,
        profiles: ['default', 'p1', 'p2'],
        bindings: { 'ws-1': 'p1' },
        paneBindings: {
          'pane-a': { workspaceId: 'ws-1', profile: 'p1' },
          'pane-b': { workspaceId: 'ws-1', profile: 'p2' },
          'pane-c': { workspaceId: 'ws-1', profile: 'p2' },
          'pane-d': { workspaceId: 'ws-1', profile: 'live' },
          'pane-e': { workspaceId: 'ws-1', profile: 'ghost' },
          'pane-f': 'p2',
        },
      }),
    );
    expect(new ChromeProfileStore(dir).getPaneBindings()).toEqual({
      'pane-b': { workspaceId: 'ws-1', profile: 'p2' },
    });
  });

  it('reconcilePanes drops orphans only, and writes nothing when nothing changed', async () => {
    const store = new ChromeProfileStore(dir);
    await store.create('p1');
    await store.create('p2');
    await store.setPaneBinding('pane-a', 'ws-1', 'p1');
    await store.setPaneBinding('pane-b', 'ws-1', 'p2');

    const before = readFileSync(getChromeProfilesPath(dir), 'utf8');
    const same = new Map([['pane-a', 'ws-1']]);
    expect(await store.reconcilePanes(new Set(['pane-a', 'pane-b', 'pane-z']), same)).toEqual({ pruned: 0, rehomed: 0 });
    expect(readFileSync(getChromeProfilesPath(dir), 'utf8')).toBe(before);

    expect(await store.reconcilePanes(new Set(['pane-a']), same)).toEqual({ pruned: 1, rehomed: 0 });
    expect(new ChromeProfileStore(dir).getPaneBindings()).toEqual({
      'pane-a': { workspaceId: 'ws-1', profile: 'p1' },
    });
  });

  describe('mirror-driven reconcile', () => {
    type Extra = { sessionRestored?: boolean; panePtys?: Record<string, string>; paneIds?: string[] };
    const pushTo = (mirror: WorkspaceMirror, extra: Extra, entries = [{ id: 'ws-1', name: 'w' }]) =>
      mirror.setSnapshot({ ts: 1, entries, fleets: [], ...extra });

    it('acts only on a restored session that sent the complete pane list', async () => {
      const store = new ChromeProfileStore(dir);
      await store.create('p1');
      await store.setPaneBinding('pane-a', 'ws-1', 'p1');
      const mirror = new WorkspaceMirror();
      const none = { pruned: 0, rehomed: 0 };

      // A fresh default tree after a failed session load: never prune.
      pushTo(mirror, { paneIds: ['pane-new'] });
      expect(await reconcilePaneBindingsFromMirror(store, mirror)).toEqual(none);
      // A renderer that sends no pane list (panePtys alone is not complete): unknown.
      pushTo(mirror, { sessionRestored: true, panePtys: { 'pty-new': 'pane-new' } });
      expect(await reconcilePaneBindingsFromMirror(store, mirror)).toEqual(none);
      expect(store.getPaneBindings()).toHaveProperty('pane-a');

      pushTo(mirror, { sessionRestored: true, paneIds: ['pane-new'], panePtys: {} });
      expect(await reconcilePaneBindingsFromMirror(store, mirror)).toEqual({ pruned: 1, rehomed: 0 });
      expect(new ChromeProfileStore(dir).getPaneBindings()).toEqual({});
    });

    it('a bound pane with no PTY (browser-only) survives a push', async () => {
      const store = new ChromeProfileStore(dir);
      await store.create('p1');
      await store.setPaneBinding('pane-browser', 'ws-1', 'p1');
      const mirror = new WorkspaceMirror();
      pushTo(mirror, { sessionRestored: true, paneIds: ['pane-term', 'pane-browser'], panePtys: { 'pty-1': 'pane-term' } });
      expect(await reconcilePaneBindingsFromMirror(store, mirror)).toEqual({ pruned: 0, rehomed: 0 });
      expect(new ChromeProfileStore(dir).getPaneBindings()).toEqual({
        'pane-browser': { workspaceId: 'ws-1', profile: 'p1' },
      });
    });

    it('a bound pane moved to another workspace is re-homed, so the old one stops reporting it', async () => {
      const store = new ChromeProfileStore(dir);
      await store.create('p1');
      await store.setPaneBinding('pane-a', 'ws-1', 'p1');
      const mirror = new WorkspaceMirror();
      const entries = [
        { id: 'ws-1', name: 'one', ptyIds: ['pty-other'] },
        { id: 'ws-2', name: 'two', ptyIds: ['pty-a'] },
      ];
      const extra = { paneIds: ['pane-a', 'pane-other'], panePtys: { 'pty-a': 'pane-a', 'pty-other': 'pane-other' } };

      // Not from an unrestored session.
      pushTo(mirror, extra, entries);
      expect(await reconcilePaneBindingsFromMirror(store, mirror)).toEqual({ pruned: 0, rehomed: 0 });
      expect(store.profileFor('ws-2', 'pane-a')).toBe(DEFAULT_CHROME_PROFILE);

      pushTo(mirror, { ...extra, sessionRestored: true }, entries);
      expect(await reconcilePaneBindingsFromMirror(store, mirror)).toEqual({ pruned: 0, rehomed: 1 });
      const fresh = new ChromeProfileStore(dir);
      expect(fresh.profileFor('ws-2', 'pane-a')).toBe('p1');
      expect(fresh.hasPaneBindings('ws-1')).toBe(false);
      expect(fresh.hasPaneBindings('ws-2')).toBe(true);
    });
  });

  it('profile names are one identity regardless of case (one user-data-dir on macOS/Windows)', async () => {
    const store = new ChromeProfileStore(dir);
    await store.create('Foo');
    await expect(store.create('Foo')).resolves.toBe('Foo'); // exact repeat stays idempotent
    await expect(store.create('foo')).rejects.toThrow('already exists');
    await expect(store.create('DEFAULT')).rejects.toThrow('already exists');
    await expect(store.create('Live')).rejects.toThrow('reserved');
    await expect(store.setPaneBinding('pane-a', 'ws-1', 'Default')).rejects.toThrow();

    await store.setPaneBinding('pane-a', 'ws-1', 'Foo');
    expect(store.isPaneBound('FOO')).toBe(true);

    // A hand-edited file that lists both spellings keeps the first.
    writeFileSync(
      getChromeProfilesPath(dir),
      JSON.stringify({ version: 2, profiles: ['default', 'Bar', 'bar', 'LIVE'], bindings: {}, paneBindings: {} }),
    );
    expect(new ChromeProfileStore(dir).listProfiles()).toEqual(['default', 'Bar']);
  });
});
