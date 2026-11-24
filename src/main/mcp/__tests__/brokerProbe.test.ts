// @wmux-lane unit
// "win32" here is a platform argument and `net` is mocked: the owner
// check is injected and no pipe is opened, so the OS cannot change the result.
import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock `net` so the probe never touches a real pipe: we drive the socket
// lifecycle (connect / timeout / error) by hand for deterministic assertions.
vi.mock('net', () => ({ connect: vi.fn() }));
import * as net from 'net';

import { canConnectBrokerPipe, nativePipeOwnerCheck, probeBrokerPipe } from '../brokerProbe';

interface FakeSocket extends EventEmitter {
  setTimeout: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}

function fakeSocket(): FakeSocket {
  const s = new EventEmitter() as FakeSocket;
  s.setTimeout = vi.fn();
  s.destroy = vi.fn();
  return s;
}

afterEach(() => vi.clearAllMocks());

describe('canConnectBrokerPipe', () => {
  it('resolves true and destroys the socket on connect', async () => {
    const sock = fakeSocket();
    vi.mocked(net.connect).mockReturnValue(sock as unknown as net.Socket);
    const p = canConnectBrokerPipe(200, 'pipe', null);
    sock.emit('connect');
    await expect(p).resolves.toBe(true);
    expect(sock.destroy).toHaveBeenCalledTimes(1);
  });

  it('arms a connect timeout and resolves false when it fires (Windows hang guard)', async () => {
    const sock = fakeSocket();
    vi.mocked(net.connect).mockReturnValue(sock as unknown as net.Socket);
    const p = canConnectBrokerPipe(200, 'pipe', null);
    // The socket-level timeout is the guard against a named-pipe connect that
    // hangs because the server exists but has not called listen() yet.
    expect(sock.setTimeout).toHaveBeenCalledWith(200);
    sock.emit('timeout');
    await expect(p).resolves.toBe(false);
    expect(sock.destroy).toHaveBeenCalledTimes(1);
  });

  it('resolves false on connection error', async () => {
    const sock = fakeSocket();
    vi.mocked(net.connect).mockReturnValue(sock as unknown as net.Socket);
    const p = canConnectBrokerPipe(200, 'pipe', null);
    sock.emit('error', new Error('ECONNREFUSED'));
    await expect(p).resolves.toBe(false);
    expect(sock.destroy).toHaveBeenCalledTimes(1);
  });

  it('ignores events after the first settle', async () => {
    const sock = fakeSocket();
    vi.mocked(net.connect).mockReturnValue(sock as unknown as net.Socket);
    const p = canConnectBrokerPipe(200, 'pipe', null);
    sock.emit('connect');
    sock.emit('error', new Error('late'));
    await expect(p).resolves.toBe(true);
    expect(sock.destroy).toHaveBeenCalledTimes(1);
  });
});

// Windows: the probe reads the pipe's owner instead of connecting, so a pipe
// at the broker's name that another owner holds is never taken for a broker.
describe('probeBrokerPipe with an owner check', () => {
  it('passes the owner verdict through, without connecting', async () => {
    for (const verdict of ['ours', 'foreign', 'busy', 'none'] as const) {
      const ownerOf = vi.fn(() => verdict);
      await expect(probeBrokerPipe(200, 'pipe', ownerOf)).resolves.toBe(verdict);
      expect(ownerOf).toHaveBeenCalledWith('pipe');
    }
    expect(net.connect).not.toHaveBeenCalled();
  });

  it('an owner check that could not run is unknown, apart from busy', async () => {
    await expect(probeBrokerPipe(200, 'pipe', () => 'unknown')).resolves.toBe('unknown');
    await expect(probeBrokerPipe(200, 'pipe', () => 'busy')).resolves.toBe('busy');
  });

  it('canConnectBrokerPipe is true only for a pipe of this user', async () => {
    await expect(canConnectBrokerPipe(200, 'pipe', () => 'ours')).resolves.toBe(true);
    for (const verdict of ['foreign', 'busy', 'none', 'unknown'] as const) {
      await expect(canConnectBrokerPipe(200, 'pipe', () => verdict), verdict).resolves.toBe(false);
    }
    expect(net.connect).not.toHaveBeenCalled();
  });

  it('without an owner check the connect decides: ours or none', async () => {
    const up = fakeSocket();
    vi.mocked(net.connect).mockReturnValue(up as unknown as net.Socket);
    const p = probeBrokerPipe(200, 'pipe', null);
    up.emit('connect');
    await expect(p).resolves.toBe('ours');
    const down = fakeSocket();
    vi.mocked(net.connect).mockReturnValue(down as unknown as net.Socket);
    const q = probeBrokerPipe(200, 'pipe', null);
    down.emit('error', new Error('ENOENT'));
    await expect(q).resolves.toBe('none');
  });

  it('there is an owner check on Windows only', () => {
    expect(nativePipeOwnerCheck('darwin')).toBeNull();
    expect(nativePipeOwnerCheck('linux')).toBeNull();
    expect(nativePipeOwnerCheck('win32')).toBeTypeOf('function');
  });
});
