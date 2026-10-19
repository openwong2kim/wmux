import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { PanesStillRunningError, assertNothingRunsIn, destroyedTreeOf, resetLingeringSurvivors, sessionHostDir, sessionsStartedIn, stopSessionsInDir, type SessionsInDirPort } from '../stopSessionsInDir';
import type { DaemonDestroySessionTree } from '../../../shared/rpc';

type Session = { id: string; pid?: number; cwd?: string; spawnCwd?: string; wslTarget?: { distribution: string } };

function port(sessions: Session[], platform: NodeJS.Platform, opts: { stubborn?: number[]; trees?: Record<string, DaemonDestroySessionTree> } = {}) {
  const alive = new Set(sessions.map((s) => s.pid).filter((p): p is number => typeof p === 'number'));
  const log = vi.fn();
  const p: SessionsInDirPort = {
    platform,
    log,
    // No real filesystem here: resolve `..` the way path.resolve does, keep everything else.
    realpath: (x) => (/^[a-zA-Z]:/.test(x) ? path.win32.resolve(x) : path.posix.resolve(x)),
    listSessions: async () => sessions,
    destroySession: vi.fn(async (id: string) => {
      const pid = sessions.find((s) => s.id === id)?.pid;
      if (pid && !opts.stubborn?.includes(pid)) alive.delete(pid);
      return opts.trees?.[id];
    }),
    isAlive: (pid) => alive.has(pid),
    sleep: async () => undefined,
  };
  return { p, alive, log };
}

beforeEach(() => resetLingeringSurvivors());

