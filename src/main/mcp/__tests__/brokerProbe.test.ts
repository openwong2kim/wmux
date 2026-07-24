import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mock `net` so the probe never touches a real pipe: we drive the socket
// lifecycle (connect / timeout / error) by hand for deterministic assertions.
vi.mock('net', () => ({ connect: vi.fn() }));
import * as net from 'net';

import { canConnectBrokerPipe } from '../brokerProbe';

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
    const p = canConnectBrokerPipe(200, 'pipe');
    sock.emit('connect');
    await expect(p).resolves.toBe(true);
    expect(sock.destroy).toHaveBeenCalledTimes(1);
  });

  it('arms a connect timeout and resolves false when it fires (Windows hang guard)', async () => {
    const sock = fakeSocket();
    vi.mocked(net.connect).mockReturnValue(sock as unknown as net.Socket);
    const p = canConnectBrokerPipe(200, 'pipe');
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
    const p = canConnectBrokerPipe(200, 'pipe');
    sock.emit('error', new Error('ECONNREFUSED'));
    await expect(p).resolves.toBe(false);
    expect(sock.destroy).toHaveBeenCalledTimes(1);
  });

  it('ignores events after the first settle', async () => {
    const sock = fakeSocket();
    vi.mocked(net.connect).mockReturnValue(sock as unknown as net.Socket);
    const p = canConnectBrokerPipe(200, 'pipe');
    sock.emit('connect');
    sock.emit('error', new Error('late'));
    await expect(p).resolves.toBe(true);
    expect(sock.destroy).toHaveBeenCalledTimes(1);
  });
});
