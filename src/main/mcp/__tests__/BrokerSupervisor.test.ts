import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/fake' } }));
vi.mock('fs', () => ({ existsSync: vi.fn(() => true) }));
vi.mock('child_process', () => ({ spawn: vi.fn() }));
vi.mock('../brokerProbe', () => ({ canConnectBrokerPipe: vi.fn() }));

import * as fs from 'fs';
import { spawn } from 'child_process';
import { canConnectBrokerPipe } from '../brokerProbe';
import { BrokerSupervisor } from '../BrokerSupervisor';

interface FakeChild extends EventEmitter {
  pid: number;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
}

function makeChild(): FakeChild {
  const c = new EventEmitter() as FakeChild;
  c.pid = 4321;
  c.stderr = new EventEmitter();
  c.kill = vi.fn();
  return c;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fs.existsSync).mockReturnValue(true);
});

describe('BrokerSupervisor.whenReady', () => {
  it('resolves true once the pipe accepts a connection', async () => {
    vi.mocked(canConnectBrokerPipe).mockResolvedValue(true);
    const sup = new BrokerSupervisor();
    await expect(sup.whenReady(4000)).resolves.toBe(true);
  });

  it('resolves false when the deadline elapses with no connection', async () => {
    vi.useFakeTimers();
    vi.mocked(canConnectBrokerPipe).mockResolvedValue(false);
    const sup = new BrokerSupervisor();
    const p = sup.whenReady(600);
    await vi.advanceTimersByTimeAsync(1000);
    await expect(p).resolves.toBe(false);
    vi.useRealTimers();
  });

  it('resolves false promptly when the broker script was missing', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false); // getBrokerScriptPath → null
    const sup = new BrokerSupervisor();
    sup.start(); // bails, sets scriptMissing
    expect(spawn).not.toHaveBeenCalled();
    await expect(sup.whenReady(4000)).resolves.toBe(false);
    expect(canConnectBrokerPipe).not.toHaveBeenCalled();
  });
});