describe('stopSessionsInDir', () => {
  it('stops only sessions STARTED in the worktree; cwd (OSC 7) never decides', async () => {
    const { p, alive, log } = port([
      { id: 'started-here', pid: 11, spawnCwd: '/w/task-1', cwd: '/home/u' },
      { id: 'started-below', pid: 12, spawnCwd: '/w/task-1/src' },
      { id: 'claims-cwd', pid: 13, spawnCwd: '/home/u', cwd: '/w/task-1' },
      { id: 'sibling', pid: 14, spawnCwd: '/w/task-10' },
      { id: 'no-spawn-cwd', pid: 15, cwd: '/w/task-1' },
    ], 'linux');
    const stopped = await stopSessionsInDir('/w/task-1', p);
    expect(stopped.sort()).toEqual(['started-below', 'started-here']);
    expect([...alive].sort()).toEqual([13, 14, 15]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no spawn directory'));
  });

  it('resolves .. before comparing', async () => {
    const { p } = port([{ id: 'b', pid: 1, spawnCwd: '/w/task-b' }], 'linux');
    expect(await stopSessionsInDir('/w/task-a/../task-b', p)).toEqual(['b']);
    const { p: p2 } = port([{ id: 'b', pid: 1, spawnCwd: '/w/task-a/../task-b' }], 'linux');
    expect(await stopSessionsInDir('/w/task-a', p2)).toEqual([]);
  });

  it('folds case only where the filesystem does', async () => {
    expect(await stopSessionsInDir('c:/w/task-1', port([{ id: 's', spawnCwd: 'C:\\W\\Task-1' }], 'win32').p)).toEqual(['s']);
    expect(await stopSessionsInDir('/w/task-1', port([{ id: 's', spawnCwd: '/W/Task-1' }], 'linux').p)).toEqual([]);
  });

  it('a WSL pane (#2254): its Linux spawn path is read as the Windows folder it is', async () => {
    const wsl = { wslTarget: { distribution: 'Ubuntu' } };
    const { p } = port([
      { id: 'drive', spawnCwd: '/mnt/c/Users/me/wt/src', ...wsl },
      { id: 'distro', spawnCwd: '/home/me/wt', ...wsl },
      { id: 'other', spawnCwd: '/mnt/d/Users/me/wt', ...wsl },
    ], 'win32');
    expect(await stopSessionsInDir('C:\\Users\\me\\wt', p)).toEqual(['drive']);
    // A sibling whose name only starts the same is another folder, either way round.
    const { p: p10 } = port([{ id: 'ten', spawnCwd: '/mnt/c/w/task-10', ...wsl }, { id: 'one', spawnCwd: '/mnt/c/w/task-1', ...wsl }], 'win32');
    expect(await sessionsStartedIn(['C:\\w\\task-1'], p10)).toEqual(['one']);
    expect(await sessionsStartedIn(['C:\\w\\task-10'], p10)).toEqual(['ten']);
    expect(sessionHostDir('/home/me/wt', wsl, 'win32')).toBe('\\\\wsl$\\Ubuntu\\home\\me\\wt');
    // Elsewhere a Linux path is the folder itself.
    expect(sessionHostDir('/mnt/c/x', wsl, 'linux')).toBe('/mnt/c/x');
  });

  it('throws when a process is still running after the wait, so the worktree is kept', async () => {
    const { p } = port([{ id: 's', pid: 7, spawnCwd: '/w/t' }], 'linux', { stubborn: [7] });
    await expect(stopSessionsInDir('/w/t', p)).rejects.toBeInstanceOf(PanesStillRunningError);
  });

  // #2388: the daemon kills each pane's whole tree and says whether every
  // process exited; one that did not keeps the worktree.
  it("throws when the daemon reports a process of a pane's tree still running", async () => {
    const { p } = port([{ id: 's', pid: 7, spawnCwd: '/w/t' }, { id: 'u', pid: 8, spawnCwd: '/w/t' }], 'linux', {
      trees: {
        s: { ok: false, killed: [7], survivors: [{ pid: 70, reason: 'still running' }] },
        u: { ok: true, killed: [8, 80] },
      },
    });
    const err = await stopSessionsInDir('/w/t', p).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PanesStillRunningError);
    expect((err as PanesStillRunningError).pids).toEqual([70]);
    expect((err as Error).message).toContain('70: still running');
  });

  it('keeps the folder on a later stop while a survivor of an earlier one still runs', async () => {
    const survivor = { pid: 70, reason: 'access denied', startTime: '123' };
    const first = port([{ id: 's', pid: 7, spawnCwd: '/w/t' }], 'linux', { trees: { s: { ok: false, killed: [7], survivors: [survivor] } } });
    await expect(stopSessionsInDir('/w/t', first.p)).rejects.toBeInstanceOf(PanesStillRunningError);

    // The session is gone now; only the survivor is left.
    const later = port([], 'linux');
    const stillRunning = vi.fn(async () => [survivor]);
    later.p.stillRunning = stillRunning;
    await expect(stopSessionsInDir('/w/t', later.p)).rejects.toThrow(/still running since an earlier stop/);
    expect(stillRunning).toHaveBeenCalledWith([survivor]);

    // Once it has exited the folder may go.
    later.p.stillRunning = async () => [];
    expect(await stopSessionsInDir('/w/t', later.p)).toEqual([]);
    later.p.stillRunning = vi.fn(async () => [survivor]);
    expect(await stopSessionsInDir('/w/t', later.p)).toEqual([]);
    expect(later.p.stillRunning).not.toHaveBeenCalled();
  });

  it('remembers a pane\'s survivors even when destroying a later pane fails', async () => {
    const survivor = { pid: 70, reason: 'still running', startTime: '123' };
    const first = port([{ id: 's', pid: 7, spawnCwd: '/w/t' }, { id: 'u', pid: 8, spawnCwd: '/w/t' }], 'linux', {
      trees: { s: { ok: false, killed: [7], survivors: [survivor] } },
    });
    const destroy = first.p.destroySession;
    first.p.destroySession = async (id) => {
      if (id === 'u') throw new Error('daemon offline');
      return destroy(id);
    };
    await expect(stopSessionsInDir('/w/t', first.p)).rejects.toThrow('daemon offline');

    const later = port([], 'linux');
    later.p.stillRunning = async () => [survivor];
    await expect(stopSessionsInDir('/w/t', later.p)).rejects.toBeInstanceOf(PanesStillRunningError);
  });

  // Each stop stands on its own: one that could not verify its tree keeps the
  // folder and says why, and the next one decides from scratch.
  it('an inconclusive stop keeps the folder and says why; a conclusive clean one after it proceeds', async () => {
    const first = port([{ id: 's', pid: 7, spawnCwd: '/w/t' }], 'linux', {
      trees: { s: { ok: false, killed: [7], survivors: [{ pid: 7, reason: 'the process table could not be read', unverified: true }] } },
    });
    await expect(stopSessionsInDir('/w/t', first.p)).rejects.toThrow('could not verify all processes exited: the process table could not be read');

    const second = port([{ id: 'u', pid: 8, spawnCwd: '/w/t' }], 'linux', { trees: { u: { ok: true, killed: [8, 80] } } });
    expect(await stopSessionsInDir('/w/t', second.p)).toEqual(['u']);
    expect(await stopSessionsInDir('/w/t', port([], 'linux').p)).toEqual([]);
  });

  it('a stop whose destroy did not answer fails, and leaves nothing behind for the next one', async () => {
    const first = port([{ id: 's', pid: 7, spawnCwd: '/w/t' }], 'linux');
    first.p.destroySession = async () => { throw new Error('RPC timeout: daemon.destroySession (60000ms)'); };
    await expect(stopSessionsInDir('/w/t', first.p)).rejects.toThrow('RPC timeout');
    expect(await stopSessionsInDir('/w/t', port([], 'linux').p)).toEqual([]);
  });

  it('the sweep\'s check stops nothing: a pane opened in the folder, or an earlier survivor, keeps it', async () => {
    const opened = port([{ id: 'new', pid: 9, spawnCwd: '/w/t' }], 'linux');
    await expect(assertNothingRunsIn('/w/t', opened.p)).rejects.toThrow(/started in the folder/);
    expect(opened.p.destroySession).not.toHaveBeenCalled();
    expect(opened.alive.has(9)).toBe(true);

    const survivor = { pid: 70, reason: 'access denied', startTime: '1' };
    await expect(stopSessionsInDir('/w/t', port([{ id: 's', pid: 7, spawnCwd: '/w/t' }], 'linux', { trees: { s: { ok: false, killed: [7], survivors: [survivor] } } }).p)).rejects.toThrow();
    const empty = port([], 'linux');
    empty.p.stillRunning = async () => [survivor];
    await expect(assertNothingRunsIn('/w/t', empty.p)).rejects.toBeInstanceOf(PanesStillRunningError);
    empty.p.stillRunning = async () => [];
    await expect(assertNothingRunsIn('/w/t', empty.p)).resolves.toBeUndefined();
  });

  it('a stop of a folder another stop is still working on waits for it, and sees what it left', async () => {
    const survivor = { pid: 70, reason: 'access denied', startTime: '1' };
    let answer: (tree: DaemonDestroySessionTree) => void = () => undefined;
    const first = port([{ id: 's', pid: 7, spawnCwd: '/w/t' }], 'linux');
    first.p.destroySession = () => new Promise((resolve) => { answer = resolve; });
    const firstStop = stopSessionsInDir('/w/t', first.p).catch((e: unknown) => e);

    // The session is gone from the daemon's list while the first kill runs.
    const second = port([], 'linux');
    second.p.stillRunning = async (list) => [...list];
    let settled = false;
    const secondStop = stopSessionsInDir('/w/t', second.p).then(() => { settled = true; }, (e: unknown) => { settled = true; throw e; });
    await new Promise((r) => setTimeout(r, 0));
    expect(settled).toBe(false);
    answer({ ok: false, killed: [7], survivors: [survivor] });
    expect(await firstStop).toBeInstanceOf(PanesStillRunningError);
    await expect(secondStop).rejects.toBeInstanceOf(PanesStillRunningError);
  });

  it('the sweep\'s check lists the sessions only after a stop under way in the folder is done', async () => {
    let answer: (tree: DaemonDestroySessionTree) => void = () => undefined;
    const first = port([{ id: 's', pid: 7, spawnCwd: '/w/t' }], 'linux');
    first.p.destroySession = () => new Promise((resolve) => { answer = resolve; });
    const firstStop = stopSessionsInDir('/w/t', first.p);
    const listing = port([], 'linux');
    const listSessions = vi.fn(async () => [{ id: 'opened-meanwhile', pid: 9, spawnCwd: '/w/t' }]);
    listing.p.listSessions = listSessions;
    const check = assertNothingRunsIn('/w/t', listing.p);
    await new Promise((r) => setTimeout(r, 0));
    expect(listSessions).not.toHaveBeenCalled();
    answer({ ok: true, killed: [7] });
    await firstStop;
    await expect(check).rejects.toThrow(/started in the folder/);
  });

  it('the sweep\'s check lists again when a stop starts while it lists', async () => {
    let answer: (tree: DaemonDestroySessionTree) => void = () => undefined;
    const checker = port([], 'linux');
    let lists = 0;
    checker.p.listSessions = async () => {
      lists++;
      if (lists === 1) {
        // A stop of the folder starts while the list is read.
        const stopping = port([{ id: 's', pid: 7, spawnCwd: '/w/t' }], 'linux');
        stopping.p.destroySession = () => new Promise((resolve) => { answer = resolve; });
        void stopSessionsInDir('/w/t', stopping.p).catch(() => undefined);
        setTimeout(() => answer({ ok: false, killed: [7], survivors: [{ pid: 70, reason: 'access denied', startTime: '1' }] }), 0);
      }
      return [];
    };
    checker.p.stillRunning = async (list) => [...list];
    await expect(assertNothingRunsIn('/w/t', checker.p)).rejects.toBeInstanceOf(PanesStillRunningError);
    expect(lists).toBe(2);
  });

  it("takes the daemon's word for a tree it checked: no wait on the shell's pid", async () => {
    const isAlive = vi.fn(() => true);
    const { p } = port([{ id: 's', pid: 7, spawnCwd: '/w/t' }], 'linux', { trees: { s: { ok: true, killed: [7, 70] } } });
    p.isAlive = isAlive;
    expect(await stopSessionsInDir('/w/t', p)).toEqual(['s']);
    expect(isAlive).not.toHaveBeenCalled();
  });

  it("reads the tree from a destroySession reply, and none from an older daemon's", () => {
    expect(destroyedTreeOf({ ok: true, tree: { ok: true, killed: [1] } })).toEqual({ ok: true, killed: [1] });
    expect(destroyedTreeOf({ ok: true, tree: { ok: false, killed: [], survivors: [{ pid: 2, reason: 'x' }] } })?.ok).toBe(false);
    expect(destroyedTreeOf({ ok: true })).toBeUndefined();
    expect(destroyedTreeOf({ ok: true, tree: { ok: false } })).toBeUndefined();
    expect(destroyedTreeOf(null)).toBeUndefined();
  });

  it('fails when a session cannot be destroyed', async () => {
    const { p } = port([{ id: 's', spawnCwd: '/w/t' }], 'linux');
    p.destroySession = async () => { throw new Error('daemon offline'); };
    await expect(stopSessionsInDir('/w/t', p)).rejects.toThrow('daemon offline');
  });

  it('counts sessions across several worktrees for the close confirm', async () => {
    const { p } = port([
      { id: 'a', spawnCwd: '/w/a' }, { id: 'b', spawnCwd: '/w/b/x' }, { id: 'c', spawnCwd: '/w/c' },
    ], 'linux');
    expect(await sessionsStartedIn(['/w/a', '/w/b'], p)).toEqual(['a', 'b']);
  });
});
