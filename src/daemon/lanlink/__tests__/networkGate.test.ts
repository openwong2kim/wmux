// The listen gate: LanLink opens its listener only when the selected NIC's
// network reads as Private (or on an OS with no network category), says why
// when it does not, and reads the category once per evaluated address, never
// on the liveness tick.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type os from 'node:os';
import { LanLinkServer } from '../server';
import { LANLINK_CONFIG_CHANGED } from '../controller';
import type { NetCategoryResult } from '../netCategory';

const NIC = { name: 'eth0', mac: 'aa:bb:cc:dd:ee:ff' };

let currentIp: string | null;
const ifaces = () =>
  ({
    eth0: currentIp
      ? [
          {
            address: currentIp,
            family: 'IPv4',
            internal: false,
            mac: NIC.mac,
            netmask: '255.255.255.0',
            cidr: `${currentIp}/24`,
          },
        ]
      : [],
  }) as unknown as NodeJS.Dict<os.NetworkInterfaceInfo[]>;

function controller(enabled: boolean) {
  return Object.assign(new EventEmitter(), {
    getStatus: () => ({ enabled, nic: NIC, port: null, effectivePort: 45651, nics: [] }),
  });
}

interface FakeNet {
  listens: Array<{ port: number; ip: string }>;
  closes: number;
  errorHandlers: Array<(err: Error) => void>;
}

function makeServer(
  netCategory: (ip: string) => Promise<NetCategoryResult>,
  opts: { enabled?: boolean } = {},
) {
  const net: FakeNet = { listens: [], closes: 0, errorHandlers: [] };
  const ctl = controller(opts.enabled ?? true);
  const server = new LanLinkServer({
    inbox: {} as never,
    controller: ctl as never,
    nudge: () => undefined,
    peers: { dispose: () => undefined } as never,
    selfName: 'host',
    ifaces,
    netCategory,
    createServer: () =>
      ({
        on(ev: string, cb: (err: Error) => void) {
          if (ev === 'error') net.errorHandlers.push(cb);
        },
        listen(port: number, ip: string) {
          net.listens.push({ port, ip });
        },
        close(cb?: () => void) {
          net.closes += 1;
          cb?.();
        },
      }) as never,
  });
  return { server, net, ctl };
}

/** A category read that stays pending until the test answers it. */
function pendingRead() {
  let answer: (c: NetCategoryResult) => void = () => undefined;
  const pending = new Promise<NetCategoryResult>((r) => {
    answer = r;
  });
  return { fn: vi.fn(() => pending), answer: (c: NetCategoryResult) => answer(c) };
}

