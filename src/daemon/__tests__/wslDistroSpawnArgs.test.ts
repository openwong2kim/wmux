import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import os from 'node:os';

// #1103 — createSession is also reached by replay paths (recovery,
// supervised restart, promote) that feed it args from the persisted state
// file, never crossing the RPC boundary's check. The spawn site itself must
// admit only an exact ['-d', <distro>] for a wsl cmd.

class MockPty extends EventEmitter {
  pid = 4242;
  onData() { return { dispose: () => { /* noop */ } }; }
  onExit() { return { dispose: () => { /* noop */ } }; }
  write(_data: string): void { /* noop */ }
  resize(_cols: number, _rows: number): void { /* noop */ }
  kill(): void { /* noop */ }
}

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock('node-pty', () => ({
  default: { spawn: spawnMock },
  spawn: spawnMock,
}));

import { DaemonSessionManager } from '../DaemonSessionManager';

describe('createSession — WSL distro args at the spawn site', () => {
  let manager: DaemonSessionManager;

  beforeEach(() => {
    spawnMock.mockReset();
    spawnMock.mockImplementation(() => new MockPty());
    manager = new DaemonSessionManager();
  });

  afterEach(() => {
    manager.disposeAll();
  });

  it('spawns wsl.exe with the validated distro selection first', () => {
    manager.createSession({ id: 'wsl-ok', cmd: 'wsl.exe', args: ['-d', 'Ubuntu-24.04'], cwd: os.tmpdir() });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0][1]).toEqual(['-d', 'Ubuntu-24.04']);
    expect(manager.getSession('wsl-ok')?.meta.args).toEqual(['-d', 'Ubuntu-24.04']);
  });

  it('drops replayed args that are not exactly a distro selection', () => {
    manager.createSession({ id: 'wsl-bad', cmd: 'wsl.exe', args: ['--exec', 'cmd.exe'], cwd: os.tmpdir() });
    expect(spawnMock.mock.calls[0][1]).not.toContain('--exec');
    expect(manager.getSession('wsl-bad')?.meta.args).toBeUndefined();
  });
});
