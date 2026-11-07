import { describe, it, expect } from 'vitest';
import { groupFleetByDevice, groupFleetPanes, selectFleetPanes, type FleetDeviceHost, type FleetPane, type FleetRow } from '../fleet';
import type { Workspace } from '../../../../shared/types';
import { LOCAL_PC_ID } from '../../../../shared/pcRail';

function pane(ptyId: string, overrides: Partial<FleetPane> = {}): FleetPane {
  return {
    workspaceId: `ws-${ptyId}`,
    workspaceName: ptyId,
    paneId: `p-${ptyId}`,
    surfaceId: `s-${ptyId}`,
    ptyId,
    agentStatus: 'idle',
    title: ptyId,
    surfaceType: 'terminal',
    isActivePane: true,
    unverifiable: false,
    ...overrides,
  };
}
const remote = (ptyId: string, hostId: string, hostLabel: string, overrides: Partial<FleetPane> = {}) =>
  pane(ptyId, { surfaceType: 'remote-terminal', remote: { hostId, hostLabel }, ...overrides });
const ids = (rows: FleetRow[]) => rows.map((row) => row.pane.ptyId);
const host = (id: string, label: string, over: Partial<FleetDeviceHost> = {}): FleetDeviceHost =>
  ({ id, label, offline: false, lastSeenAt: null, ...over });