describe('BrokerSupervisor exit-75 reclaim (W2)', () => {
  it('reclaims the pipe when a probe finds the other broker gone', async () => {
    vi.useFakeTimers();
    const first = makeChild();
    const second = makeChild();
    vi.mocked(spawn).mockReturnValueOnce(first as never).mockReturnValueOnce(second as never);
    vi.mocked(canConnectBrokerPipe).mockResolvedValue(false); // pipe orphaned
    const sup = new BrokerSupervisor();
    sup.start();
    expect(spawn).toHaveBeenCalledTimes(1);
    first.emit('exit', 75, null); // stand down + arm reclaim probe
    await vi.advanceTimersByTimeAsync(15_000);
    expect(canConnectBrokerPipe).toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(2); // reclaimed
    sup.stop();
    vi.useRealTimers();
  });

  it('keeps standing down while the pipe stays owned', async () => {
    vi.useFakeTimers();
    const first = makeChild();
    vi.mocked(spawn).mockReturnValue(first as never);
    vi.mocked(canConnectBrokerPipe).mockResolvedValue(true); // still owned
    const sup = new BrokerSupervisor();
    sup.start();
    first.emit('exit', 75, null);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(spawn).toHaveBeenCalledTimes(1); // never reclaimed
    sup.stop();
    vi.useRealTimers();
  });

  it('start() while a reclaim timer is armed clears it (no interval leak)', async () => {
    vi.useFakeTimers();
    const first = makeChild();
    const second = makeChild();
    vi.mocked(spawn).mockReturnValueOnce(first as never).mockReturnValueOnce(second as never);
    // Broker stays reachable, so reclaimTick would never clear the timer itself.
    vi.mocked(canConnectBrokerPipe).mockResolvedValue(true);
    const sup = new BrokerSupervisor();
    sup.start();
    first.emit('exit', 75, null); // arm reclaim probe, child now null
    // Directly re-invoking start() (defensive path) must tear the timer down.
    sup.start();
    expect(spawn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(canConnectBrokerPipe).not.toHaveBeenCalled(); // interval was cleared, never ticked
    sup.stop();
    vi.useRealTimers();
  });

  it('stop() clears the reclaim probe timer', async () => {
    vi.useFakeTimers();
    const first = makeChild();
    vi.mocked(spawn).mockReturnValue(first as never);
    vi.mocked(canConnectBrokerPipe).mockResolvedValue(false);
    const sup = new BrokerSupervisor();
    sup.start();
    first.emit('exit', 75, null); // arm reclaim probe
    sup.stop(); // must clear it before the first tick
    await vi.advanceTimersByTimeAsync(60_000);
    expect(canConnectBrokerPipe).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe('BrokerSupervisor status', () => {
  it('spawns the broker with an IPC channel and stdout still ignored', () => {
    vi.mocked(spawn).mockReturnValue(makeChild() as never);
    const sup = new BrokerSupervisor();
    sup.start();
    const opts = vi.mocked(spawn).mock.calls[0][2] as { stdio: unknown[] };
    expect(opts.stdio).toEqual(['ignore', 'ignore', 'pipe', 'ipc']);
    sup.stop();
  });

  it('takes the connection count only from the exact report shape', () => {
    const child = makeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const sup = new BrokerSupervisor();
    sup.start();
    child.emit('message', { wmuxBroker: 'connections', open: 3 });
    expect(sup.status().connections).toBe(3);
    for (const bad of [
      { wmuxBroker: 'connections', open: -1 },
      { wmuxBroker: 'connections', open: 1.5 },
      { wmuxBroker: 'connections', open: '7' },
      { wmuxBroker: 'connections', open: 7, extra: 1 },
      { wmuxBroker: 'other', open: 7 },
      [7],
      'connections=7',
      null,
    ]) {
      child.emit('message', bad);
    }
    expect(sup.status().connections).toBe(3);
    sup.stop();
  });

  it('counts crash exits and stand-downs apart, and an exit drops the connections', () => {
    vi.useFakeTimers();
    const first = makeChild();
    const second = makeChild();
    vi.mocked(spawn).mockReturnValueOnce(first as never).mockReturnValueOnce(second as never);
    vi.mocked(canConnectBrokerPipe).mockResolvedValue(true);
    const sup = new BrokerSupervisor();
    sup.start();
    expect(sup.status()).toMatchObject({ running: true, pid: 4321, crashExits: 0, standDowns: 0, standingDown: false });
    first.emit('message', { wmuxBroker: 'connections', open: 2 });
    first.emit('exit', 1, null);
    expect(sup.status()).toMatchObject({ running: false, pid: null, connections: 0, crashExits: 1 });
    vi.advanceTimersByTime(500); // backoff restart
    second.emit('exit', 75, null);
    expect(sup.status()).toMatchObject({ running: false, crashExits: 1, standDowns: 1, standingDown: true });
    sup.stop();
    vi.useRealTimers();
  });

  it('counts a failed spawn once, apart from crashes, and an exit after stop() not at all', () => {
    vi.useFakeTimers();
    const first = makeChild();
    const second = makeChild();
    vi.mocked(spawn).mockReturnValueOnce(first as never).mockReturnValueOnce(second as never);
    const sup = new BrokerSupervisor();
    sup.start();
    first.emit('error', new Error('EPERM'));
    first.emit('exit', null, null);
    expect(sup.status()).toMatchObject({ spawnFailures: 1, crashExits: 0 });
    vi.advanceTimersByTime(500);
    sup.stop();
    second.emit('exit', null, 'SIGTERM');
    expect(sup.status()).toMatchObject({ spawnFailures: 1, crashExits: 0 });
    vi.useRealTimers();
  });

  it('reports uptime from the current child start', () => {
    vi.useFakeTimers();
    vi.mocked(spawn).mockReturnValue(makeChild() as never);
    const sup = new BrokerSupervisor();
    expect(sup.status()).toMatchObject({ running: false, uptimeS: null });
    sup.start();
    vi.advanceTimersByTime(65_000);
    expect(sup.status().uptimeS).toBe(65);
    sup.stop();
    vi.useRealTimers();
  });
});

describe('BrokerSupervisor down reason', () => {
  it('names why the broker is not running, and nothing while it runs', () => {
    vi.useFakeTimers();
    const first = makeChild();
    const second = makeChild();
    vi.mocked(spawn).mockReturnValueOnce(first as never).mockReturnValueOnce(second as never);
    const sup = new BrokerSupervisor();
    expect(sup.status().downReason).toBe('not-started');
    sup.start();
    expect(sup.status().downReason).toBeNull();
    first.emit('exit', 1, null);
    expect(sup.status().downReason).toBe('restarting');
    vi.advanceTimersByTime(500);
    expect(sup.status().downReason).toBeNull();
    sup.stop();
    expect(sup.status().downReason).toBe('stopped');
    vi.useRealTimers();
  });

  it('says the script is missing when there is none to start', () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const sup = new BrokerSupervisor();
    sup.start();
    expect(sup.status().downReason).toBe('script-missing');
  });

  it('says it stands down while another broker serves the pipe', () => {
    vi.useFakeTimers();
    const first = makeChild();
    vi.mocked(spawn).mockReturnValue(first as never);
    vi.mocked(canConnectBrokerPipe).mockResolvedValue(true);
    const sup = new BrokerSupervisor();
    sup.start();
    first.emit('exit', 75, null);
    expect(sup.status().downReason).toBe('standing-down');
    sup.stop();
    vi.useRealTimers();
  });
});

describe('BrokerSupervisor after an aborted teardown', () => {
  // stop() then resume() spawns a replacement before the old child has exited.
  // The old child's late exit or error must not touch the replacement.
  it.each([
    ['a crash exit', (old: FakeChild) => old.emit('exit', 1, null)],
    ['a stand-down exit', (old: FakeChild) => old.emit('exit', 75, null)],
    ['a spawn error', (old: FakeChild) => old.emit('error', new Error('EPERM'))],
  ])('ignores the old child\'s %s', async (_label, late) => {
    vi.useFakeTimers();
    const old = makeChild();
    const replacement = makeChild();
    replacement.pid = 5555;
    vi.mocked(spawn).mockReturnValueOnce(old as never).mockReturnValueOnce(replacement as never);
    vi.mocked(canConnectBrokerPipe).mockResolvedValue(false);
    const sup = new BrokerSupervisor();
    sup.start();
    sup.stop();
    sup.resume();
    replacement.emit('message', { wmuxBroker: 'connections', open: 2 });
    const before = sup.status();
    expect(before).toMatchObject({ running: true, pid: 5555, connections: 2 });

    late(old);
    expect(sup.status()).toEqual(before);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spawn).toHaveBeenCalledTimes(2); // no restart scheduled
    expect(canConnectBrokerPipe).not.toHaveBeenCalled(); // no reclaim probe
    sup.stop();
    vi.useRealTimers();
  });
});

describe('BrokerSupervisor crash-loop breaker', () => {
  function effects() {
    return { clear: vi.fn(), tripped: vi.fn(async () => undefined) };
  }

  /** Each spawn returns a fresh child; `children` holds them in order. */
  function spawning() {
    const children: FakeChild[] = [];
    vi.mocked(spawn).mockImplementation((() => {
      const c = makeChild();
      children.push(c);
      return c;
    }) as never);
    return children;
  }

  it('stops restarting after 5 failures in 60 s and reports the trip once', async () => {
    vi.useFakeTimers();
    const children = spawning();
    const off = effects();
    const sup = new BrokerSupervisor({ brokerOff: off });
    sup.start();
    for (let i = 0; i < 4; i++) {
      children.at(-1)!.emit('exit', 1, null);
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(children).toHaveLength(5);
    expect(off.tripped).not.toHaveBeenCalled();
    children.at(-1)!.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children).toHaveLength(5);
    expect(sup.status()).toMatchObject({ running: false, crashExits: 5, downReason: 'crash-loop' });
    expect(off.tripped).toHaveBeenCalledTimes(1);
    sup.stop();
    vi.useRealTimers();
  });

  it('catches a slow loop: 8 failures in 30 minutes, though no minute holds 5', async () => {
    vi.useFakeTimers();
    const children = spawning();
    const off = effects();
    const sup = new BrokerSupervisor({ brokerOff: off });
    sup.start();
    for (let i = 0; i < 7; i++) {
      await vi.advanceTimersByTimeAsync(40_000); // outlives the stable window, so the backoff resets
      children.at(-1)!.emit('exit', 1, null);
      await vi.advanceTimersByTimeAsync(1_000);
    }
    expect(off.tripped).not.toHaveBeenCalled();
    expect(children).toHaveLength(8);
    await vi.advanceTimersByTimeAsync(40_000);
    children.at(-1)!.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(children).toHaveLength(8);
    expect(sup.status().downReason).toBe('crash-loop');
    expect(off.tripped).toHaveBeenCalledTimes(1);
    sup.stop();
    vi.useRealTimers();
  });

  it('counts spawn failures toward the breaker', async () => {
    vi.useFakeTimers();
    const children = spawning();
    const off = effects();
    const sup = new BrokerSupervisor({ brokerOff: off });
    sup.start();
    for (let i = 0; i < 5; i++) {
      children.at(-1)!.emit('error', new Error('EPERM'));
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(children).toHaveLength(5);
    expect(sup.status()).toMatchObject({ spawnFailures: 5, downReason: 'crash-loop' });
    sup.stop();
    vi.useRealTimers();
  });

  it('clears the marker whenever it starts a broker, a reclaim included', async () => {
    vi.useFakeTimers();
    const children = spawning();
    vi.mocked(canConnectBrokerPipe).mockResolvedValue(false);
    const off = effects();
    const sup = new BrokerSupervisor({ brokerOff: off });
    sup.start();
    expect(off.clear).toHaveBeenCalledTimes(1);
    children.at(-1)!.emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(children).toHaveLength(2);
    expect(off.clear).toHaveBeenCalledTimes(2);
    // Another instance's broker owned the pipe, then went: the reclaim starts one here.
    children.at(-1)!.emit('exit', 75, null);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(children).toHaveLength(3);
    expect(off.clear).toHaveBeenCalledTimes(3);
    sup.stop();
    vi.useRealTimers();
  });

  it('keeps the tool names a crash interrupted, names only', async () => {
    vi.useFakeTimers();
    const children = spawning();
    const sup = new BrokerSupervisor({ brokerOff: effects() });
    sup.start();
    children[0].emit('message', { wmuxBroker: 'connections', open: 2, inflight: ['browser_click', 'terminal_send'] });
    expect(sup.status()).toMatchObject({ connections: 2, lastCrashTools: [] });
    children[0].emit('exit', 1, null);
    expect(sup.status().lastCrashTools).toEqual(['browser_click', 'terminal_send']);
    await vi.advanceTimersByTimeAsync(1_000);
    // A report naming anything but tool names is not taken.
    for (const inflight of [['../etc/passwd'], ['a b'], ['x'.repeat(65)], Array(9).fill('t'), 'browser_click', [1]]) {
      children[1].emit('message', { wmuxBroker: 'connections', open: 5, inflight });
    }
    expect(sup.status().connections).toBe(0);
    children[1].emit('exit', 1, null);
    expect(sup.status().lastCrashTools).toEqual([]);
    await vi.advanceTimersByTimeAsync(2_000);
    // A failed spawn ran no tools: an older crash's names are not shown for it.
    children[2].emit('message', { wmuxBroker: 'connections', open: 1, inflight: ['browser_type'] });
    children[2].emit('exit', 1, null);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sup.status().lastCrashTools).toEqual(['browser_type']);
    children[3].emit('error', new Error('EPERM'));
    expect(sup.status().lastCrashTools).toEqual([]);
    sup.stop();
    vi.useRealTimers();
  });
});
