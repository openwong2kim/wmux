import { describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { PanesStillRunningError, sessionHostDir, sessionsStartedIn, stopSessionsInDir, type SessionsInDirPort } from '../stopSessionsInDir';

type Session = { id: string; pid?: number; cwd?: string; spawnCwd?: string; wslTarget?: { distribution: string } };

function port(sessions: Session[], platform: NodeJS.Platform, opts: { stubborn?: number[] } = {}) {
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
    }),
    isAlive: (pid) => alive.has(pid),
    sleep: async () => undefined,
  };
  return { p, alive, log };
}

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
