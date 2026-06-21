import os from 'node:os';
import { describe, it, expect } from 'vitest';
import { assertLanBindAddress, enumerateNics } from '../bindGuard';

// Fixture mirrors a real os.networkInterfaces() snapshot under Node 18+: `family`
// is the STRING 'IPv4'/'IPv6' (NOT numeric 4/6), loopback entries are internal:true
// with the all-zero MAC, and a NIC can carry both an IPv4 and IPv6 address.
type Ifaces = NodeJS.Dict<os.NetworkInterfaceInfo[]>;

function snapshot(): Ifaces {
  return {
    lo: [
      { address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' },
      { address: '::1', netmask: 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff', family: 'IPv6', mac: '00:00:00:00:00:00', internal: true, cidr: '::1/128', scopeid: 0 },
    ],
    Ethernet: [
      { address: '192.168.1.5', netmask: '255.255.255.0', family: 'IPv4', mac: 'aa:bb:cc:dd:ee:ff', internal: false, cidr: '192.168.1.5/24' },
      { address: 'fe80::1', netmask: 'ffff:ffff:ffff:ffff::', family: 'IPv6', mac: 'aa:bb:cc:dd:ee:ff', internal: false, cidr: 'fe80::1/64', scopeid: 11 },
    ],
    'Wi-Fi': [
      { address: '192.168.1.6', netmask: '255.255.255.0', family: 'IPv4', mac: '11:22:33:44:55:66', internal: false, cidr: '192.168.1.6/24' },
    ],
    // Defensive: the dict value can be undefined for a key.
    Ghost: undefined,
  } as Ifaces;
}

describe('assertLanBindAddress (C2 fail-closed bind guard)', () => {
  it('rejects wildcard / empty / IPv6-wildcard addresses', () => {
    const ifaces = snapshot();
    for (const bad of ['', '0.0.0.0', '::']) {
      expect(() => assertLanBindAddress(bad, ifaces)).toThrow();
    }
  });

  it('rejects loopback addresses', () => {
    const ifaces = snapshot();
    for (const lo of ['::1', '127.0.0.1', '127.0.0.53']) {
      expect(() => assertLanBindAddress(lo, ifaces)).toThrow();
    }
  });

  it('rejects an internal (loopback) address even though it exists', () => {
    // 127.0.0.1 is present in the fixture but internal:true — must still throw.
    expect(() => assertLanBindAddress('127.0.0.1', snapshot())).toThrow();
  });

  it('rejects an address that is not present on any live NIC', () => {
    expect(() => assertLanBindAddress('192.168.99.99', snapshot())).toThrow();
  });

  it('rejects an IPv6 address even when it is external (IPv4-only guard)', () => {
    expect(() => assertLanBindAddress('fe80::1', snapshot())).toThrow();
  });

  it('passes for a real external IPv4 present on a live NIC', () => {
    const ifaces = snapshot();
    expect(() => assertLanBindAddress('192.168.1.5', ifaces)).not.toThrow();
    expect(() => assertLanBindAddress('192.168.1.6', ifaces)).not.toThrow();
  });

  it('throws on an empty interface snapshot (no NICs → fail closed)', () => {
    expect(() => assertLanBindAddress('192.168.1.5', {} as Ifaces)).toThrow();
  });
});

describe('enumerateNics', () => {
  it('lists only external NICs, grouped by name, IPv4 addresses only', () => {
    const nics = enumerateNics(snapshot());
    const names = nics.map((n) => n.name).sort();
    expect(names).toEqual(['Ethernet', 'Wi-Fi']); // lo excluded (internal), Ghost skipped (undefined)
    const eth = nics.find((n) => n.name === 'Ethernet')!;
    expect(eth.mac).toBe('aa:bb:cc:dd:ee:ff');
    expect(eth.addresses).toEqual(['192.168.1.5']); // IPv6 fe80::1 excluded
  });

  it('does not crash on an undefined dict value', () => {
    expect(() => enumerateNics(snapshot())).not.toThrow();
  });

  it('returns an empty list when there are no external interfaces', () => {
    const loopbackOnly: Ifaces = {
      lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }],
    } as Ifaces;
    expect(enumerateNics(loopbackOnly)).toEqual([]);
  });

  it('reads a live os.networkInterfaces() snapshot without throwing (smoke)', () => {
    expect(() => enumerateNics()).not.toThrow();
    // Every enumerated NIC must carry the runtime string-family invariant: at
    // least one address, all of them IPv4 dotted-quad strings.
    for (const nic of enumerateNics()) {
      expect(nic.addresses.length).toBeGreaterThan(0);
      for (const a of nic.addresses) expect(a).toMatch(/^\d{1,3}(\.\d{1,3}){3}$/);
    }
  });
});
