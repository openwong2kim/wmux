// A paired PC that stops answering: its rows (agent and plain remote shells)
// leave every reader of remote rows on the same tick the drop notice fires
// (two failed polls in a row), never on one miss, and come back on the first
// good round. A refused credential or a workspace gone from a host that
// answered hides them at once: a row that can't be opened doesn't show.
import { describe, it, expect } from 'vitest';
import { useStore, type StoreState } from '../../index';
import { selectFleetBoard, selectFleetSectionCounts } from '../fleet';
import { selectWorkspaceAgentRoster } from '../workspaceAgentRoster';
import { buildFleetTriage } from '../../../utils/fleetTriage';
import { connectionsInUse } from '../../../hooks/useConnectionDropNotice';
import { selectDownHostIds } from '../pcRail';
import type { Workspace, Surface, Pane } from '../../../../shared/types';
import type { AttachedRemoteWorkspace } from '../../slices/remoteWorkspacesSlice';
import type { RemoteHostStatus } from '../../../../shared/remoteHosts';

const HOST = 'host-1';
function remoteSurface(id: string, sessionId: string): Surface {
  return { id, ptyId: '', title: id, shell: 'zsh', cwd: '', surfaceType: 'remote-terminal', remoteHostId: HOST, remoteSessionId: sessionId };
}
function leaf(id: string, s: Surface): Pane { return { id, type: 'leaf', surfaces: [s], activeSurfaceId: s.id }; }
const ws: Workspace = {
  id: 'ws-1', name: 'w1', activePaneId: 'p-agent',
  rootPane: { id: 'b', type: 'branch', direction: 'horizontal', children: [leaf('p-agent', remoteSurface('s-agent', 'sess-agent')), leaf('p-shell', remoteSurface('s-shell', 'sess-shell'))] },
};
function attachment(over: Partial<AttachedRemoteWorkspace> = {}): AttachedRemoteWorkspace {
  return {
    key: `${HOST}:rw`, hostId: HOST, hostLabel: 'office', workspaceId: 'rw', name: 'remote',
    panes: [{ sessionId: 'sess-agent', agentName: 'Codex', agentStatus: 'awaiting_input' }, { sessionId: 'sess-shell' }],
    ...over,
  };
}
/** One rail tick's state for the host: its status and failed polls, and the attachment as the poll left it. */
function at(rail: { status?: RemoteHostStatus; failed?: number }, att: Partial<AttachedRemoteWorkspace> = {}): StoreState {
  return {
    ...useStore.getInitialState(),
    workspaces: [ws],
    remoteWorkspaces: [attachment(att)],
    pcRailHosts: [{ id: HOST, label: 'office' }],
    pcRailHostStatus: rail.status ? { [HOST]: rail.status } : {},
    pcRailFeeds: rail.status ? { [HOST]: { workspaces: [], fetchedAt: 1, failedTicks: rail.failed ?? 0 } } : {},
  } as StoreState;
}
const paneIds = (s: StoreState) => {
  const g = selectFleetBoard(s, { now: 10, sortMode: 'attention' }).groups;
  return [...g.needsYou, ...g.finished, ...g.running, ...g.idle].map((r) => r.pane.paneId).sort();
};
const triagePanes = (s: StoreState) => {
  const r = buildFleetTriage(s, { includeIdle: true }, 10);
  return [...r.needsYou, ...(r.finished ?? []), ...r.running, ...(r.idle.rows ?? [])].map((row) => row.paneId).sort();
};

