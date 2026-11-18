import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// #2398 — node-pty 1.2.0-beta on Windows: the PTY has pid 0 until its output
// pipe connects (`ready_datapipe` on `_socket`), and a CreateProcess failure
// arrives as an exit while the pid is still 0. A session must only ever be
// registered with the shell's real pid.
const spawned: DeferredPty[] = [];
class DeferredPty extends EventEmitter {
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
  const spawn = () => { const p = new DeferredPty(); spawned.push(p); return p; };
  return { default: { spawn }, spawn };
});

const ftReads: number[] = [];
vi.mock('../phantomExit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../phantomExit')>()),
  getProcessCreatedAtFt: (pid: number) => { ftReads.push(pid); return 134296036801234567n; },
  getProcessStartTime: async () => null,
}));

import { DaemonSessionManager } from '../DaemonSessionManager';
import { createDefaultConfig } from '../config';

const flush = () => new Promise<void>((r) => setImmediate(r));

describe('createSessionAsync registers only a PTY whose pid is known (#2398)', () => {
  let manager: DaemonSessionManager;
  const created: unknown[] = [];

  beforeEach(() => {
    spawned.length = 0;
    ftReads.length = 0;
    created.length = 0;
    manager = new DaemonSessionManager();
    manager.on('session:created', (e) => created.push(e));
  });

  afterEach(() => manager.disposeAll());

  it('waits for the pid, then stamps meta.pid and pidCreatedAtFt from it', async () => {
    const pending = manager.createSessionAsync({ id: 'late-pid', cmd: process.execPath, cwd: process.cwd() });
    await flush();
    expect(spawned).toHaveLength(1);
    expect(manager.getSession('late-pid')).toBeUndefined();
    expect(created).toHaveLength(0);

    spawned[0].connect(4242);
    const session = await pending;
    expect(session.pid).toBe(4242);
    expect(manager.getSession('late-pid')?.meta.pid).toBe(4242);
    expect(ftReads).toEqual([4242]);
    expect(created).toHaveLength(1);
  });

  it('never registers a pane whose spawn failed before the pid, and keeps node-pty 1.1.0\'s message', async () => {
    const pending = manager.createSessionAsync({ id: 'bad-cwd', cmd: process.execPath, cwd: process.cwd() });
    await flush();
    spawned[0].emit('exit', { exitCode: 267 });
    await expect(pending).rejects.toThrow(/^Failed to start shell ".*": Cannot create process, error code: 267$/);
    expect(manager.getSession('bad-cwd')).toBeUndefined();
    expect(created).toHaveLength(0);
    expect(ftReads).toEqual([]);
  });

  it('kills the PTY and registers nothing when the session is destroyed while the pid is pending', async () => {
    const pending = manager.createSessionAsync({ id: 'cancelled', cmd: process.execPath, cwd: process.cwd() });
    await flush();
    manager.destroySession('cancelled');
    spawned[0].connect(5151);
    await expect(pending).rejects.toThrow('Session creation cancelled');
    expect(spawned[0].kill).toHaveBeenCalled();
    expect(manager.getSession('cancelled')).toBeUndefined();
    expect(created).toHaveLength(0);
  });

  it('refuses a second create of the same id while the first is pending', async () => {
    const first = manager.createSessionAsync({ id: 'dup', cmd: process.execPath, cwd: process.cwd() });
    await flush();
    await expect(manager.createSessionAsync({ id: 'dup', cmd: process.execPath, cwd: process.cwd() }))
      .rejects.toThrow("Session 'dup' creation is already pending");
    expect(() => manager.createSession({ id: 'dup', cmd: process.execPath, cwd: process.cwd() }))
      .toThrow("Session 'dup' creation is already pending");
    spawned[0].connect(6161);
    await first;
  });

  it('the synchronous createSession refuses a pid-less PTY instead of registering pid 0', () => {
    expect(() => manager.createSession({ id: 'sync-zero', cmd: process.execPath, cwd: process.cwd() }))
      .toThrow(/Cannot create process/);
    expect(spawned[0].kill).toHaveBeenCalled();
    expect(manager.getSession('sync-zero')).toBeUndefined();
    expect(created).toHaveLength(0);
  });

  it('counts a create whose pid is pending against maxSessions', async () => {
    const cfg = createDefaultConfig();
    cfg.session.maxSessions = 1;
    manager.setConfig(cfg);
    const first = manager.createSessionAsync({ id: 'cap-1', cmd: process.execPath, cwd: process.cwd() });
    await flush();
    await expect(manager.createSessionAsync({ id: 'cap-2', cmd: process.execPath, cwd: process.cwd() }))
      .rejects.toThrow(/^Cannot create new terminal: 1 active sessions/);
    expect(spawned).toHaveLength(1);
    spawned[0].connect(7171);
    await first;
    expect(manager.getSession('cap-2')).toBeUndefined();
  });

  it('a fractional bufferSizeMb makes a ring of whole bytes instead of failing the create (#3351)', async () => {
    const cfg = createDefaultConfig();
    cfg.session.bufferSizeMb = 0.3;
    manager.setConfig(cfg);
    const pending = manager.createSessionAsync({ id: 'ring-frac', cmd: process.execPath, cwd: process.cwd() });
    await flush();
    spawned[0].connect(5151);
    await pending;
    const ring = manager.getSession('ring-frac')!.ringBuffer as unknown as { capacity: number };
    expect(ring.capacity).toBe(Math.floor(0.3 * 1024 * 1024));
  });

  it('reports a cancel, not the spawn error, when a cancelled create then fails to spawn', async () => {
    const pending = manager.createSessionAsync({ id: 'closed', cmd: process.execPath, cwd: process.cwd() });
    await flush();
    manager.destroySession('closed');
    spawned[0].emit('exit', { exitCode: 87 });
    await expect(pending).rejects.toThrow(/^Session creation cancelled$/);
  });

  it('a cancelled create cannot release the reservation of its replacement under the same id', async () => {
    const cfg = createDefaultConfig();
    cfg.session.maxSessions = 2;
    manager.setConfig(cfg);
    const cancelled = manager.createSessionAsync({ id: 'a', cmd: process.execPath, cwd: process.cwd() });
    await flush();
    manager.destroySession('a');
    const replacement = manager.createSessionAsync({ id: 'a', cmd: process.execPath, cwd: process.cwd() });
    await flush();
    spawned[0].connect(8001);
    await expect(cancelled).rejects.toThrow('Session creation cancelled');
    const b = manager.createSessionAsync({ id: 'b', cmd: process.execPath, cwd: process.cwd() });
    await flush();
    await expect(manager.createSessionAsync({ id: 'c', cmd: process.execPath, cwd: process.cwd() }))
      .rejects.toThrow(/^Cannot create new terminal: 2 active sessions/);
    spawned[1].connect(8002);
    spawned[2].connect(8003);
    await Promise.all([replacement, b]);
    expect(spawned).toHaveLength(3);
  });

  it('hands the pane job the shell pid with the mark read before the spawn', async () => {
    const contain = vi.fn();
    manager.setPaneJob({ enter: vi.fn(), spawnMark: () => 55n, contain, disarm: vi.fn(), stats: () => ({ mode: 'per-pane', contained: 0, failed: 0 }) });
    const pending = manager.createSessionAsync({ id: 'jobbed', cmd: process.execPath, cwd: process.cwd() });
    await flush();
    spawned[0].connect(9090);
    await pending;
    expect(contain).toHaveBeenCalledWith(9090, 55n);
  });

  it('kills the shell it just spawned when registering the session throws, and registers nothing', async () => {
    // #2398 review: a throw out of registerSession used to reject the create
    // while the shell kept running with no session to reach it.
    manager.setPaneJob({
      enter: vi.fn(),
      spawnMark: () => null,
      contain: () => { throw new Error('native call failed'); },
      disarm: vi.fn(),
      stats: () => ({ mode: 'per-pane', contained: 0, failed: 0 }),
    });
    const pending = manager.createSessionAsync({ id: 'leak', cmd: process.execPath, cwd: process.cwd() });
    await flush();
    spawned[0].connect(9191);
    await expect(pending).rejects.toThrow('native call failed');
    expect(spawned[0].kill).toHaveBeenCalled();
    expect(manager.getSession('leak')).toBeUndefined();
    expect(created).toHaveLength(0);
  });

  it('drops a half-registered session and kills its shell when registration throws late', async () => {
    manager.on('session:created', () => { throw new Error('listener failed'); });
    const pending = manager.createSessionAsync({ id: 'late-throw', cmd: process.execPath, cwd: process.cwd() });
    await flush();
    spawned[0].connect(9292);
    await expect(pending).rejects.toThrow('listener failed');
    expect(spawned[0].kill).toHaveBeenCalled();
    expect(manager.getSession('late-throw')).toBeUndefined();
  });
});
