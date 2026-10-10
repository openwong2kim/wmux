// PC rail: one paired computer's rows as a store the local row components
// read. Its keys are built only from what the host sends; the rest of the
// state reads through, and nothing local is offered.
import { describe, expect, it } from 'vitest';
import { useStore, type StoreState } from '../index';
import { buildHostRowOverrides, overlayHostRows } from '../hostRowStore';
import { selectWorkspaceAgentStatus } from '../selectors/fleet';
import { selectWorkspaceAgentRoster } from '../selectors/workspaceAgentRoster';
import { remoteAgentKey } from '../../../shared/remoteHosts';
import type { PcRailWorkspaceRow } from '../../../shared/pcRail';

const rows: PcRailWorkspaceRow[] = [
  { id: 'rw-b', name: 'web', order: 1, panes: [{ sessionId: 's2' }] },
  {
    id: 'rw-a', name: 'api', order: 0, pinned: true, gitBranch: 'main', gitSync: { ahead: 2, behind: 0, hasUpstream: true },
    panes: [{ sessionId: 's1', agentName: 'Claude Code', agentStatus: 'awaiting_input', paneName: 'w1-1', surfaceTitle: 'fix login', lastActivityAt: 1_000 }],
  },
  { id: 'rw-e', name: '', order: 2, panes: [], empty: true },
];

function state(failedTicks = 0): StoreState {
  return {
    ...useStore.getState(),
    pcRailHosts: [{ id: 'h1', label: 'office-mac' }],
    pcRailFeeds: { h1: { workspaces: rows, fetchedAt: 1, failedTicks } },
  } as StoreState;
}

describe('buildHostRowOverrides', () => {
  it("builds the host's rows in its order, read-only, with its pane names, titles, stamps and git line", () => {
    const o = buildHostRowOverrides(state(), 'h1');
    expect(o.workspaces.map((w) => w.id)).toEqual(['shadow:h1:rw-a', 'shadow:h1:rw-b', 'shadow:h1:rw-e']);
    expect(o.readOnly).toBe(true);
    expect(o.sidebarPinnedIds).toEqual(['shadow:h1:rw-a']);
    expect(o.workspaces[0].metadata).toEqual({ gitBranch: 'main', gitSync: { dirty: 0, ahead: 2, behind: 0, hasUpstream: true } });
    expect(o.surfaceActivityAt).toEqual({ [remoteAgentKey('h1', 's1')]: 1_000 });
    expect(Object.values(o.paneLabel)).toEqual(['w1-1']);
    expect(o.notifications).toEqual([]);
  });

  it("lets the local selectors read the host's agents: status roll-up and pane rows", () => {
    const real = state();
    const s = { ...real, ...buildHostRowOverrides(real, 'h1') } as StoreState;
    expect(selectWorkspaceAgentStatus(s, 'shadow:h1:rw-a')).toBe('awaiting_input');
    const roster = selectWorkspaceAgentRoster(s, 'shadow:h1:rw-a');
    expect(roster.rows).toHaveLength(1);
    expect(roster.rows[0]).toMatchObject({ agentName: 'Claude Code', paneName: 'w1-1', surfaceTitle: 'fix login', status: 'awaiting_input' });
  });

  it('draws no host status from a stale list', () => {
    const real = state(99);
    const s = { ...real, ...buildHostRowOverrides(real, 'h1') } as StoreState;
    expect(selectWorkspaceAgentStatus(s, 'shadow:h1:rw-a')).toBe('idle');
  });
});

describe('overlayHostRows', () => {
  it('reads the replaced keys over a frozen app state, and everything else through it', () => {
    const real = Object.freeze(state());
    const view = overlayHostRows(real, buildHostRowOverrides(real, 'h1'));
    expect(view.workspaces.map((w) => w.id)[0]).toBe('shadow:h1:rw-a');
    expect(view.readOnly).toBe(true);
    expect(view.pcRailHosts).toBe(real.pcRailHosts);
    expect('workspaces' in view && 'theme' in view).toBe(true);
  });
});
