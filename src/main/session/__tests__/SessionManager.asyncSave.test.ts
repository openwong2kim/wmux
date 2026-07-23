/**
 * A4 (NB2 wave 0) — async periodic save (saveAsync) contract.
 *
 * Goal: move 5s crash-safety tick to async atomic write that does not block main event loop,
 * while fixing:
 *   (a) exit/flush path persists last staging to disk without loss,
 *   (b) event-driven sync save() after async staging is not overwritten by stale async write (epoch guard),
 *   (c) write atomicity (tmp+rename, valid payload) unchanged
 *
 * Electron `app.getPath('userData')` mocked to per-test tmpdir (same pattern as other SessionManager
 * tests).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpRoot = path.join(os.tmpdir(), 'wmux-sessionmgr-asyncsave-test');

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => tmpRoot),
  },
}));

// Review fix (panel 2-MODEL): reproducing true in-flight race (async write entered await then
// sync save interleaves) requires gate to artificially pause async write.
// Default is pass-through (open) — only that case closes gate.
// Path note: vi.mock resolves relative to "this test file" (must hit same module as SessionManager
// import spec) — wrong path silently ignored causing false positive so assert gatedCalls counter.
let asyncWriteGate: Promise<void> | null = null;
let gatedCalls = 0;
vi.mock('../../../daemon/util/atomicWrite', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../daemon/util/atomicWrite')>();
  return {
    ...original,
    atomicWriteJSON: async (...args: Parameters<typeof original.atomicWriteJSON>) => {
      if (asyncWriteGate) {
        gatedCalls += 1;
        await asyncWriteGate;
      }
      return original.atomicWriteJSON(...args);
    },
  };
});

import { SessionManager } from '../SessionManager';
import type { SessionData } from '../../../shared/types';

function freshDir(): void {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
}

/** Minimal SessionData with one ptyId in a single leaf. */
function makeSession(ptyId: string): SessionData {
  return {
    workspaces: [{
      id: 'ws-1',
      name: 'W1',
      rootPane: {
        id: 'pane-0',
        type: 'leaf',
        surfaces: [{ id: 'surf-0', ptyId, title: 't', shell: 'pwsh', cwd: '/x' }],
        activeSurfaceId: 'surf-0',
      },
      activePaneId: 'pane-0',
    } as SessionData['workspaces'][number]],
    activeWorkspaceId: 'ws-1',
    sidebarVisible: true,
  };
}

function readDiskPtyId(sm: SessionManager): string | undefined {
  const loaded = sm.load();
  const rp = loaded?.workspaces?.[0]?.rootPane;
  if (rp && rp.type === 'leaf') return rp.surfaces[0]?.ptyId;
  return undefined;
}

describe('SessionManager — async periodic save (A4)', () => {
  beforeEach(freshDir);
  afterEach(() => vi.restoreAllMocks());

  it('saveAsync writes the payload atomically and validly (loadable round-trip)', async () => {
    const sm = new SessionManager();
    sm.saveAsync(makeSession('pty-async-1'));
    // Wait until async queue completes actual write.
    await sm.flush();
    expect(readDiskPtyId(sm)).toBe('pty-async-1');
  });

  it('flush() persists the last staged async snapshot before the debounce timer fires', async () => {
    const sm = new SessionManager();
    sm.saveAsync(makeSession('pty-A'));
    sm.saveAsync(makeSession('pty-B')); // coalesce — last value must win
    await sm.flush();
    expect(readDiskPtyId(sm)).toBe('pty-B');
  });

  it('flushSync() (exit path) writes the last staged async snapshot synchronously', () => {
    const sm = new SessionManager();
    sm.saveAsync(makeSession('pty-exit'));
    // Exit path: assume event loop stops — synchronous flush.
    sm.flushSync();
    expect(readDiskPtyId(sm)).toBe('pty-exit');
  });

  it('a later sync save() wins over an in-flight async stage (reboot-survival guard)', async () => {
    const sm = new SessionManager();
    // Stage stale snapshot via async then commit latest ptyId via event-driven sync save.
    // Final disk state must be latest (sync) value.
    sm.saveAsync(makeSession('pty-stale-async'));
    sm.save(makeSession('pty-fresh-sync'));
    // Even if queued async task runs, epoch guard skips stale write.
    await sm.flush();
    expect(readDiskPtyId(sm)).toBe('pty-fresh-sync');
  });

  it('sync save() remains synchronous — data is on disk immediately (no await)', () => {
    const sm = new SessionManager();
    sm.save(makeSession('pty-sync-now'));
    // Read immediately without await should show latest (synchronous atomic write).
    expect(readDiskPtyId(sm)).toBe('pty-sync-now');
  });

  it('a sync save that lands while an async write is IN-FLIGHT is restored (post-write recovery)', async () => {
    // Review fix (panel 2-MODEL — in-flight inversion): after async task passes pre-write epoch
    // check and enters actual write (await), sync save commits,
    // late async rename would revert disk to stale. post-write recovery loop must
    // detect and re-write sync commit — final disk = latest (sync).
    const sm = new SessionManager();
    let openGate!: () => void;
    asyncWriteGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    try {
      gatedCalls = 0;
      sm.saveAsync(makeSession('pty-stale-inflight'));
      // Yield until task starts, passes pre-check, and blocks on gate.
      await new Promise((r) => setTimeout(r, 10));
      // Confirm mock applied — stale write actually blocked on gate (prevent false positive).
      expect(gatedCalls).toBe(1);
      // At this point async is in-flight — cannot remove via queue.clear(). sync commits latest.
      sm.save(makeSession('pty-fresh-sync-late'));
      expect(readDiskPtyId(sm)).toBe('pty-fresh-sync-late');
      // Open gate so stale async completes rename then drain queue.
      openGate();
      await sm.flush();
      // Without post-write recovery pty-stale-inflight would appear here (inversion).
      expect(readDiskPtyId(sm)).toBe('pty-fresh-sync-late');
    } finally {
      asyncWriteGate = null;
    }
  });
});
