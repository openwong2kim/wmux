import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';

// #2388: a task folder whose removal did not finish takes no new pane. The
// check sat on the createSession RPC only, so a recovery, a restart or a
// promote still spawned there. It is now part of every spawn.
const spawned: FakePty[] = [];
class FakePty extends EventEmitter {
  pid = 0;
  readonly _socket = new EventEmitter();
  readonly kill = vi.fn();
  onData() { return { dispose: () => { /* noop */ } }; }
  onExit(listener: (e: { exitCode: number }) => void) {
    this.on('exit', listener);
    return { dispose: () => { this.off('exit', listener); } };
  }
  write(): void { /* noop */ }
  resize(): void { /* noop */ }
  connect(pid: number): void { this.pid = pid; this._socket.emit('ready_datapipe'); }
}

vi.mock('../../shared/terminalPty', async (importOriginal) => (await import('../../test-utils/ptyTransportStub')).routeSpawnToNodePtyMock(importOriginal));
vi.mock('node-pty', () => {
  const spawn = () => { const p = new FakePty(); spawned.push(p); return p; };
  return { default: { spawn }, spawn };
});

vi.mock('../phantomExit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../phantomExit')>()),
  getProcessCreatedAtFt: () => null,
  getProcessStartTime: async () => null,
}));

import { DaemonSessionManager } from '../DaemonSessionManager';

const flush = () => new Promise<void>((r) => setImmediate(r));

describe('the spawn-time folder refusal (#2388)', () => {
  let manager: DaemonSessionManager;
  const locked = new Set<string>();
  const checked: string[] = [];
  const dir = path.join(os.tmpdir(), 'wmux-locked-task');

  beforeEach(() => {
    spawned.length = 0;
    locked.clear();
    checked.length = 0;
    manager = new DaemonSessionManager();
    manager.spawnStartRetryDelaysMs = [];
    manager.setSpawnCwdRefusal((cwd) => {
      checked.push(cwd);
      return locked.has(cwd) ? `${cwd} is locked` : null;
    });
  });

  afterEach(() => manager.disposeAll());

  it('refuses a locked folder before anything is spawned, with the cwd as the spawn uses it', async () => {
    locked.add(dir);
    await expect(manager.createSessionAsync({ id: 's', cmd: process.execPath, cwd: dir })).rejects.toThrow(/is locked/);
    expect(spawned).toHaveLength(0);
    expect(manager.getSession('s')).toBeUndefined();
    if (process.platform !== 'win32') {
      // `~/` is expanded before the check, as the spawn does.
      locked.add(path.join(os.homedir(), 'x'));
      await expect(manager.createSessionAsync({ id: 't', cmd: process.execPath, cwd: '~/x' })).rejects.toThrow(/is locked/);
      expect(spawned).toHaveLength(0);
    }
  });

  it('a folder locked while the pid is pending registers the session, so the removal\'s last look finds it', async () => {
    const pending = manager.createSessionAsync({ id: 's', cmd: process.execPath, cwd: dir });
    await flush();
    expect(spawned).toHaveLength(1);
    locked.add(dir);
    spawned[0].connect(4242);
    await pending;
    expect(spawned[0].kill).not.toHaveBeenCalled();
    expect(manager.getSession('s')).toBeDefined();
  });

  it('an unlocked folder spawns as before', async () => {
    const pending = manager.createSessionAsync({ id: 's', cmd: process.execPath, cwd: dir });
    await flush();
    spawned[0].connect(4242);
    await pending;
    expect(manager.getSession('s')).toBeDefined();
    expect(checked).toEqual([dir]);
  });
});
