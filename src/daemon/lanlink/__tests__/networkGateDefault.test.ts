// Without an injected reader the server reads the real network category: the
// gate is wired in production, not only in tests.
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type os from 'node:os';
import { LanLinkServer } from '../server';
import { readNetCategory } from '../netCategory';

vi.mock('../netCategory', () => ({ readNetCategory: vi.fn(async () => 'Public') }));

const NIC = { name: 'eth0', mac: 'aa:bb:cc:dd:ee:ff' };

describe('LanLinkServer default network-category reader', () => {
  it('reads the category of the address it would bind', async () => {
    const listen = vi.fn();
    const server = new LanLinkServer({
      inbox: {} as never,
      controller: Object.assign(new EventEmitter(), {
        getStatus: () => ({ enabled: true, nic: NIC, port: null, effectivePort: 45651, nics: [] }),
      }) as never,
      nudge: () => undefined,
      peers: { dispose: () => undefined } as never,
      selfName: 'host',
      ifaces: () =>
        ({
          eth0: [{ address: '192.168.1.10', family: 'IPv4', internal: false, mac: NIC.mac, netmask: '255.255.255.0', cidr: '192.168.1.10/24' }],
        }) as unknown as NodeJS.Dict<os.NetworkInterfaceInfo[]>,
      createServer: () => ({ on: () => undefined, listen, close: (cb?: () => void) => cb?.() }) as never,
    });
    await server.settled();
    expect(readNetCategory).toHaveBeenCalledWith('192.168.1.10');
    expect(listen).not.toHaveBeenCalled();
    expect(server.runtimeStatus()).toEqual({ listening: false, stopReason: 'network-public' });
    server.dispose();
  });
});
