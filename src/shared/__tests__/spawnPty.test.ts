import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IPty } from 'node-pty';
import { awaitPtyPid, spawnPty, spawnPtySync, type SpawnPtyRequest } from '../spawnPty';
import { classifyConptySpawnError } from '../conptyWindows';

// #2398 — node-pty 1.2.0-beta's Windows PTY: pid 0 until its output pipe
// connects (`ready_datapipe` on `_socket`), and a CreateProcess failure is an
// exit while the pid is still 0. This double models exactly that.
class DeferredPty {
  pid = 0;
  readonly _socket = new EventEmitter();
  private readonly exits = new EventEmitter();
  readonly kill = vi.fn();
  onExit(listener: (e: { exitCode: number }) => void) {
    this.exits.on('exit', listener);
    return { dispose: () => { this.exits.off('exit', listener); } };
  }
  connect(pid: number): void { this.pid = pid; this._socket.emit('ready_datapipe'); }
  fail(exitCode: number): void { this.exits.emit('exit', { exitCode }); }
  get exitListeners(): number { return this.exits.listenerCount('exit'); }
}

const asPty = (p: unknown) => p as IPty;
const request = (made: unknown, extra: Partial<SpawnPtyRequest> = {}): SpawnPtyRequest => ({
  command: 'cmd.exe',
  args: [],
  options: { cols: 80, rows: 24 },
  useBundledConpty: false,
  onNotice: () => { /* noop */ },
  nodeSpawn: () => asPty(made),
  ...extra,
});

/** The error a promise rejects with; fails if it resolves. */
const rejection = (p: Promise<unknown>): Promise<Error> =>
  p.then(() => { throw new Error('expected a rejection'); }, (e: Error) => e);

afterEach(() => { vi.useRealTimers(); });

describe('spawnPty — the one PTY spawn seam (#2398)', () => {
  it('returns a PTY whose pid is already known with no listener or timer (macOS/Linux, Rust core)', async () => {
    vi.useFakeTimers();
    const ready = { pid: 4321, onExit: vi.fn(), kill: vi.fn() };
    await expect(spawnPty(request(ready))).resolves.toBe(ready);
    expect(ready.onExit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves only once the deferred ConPTY reports its pid, and lets go of its listeners', async () => {
    const p = new DeferredPty();
    let resolved: IPty | undefined;
    const pending = spawnPty(request(p)).then((r) => { resolved = r; return r; });
    await Promise.resolve();
    expect(resolved).toBeUndefined();
    p.connect(9876);
    await expect(pending).resolves.toBe(p);
    expect(resolved?.pid).toBe(9876);
    expect(p.exitListeners).toBe(0);
    expect(p._socket.listenerCount('ready_datapipe')).toBe(0);
  });

  it('resolves inside the connect event, before a later I/O callback could deliver output', async () => {
    const p = new DeferredPty();
    const order: string[] = [];
    const pending = spawnPty(request(p)).then(() => { order.push('resolved'); });
    p.connect(1);
    // node-pty reads output in a later I/O callback; a setImmediate stands in.
    await new Promise<void>((r) => setImmediate(() => { order.push('first data'); r(); }));
    await pending;
    expect(order).toEqual(['resolved', 'first data']);
  });

  it('turns an exit before the pid into node-pty 1.1.0\'s throw, without a second kill', async () => {
    const p = new DeferredPty();
    const pending = spawnPty(request(p));
    p.fail(267);
    await expect(pending).rejects.toThrow('Cannot create process, error code: 267');
    expect(p.kill).not.toHaveBeenCalled();
  });

  it('keeps a transient error 87 matchable by the daemon retry and the conpty policy', async () => {
    const p = new DeferredPty();
    const pending = spawnPty(request(p));
    p.fail(87);
    const err = await rejection(pending);
    expect(err.message).toContain('error code: 87');
    expect(classifyConptySpawnError(err.message, false)).toBe('rethrow');
  });

  it('kills and rejects when no pid arrives within the bound', async () => {
    vi.useFakeTimers();
    const p = new DeferredPty();
    const pending = spawnPty(request(p, { pidTimeoutMs: 5000 }));
    const settled = rejection(pending);
    await vi.advanceTimersByTimeAsync(4999);
    expect(p.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await settled).message).toMatch(/^Cannot create process, no pid within 5000 ms/);
    expect(p.kill).toHaveBeenCalledOnce();
  });

  it('clears its timer once the pid is known, so it can never kill a live pane', async () => {
    vi.useFakeTimers();
    const p = new DeferredPty();
    const pending = spawnPty(request(p, { pidTimeoutMs: 5000 }));
    p.connect(77);
    await pending;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(p.kill).not.toHaveBeenCalled();
  });

  it('refuses a pid-less PTY that exposes no connect event instead of polling', async () => {
    const p = { pid: 0, kill: vi.fn(), onExit: vi.fn() };
    await expect(awaitPtyPid(asPty(p), 5000)).rejects.toThrow(/^Cannot create process/);
    expect(p.kill).toHaveBeenCalledOnce();
  });

  it('runs the spawn through the ConPTY policy with the backend it picked', async () => {
    const nodeSpawn = vi.fn(() => asPty({ pid: 5, kill: vi.fn() }));
    const onBackend = vi.fn();
    await spawnPty(request(undefined, { nodeSpawn, useBundledConpty: true, onBackend }));
    expect(nodeSpawn).toHaveBeenCalledWith('cmd.exe', [], expect.objectContaining({ useConpty: true, useConptyDll: true }));
    expect(onBackend).toHaveBeenCalledWith('bundled');
  });
});

describe('spawnPtySync', () => {
  it('returns a PTY that has a pid', () => {
    const ready = { pid: 11, kill: vi.fn() };
    expect(spawnPtySync(request(ready))).toBe(ready);
  });

  it('kills and throws on a PTY without a pid rather than register it', () => {
    const p = new DeferredPty();
    expect(() => spawnPtySync(request(p))).toThrow(/^Cannot create process/);
    expect(p.kill).toHaveBeenCalledOnce();
  });
});
