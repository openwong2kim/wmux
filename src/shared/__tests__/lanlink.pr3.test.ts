import { describe, it, expect } from 'vitest';
import {
  coerceLanLinkConfig,
  coerceLanLinkPatch,
  defaultLanLinkConfig,
  isLanLinkNic,
  LANLINK_PORT_MIN,
  LANLINK_PORT_MAX,
  type LanLinkConfig,
} from '../lanlink';

const DEF: LanLinkConfig = { enabled: false, nic: null };

describe('isLanLinkNic', () => {
  it('accepts a well-formed {name, mac}', () => {
    expect(isLanLinkNic({ name: 'Ethernet', mac: 'aa:bb:cc:dd:ee:ff' })).toBe(true);
    expect(isLanLinkNic({ name: 'Wi-Fi', mac: '00:1A:2B:3C:4D:5E' })).toBe(true); // uppercase ok
  });
  it('rejects arrays, null, and missing/blank fields', () => {
    expect(isLanLinkNic([])).toBe(false); // Array.isArray-first
    expect(isLanLinkNic(null)).toBe(false);
    expect(isLanLinkNic({ name: '', mac: 'aa:bb:cc:dd:ee:ff' })).toBe(false);
    expect(isLanLinkNic({ name: 'Eth' })).toBe(false);
    expect(isLanLinkNic({ name: 1, mac: 2 })).toBe(false);
  });
  it('rejects a malformed MAC (not a real NIC identity PR-4 can re-resolve)', () => {
    expect(isLanLinkNic({ name: 'Eth', mac: 'x' })).toBe(false);
    expect(isLanLinkNic({ name: 'Eth', mac: 'aa:bb:cc:dd:ee' })).toBe(false); // 5 octets
    expect(isLanLinkNic({ name: 'Eth', mac: 'gg:bb:cc:dd:ee:ff' })).toBe(false); // non-hex
    expect(isLanLinkNic({ name: 'Eth', mac: '' })).toBe(false);
  });
});

describe('coerceLanLinkConfig (lenient config backfill — never throws)', () => {
  it('degrades a non-object / array to the default', () => {
    expect(coerceLanLinkConfig(undefined, DEF)).toEqual(DEF);
    expect(coerceLanLinkConfig('nope', DEF)).toEqual(DEF);
    expect(coerceLanLinkConfig([], DEF)).toEqual(DEF); // array is NOT an object
    expect(coerceLanLinkConfig(null, DEF)).toEqual(DEF);
  });

  it('coerces each sub-field independently (a bad field backfills only itself)', () => {
    expect(coerceLanLinkConfig({ enabled: 'yes', nic: 5, port: -1 }, DEF)).toEqual({ enabled: false, nic: null });
    expect(coerceLanLinkConfig({ enabled: true, nic: null, port: 'x' }, DEF)).toEqual({ enabled: true, nic: null });
  });

  it('preserves valid values verbatim', () => {
    const valid = { enabled: true, nic: { name: 'Wi-Fi', mac: '11:22:33:44:55:66' }, port: 41234 };
    expect(coerceLanLinkConfig(valid, DEF)).toEqual(valid);
  });

  it('drops a port outside the valid range', () => {
    expect(coerceLanLinkConfig({ enabled: false, nic: null, port: LANLINK_PORT_MIN - 1 }, DEF).port).toBeUndefined();
    expect(coerceLanLinkConfig({ enabled: false, nic: null, port: LANLINK_PORT_MAX + 1 }, DEF).port).toBeUndefined();
    expect(coerceLanLinkConfig({ enabled: false, nic: null, port: LANLINK_PORT_MAX }, DEF).port).toBe(LANLINK_PORT_MAX);
  });

  it('returns a fresh object (does not alias the default)', () => {
    const out = coerceLanLinkConfig(undefined, DEF);
    expect(out).not.toBe(DEF);
  });
});

describe('coerceLanLinkPatch (STRICT RPC trust boundary — throws on garbage)', () => {
  it('throws on a non-object payload', () => {
    expect(() => coerceLanLinkPatch(null)).toThrow();
    expect(() => coerceLanLinkPatch([])).toThrow();
    expect(() => coerceLanLinkPatch('x')).toThrow();
  });

  it('returns only the keys actually present', () => {
    expect(coerceLanLinkPatch({})).toEqual({});
    expect(coerceLanLinkPatch({ enabled: true })).toEqual({ enabled: true });
  });

  it('distinguishes an absent nic from an explicit null clear', () => {
    expect('nic' in coerceLanLinkPatch({ enabled: true })).toBe(false);
    expect(coerceLanLinkPatch({ nic: null })).toEqual({ nic: null });
    const nic = { name: 'Eth', mac: 'aa:bb:cc:dd:ee:ff' };
    expect(coerceLanLinkPatch({ nic })).toEqual({ nic });
  });

  it('throws on a malformed field rather than silently dropping it', () => {
    expect(() => coerceLanLinkPatch({ enabled: 'yes' })).toThrow();
    expect(() => coerceLanLinkPatch({ nic: 5 })).toThrow();
    expect(() => coerceLanLinkPatch({ nic: { name: 'Eth', mac: 'not-a-mac' } })).toThrow(); // bad MAC format
    expect(() => coerceLanLinkPatch({ port: 80 })).toThrow(); // below LANLINK_PORT_MIN
    expect(() => coerceLanLinkPatch({ port: 70000 })).toThrow();
  });

  it('defaultLanLinkConfig is OFF with no NIC', () => {
    expect(defaultLanLinkConfig()).toEqual({ enabled: false, nic: null });
  });
});