beforeEach(() => {
  currentIp = '192.168.1.10';
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('LanLinkServer network gate', () => {
  it('listens on a Private network', async () => {
    const { server, net } = makeServer(async () => 'Private');
    await server.settled();
    expect(net.listens).toEqual([{ port: 45651, ip: '192.168.1.10' }]);
    expect(server.runtimeStatus()).toEqual({ listening: true, stopReason: null });
    server.dispose();
  });

  it('listens where the OS has no network category (macOS, Linux)', async () => {
    const { server, net } = makeServer(async () => 'not-applicable');
    await server.settled();
    expect(net.listens).toHaveLength(1);
    expect(server.runtimeStatus()).toEqual({ listening: true, stopReason: null });
    server.dispose();
  });

  it.each([
    ['Public', 'network-public'],
    ['Domain', 'network-domain'],
    ['Unknown', 'network-unknown'],
  ] as const)('does not listen on a %s network, and says why', async (category, reason) => {
    const { server, net } = makeServer(async () => category);
    await server.settled();
    expect(net.listens).toEqual([]);
    expect(server.isListening()).toBe(false);
    expect(server.runtimeStatus()).toEqual({ listening: false, stopReason: reason });
    server.dispose();
  });

  it('does not listen when the category cannot be read', async () => {
    const { server, net } = makeServer(async () => {
      throw new Error('powershell.exe blocked');
    });
    await server.settled();
    expect(net.listens).toEqual([]);
    expect(server.runtimeStatus()).toEqual({ listening: false, stopReason: 'network-check-failed' });
    server.dispose();
  });

  it('does not read the category for a NIC with no address', async () => {
    currentIp = null;
    const netCategory = vi.fn(async () => 'Private' as const);
    const { server, net } = makeServer(netCategory);
    await server.settled();
    expect(netCategory).not.toHaveBeenCalled();
    expect(net.listens).toEqual([]);
    expect(server.runtimeStatus()).toEqual({ listening: false, stopReason: 'no-address' });
    server.dispose();
  });

  it('reports nothing while LanLink is off, and reads nothing', async () => {
    const netCategory = vi.fn(async () => 'Private' as const);
    const { server, net } = makeServer(netCategory, { enabled: false });
    await server.settled();
    expect(netCategory).not.toHaveBeenCalled();
    expect(net.listens).toEqual([]);
    expect(server.runtimeStatus()).toEqual({ listening: false, stopReason: null });
    server.dispose();
  });

  it('reads the category once per address, not on every liveness tick', async () => {
    const netCategory = vi.fn(async () => 'Private' as const);
    const { server } = makeServer(netCategory);
    await server.settled();
    for (let i = 0; i < 6; i++) {
      vi.advanceTimersByTime(10_000);
      await server.settled();
    }
    expect(netCategory).toHaveBeenCalledTimes(1);
    expect(server.isListening()).toBe(true);
    server.dispose();
  });

  it('stops listening when the NIC moves from a Private to a Public network', async () => {
    const netCategory = vi.fn(async (ip: string) => (ip === '192.168.1.10' ? 'Private' : 'Public') as NetCategoryResult);
    const { server, net } = makeServer(netCategory);
    await server.settled();
    expect(server.isListening()).toBe(true);

    currentIp = '10.0.0.7';
    vi.advanceTimersByTime(10_000);
    await server.settled();

    expect(netCategory).toHaveBeenLastCalledWith('10.0.0.7');
    expect(net.closes).toBe(1);
    expect(server.isListening()).toBe(false);
    expect(server.runtimeStatus()).toEqual({ listening: false, stopReason: 'network-public' });
    server.dispose();
  });

  it('starts listening when a refused NIC moves to a Private network', async () => {
    const netCategory = vi.fn(async (ip: string) => (ip === '10.0.0.7' ? 'Private' : 'Public') as NetCategoryResult);
    const { server, net } = makeServer(netCategory);
    await server.settled();
    expect(server.runtimeStatus().stopReason).toBe('network-public');

    currentIp = '10.0.0.7';
    vi.advanceTimersByTime(10_000);
    await server.settled();

    expect(net.listens).toEqual([{ port: 45651, ip: '10.0.0.7' }]);
    expect(server.runtimeStatus()).toEqual({ listening: true, stopReason: null });
    server.dispose();
  });

  it('opens no listener when LanLink is turned off while the category is being read', async () => {
    const read = pendingRead();
    const { server, net, ctl } = makeServer(read.fn);
    await vi.waitFor(() => expect(read.fn).toHaveBeenCalled(), { timeout: 5_000 });
    ctl.emit(LANLINK_CONFIG_CHANGED, { enabled: false, nic: NIC });
    read.answer('Private');
    await server.settled();
    expect(net.listens).toEqual([]);
    expect(server.runtimeStatus()).toEqual({ listening: false, stopReason: null });
    server.dispose();
  });

  it('opens no listener when disposed while the category is being read', async () => {
    const read = pendingRead();
    const { server, net } = makeServer(read.fn);
    await vi.waitFor(() => expect(read.fn).toHaveBeenCalled(), { timeout: 5_000 });
    server.dispose();
    read.answer('Private');
    await server.settled();
    expect(net.listens).toEqual([]);
    expect(server.runtimeStatus()).toEqual({ listening: false, stopReason: null });
  });

  it('says listen-failed when the port cannot be opened', async () => {
    const { server, net } = makeServer(async () => 'Private');
    await server.settled();
    net.errorHandlers[0](Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }));
    expect(server.isListening()).toBe(false);
    expect(server.runtimeStatus()).toEqual({ listening: false, stopReason: 'listen-failed' });
    server.dispose();
  });
});