describe('groupFleetByDevice', () => {
  const panes = [
    pane('l-run', { agentStatus: 'running' }),
    remote('b-ask', 'host-b', 'beta', { agentStatus: 'awaiting_input' }),
    remote('b-run', 'host-b', 'beta', { agentStatus: 'running' }),
    remote('a-idle', 'host-a', 'alpha'),
    pane('l-done', { agentStatus: 'complete' }),
    pane('l-ask', { agentStatus: 'awaiting_input' }),
  ];

  it('keeps Needs you whole and puts every other row under its own device', () => {
    const groups = groupFleetPanes(panes);
    const byDevice = groupFleetByDevice(groups, { hosts: [host('host-b', 'beta'), host('host-a', 'alpha')] });
    expect(ids(byDevice.needsYou).sort()).toEqual(['b-ask', 'l-ask']);
    const [local, b, a] = byDevice.devices;
    expect(local).toMatchObject({ id: LOCAL_PC_ID, state: 'local' });
    expect([ids(local.running), ids(local.finished), ids(local.idle)]).toEqual([['l-run'], ['l-done'], []]);
    expect(b).toMatchObject({ id: 'host-b', label: 'beta', state: 'connected' });
    expect(ids(b.running)).toEqual(['b-run']);
    expect(a).toMatchObject({ id: 'host-a', label: 'alpha' });
    expect(ids(a.idle)).toEqual(['a-idle']);
  });

  it('counts every row once: Needs you rows sit under no device', () => {
    const groups = groupFleetPanes(panes);
    const byDevice = groupFleetByDevice(groups);
    const underDevices = byDevice.devices.flatMap((d) => [...d.running, ...d.finished, ...d.idle]);
    expect(underDevices.length + byDevice.needsYou.length).toBe(panes.length);
    expect(byDevice.needsYou).toBe(groups.needsYou);
    expect(underDevices.some((row) => row.section === 'needsYou')).toBe(false);
  });

  it('this computer first, then the rail order, then unknown hosts by label, whatever the activity', () => {
    const order = (list: FleetPane[]) => groupFleetByDevice(groupFleetPanes(list), { hosts: [host('host-c', 'charlie')] })
      .devices.map((d) => d.id);
    const list = [
      remote('z', 'host-z', 'zulu', { agentStatus: 'running' }),
      remote('c', 'host-c', 'charlie'),
      remote('m', 'host-m', 'mike'),
      pane('l'),
    ];
    expect(order(list)).toEqual([LOCAL_PC_ID, 'host-c', 'host-m', 'host-z']);
    // Another status or input order does not move a device.
    expect(order([...list].reverse().map((p) => ({ ...p, agentStatus: 'running' as const })))).toEqual(
      [LOCAL_PC_ID, 'host-c', 'host-m', 'host-z'],
    );
  });

  it('a host the rail cannot reach, with every attachment stale, keeps a row-less disconnected head with when it was last seen', () => {
    const groups = groupFleetPanes([pane('l')]);
    const remoteWorkspaces = [
      { hostId: 'host-off', hostLabel: 'office', stale: true },
      { hostId: 'host-off', hostLabel: 'office', stale: true },
      { hostId: 'host-up', hostLabel: 'laptop', stale: false },
    ];
    const byDevice = groupFleetByDevice(groups, {
      remoteWorkspaces, hosts: [host('host-off', 'office', { offline: true, lastSeenAt: 1_000 })], includeDisconnected: true,
    });
    expect(byDevice.devices.map((d) => d.id)).toEqual([LOCAL_PC_ID, 'host-off']);
    expect(byDevice.devices[1]).toMatchObject({
      label: 'office', state: 'disconnected', lastSeenAt: 1_000, running: [], finished: [], idle: [],
    });
    // Not in the rail (or not polled yet): still a head, no age.
    expect(groupFleetByDevice(groups, { remoteWorkspaces, includeDisconnected: true }).devices[1].lastSeenAt).toBeNull();
    // A search or a filter narrows the list: no row-less heads then.
    expect(groupFleetByDevice(groups, { remoteWorkspaces }).devices.map((d) => d.id)).toEqual([LOCAL_PC_ID]);
  });

  it('a host with live rows is connected even when one of its attachments is stale', () => {
    const groups = groupFleetPanes([remote('r', 'host-x', 'x', { agentStatus: 'running' })]);
    const byDevice = groupFleetByDevice(groups, {
      remoteWorkspaces: [{ hostId: 'host-x', hostLabel: 'x', stale: true }], includeDisconnected: true,
    });
    expect(byDevice.devices).toHaveLength(1);
    expect(byDevice.devices[0]).toMatchObject({ id: 'host-x', state: 'connected' });
  });

  it('a stale attachment on a host the rail still reaches is a workspace gone, not a disconnected PC', () => {
    const byDevice = groupFleetByDevice(groupFleetPanes([pane('l')]), {
      remoteWorkspaces: [{ hostId: 'host-x', hostLabel: 'x', stale: true }],
      hosts: [host('host-x', 'x', { lastSeenAt: 5_000 })],
      includeDisconnected: true,
    });
    expect(byDevice.devices.map((d) => d.id)).toEqual([LOCAL_PC_ID]);
  });

  it('names a host the rail knows by the rail\'s name, not the attachment\'s snapshot', () => {
    const byDevice = groupFleetByDevice(groupFleetPanes([remote('r', 'host-x', 'DESKTOP-1234', { agentStatus: 'running' })]), {
      hosts: [host('host-x', 'office')],
    });
    expect(byDevice.devices[0]).toMatchObject({ id: 'host-x', label: 'office' });
  });

  it('a remote pane with no agent resolved still sits under its host, not this computer', () => {
    const shell = pane('', { surfaceType: 'remote-terminal', remoteHostId: 'host-x', paneId: 'p-shell' });
    const byDevice = groupFleetByDevice(groupFleetPanes([pane('l'), shell]), {
      remoteWorkspaces: [{ hostId: 'host-x', hostLabel: 'x-snapshot', stale: false }],
    });
    expect(byDevice.devices.map((d) => [d.id, d.label, d.idle.map((row) => row.pane.paneId)])).toEqual([
      [LOCAL_PC_ID, '', ['p-l']],
      ['host-x', 'x-snapshot', ['p-shell']],
    ]);
  });

  it('selectFleetPanes names the host of a remote-terminal row even when no agent resolved', () => {
    const ws: Workspace = {
      id: 'ws-r', name: 'r', activePaneId: 'p-r',
      rootPane: {
        id: 'p-r', type: 'leaf', activeSurfaceId: 's-r',
        surfaces: [{ id: 's-r', ptyId: '', title: 'shell', shell: 'zsh', cwd: '', surfaceType: 'remote-terminal', remoteHostId: 'host-x', remoteSessionId: 'sess-1' }],
      },
    };
    const [row] = selectFleetPanes({ workspaces: [ws], surfaceAgentStatus: {}, surfaceActivity: {}, remoteWorkspaces: [] });
    expect(row).toMatchObject({ surfaceType: 'remote-terminal', remoteHostId: 'host-x' });
    expect(row.remote).toBeUndefined();
  });

  it('a host the rail cannot reach reads disconnected even while its last rows still resolve', () => {
    const byDevice = groupFleetByDevice(groupFleetPanes([remote('r', 'host-x', 'x')]), {
      hosts: [host('host-x', 'x', { offline: true, lastSeenAt: 2_000 })],
    });
    expect(byDevice.devices[0]).toMatchObject({ id: 'host-x', state: 'disconnected', lastSeenAt: 2_000 });
    expect(ids(byDevice.devices[0].idle)).toEqual(['r']);
  });
});
