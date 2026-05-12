import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * PTYBridge micro-batch behaviour.
 *
 * The hot-path callback (`instance.process.onData`) accumulates chunks and
 * flushes them every BATCH_INTERVAL_MS. After the flush:
 *   - middlewares run exactly once with the joined data
 *   - the renderer sees a single PTY_DATA send with the joined data
 *
 * We use fake timers + module mocks so the test is deterministic and
 * decoupled from electron / node-pty / notify-rpc internals.
 */

// ── Module mocks (must be declared before importing PTYBridge) ─────────────

vi.mock('electron', () => ({
  BrowserWindow: class {},
}));

vi.mock('../../pipe/handlers/notify.rpc', () => ({
  toastManager: { show: vi.fn() },
}));

vi.mock('../../ipc/handlers/metadata.handler', () => ({
  updateCwd: vi.fn(),
  removeCwd: vi.fn(),
  updateBranch: vi.fn(),
  removeBranch: vi.fn(),
  broadcastMetadataUpdate: vi.fn(),
}));

vi.mock('../../notification/sendNotification', () => ({
  sendNotification: vi.fn(),
}));

import { PTYBridge } from '../PTYBridge';
import type { PTYManager, PTYInstance } from '../PTYManager';

// ── Helpers ────────────────────────────────────────────────────────────────

interface MockProcess {
  onData: (cb: (data: string) => void) => void;
  onExit: (cb: (info: { exitCode: number }) => void) => void;
  emitData: (data: string) => void;
  emitExit: (code: number) => void;
}

function makeMockProcess(): MockProcess {
  let dataCb: ((data: string) => void) | null = null;
  let exitCb: ((info: { exitCode: number }) => void) | null = null;
  return {
    onData: (cb) => { dataCb = cb; },
    onExit: (cb) => { exitCb = cb; },
    emitData: (d) => { dataCb?.(d); },
    emitExit: (c) => { exitCb?.({ exitCode: c }); },
  };
}

function makeMockManager(instance: PTYInstance) {
  return {
    get: vi.fn(() => instance),
    remove: vi.fn(),
    onDispose: vi.fn(),
  } as unknown as PTYManager;
}

