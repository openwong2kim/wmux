import { describe, it, expect } from 'vitest';
import { hydrateWebState, type ServerSelection, type WebWorkspacesReply } from '../webHydration';
import { selectAllWorkspaceAgentStatus } from '../../stores/selectors/fleet';
import type { PaneLeaf, Workspace } from '../../../shared/types';

const reply = (activeIndex = 0, activePaneId = 'p1'): WebWorkspacesReply => ({
  activeWorkspaceId: 'w1',
  workspaces: [{
    id: 'w1', name: 'one', order: 0, panes: [{ sessionId: 'pty-1', shell: 'zsh', cwd: '/r', agentName: 'Claude', agentStatus: 'running' }],
    layout: {
      activePaneId, unplaced: [],
      root: { kind: 'split', direction: 'horizontal', sizes: [50, 50], children: [
        { kind: 'leaf', paneId: 'p1', activeIndex, surfaces: [
          { surfaceId: 's1', kind: 'terminal', ptyId: 'pty-1' },
          { surfaceId: 's2', kind: 'browser', title: 'Docs' },
          { surfaceId: 's3', kind: 'terminal' },
        ] },
        { kind: 'leaf', paneId: 'p2', activeIndex: 0, surfaces: [{ surfaceId: 's4', kind: 'git', title: 'Git' }] },
      ] },
    },
  }, { id: 'w0', name: 'zero', order: 1, pinned: true, panes: [{ sessionId: 'pty-9' }] }],
});

function run(r: WebWorkspacesReply, current: { workspaces: Workspace[]; activeWorkspaceId: string }, lastServer: ServerSelection, cache = new Map()) {
  return hydrateWebState({ workspacesReply: r, sessionsReply: { sessions: [{ id: 'pty-1', surfaceTitle: 'claude', paneId: 'p1', paneName: 'w3-2(claude)' }, { id: 'pty-9', paneId: 'web-pane:w0', paneName: 'Build box' }] }, current, lastServer, cache });
}
const leaf = (ws: Workspace, id: string) => (ws.rootPane.type === 'branch'
  ? ws.rootPane.children.find((c) => c.id === id) : ws.rootPane) as PaneLeaf;

