import type os from 'node:os';
import { describe, expect, it } from 'vitest';
import { devTailscaleDir, tailnetRangeOnLan } from '../tailnet';

function nic(address: string, over: Partial<os.NetworkInterfaceInfo> = {}): os.NetworkInterfaceInfo {
  return { address, netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: null, ...over } as os.NetworkInterfaceInfo;
}

describe('devTailscaleDir — the fixture directory is a development-only seam', () => {
  it('is honoured only when NODE_ENV is development or test', () => {
    expect(devTailscaleDir({ NODE_ENV: 'development', WMUX_DEV_TAILSCALE_DIR: '/tmp/ts' })).toBe('/tmp/ts');
    expect(devTailscaleDir({ NODE_ENV: 'test', WMUX_DEV_TAILSCALE_DIR: '/tmp/ts' })).toBe('/tmp/ts');
    // A packaged build leaves NODE_ENV unset.
    expect(devTailscaleDir({ WMUX_DEV_TAILSCALE_DIR: '/tmp/ts' })).toBeNull();
    expect(devTailscaleDir({ NODE_ENV: 'production', WMUX_DEV_TAILSCALE_DIR: '/tmp/ts' })).toBeNull();
    expect(devTailscaleDir({ NODE_ENV: 'staging', WMUX_DEV_TAILSCALE_DIR: '/tmp/ts' })).toBeNull();
  });

  it('is null when unset or blank', () => {
    expect(devTailscaleDir({ NODE_ENV: 'development' })).toBeNull();
    expect(devTailscaleDir({ NODE_ENV: 'development', WMUX_DEV_TAILSCALE_DIR: '  ' })).toBeNull();
  });
});

describe('tailnetRangeOnLan', () => {
  const self = ['100.101.0.1'];

  it('is false when the only 100.64/10 address is this PC’s tailnet address', () => {
    expect(tailnetRangeOnLan({ en0: [nic('192.168.1.20')], utun4: [nic('100.101.0.1')] }, self)).toBe(false);
  });

  it('is true when another interface holds an address in 100.64/10 (a CGNAT LAN)', () => {
    expect(tailnetRangeOnLan({ en0: [nic('100.72.4.20')], utun4: [nic('100.101.0.1')] }, self)).toBe(true);
    // Even beside it on the same interface.
    expect(tailnetRangeOnLan({ utun4: [nic('100.101.0.1'), nic('100.101.0.2')] }, self)).toBe(true);
  });

  it('ignores loopback interfaces, IPv6 and addresses outside the range', () => {
    expect(
      tailnetRangeOnLan(
        {
          lo0: [nic('127.0.0.1', { internal: true }), nic('100.100.1.2', { internal: true })],
          en0: [nic('100.128.0.1'), nic('10.0.0.4'), nic('fd7a::1', { family: 'IPv6' })],
          utun4: [nic('100.101.0.1')],
        },
        self,
      ),
    ).toBe(false);
  });
});