function makeMockSend() {
  const calls: Array<{ channel: string; args: unknown[] }> = [];
  const win = {
    isDestroyed: () => false,
    webContents: {
      send: (channel: string, ...args: unknown[]) => {
        calls.push({ channel, args });
      },
    },
  };
  return { win, calls };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PTYBridge micro-batch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces multiple chunks into a single send + single middleware call', () => {
    const proc = makeMockProcess();
    const instance: PTYInstance = {
      id: 'p1',
      process: proc as unknown as PTYInstance['process'],
      shell: 'bash',
    };
    const manager = makeMockManager(instance);
    const { win, calls } = makeMockSend();
    const bridge = new PTYBridge(manager, () => win as never);

    bridge.setupDataForwarding('p1');

    // Add a custom middleware AFTER setup so we can observe its calls.
    const mw = vi.fn();
    bridge.addMiddleware('p1', mw);

    // Three rapid chunks within one batch window
    proc.emitData('hello ');
    proc.emitData('world');
    proc.emitData('!');

    // Before the timer fires, nothing has been sent to the renderer
    const ptyDataBefore = calls.filter((c) => c.channel === 'pty:data');
    expect(ptyDataBefore).toHaveLength(0);
    expect(mw).not.toHaveBeenCalled();

    // Advance past the batch interval (8ms)
    vi.advanceTimersByTime(20);

    // Single coalesced flush
    const ptyDataAfter = calls.filter((c) => c.channel === 'pty:data');
    expect(ptyDataAfter).toHaveLength(1);
    expect(ptyDataAfter[0].args).toEqual(['p1', 'hello world!']);
    expect(mw).toHaveBeenCalledTimes(1);
    expect(mw).toHaveBeenCalledWith('hello world!');
  });

  it('flushes a single chunk after the batch interval', () => {
    const proc = makeMockProcess();
    const instance: PTYInstance = {
      id: 'p1',
      process: proc as unknown as PTYInstance['process'],
      shell: 'bash',
    };
    const manager = makeMockManager(instance);
    const { win, calls } = makeMockSend();
    const bridge = new PTYBridge(manager, () => win as never);

    bridge.setupDataForwarding('p1');
    proc.emitData('only-one');
    expect(calls.filter((c) => c.channel === 'pty:data')).toHaveLength(0);

    vi.advanceTimersByTime(20);
    const ptyData = calls.filter((c) => c.channel === 'pty:data');
    expect(ptyData).toHaveLength(1);
    expect(ptyData[0].args).toEqual(['p1', 'only-one']);
  });

  it('starts a new batch after the previous one flushes', () => {
    const proc = makeMockProcess();
    const instance: PTYInstance = {
      id: 'p1',
      process: proc as unknown as PTYInstance['process'],
      shell: 'bash',
    };
    const manager = makeMockManager(instance);
    const { win, calls } = makeMockSend();
    const bridge = new PTYBridge(manager, () => win as never);
    bridge.setupDataForwarding('p1');

    proc.emitData('A');
    vi.advanceTimersByTime(20);
    proc.emitData('B');
    vi.advanceTimersByTime(20);

    const ptyData = calls.filter((c) => c.channel === 'pty:data');
    expect(ptyData).toHaveLength(2);
    expect(ptyData[0].args).toEqual(['p1', 'A']);
    expect(ptyData[1].args).toEqual(['p1', 'B']);
  });

  it('drains pending data on exit before sending PTY_EXIT', () => {
    const proc = makeMockProcess();
    const instance: PTYInstance = {
      id: 'p1',
      process: proc as unknown as PTYInstance['process'],
      shell: 'bash',
    };
    const manager = makeMockManager(instance);
    const { win, calls } = makeMockSend();
    const bridge = new PTYBridge(manager, () => win as never);
    bridge.setupDataForwarding('p1');

    // Chunk arrives, then exit fires before batch timer
    proc.emitData('final-line\n');
    proc.emitExit(0);

    // Both PTY_DATA (drained) and PTY_EXIT must have been sent, in that order
    const channels = calls.map((c) => c.channel);
    const dataIdx = channels.indexOf('pty:data');
    const exitIdx = channels.indexOf('pty:exit');
    expect(dataIdx).toBeGreaterThanOrEqual(0);
    expect(exitIdx).toBeGreaterThanOrEqual(0);
    expect(dataIdx).toBeLessThan(exitIdx);

    // The data sent should be the buffered chunk
    expect(calls[dataIdx].args).toEqual(['p1', 'final-line\n']);
  });

  it('isolates failures in one middleware: still sends to renderer', () => {
    const proc = makeMockProcess();
    const instance: PTYInstance = {
      id: 'p1',
      process: proc as unknown as PTYInstance['process'],
      shell: 'bash',
    };
    const manager = makeMockManager(instance);
    const { win, calls } = makeMockSend();
    const bridge = new PTYBridge(manager, () => win as never);
    bridge.setupDataForwarding('p1');

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const goodMw = vi.fn();
    bridge.addMiddleware('p1', () => { throw new Error('boom'); });
    bridge.addMiddleware('p1', goodMw);

    proc.emitData('payload');
    vi.advanceTimersByTime(20);

    // Renderer still got the data
    const ptyData = calls.filter((c) => c.channel === 'pty:data');
    expect(ptyData).toHaveLength(1);
    expect(ptyData[0].args).toEqual(['p1', 'payload']);
    // Good middleware was still called despite the bad one throwing
    expect(goodMw).toHaveBeenCalledWith('payload');

    errSpy.mockRestore();
  });

  it('multiple ptyIds are batched independently', () => {
    const procA = makeMockProcess();
    const procB = makeMockProcess();
    const instA: PTYInstance = {
      id: 'a', process: procA as unknown as PTYInstance['process'], shell: 'bash',
    };
    const instB: PTYInstance = {
      id: 'b', process: procB as unknown as PTYInstance['process'], shell: 'bash',
    };
    // Manager.get returns the right instance based on id
    const manager = {
      get: vi.fn((id: string) => (id === 'a' ? instA : instB)),
      remove: vi.fn(),
      onDispose: vi.fn(),
    } as unknown as PTYManager;

    const { win, calls } = makeMockSend();
    const bridge = new PTYBridge(manager, () => win as never);
    bridge.setupDataForwarding('a');
    bridge.setupDataForwarding('b');

    procA.emitData('A1');
    procB.emitData('B1');
    procA.emitData('A2');
    vi.advanceTimersByTime(20);

    const ptyData = calls.filter((c) => c.channel === 'pty:data');
    expect(ptyData).toHaveLength(2);
    const byId = new Map(ptyData.map((c) => [c.args[0], c.args[1]]));
    expect(byId.get('a')).toBe('A1A2');
    expect(byId.get('b')).toBe('B1');
  });
});
