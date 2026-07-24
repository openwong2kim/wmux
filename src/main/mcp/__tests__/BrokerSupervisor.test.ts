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
