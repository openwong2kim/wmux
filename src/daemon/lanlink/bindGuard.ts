import os from 'node:os';
import type { NicInfo } from '../../shared/lanlink';

// === LanLink NIC introspection + bind guard (PR-3, pure, network-0) ===
//
// Two pure functions over an `os.networkInterfaces()` snapshot:
//   - enumerateNics      → the LAN-capable NICs the Settings dropdown offers
//   - assertLanBindAddress → the C2 fail-closed guard PR-4 calls right before listen()
//
// Both default the interface snapshot to a live `os.networkInterfaces()` read but
// accept an injected snapshot so they unit-test with a fixture and stay network-0.
// This module imports ONLY node:os + shared types — it never touches the execute
// machinery (ClaudeWorker / RpcRouter / a2a), so the daemon execute-wall source
// scan stays green.
//
// RUNTIME NOTE: the daemon runs under Electron's bundled Node 22 (ELECTRON_RUN_AS_
// NODE=1), where `os.networkInterfaces()` reports `family` as the STRING 'IPv4'
// / 'IPv6' (the numeric 4/6 form was Node ≤17). All comparisons use the string
// form; comparing `family === 4` would silently match nothing and reject every
// valid IPv4.

type IfaceSnapshot = NodeJS.Dict<os.NetworkInterfaceInfo[]>;

/** One external (non-internal) IPv4 entry, tagged with its interface name. */
interface ExternalIPv4 {
  name: string;
  mac: string;
  address: string;
}

/**
 * Collect every external (internal === false) IPv4 address across all interfaces,
 * each tagged with its interface name + MAC. Loopback / internal entries are
 * dropped (their MAC is the all-zero '00:00:00:00:00:00' placeholder). The dict
 * value can be undefined for a key, so iterate defensively.
 */
function collectExternalIPv4(ifaces: IfaceSnapshot): ExternalIPv4[] {
  const out: ExternalIPv4[] = [];
  for (const [name, entries] of Object.entries(ifaces)) {
    if (!entries) continue;
    for (const e of entries) {
      // family is the STRING 'IPv4' under Node 18+ (see RUNTIME NOTE).
      if (e.internal === false && e.family === 'IPv4') {
        out.push({ name, mac: e.mac, address: e.address });
      }
    }
  }
  return out;
}

/**
 * Enumerate the LAN-capable NICs for the Settings dropdown: one entry per
 * interface that has at least one external IPv4 address. `mac` comes from a
 * non-internal entry (consistent across an interface's addresses); `addresses`
 * lists every external IPv4 the interface holds. Internal/loopback interfaces are
 * excluded entirely.
 */
export function enumerateNics(ifaces: IfaceSnapshot = os.networkInterfaces()): NicInfo[] {
  const byName = new Map<string, NicInfo>();
  for (const { name, mac, address } of collectExternalIPv4(ifaces)) {
    const existing = byName.get(name);
    if (existing) {
      existing.addresses.push(address);
    } else {
      byName.set(name, { name, mac, addresses: [address] });
    }
  }
  return [...byName.values()];
}

/**
 * Fail-closed bind-address guard (C2). PR-4 calls this immediately before
 * `server.listen(ip)`; on any rejection it THROWS so the listener never starts —
 * there is no silent pass. An address is acceptable ONLY if it is a real,
 * non-wildcard, non-loopback external IPv4 currently present on some interface:
 *
 *   - reject empty / wildcard ('', '0.0.0.0', '::')
 *   - reject loopback ('::1', '127.x.x.x')
 *   - reject anything not found as an external IPv4 on a live NIC (covers a
 *     vanished NIC, an IPv6-only address, or an internal address)
 *
 * Scope: this guard deliberately does NOT enforce RFC1918 private ranges —
 * LAN-locality is enforced by the Windows Private firewall profile (PR-4), not a
 * range check here. The guard's contract is purely "a real external IPv4 on a
 * live interface, never a wildcard/loopback".
 */
export function assertLanBindAddress(
  ip: string,
  ifaces: IfaceSnapshot = os.networkInterfaces(),
): void {
  if (!ip || ip === '0.0.0.0' || ip === '::' || ip === '::1' || ip.startsWith('127.')) {
    throw new Error(`assertLanBindAddress: refusing to bind wildcard/loopback address "${ip}"`);
  }
  const external = collectExternalIPv4(ifaces);
  if (!external.some((e) => e.address === ip)) {
    throw new Error(
      `assertLanBindAddress: "${ip}" is not an external IPv4 address on any live network interface`,
    );
  }
}
