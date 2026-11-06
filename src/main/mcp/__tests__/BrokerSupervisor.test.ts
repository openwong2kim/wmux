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

  it('counts a failed spawn once, and an exit after stop() not at all', () => {
    vi.useFakeTimers();
    const first = makeChild();
    const second = makeChild();
    vi.mocked(spawn).mockReturnValueOnce(first as never).mockReturnValueOnce(second as never);
    const sup = new BrokerSupervisor();
    sup.start();
    first.emit('error', new Error('EPERM'));
    first.emit('exit', null, null);
    expect(sup.status().crashExits).toBe(1);
    vi.advanceTimersByTime(500);
    sup.stop();
    second.emit('exit', null, 'SIGTERM');
    expect(sup.status().crashExits).toBe(1);
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