describe('hydrateWebState', () => {
  const empty: ServerSelection = { activePane: {}, activeSurface: {} };

  it('keeps the desktop ids, turns unshowable tabs into placeholders, sorts pinned first', () => {
    const { state } = run(reply(), { workspaces: [], activeWorkspaceId: '' }, empty);
    expect(state.workspaces.map((w) => w.id)).toEqual(['w0', 'w1']);
    expect(state.sidebarPinnedIds).toEqual(['w0']);
    const w1 = state.workspaces[1];
    const p1 = leaf(w1, 'p1');
    expect(p1.surfaces.map((s) => [s.id, s.surfaceType, s.ptyId, s.title])).toEqual([
      ['s1', 'terminal', 'pty-1', 'claude'],
      ['s2', 'placeholder', '', 'Docs'],
      ['s3', 'placeholder', '', 'Terminal'],
    ]);
    expect(leaf(w1, 'p2').surfaces[0].surfaceType).toBe('placeholder');
    expect(state.activeWorkspaceId).toBe('w1');
    expect(state.surfaceAgent).toEqual({ 'pty-1': { name: 'Claude', status: 'running' } });
    // The desktop's auto pane name gives back its ordinals; a typed name is a label.
    expect(w1.wsOrdinal).toBe(3);
    expect(p1.ordinal).toBe(2);
    expect(state.paneLabel).toEqual({ 'web-pane:w0': 'Build box' });
    // A workspace with no layout tree still gets a pane, without mounting a PTY-less terminal.
    expect(leaf(state.workspaces[0], 'web-pane:w0').surfaces[0].ptyId).toBe('pty-9');
  });

  it('returns the same objects when nothing changed (no re-render, no remount)', () => {
    const cache = new Map();
    const first = run(reply(), { workspaces: [], activeWorkspaceId: '' }, empty, cache);
    const second = run(reply(), { workspaces: first.state.workspaces, activeWorkspaceId: first.state.activeWorkspaceId }, first.server, cache);
    expect(second.state.workspaces[1]).toBe(first.state.workspaces[1]);
    expect(second.state.workspaces[0]).toBe(first.state.workspaces[0]);
  });

  it('keeps a local tab/pane choice until the desktop moves its own focus', () => {
    const first = run(reply(), { workspaces: [], activeWorkspaceId: '' }, empty);
    // The browser user picks tab s2 and pane p2 locally.
    const local = first.state.workspaces.map((w) => (w.id !== 'w1' ? w : {
      ...w,
      activePaneId: 'p2',
      rootPane: { ...w.rootPane, children: (w.rootPane as { children: PaneLeaf[] }).children.map((c) => (c.id === 'p1' ? { ...c, activeSurfaceId: 's2' } : c)) },
    } as Workspace));
    // An unrelated change arrives (a title): local choice survives.
    const r2 = reply();
    r2.workspaces[0].name = 'renamed';
    const second = run(r2, { workspaces: local, activeWorkspaceId: 'w1' }, first.server);
    const w1 = second.state.workspaces.find((w) => w.id === 'w1')!;
    expect(w1.activePaneId).toBe('p2');
    expect(leaf(w1, 'p1').activeSurfaceId).toBe('s2');
    // The desktop switches p1 to its third tab: that tab wins; the desktop's
    // focused pane did not move, so the local pane choice still stands.
    const third = run(reply(2, 'p1'), { workspaces: second.state.workspaces, activeWorkspaceId: 'w1' }, second.server);
    const w1b = third.state.workspaces.find((w) => w.id === 'w1')!;
    expect(leaf(w1b, 'p1').activeSurfaceId).toBe('s3');
    expect(w1b.activePaneId).toBe('p2');
    // The desktop then focuses p2 and back to p1: the move wins.
    const fourth = run(reply(2, 'p2'), { workspaces: third.state.workspaces, activeWorkspaceId: 'w1' }, third.server);
    const fifth = run(reply(2, 'p1'), { workspaces: fourth.state.workspaces, activeWorkspaceId: 'w1' }, fourth.server);
    expect(fifth.state.workspaces.find((w) => w.id === 'w1')!.activePaneId).toBe('p1');
  });

  it('keeps unplaced (stashed) sessions as the workspace\'s stashed panes', () => {
    const r = reply();
    r.workspaces[0].panes.push({ sessionId: 'pty-2', shell: 'zsh', paneId: 'p9' }, { sessionId: 'pty-3', shell: 'zsh', paneId: 'p9' });
    r.workspaces[0].layout!.unplaced = ['pty-2', 'pty-3', 'pty-gone'];
    const { state } = run(r, { workspaces: [], activeWorkspaceId: '' }, empty);
    const stashed = state.workspaces.find((w) => w.id === 'w1')!.stashedPanes!;
    expect(stashed).toHaveLength(1);
    expect(stashed[0].pane.id).toBe('p9');
    expect(stashed[0].pane.surfaces.map((s) => s.ptyId)).toEqual(['pty-2', 'pty-3']);
  });

  it('feeds the desktop status selectors so the sidebar draws the same dots', () => {
    const statuses = ['running', 'waiting', 'complete', 'error', 'awaiting_input', 'idle'] as const;
    const r: WebWorkspacesReply = {
      workspaces: statuses.map((status, i) => ({
        id: `w-${status}`, name: status, order: i,
        panes: [{ sessionId: `pty-${status}`, agentName: 'Claude', agentStatus: status }],
      })),
    };
    const { state } = hydrateWebState({
      workspacesReply: r, sessionsReply: { sessions: [] }, current: { workspaces: [], activeWorkspaceId: '' },
      lastServer: empty, cache: new Map(), now: 1000,
    });
    expect(state.surfaceTurnOpenAt).toEqual({ 'pty-running': 1000 });
    const rolled = selectAllWorkspaceAgentStatus({
      workspaces: state.workspaces, surfaceAgentStatus: state.surfaceAgentStatus, surfaceActivity: {},
      surfaceAgent: state.surfaceAgent, surfaceTurnOpenAt: state.surfaceTurnOpenAt, agentClockMs: 1000,
    } as Parameters<typeof selectAllWorkspaceAgentStatus>[0]);
    expect(rolled).toEqual({
      'w-running': 'running', 'w-waiting': 'waiting', 'w-complete': 'complete',
      'w-error': 'error', 'w-awaiting_input': 'awaiting_input',
    });
    // A pane that keeps running keeps its latch stamp across polls.
    const again = hydrateWebState({
      workspacesReply: r, sessionsReply: { sessions: [] },
      current: { workspaces: state.workspaces, activeWorkspaceId: state.activeWorkspaceId, surfaceTurnOpenAt: state.surfaceTurnOpenAt },
      lastServer: empty, cache: new Map(), now: 9000,
    });
    expect(again.state.surfaceTurnOpenAt).toEqual({ 'pty-running': 1000 });
  });
});
