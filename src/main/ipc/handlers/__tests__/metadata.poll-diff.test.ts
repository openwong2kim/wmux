import { describe, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';
import type { PTYManager } from '../../../pty/PTYManager';
import {
  runMetadataPollTick,
  updateCwd,
  updateBranch,
  updatePorts,
  removeCwd,
} from '../metadata.handler';

vi.mock('electron', () => ({
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn() },
  BrowserWindow: {},
}));

// Keep the poll from exec-ing `git` / `gh` subprocesses in unit tests.
vi.mock('../../../metadata/MetadataCollector', () => ({
  MetadataCollector: class {
    async getGitBranch(): Promise<string | null> { return null; }
  },
}));
vi.mock('../../../metadata/PrStatusCache', () => ({
  prStatusCache: { get: vi.fn(async () => null) },
}));

/** Fake visible window that records webContents.send payloads. */
function fakeWindow() {
  const sent: unknown[][] = [];
  const win = {
    isDestroyed: () => false,
    webContents: { send: (...args: unknown[]) => { sent.push(args); } },
  } as unknown as BrowserWindow;
  return { win, sent };
}

/** Fake PTYManager backed by a Set of live ptyIds. */
function fakePtyManager(live: Set<string>): PTYManager {
  return {
    get: (ptyId: string) => (live.has(ptyId) ? { process: { pid: 1234 } } : undefined),
  } as unknown as PTYManager;
}

// app-weight P1-2 — last-payload diff on the poll tick.
describe('runMetadataPollTick payload diff', () => {
  it('sends the first payload, then skips unchanged ticks', async () => {
    const live = new Set(['pty-diff-1']);
    const mgr = fakePtyManager(live);
    const { win, sent } = fakeWindow();
    updateCwd('pty-diff-1', 'C:/repo-a');
    updateBranch('pty-diff-1', 'main');

    await runMetadataPollTick(mgr, win, true);
    expect(sent).toHaveLength(1);
    expect(sent[0][1]).toMatchObject({ ptyId: 'pty-diff-1', cwd: 'C:/repo-a', gitBranch: 'main' });

    // Nothing changed → second and third ticks broadcast nothing.
    await runMetadataPollTick(mgr, win, true);
    await runMetadataPollTick(mgr, win, true);
    expect(sent).toHaveLength(1);

    removeCwd('pty-diff-1');
  });

  it('sends again when a field changes, and on revert to a prior value', async () => {
    const live = new Set(['pty-diff-2']);
    const mgr = fakePtyManager(live);
    const { win, sent } = fakeWindow();
    updateCwd('pty-diff-2', 'C:/repo-b');
    updateBranch('pty-diff-2', 'main');

    await runMetadataPollTick(mgr, win, true);
    updateBranch('pty-diff-2', 'feat/x');
    await runMetadataPollTick(mgr, win, true);
    expect(sent).toHaveLength(2);
    expect(sent[1][1]).toMatchObject({ gitBranch: 'feat/x' });

    // Revert to a previously-seen value: cache holds the LAST sent payload,
    // so this must broadcast again.
    updateBranch('pty-diff-2', 'main');
    await runMetadataPollTick(mgr, win, true);
    expect(sent).toHaveLength(3);
    expect(sent[2][1]).toMatchObject({ gitBranch: 'main' });

    removeCwd('pty-diff-2');
  });

  it('sends immediately for a pane added between ticks', async () => {
    const live = new Set(['pty-diff-3a']);
    const mgr = fakePtyManager(live);
    const { win, sent } = fakeWindow();
    updateCwd('pty-diff-3a', 'C:/repo-c');
    updateBranch('pty-diff-3a', 'main');
    await runMetadataPollTick(mgr, win, true);
    expect(sent).toHaveLength(1);

    live.add('pty-diff-3b');
    updateCwd('pty-diff-3b', 'C:/repo-d');
    updateBranch('pty-diff-3b', 'dev');
    await runMetadataPollTick(mgr, win, true);
    expect(sent).toHaveLength(2);
    expect(sent[1][1]).toMatchObject({ ptyId: 'pty-diff-3b' });

    removeCwd('pty-diff-3a');
    removeCwd('pty-diff-3b');
  });

  it('prunes the cache when a pane goes away, so a reused id sends fresh', async () => {
    const live = new Set(['pty-diff-4']);
    const mgr = fakePtyManager(live);
    const { win, sent } = fakeWindow();
    updateCwd('pty-diff-4', 'C:/repo-e');
    updateBranch('pty-diff-4', 'main');
    await runMetadataPollTick(mgr, win, true);
    expect(sent).toHaveLength(1);

    // Pane dies: the liveness prune drops its maps AND its diff-cache entry
    // (the cache is rebuilt from live panes each tick).
    live.delete('pty-diff-4');
    await runMetadataPollTick(mgr, win, true);
    expect(sent).toHaveLength(1);

    // Same id comes back with identical metadata → must send (no stale entry).
    live.add('pty-diff-4');
    updateCwd('pty-diff-4', 'C:/repo-e');
    updateBranch('pty-diff-4', 'main');
    await runMetadataPollTick(mgr, win, true);
    expect(sent).toHaveLength(2);

    removeCwd('pty-diff-4');
  });

  it('changed ports also trigger a send', async () => {
    const live = new Set(['pty-diff-5']);
    const mgr = fakePtyManager(live);
    const { win, sent } = fakeWindow();
    updateCwd('pty-diff-5', 'C:/repo-f');
    updateBranch('pty-diff-5', 'main');
    updatePorts('pty-diff-5', [3000]);
    await runMetadataPollTick(mgr, win, true);
    await runMetadataPollTick(mgr, win, true);
    expect(sent).toHaveLength(1);

    updatePorts('pty-diff-5', [3000, 5173]);
    await runMetadataPollTick(mgr, win, true);
    expect(sent).toHaveLength(2);
    expect(sent[1][1]).toMatchObject({ listeningPorts: [3000, 5173] });

    removeCwd('pty-diff-5');
  });
});

// codex review (PR #471): the poll dedup means a pane switch must be able to
// PULL unchanged context — METADATA_REQUEST re-broadcasts through the normal
// METADATA_UPDATE path so the renderer's active-surface apply logic runs.
describe('METADATA_REQUEST re-broadcast (active-surface pull)', () => {
  it('the request handler broadcasts the payload in addition to returning it', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'metadata.handler.ts'), 'utf-8');
    const idx = src.indexOf('ipcMain.handle(IPC.METADATA_REQUEST');
    expect(idx).toBeGreaterThan(0);
    const body = src.slice(idx, idx + 900);
    expect(body).toMatch(/broadcastMetadataUpdate\(win, payload\)/);
  });
});