describe('remote rows follow the rail\'s down rule', () => {
  it('no status yet (no first round): the rows are shown', () => {
    const s = at({});
    expect(paneIds(s)).toEqual(['p-agent', 'p-shell']);
    expect(selectFleetSectionCounts(s).needsYou).toBe(1);
  });

  it('one missed round keeps the rows (with their last status); the second drops agent and shell rows everywhere', () => {
    const oneMiss = at({ status: 'unreachable', failed: 1 }, { stale: true, staleReason: 'unanswered' });
    expect(paneIds(oneMiss)).toEqual(['p-agent', 'p-shell']);
    expect(selectFleetSectionCounts(oneMiss).needsYou).toBe(1);
    expect(triagePanes(oneMiss)).toEqual(['p-agent', 'p-shell']);

    const twoMisses = at({ status: 'unreachable', failed: 2 }, { stale: true, staleReason: 'unanswered' });
    expect(paneIds(twoMisses)).toEqual([]);
    expect(selectFleetSectionCounts(twoMisses).needsYou).toBe(0);
    expect(triagePanes(twoMisses)).toEqual([]);

    // A good round: reachable, the attachment refreshed.
    const back = at({ status: 'reachable', failed: 0 }, { stale: false });
    expect(paneIds(back)).toEqual(['p-agent', 'p-shell']);
    expect(selectFleetSectionCounts(back).needsYou).toBe(1);
  });

  it('a refused credential or a workspace gone from a host that answered hides the agent at once', () => {
    for (const reason of ['refused', 'gone'] as const) {
      const s = at({ status: reason === 'refused' ? 'needs-repair' : 'reachable', failed: reason === 'refused' ? 1 : 0 },
        { stale: true, staleReason: reason, ...(reason === 'refused' ? { authRejected: true } : {}) });
      expect(selectFleetSectionCounts(s).needsYou, reason).toBe(0);
      expect(selectFleetBoard(s, { now: 10, sortMode: 'attention' }).groups.needsYou, reason).toEqual([]);
    }
  });

  // A row that can't be opened doesn't show, agent or anonymous.
  it('a refused credential drops that host\'s plain remote shells on the same tick as its agents', () => {
    const s = at({ status: 'needs-repair', failed: 1 }, { stale: true, staleReason: 'refused', authRejected: true });
    expect(paneIds(s)).toEqual([]);
    expect(triagePanes(s)).toEqual([]);
  });

  it('a workspace gone from a host that answered drops its plain remote shells on the same tick as its agents', () => {
    const s = at({ status: 'reachable', failed: 0 }, { stale: true, staleReason: 'gone' });
    expect(paneIds(s)).toEqual([]);
    expect(triagePanes(s)).toEqual([]);
  });

  it('the drop notice and the row gate agree at every tick', () => {
    // fail, fail, fail, answer, fail, answer
    const ticks: Array<[RemoteHostStatus, number, Partial<AttachedRemoteWorkspace>]> = [
      ['reachable', 0, { stale: false }],
      ['unreachable', 1, { stale: true, staleReason: 'unanswered' }],
      ['unreachable', 2, { stale: true, staleReason: 'unanswered' }],
      ['unreachable', 3, { stale: true, staleReason: 'unanswered' }],
      ['reachable', 0, { stale: false }],
      ['unreachable', 1, { stale: true, staleReason: 'unanswered' }],
      ['reachable', 0, { stale: false }],
    ];
    for (const [i, [status, failed, att]] of ticks.entries()) {
      const s = at({ status, failed }, att);
      const noticeDown = connectionsInUse(s).find((c) => c.shareHostId === HOST)?.up === false;
      const gateDown = selectDownHostIds(s).has(HOST);
      const rowsGone = paneIds(s).length === 0;
      expect([noticeDown, gateDown, rowsGone], `tick ${i}`).toEqual([gateDown, gateDown, gateDown]);
    }
  });

  it('the sidebar roster drops the agent on the same tick', () => {
    const roster = (s: StoreState) => selectWorkspaceAgentRoster(s, 'ws-1').rows.length;
    expect(roster(at({ status: 'unreachable', failed: 1 }, { stale: true, staleReason: 'unanswered' }))).toBe(1);
    expect(roster(at({ status: 'unreachable', failed: 2 }, { stale: true, staleReason: 'unanswered' }))).toBe(0);
    expect(roster(at({ status: 'reachable', failed: 0 }, { stale: false }))).toBe(1);
  });
});
