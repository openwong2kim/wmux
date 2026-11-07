import { describe, it, expect } from 'vitest';
import { FLEET_LOCAL_DEVICE, groupFleetByDevice, groupFleetPanes, type FleetPane, type FleetRow } from '../fleet';

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
    const byDevice = groupFleetByDevice(groups, { hostOrder: ['host-b', 'host-a'] });
    expect(ids(byDevice.needsYou).sort()).toEqual(['b-ask', 'l-ask']);
    const [local, b, a] = byDevice.devices;
    expect(local).toMatchObject({ id: FLEET_LOCAL_DEVICE, state: 'local' });
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
    const order = (list: FleetPane[]) => groupFleetByDevice(groupFleetPanes(list), { hostOrder: ['host-c'] })
      .devices.map((d) => d.id);
    const list = [
      remote('z', 'host-z', 'zulu', { agentStatus: 'running' }),
      remote('c', 'host-c', 'charlie'),
      remote('m', 'host-m', 'mike'),
      pane('l'),
    ];
    expect(order(list)).toEqual([FLEET_LOCAL_DEVICE, 'host-c', 'host-m', 'host-z']);
    // Another status or input order does not move a device.
    expect(order([...list].reverse().map((p) => ({ ...p, agentStatus: 'running' as const })))).toEqual(
      [FLEET_LOCAL_DEVICE, 'host-c', 'host-m', 'host-z'],
    );
  });

  it('a host whose attachments are all stale keeps a row-less disconnected head with when it was last seen', () => {
    const groups = groupFleetPanes([pane('l')]);
    const remoteWorkspaces = [
      { hostId: 'host-off', hostLabel: 'office', stale: true },
      { hostId: 'host-off', hostLabel: 'office', stale: true },
      { hostId: 'host-up', hostLabel: 'laptop', stale: false },
    ];
    const byDevice = groupFleetByDevice(groups, {
      remoteWorkspaces, lastSeenAt: { 'host-off': 1_000 }, includeDisconnected: true,
    });
    expect(byDevice.devices.map((d) => d.id)).toEqual([FLEET_LOCAL_DEVICE, 'host-off']);
    expect(byDevice.devices[1]).toMatchObject({
      label: 'office', state: 'disconnected', lastSeenAt: 1_000, running: [], finished: [], idle: [],
    });
    // Unknown time: still a head, no age.
    expect(groupFleetByDevice(groups, { remoteWorkspaces, includeDisconnected: true }).devices[1].lastSeenAt).toBeNull();
    // A search or a filter narrows the list: no row-less heads then.
    expect(groupFleetByDevice(groups, { remoteWorkspaces }).devices.map((d) => d.id)).toEqual([FLEET_LOCAL_DEVICE]);
  });

  it('a host with live rows is connected even when one of its attachments is stale', () => {
    const groups = groupFleetPanes([remote('r', 'host-x', 'x', { agentStatus: 'running' })]);
    const byDevice = groupFleetByDevice(groups, {
      remoteWorkspaces: [{ hostId: 'host-x', hostLabel: 'x', stale: true }], includeDisconnected: true,
    });
    expect(byDevice.devices).toHaveLength(1);
    expect(byDevice.devices[0]).toMatchObject({ id: 'host-x', state: 'connected' });
  });
});
