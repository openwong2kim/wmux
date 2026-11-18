import { describe, it, expect } from 'vitest';
import { groupFleetByDevice, groupFleetPanes, selectDownHostAway, selectFleetPanes, type FleetDeviceHost, type FleetPane, type FleetRow } from '../fleet';
import type { AttachedRemoteWorkspace } from '../../slices/remoteWorkspacesSlice';
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
  ({ id, label, offline: false, needsRepair: false, insecure: false, online: true, lastSeenAt: null, ...over });

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
      { hostId: 'host-off', hostLabel: 'office', stale: true, panes: [{ sessionId: 'a', agentName: 'Claude Code', agentStatus: 'awaiting_input' as const }] },
      { hostId: 'host-off', hostLabel: 'office', stale: true, panes: [{ sessionId: 'b', agentName: 'Codex' }, { sessionId: 'c' }] },
      { hostId: 'host-up', hostLabel: 'laptop', stale: false, panes: [] },
    ];
    const byDevice = groupFleetByDevice(groups, {
      remoteWorkspaces, hosts: [host('host-off', 'office', { offline: true, lastSeenAt: 1_000 })], includeDisconnected: true,
    });
    expect(byDevice.devices.map((d) => d.id)).toEqual([LOCAL_PC_ID, 'host-off']);
    expect(byDevice.devices[1]).toMatchObject({
      label: 'office', state: 'disconnected', lastSeenAt: 1_000, running: [], finished: [], idle: [],
      // Every pane in the last snapshot, plain shell included; one agent asked.
      lastSeen: { panes: 3, neededYou: 1 },
    });
    // Not in the rail (or not polled yet): still a head, no age.
    expect(groupFleetByDevice(groups, { remoteWorkspaces, includeDisconnected: true }).devices[1].lastSeenAt).toBeNull();
    // A search or a filter narrows the list: no row-less heads then.
    expect(groupFleetByDevice(groups, { remoteWorkspaces }).devices.map((d) => d.id)).toEqual([LOCAL_PC_ID]);
  });

  it('a host the rail does not know, whose attachments are stale because it answered, is not drawn as disconnected', () => {
    const groups = groupFleetPanes([pane('l')]);
    const stale = (staleReason?: 'unanswered' | 'gone' | 'refused') => [
      { hostId: 'host-u', hostLabel: 'u', stale: true, ...(staleReason ? { staleReason } : {}), panes: [{ sessionId: 'a', agentName: 'Codex' }] },
    ];
    const devices = (remoteWorkspaces: ReturnType<typeof stale>) =>
      groupFleetByDevice(groups, { remoteWorkspaces, includeDisconnected: true }).devices.map((d) => [d.id, d.state]);
    // Gone from it, or it refused this computer: the PC answered.
    expect(devices(stale('gone'))).toEqual([[LOCAL_PC_ID, 'local']]);
    expect(devices(stale('refused'))).toEqual([[LOCAL_PC_ID, 'local']]);
    // It did not answer (or has not yet this run): disconnected.
    expect(devices(stale('unanswered'))).toEqual([[LOCAL_PC_ID, 'local'], ['host-u', 'disconnected']]);
    expect(devices(stale())).toEqual([[LOCAL_PC_ID, 'local'], ['host-u', 'disconnected']]);
    // The rail calling it down wins over the reason.
    expect(groupFleetByDevice(groups, {
      remoteWorkspaces: stale('gone'), hosts: [host('host-u', 'u', { offline: true })], includeDisconnected: true,
    }).devices.map((d) => [d.id, d.state])).toEqual([[LOCAL_PC_ID, 'local'], ['host-u', 'disconnected']]);
  });

  it('a host with live rows is connected even when one of its attachments is stale', () => {
    const groups = groupFleetPanes([remote('r', 'host-x', 'x', { agentStatus: 'running' })]);
    const byDevice = groupFleetByDevice(groups, {
      remoteWorkspaces: [{ hostId: 'host-x', hostLabel: 'x', stale: true, panes: [] }], hosts: [host('host-x', 'x')], includeDisconnected: true,
    });
    expect(byDevice.devices).toHaveLength(1);
    expect(byDevice.devices[0]).toMatchObject({ id: 'host-x', state: 'connected' });
  });

  it('a host with rows takes its head state from the rail, and claims nothing the rail has not said', () => {
    const groups = groupFleetPanes([remote('r', 'host-x', 'x', { agentStatus: 'running' })]);
    const stateWith = (hosts?: FleetDeviceHost[]) => groupFleetByDevice(groups, { hosts }).devices[0];
    expect(stateWith([host('host-x', 'x')])).toMatchObject({ state: 'connected' });
    // Not on the rail, or on it but not online (not answered yet, one missed poll): no claim.
    expect(stateWith()).toMatchObject({ id: 'host-x', state: 'unknown' });
    expect(stateWith([host('host-x', 'x', { online: false })])).toMatchObject({ state: 'unknown' });
    expect(stateWith([host('host-x', 'x', { online: false, insecure: true })])).toMatchObject({ state: 'insecure' });
    expect(stateWith([host('host-x', 'x', { online: false, needsRepair: true, lastSeenAt: 7 })]))
      .toMatchObject({ state: 'needs-repair', lastSeenAt: 7 });
    expect(stateWith([host('host-x', 'x', { online: false, offline: true, lastSeenAt: 7 })]))
      .toMatchObject({ state: 'disconnected', lastSeenAt: 7 });
    // Its rows stay under it whatever the state.
    expect(ids(stateWith().running)).toEqual(['r']);
  });

  it('a stale attachment on a host the rail still reaches is a workspace gone, not a disconnected PC', () => {
    const byDevice = groupFleetByDevice(groupFleetPanes([pane('l')]), {
      remoteWorkspaces: [{ hostId: 'host-x', hostLabel: 'x', stale: true, panes: [] }],
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
      remoteWorkspaces: [{ hostId: 'host-x', hostLabel: 'x-snapshot', stale: false, panes: [] }],
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

  it('a PC that refused this computer (needs pairing) keeps a row-less head while it has panes here', () => {
    const groups = groupFleetPanes([pane('l')]);
    const remoteWorkspaces = [{ hostId: 'host-r', hostLabel: 'r', stale: true, panes: [{ sessionId: 'a', agentName: 'Codex' }] }];
    const hosts = [host('host-r', 'office', { needsRepair: true, lastSeenAt: 5_000 }), host('host-q', 'quiet', { needsRepair: true })];
    const byDevice = groupFleetByDevice(groups, { remoteWorkspaces, hosts, includeDisconnected: true });
    // host-q has nothing here, so no head.
    expect(byDevice.devices.map((d) => [d.id, d.state])).toEqual([[LOCAL_PC_ID, 'local'], ['host-r', 'needs-repair']]);
    expect(byDevice.devices[1]).toMatchObject({ label: 'office', lastSeenAt: 5_000, running: [], finished: [], idle: [] });
    expect(byDevice.devices[1].lastSeen).toBeUndefined();
    // A search or a filter drops row-less heads.
    expect(groupFleetByDevice(groups, { remoteWorkspaces, hosts }).devices.map((d) => d.id)).toEqual([LOCAL_PC_ID]);
  });

  it('a PC the rail calls down: its head notes every pane it last had, on the toast\'s tick', () => {
    const remoteWs = (id: string, sessionId: string): Workspace => ({
      id, name: id, activePaneId: `p-${id}`,
      rootPane: {
        id: `p-${id}`, type: 'leaf', activeSurfaceId: `s-${id}`,
        surfaces: [{ id: `s-${id}`, ptyId: '', title: 'shell', shell: 'zsh', cwd: '', surfaceType: 'remote-terminal', remoteHostId: 'host-x', remoteSessionId: sessionId }],
      },
    });
    const workspaces = [remoteWs('ws-ask', 'sess-ask'), remoteWs('ws-run', 'sess-run'), remoteWs('ws-shell', 'sess-shell')];
    const remoteWorkspaces: AttachedRemoteWorkspace[] = [{
      key: 'host-x:rw', hostId: 'host-x', hostLabel: 'x', workspaceId: 'rw', name: 'r',
      panes: [
        { sessionId: 'sess-ask', agentName: 'Codex', agentStatus: 'awaiting_input' },
        { sessionId: 'sess-run', agentName: 'Codex', agentStatus: 'running' },
        { sessionId: 'sess-shell' },
      ],
      stale: true, staleReason: 'unanswered', staleSince: 5,
    }];
    const at = (failedTicks: number) => ({
      workspaces, remoteWorkspaces, surfaceAgentStatus: {}, surfaceActivity: {},
      pcRailHostStatus: { 'host-x': 'unreachable' as const },
      pcRailFeeds: { 'host-x': { workspaces: [], fetchedAt: 1, failedTicks } },
    });
    // One miss: not down, the rows are still on the board, no note.
    expect(selectFleetPanes(at(1))).toHaveLength(3);
    expect(selectDownHostAway(at(1))).toEqual({});
    // The second miss, the drop notice's tick: no rows, and the note counts its agents.
    expect(selectFleetPanes(at(2))).toEqual([]);
    const away = selectDownHostAway(at(2));
    // Every pane it had, plain shell included; only the asking agent needed you.
    expect(away).toEqual({ 'host-x': { panes: 3, neededYou: 1 } });
    const byDevice = groupFleetByDevice(groupFleetPanes([pane('l', { agentStatus: 'running' })]), {
      remoteWorkspaces, hosts: [host('host-x', 'x', { offline: true, lastSeenAt: 1 })], away, includeDisconnected: true,
    });
    expect(byDevice.devices.map((d) => [d.id, d.state, d.running.length + d.idle.length])).toEqual([
      [LOCAL_PC_ID, 'local', 1], ['host-x', 'disconnected', 0],
    ]);
    expect(byDevice.devices[1]).toMatchObject({ lastSeenAt: 1, lastSeen: { panes: 3, neededYou: 1 } });
    // It answers: no note.
    expect(selectDownHostAway({ ...at(0), pcRailHostStatus: { 'host-x': 'reachable' as const } })).toEqual({});
  });

  it('a down PC\'s note does not count a Needs you the rail has since outdated', () => {
    const ws: Workspace = {
      id: 'ws-r', name: 'r', activePaneId: 'p-r',
      rootPane: {
        id: 'p-r', type: 'leaf', activeSurfaceId: 's-r',
        surfaces: [{ id: 's-r', ptyId: '', title: 'shell', shell: 'zsh', cwd: '', surfaceType: 'remote-terminal', remoteHostId: 'host-x', remoteSessionId: 'sess' }],
      },
    };
    const at = (fetchedAt: number) => selectDownHostAway({
      workspaces: [ws],
      remoteWorkspaces: [{
        key: 'host-x:rw', hostId: 'host-x', hostLabel: 'x', workspaceId: 'rw', name: 'r',
        panes: [{ sessionId: 'sess', agentName: 'Codex', agentStatus: 'awaiting_input' }],
        stale: true, staleReason: 'unanswered', staleSince: 5,
      }],
      pcRailHostStatus: { 'host-x': 'unreachable' },
      pcRailFeeds: { 'host-x': { workspaces: [], fetchedAt, failedTicks: 2 } },
    });
    // The snapshot is the PC's last word: it asked.
    expect(at(1)).toEqual({ 'host-x': { panes: 1, neededYou: 1 } });
    // The rail heard from the PC after the snapshot went stale: the ask is outdated, as on the board.
    expect(at(10)).toEqual({ 'host-x': { panes: 1, neededYou: 0 } });
  });

  it('a PC the rail calls down keeps its head before its attachments are marked stale', () => {
    const byDevice = groupFleetByDevice(groupFleetPanes([pane('l')]), {
      remoteWorkspaces: [{ hostId: 'host-x', hostLabel: 'x', stale: false, panes: [
        { sessionId: 'a', agentName: 'Codex', agentStatus: 'awaiting_input' }, { sessionId: 'b' },
      ] }],
      hosts: [host('host-x', 'office', { offline: true, online: false, lastSeenAt: 3 })],
      includeDisconnected: true,
    });
    expect(byDevice.devices.map((d) => [d.id, d.state])).toEqual([[LOCAL_PC_ID, 'local'], ['host-x', 'disconnected']]);
    expect(byDevice.devices[1]).toMatchObject({ label: 'office', lastSeenAt: 3, lastSeen: { panes: 2, neededYou: 1 } });
  });

  it('a pane is counted for a down PC only when its row is that PC\'s, never as well as a local row', () => {
    const ws: Workspace = {
      id: 'ws-mixed', name: 'mixed', activePaneId: 'p-mixed',
      rootPane: {
        id: 'p-mixed', type: 'leaf', activeSurfaceId: 's-local',
        surfaces: [
          { id: 's-local', ptyId: 'pty-local', title: 'shell', shell: 'zsh', cwd: '' },
          { id: 's-remote', ptyId: '', title: 'shell', shell: 'zsh', cwd: '', surfaceType: 'remote-terminal', remoteHostId: 'host-x', remoteSessionId: 'sess' },
        ],
      },
    };
    const state = {
      workspaces: [ws], surfaceAgentStatus: {}, surfaceActivity: {}, remoteWorkspaces: [],
      pcRailHostStatus: { 'host-x': 'unreachable' as const },
      pcRailFeeds: { 'host-x': { workspaces: [], fetchedAt: 1, failedTicks: 2 } },
    };
    // The active tab is local: the row stays on the board, so the down PC's note does not count it.
    expect(selectFleetPanes(state).map((row) => row.paneId)).toEqual(['p-mixed']);
    expect(selectDownHostAway(state)).toEqual({});
    // With the remote tab active the row is the down PC's: it leaves the board and is counted there.
    const remoteActive = { ...state, workspaces: [{ ...ws, rootPane: { ...ws.rootPane, activeSurfaceId: 's-remote' } as Workspace['rootPane'] }] };
    expect(selectFleetPanes(remoteActive)).toEqual([]);
    expect(selectDownHostAway(remoteActive)).toEqual({ 'host-x': { panes: 1, neededYou: 0 } });
  });
});
