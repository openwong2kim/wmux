import { describe, it, expect } from 'vitest';
import {
  countNeedsAttention,
  groupFleetPanes,
  selectAllWorkspaceAgentStatus,
  selectFleetPanes,
  selectWorkspaceAgentStatus,
} from '../fleet';
import type { FleetSelectorState } from '../fleet';
import type { Workspace, Pane, PaneLeaf, Surface, AgentStatus } from '../../../../shared/types';

// ─── #1509 — "needs you" follows the pane that raised it, not focus ──────────
//
// A pane's `surfaceAgentStatus` entry is the UNREAD cue: Pane.tsx deletes it
// while the pane is focused. The workspace-metadata `agentStatus` is ONE slot
// per workspace and is only read for the active pane. A permission dialog raised
// in the pane the user is watching was therefore carried by the active-pane slot
// alone, and moving focus to another pane (a split, a click) dropped the chip,
// the red row and the workspace dot while the dialog was still on screen.
//
// The pane's own lifecycle status (`surfaceAgent[pty].status`) is what says a
// human is being waited on. These cases replay the live repro table from the
// issue against every consumer of the roll-up.

function surface(id: string, ptyId: string, extra: Partial<Surface> = {}): Surface {
  return { id, ptyId, title: id, shell: 'pwsh', cwd: `C:\\repo\\${id}`, surfaceType: 'terminal', ...extra };
}
function leaf(id: string, surfaces: Surface[], activeSurfaceId?: string): PaneLeaf {
  return { id, type: 'leaf', surfaces, activeSurfaceId: activeSurfaceId ?? surfaces[0]?.id ?? '' };
}
function branch(id: string, children: Pane[]): Pane {
  return { id, type: 'branch', direction: 'horizontal', children };
}
function workspace(rootPane: Pane, activePaneId: string, metadata?: Workspace['metadata']): Workspace {
  return { id: 'ws-1', name: 'repo', rootPane, activePaneId, metadata };
}

const CLAUDE = 'Claude Code';

// Pane A runs claude and shows a permission dialog. Its unread entry is already
// gone: the user was looking at it when the dialog appeared.
const paneA = leaf('pA', [surface('sA', 'pty-a')]);
const paneB = leaf('pB', [surface('sB', 'pty-b')]);

function state(overrides: Partial<FleetSelectorState> = {}): FleetSelectorState {
  return {
    workspaces: [workspace(paneA, 'pA', { agentName: CLAUDE, agentStatus: 'awaiting_input' })],
    surfaceAgentStatus: {},
    surfaceActivity: {},
    surfaceAgent: { 'pty-a': { name: CLAUDE, status: 'awaiting_input' } },
    surfacePendingQuestion: {},
    ...overrides,
  };
}

function rowFor(s: FleetSelectorState, paneId: string) {
  const row = selectFleetPanes(s).find((p) => p.paneId === paneId);
  if (!row) throw new Error(`no fleet row for ${paneId}`);
  return row;
}

function expectNeedsYou(s: FleetSelectorState): void {
  const panes = selectFleetPanes(s);
  expect(rowFor(s, 'pA').agentStatus).toBe('awaiting_input');
  expect(countNeedsAttention(panes)).toBe(1);
  expect(selectWorkspaceAgentStatus(s, 'ws-1')).toBe('awaiting_input');
  expect(selectAllWorkspaceAgentStatus(s)['ws-1']).toBe('awaiting_input');
  const groups = groupFleetPanes(panes);
  expect(groups.needsYou.map((r) => r.pane.paneId)).toEqual(['pA']);
}

describe('#1509 — attention follows the pane, not focus', () => {
  it('dialog shown in the watched pane: needs you', () => {
    expectNeedsYou(state());
  });

  it('split, new pane focused: the dialog pane still needs you', () => {
    // The repro's 22:40:00 row. B is a plain shell and now owns focus.
    expectNeedsYou(state({
      workspaces: [workspace(branch('b', [paneA, paneB]), 'pB', { agentName: CLAUDE, agentStatus: 'awaiting_input' })],
    }));
  });

  it("a sibling's write to the workspace slot cannot mask it", () => {
    // The earlier run: the new pane's 'running' landed in the one shared slot
    // and the chip stayed gone even after the split closed.
    const split = state({
      workspaces: [workspace(branch('b', [paneA, paneB]), 'pB', { agentName: CLAUDE, agentStatus: 'running' })],
    });
    expectNeedsYou(split);
    expect(rowFor(split, 'pB').agentStatus).not.toBe('awaiting_input');
    // Split closed, A focused again, the slot still holds B's 'running'.
    expectNeedsYou(state({
      workspaces: [workspace(paneA, 'pA', { agentName: CLAUDE, agentStatus: 'running' })],
    }));
  });

  it('clicking back to the dialog pane keeps it', () => {
    expectNeedsYou(state({
      workspaces: [workspace(branch('b', [paneA, paneB]), 'pA', { agentName: CLAUDE, agentStatus: 'running' })],
    }));
  });

  it('a second agent of the same kind does not inherit the dialog from the shared slot', () => {
    // B is also Claude Code, so the slot's name matches it. The slot cannot
    // prove which pane asked: counting it on B too would read "2 need you".
    const s = state({
      workspaces: [workspace(branch('b', [paneA, paneB]), 'pB', { agentName: CLAUDE, agentStatus: 'awaiting_input' })],
      surfaceAgent: {
        'pty-a': { name: CLAUDE, status: 'awaiting_input' },
        'pty-b': { name: CLAUDE, status: 'running' },
      },
    });
    expectNeedsYou(s);
    expect(rowFor(s, 'pB').agentStatus).not.toBe('awaiting_input');
  });

  it('answering the dialog clears it everywhere', () => {
    const s = state({
      workspaces: [workspace(branch('b', [paneA, paneB]), 'pB', { agentName: CLAUDE, agentStatus: 'running' })],
      surfaceAgent: { 'pty-a': { name: CLAUDE, status: 'running' } },
    });
    const panes = selectFleetPanes(s);
    expect(rowFor(s, 'pA').agentStatus).not.toBe('awaiting_input');
    expect(countNeedsAttention(panes)).toBe(0);
    expect(selectWorkspaceAgentStatus(s, 'ws-1')).not.toBe('awaiting_input');
  });

  it('a background TAB awaiting input lights its pane and names that tab', () => {
    const s = state({
      workspaces: [workspace(
        leaf('pA', [surface('s-bg', 'pty-bg'), surface('s-fg', 'pty-fg')], 's-fg'),
        'pA',
      )],
      surfaceAgent: { 'pty-bg': { name: CLAUDE, status: 'awaiting_input' } },
    });
    const row = rowFor(s, 'pA');
    expect(row.agentStatus).toBe('awaiting_input');
    expect(row.attentionPtyId).toBe('pty-bg');
  });

  it('finished turns stay unread-only: a viewed complete/waiting/error is not re-raised', () => {
    // Only the open dialog outlives the focus clear. A finished turn is "you
    // have not looked yet" (DESIGN.md Fleet: finished turns until focused).
    for (const status of ['complete', 'waiting', 'error'] as AgentStatus[]) {
      const s = state({
        workspaces: [workspace(branch('b', [paneA, paneB]), 'pB')],
        surfaceAgent: { 'pty-a': { name: CLAUDE, status } },
      });
      expect(rowFor(s, 'pA').agentStatus).toBe('idle');
    }
  });
});
