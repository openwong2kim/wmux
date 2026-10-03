import type { WebDeviceSummary, WebTerminalInfo } from '../../../shared/web';
import { webIsExposed } from '../../../shared/web';
import type { RemoteHostPublic, RemoteHostStatus } from '../../../shared/remoteHosts';
import type { LanLinkPeerSummary } from '../../../shared/lanlink';

/**
 * One row of the Remote page: a device paired with this machine, a host this
 * machine connects to, or a LAN peer. Built only from data the app already
 * reads; anything it does not know stays null and is shown as "unknown".
 * Never carries a token, a secret or a full id — `shortId` is a 6-character
 * stub for telling same-named rows apart.
 */
export interface RemoteEntry {
  key: string;
  /** The full id, for row actions only. Never rendered. */
  id: string;
  kind: 'phone' | 'computer' | 'device' | 'host' | 'peer';
  name: string;
  shortId: string;
  /** Holding a live connection right now — the only case that earns a live dot. */
  live: boolean;
  status: 'online' | 'offline' | 'blocked' | 'unknown' | RemoteHostStatus;
  lastSeenAt: number | null;
  /** What it has open right now; null when nothing reports it. */
  viewing: string[] | null;
  /** May it type? null when unknown; 'messages' for message-only peers. */
  access: 'input' | 'input-when-on' | 'view' | 'messages' | null;
  /** Host rows: the address, scheme and host only (never a credential). */
  address?: string;
}

export function shortId(id: string): string {
  return id.replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase();
}

export interface RemoteSources {
  devices: WebDeviceSummary[] | null;
  info: WebTerminalInfo | null;
  hosts: RemoteHostPublic[] | null;
  hostStatus: Record<string, RemoteHostStatus>;
  peers: LanLinkPeerSummary[] | null;
  /** Names of the remote workspaces this app has open, per host id. */
  openByHost: Record<string, string[]>;
}

export function buildRemoteEntries(src: RemoteSources): RemoteEntry[] {
  const serverInput = src.info?.allowInput === true;
  const devices: RemoteEntry[] = (src.devices ?? [])
    .filter((d) => !d.revokedAt)
    .map((d) => ({
      key: `device:${d.deviceId}`,
      id: d.deviceId,
      kind: d.kind === 'phone' ? 'phone' : d.kind === 'computer' ? 'computer' : 'device',
      name: d.name,
      shortId: shortId(d.deviceId),
      live: d.activeNow === true,
      status: d.activeNow ? 'online' : 'offline',
      lastSeenAt: d.lastSeenAt > 0 ? d.lastSeenAt : null,
      // The daemon tracks which pane each stream shows but does not report it.
      viewing: null,
      access: !d.allowInput ? 'view' : serverInput ? 'input' : 'input-when-on',
    }));
  const hosts: RemoteEntry[] = (src.hosts ?? []).map((h) => {
    const status = src.hostStatus[h.id];
    let address = h.origin;
    try { address = new URL(h.origin).host; } catch { /* keep the stored origin */ }
    return {
      key: `host:${h.id}`,
      id: h.id,
      kind: 'host',
      name: h.label,
      shortId: shortId(h.id),
      live: status === 'connected',
      status: status ?? 'unknown',
      lastSeenAt: null,
      viewing: src.openByHost[h.id] ?? [],
      access: h.allowInput === undefined ? null : h.allowInput ? 'input' : 'view',
      address,
    };
  });
  const peers: RemoteEntry[] = (src.peers ?? []).map((p) => ({
    key: `peer:${p.peerUuid}`,
    id: p.peerUuid,
    kind: 'peer',
    name: p.peerName,
    shortId: shortId(p.peerUuid),
    live: false,
    status: p.burned ? 'blocked' : 'unknown',
    lastSeenAt: p.lastSeenAt > 0 ? p.lastSeenAt : null,
    viewing: null,
    // LanLink carries messages only; it cannot reach a pane.
    access: 'messages',
  }));
  const byRecent = (a: RemoteEntry, b: RemoteEntry) =>
    Number(b.live) - Number(a.live) || (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0);
  return [...devices.sort(byRecent), ...hosts.sort(byRecent), ...peers.sort(byRecent)];
}

export type ServerReach = 'off' | 'local' | 'lan' | 'tailscale' | 'unknown';

export function serverReach(info: WebTerminalInfo | null): ServerReach {
  if (!info) return 'unknown';
  // A daemon that did not answer reports `{ running: false, error }`.
  if (!info.running) return info.error ? 'unknown' : 'off';
  if (info.tailscale) return 'tailscale';
  return webIsExposed(info) ? 'lan' : 'local';
}
