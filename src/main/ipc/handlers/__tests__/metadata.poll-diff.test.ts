import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import type { BrowserWindow } from 'electron';
import type { PTYManager } from '../../../pty/PTYManager';
import {
  runMetadataPollTick,
  updateCwd,
  updateBranch,
  updatePorts,
  removeCwd,
  resetMetadataPollCache,
  broadcastMetadataUpdate,
  clearLastBroadcastAgentStatus,
  getLastBroadcastAgentName,
  getLastBroadcastAgentStatus,
  hasOutstandingRunningClaim,
} from '../metadata.handler';
import { readSourceText } from '../../../../test-utils/sourceText';
import { noteShellPrompt, resetShellPromptMirrorForTests } from '../../../shellPrompt/shellPromptMirror';

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

/** Above Linux's largest pid_max (2^22), so no process can have it: the
 *  poll's live-cwd read (/proc/<pid>/cwd) finds nothing on any runner. */
const NO_SUCH_PID = 2 ** 22 + 1;

/** Fake PTYManager backed by a Set of live ptyIds. */
function fakePtyManager(live: Set<string>): PTYManager {
  return {
    get: (ptyId: string) => (live.has(ptyId) ? { process: { pid: NO_SUCH_PID } } : undefined),
  } as unknown as PTYManager;
}

const TEST_PTY_IDS = ['pty-diff-1', 'pty-diff-sp', 'pty-diff-2', 'pty-diff-3a', 'pty-diff-3b', 'pty-diff-4', 'pty-diff-5', 'pty-diff-proc'];

// app-weight P1-2 — last-payload diff on the poll tick.
describe('runMetadataPollTick payload diff', () => {
  // Module state outlives a test: a failed attempt skips its removeCwd, and a
  // retry would then find its cwd and its last sent payload still there.
  beforeEach(() => {
    resetMetadataPollCache();
    for (const id of TEST_PTY_IDS) removeCwd(id);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('the fake pane pid names no process, so a live /proc cwd never replaces the tracked one', async () => {
    // A Linux /proc as a runner has it: every pid up to pid_max may be a real
    // process whose cwd is somewhere else.
    vi.spyOn(fs.promises, 'readlink').mockImplementation((async (target: fs.PathLike) => {
      const pid = Number(/^\/proc\/(\d+)\/cwd$/.exec(String(target))?.[1]);
      if (Number.isInteger(pid) && pid <= 2 ** 22) return '/home/runner';
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    }) as unknown as typeof fs.promises.readlink);
    const mgr = fakePtyManager(new Set(['pty-diff-proc']));
    const { win, sent } = fakeWindow();
    updateCwd('pty-diff-proc', 'C:/repo-proc');

    await runMetadataPollTick(mgr, win, true);
    expect(sent[0][1]).toMatchObject({ ptyId: 'pty-diff-proc', cwd: 'C:/repo-proc' });

    removeCwd('pty-diff-proc');
  });

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

  it('carries a waiting shell prompt, so a renderer that reloaded gets it back', async () => {
    const live = new Set(['pty-diff-sp']);
    const mgr = fakePtyManager(live);
    const { win, sent } = fakeWindow();
    updateCwd('pty-diff-sp', 'C:/repo-sp');
    noteShellPrompt('pty-diff-sp', { epoch: 'e', seq: 1, prompt: { shape: 'secret' } });

    await runMetadataPollTick(mgr, win, true);
    expect(sent[0][1]).toMatchObject({ ptyId: 'pty-diff-sp', shellPrompt: { shape: 'secret' } });
    noteShellPrompt('pty-diff-sp', { epoch: 'e', seq: 2, prompt: null });
    await runMetadataPollTick(mgr, win, true);
    expect(sent).toHaveLength(2);
    expect(sent[1][1]).toMatchObject({ ptyId: 'pty-diff-sp', shellPrompt: null });

    removeCwd('pty-diff-sp');
    resetShellPromptMirrorForTests();
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
    const path = await import('node:path');
    const src = readSourceText(path.join(__dirname, '..', 'metadata.handler.ts'));
    const idx = src.indexOf('ipcMain.handle(IPC.METADATA_REQUEST');
    expect(idx).toBeGreaterThan(0);
    const body = src.slice(idx, idx + 900);
    expect(body).toMatch(/broadcastMetadataUpdate\(win, payload\)/);
  });
});

describe('agent identity mirror', () => {
  it('tracks identity and status through the shared broadcast funnel', () => {
    broadcastMetadataUpdate(null, {
      ptyId: 'pty-scheduled',
      agentName: 'Codex CLI',
      agentStatus: 'waiting',
    });
    expect(getLastBroadcastAgentName('pty-scheduled')).toBe('Codex CLI');
    expect(getLastBroadcastAgentStatus('pty-scheduled')).toBe('waiting');

    broadcastMetadataUpdate(null, { ptyId: 'pty-scheduled', agentName: '' });
    expect(getLastBroadcastAgentName('pty-scheduled')).toBeUndefined();
    clearLastBroadcastAgentStatus('pty-scheduled');
    expect(getLastBroadcastAgentStatus('pty-scheduled')).toBeUndefined();
  });

  it('#1463 — a running claim outlives an unmarked idle, and only a settle withdraws it', () => {
    broadcastMetadataUpdate(null, { ptyId: 'pty-claim', agentStatus: 'running' });
    broadcastMetadataUpdate(null, { ptyId: 'pty-claim', agentStatus: 'idle' });
    expect(hasOutstandingRunningClaim('pty-claim')).toBe(true);
    broadcastMetadataUpdate(null, { ptyId: 'pty-claim', agentStatus: 'idle', settled: true });
    expect(hasOutstandingRunningClaim('pty-claim')).toBe(false);
    // An activity line alone (a late transcript line on an idle pane) is no claim.
    broadcastMetadataUpdate(null, { ptyId: 'pty-claim', activity: 'Edit foo.ts' });
    expect(hasOutstandingRunningClaim('pty-claim')).toBe(false);
    broadcastMetadataUpdate(null, { ptyId: 'pty-claim', agentStatus: 'running' });
    clearLastBroadcastAgentStatus('pty-claim');
    expect(hasOutstandingRunningClaim('pty-claim')).toBe(false);
  });
});
