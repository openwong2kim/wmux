import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import type { PTYManager } from '../../pty/PTYManager';
import type { DaemonClient } from '../../DaemonClient';

// The poll's git fallback: counted, never spawned. It answers "not a repo",
// which is what a real `git` says for these temp directories.
const getGitBranch = vi.fn<(cwd: string) => Promise<string | undefined>>(async () => undefined);

vi.mock('electron', () => ({
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn() },
  BrowserWindow: {},
}));
vi.mock('../MetadataCollector', () => ({
  MetadataCollector: class {
    getGitBranch(cwd: string) { return getGitBranch(cwd); }
  },
}));
vi.mock('../PrStatusCache', () => ({
  prStatusCache: { get: vi.fn(async () => null) },
}));
vi.mock('../GitSyncStatusCache', () => ({
  gitSyncStatusCache: { get: vi.fn(async () => null), invalidate: vi.fn() },
}));
// Local mode starts a PortWatcher, which scans processes; not under test.
vi.mock('../../pty/portWatch', () => ({
  PortWatcher: class extends EventEmitter {
    start() { /* no process scan in tests */ }
    stop() { /* nothing started */ }
  },
}));

import { GitContextWatcher } from '../../pty/gitContextWatch';
import { WorkspaceContextRouter } from '../WorkspaceContextRouter';
import { startLocalContextWatch } from '../localContextWatch';
import { runMetadataPollTick, updateCwd, removeCwd, removeBranch } from '../../ipc/handlers/metadata.handler';

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-branchstate-'));
  tmpDirs.push(dir);
  return dir;
}
function initRepo(root: string, branch: string): void {
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
}

function fakeWindow() {
  const sent: Array<{ ptyId?: string; gitBranch?: string }> = [];
  const win = {
    isDestroyed: () => false,
    webContents: { send: (_ch: string, payload: { ptyId?: string; gitBranch?: string }) => { sent.push(payload); } },
  } as unknown as BrowserWindow;
  return { win, sent };
}

const cleanups: Array<() => void> = [];
beforeEach(() => { getGitBranch.mockClear(); });
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
  for (const dir of tmpDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* win32 lock */ }
  }
});

/**
 * Daemon mode: a real GitContextWatcher feeds `session:git` the way the
 * daemon broadcasts `context.git`, and the poll runs with daemon ownership.
 */
function daemonRig(ptyId: string) {
  const client = new EventEmitter();
  const router = new WorkspaceContextRouter(client as unknown as DaemonClient, () => null);
  router.start();
  const watcher = new GitContextWatcher();
  watcher.on('git', (p: { sessionId: string; branch: string | null; isWorktree: boolean; absent?: true }) => {
    client.emit('session:git', {
      sessionId: p.sessionId,
      data: p.absent
        ? { branch: p.branch, isWorktree: p.isWorktree, absent: true }
        : { branch: p.branch, isWorktree: p.isWorktree },
    });
  });
  const mgr = { get: () => undefined } as unknown as PTYManager;
  const { win, sent } = fakeWindow();
  cleanups.push(() => { router.stop(); watcher.dispose(); removeCwd(ptyId); removeBranch(ptyId); });
  return {
    client,
    sent,
    cd(dir: string) { updateCwd(ptyId, dir); watcher.update(ptyId, dir); },
    tick: () => runMetadataPollTick(mgr, win, false),
  };
}

describe('watcher branch state reaches the metadata poll', () => {
  it('a non-repo pane the watcher knows spawns no git over 12 ticks', async () => {
    const rig = daemonRig('pty-absent-1');
    rig.cd(tmp());
    for (let i = 0; i < 12; i++) await rig.tick();
    expect(getGitBranch).not.toHaveBeenCalled();
    expect(rig.sent.at(-1)).toMatchObject({ ptyId: 'pty-absent-1', gitBranch: '' });
  });

  it('repo → non-repo → repo: the poll follows the watcher and never asks git', async () => {
    const repo = tmp();
    initRepo(repo, 'main');
    const other = tmp();
    initRepo(other, 'feat');
    const rig = daemonRig('pty-absent-2');

    rig.cd(repo);
    await rig.tick();
    expect(rig.sent.at(-1)).toMatchObject({ gitBranch: 'main' });

    rig.cd(tmp());
    await rig.tick();
    await rig.tick();
    expect(rig.sent.at(-1)).toMatchObject({ gitBranch: '' });

    rig.cd(other);
    await rig.tick();
    expect(rig.sent.at(-1)).toMatchObject({ gitBranch: 'feat' });
    expect(getGitBranch).not.toHaveBeenCalled();
  });

  it('a null branch without `absent` (unknown) still uses the git fallback', async () => {
    const rig = daemonRig('pty-absent-3');
    const dir = tmp();
    updateCwd('pty-absent-3', dir);
    // An older daemon, or a repo whose HEAD could not be read.
    rig.client.emit('session:git', { sessionId: 'pty-absent-3', data: { branch: null, isWorktree: false } });
    await rig.tick();
    expect(getGitBranch).toHaveBeenCalledTimes(1);
    expect(getGitBranch).toHaveBeenCalledWith(dir);
  });

  it('local mode: the same watcher answer stops the fallback', async () => {
    const live = new Set(['pty-local-1']);
    const mgr = {
      get: (id: string) => (live.has(id) ? { process: { pid: 0 } } : undefined),
      getActiveSessionPids: () => [],
    } as unknown as PTYManager;
    const { win, sent } = fakeWindow();
    const stop = startLocalContextWatch(mgr, () => null);
    cleanups.push(() => { stop(); removeCwd('pty-local-1'); removeBranch('pty-local-1'); });

    const repo = tmp();
    initRepo(repo, 'main');
    updateCwd('pty-local-1', repo);
    await runMetadataPollTick(mgr, win, true);
    expect(sent.at(-1)).toMatchObject({ gitBranch: 'main' });

    updateCwd('pty-local-1', tmp());
    for (let i = 0; i < 12; i++) await runMetadataPollTick(mgr, win, true);
    expect(sent.at(-1)).toMatchObject({ gitBranch: '' });
    expect(getGitBranch).not.toHaveBeenCalled();
  });
});
