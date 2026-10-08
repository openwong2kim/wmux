import { describe, expect, it } from 'vitest';
import { buildRemoteEntries, paneNamesByPty, serverReach, shortId, type RemoteSources } from '../remoteEntries';

const base: RemoteSources = { devices: null, info: null, hosts: null, hostStatus: {}, peers: null, openByHost: {} };

describe('Remote page entries', () => {
  it('lists devices, hosts and peers with only what is known, live ones first', () => {
    const entries = buildRemoteEntries({
      ...base,
      info: { running: true, allowInput: false },
      devices: [
        { deviceId: 'dev-aaaaaaaa-1111', name: 'Old tablet', createdAt: 1, lastSeenAt: 100, allowInput: false },
        { deviceId: 'dev-bbbbbbbb-2222', name: 'Phone', createdAt: 1, lastSeenAt: 200, allowInput: true, kind: 'phone', activeNow: true },
        { deviceId: 'dev-cccccccc-3333', name: 'Gone', createdAt: 1, lastSeenAt: 300, allowInput: true, revokedAt: 400 },
      ],
      hosts: [{ id: 'host-1', label: 'office', origin: 'https://office.example:9600', addedAt: 1, allowInput: true }],
      hostStatus: { 'host-1': 'connected' },
      peers: [{ peerUuid: 'peer-1', peerName: 'lab', pairedAt: 1, lastSeenAt: 0, burned: false }],
      openByHost: { 'host-1': ['api'] },
    });
    expect(entries.map((e) => e.name)).toEqual(['Phone', 'Old tablet', 'office', 'lab']);
    const [phone, tablet, host, peer] = entries;
    expect(phone).toMatchObject({ kind: 'phone', live: true, status: 'online', access: 'input-when-on', viewing: null });
    expect(tablet).toMatchObject({ kind: 'device', live: false, status: 'offline', access: 'view' });
    expect(host).toMatchObject({ kind: 'host', live: true, address: 'office.example:9600', viewing: ['api'], access: 'input', lastSeenAt: null });
    expect(peer).toMatchObject({ kind: 'peer', live: false, status: 'unknown', lastSeenAt: null, access: 'messages' });
  });

  it('names what each phone is viewing from this PC\'s panes, dropping ids it cannot name', () => {
    const ws = {
      id: 'w1', name: 'api', wsOrdinal: 1, activePaneId: 'p1',
      rootPane: {
        id: 'p1', type: 'leaf', ordinal: 1, metadata: { label: 'claude' }, activeSurfaceId: 's1',
        surfaces: [{ id: 's1', ptyId: 'pty-1' }, { id: 's2', ptyId: 'pty-2' }],
      },
    };
    const names = paneNamesByPty([ws as never]);
    expect(names).toEqual({ 'pty-1': 'api / claude', 'pty-2': 'api / claude' });
    const [watching, idle, old] = buildRemoteEntries({
      ...base,
      paneNameByPty: names,
      devices: [
        { deviceId: 'd-1', name: 'Phone', createdAt: 1, lastSeenAt: 3, allowInput: true, activeNow: true, viewingSessions: ['pty-1', 'pty-2', 'gone'] },
        { deviceId: 'd-2', name: 'Idle', createdAt: 1, lastSeenAt: 2, allowInput: true, activeNow: true, viewingSessions: [] },
        { deviceId: 'd-3', name: 'Old', createdAt: 1, lastSeenAt: 1, allowInput: true },
      ],
    });
    expect(watching.viewing).toEqual(['api / claude']);
    expect(idle.viewing).toEqual([]);
    expect(old.viewing).toBeNull();
  });

  it('never carries a full id into what it shows', () => {
    expect(shortId('3f2a9c1e-77b0-4d2e-9a10-5b6c7d8e9f00')).toBe('3f2a9c');
    const [entry] = buildRemoteEntries({
      ...base,
      devices: [{ deviceId: '3f2a9c1e-77b0-4d2e', name: '', createdAt: 1, lastSeenAt: 0, allowInput: false }],
    });
    expect(entry.shortId).toBe('3f2a9c');
    expect(entry.lastSeenAt).toBeNull();
  });

  it('a reachable host is online but not live; an unanswered status is unknown', () => {
    const entries = buildRemoteEntries({
      ...base,
      hosts: [
        { id: 'a', label: 'a', origin: 'https://a', addedAt: 1 },
        { id: 'b', label: 'b', origin: 'https://b', addedAt: 1 },
      ],
      hostStatus: { a: 'reachable' },
    });
    expect(entries.map((e) => [e.status, e.live, e.access])).toEqual([['reachable', false, null], ['unknown', false, null]]);
  });

  it('says how the web server is reachable', () => {
    expect(serverReach(null)).toBe('unknown');
    expect(serverReach({ running: false })).toBe('off');
    expect(serverReach({ running: false, error: 'daemon unreachable' })).toBe('unknown');
    expect(serverReach({ running: true, host: '127.0.0.1' })).toBe('local');
    expect(serverReach({ running: true, host: '0.0.0.0' })).toBe('lan');
    expect(serverReach({ running: true, host: '127.0.0.1', tailscale: true })).toBe('tailscale');
  });
});
