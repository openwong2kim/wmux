// @vitest-environment jsdom
//
// "N requested" on a roster row: each agent pane counts the open fan-out tasks
// it asked for, so two panes in one workspace show their own numbers; a click
// opens the workspace's task group.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import WorkspaceAgentRoster from '../WorkspaceAgentRoster';
import { useStore } from '../../../stores';
import type { Pane, Surface, Workspace } from '../../../../shared/types';

let container: HTMLDivElement;
let root: Root;

const surface = (id: string, ptyId: string): Surface => ({
  id, ptyId, title: '', shell: 'zsh', cwd: '/repo', surfaceType: 'terminal',
});
const leaf = (id: string, ordinal: number, s: Surface): Pane =>
  ({ id, type: 'leaf', ordinal, surfaces: [s], activeSurfaceId: s.id }) as Pane;

const owner: Workspace = {
  id: 'ws-owner', name: 'app', wsOrdinal: 115, activePaneId: 'p62',
  rootPane: {
    id: 'split', type: 'branch', direction: 'horizontal', sizes: [50, 50],
    children: [leaf('p62', 62, surface('s62', 'pty-62')), leaf('p74', 74, surface('s74', 'pty-74'))],
  } as unknown as Pane,
} as Workspace;
const task = (id: string): Workspace =>
  ({ id, name: `wtask: ${id}`, wsOrdinal: 200, activePaneId: `${id}-p`, rootPane: leaf(`${id}-p`, 1, surface(`${id}-s`, `${id}-pty`)) }) as Workspace;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => { root = createRoot(container); });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('roster "requested" badge', () => {
  it('gives each requesting pane its own count and opens the task group on click', async () => {
    useStore.setState({
      workspaces: [owner, task('t1'), task('t2'), task('t3'), task('t4')],
      activeWorkspaceId: 'ws-owner',
      surfaceAgent: {
        'pty-62': { name: 'Claude Code', status: 'idle' },
        'pty-74': { name: 'Codex CLI', status: 'idle' },
      },
      fanoutOrigin: {
        t1: { kind: 'pane', paneId: 'p62', surfaceId: 's62' },
        t2: { kind: 'pane', paneId: 'p74', surfaceId: 's74' },
        t3: { kind: 'pane', paneId: 'p74', surfaceId: 's74' },
        t4: { kind: 'pane', paneId: 'p74', surfaceId: 's74' },
      },
      fanoutProvenance: {},
      // t3's owner is another workspace: its badge lives there, not here.
      fanoutLineage: { t1: 'ws-owner', t2: 'ws-owner', t3: 'ws-owner', t4: 'ws-elsewhere' },
      fanoutSpawnOwner: {},
      missionByPaneGroup: {},
      sidebarTaskGroupExpanded: { 'ws-owner': false },
    });
    // Stands in for the workspace row, which selects on click and is a drag source.
    const rowPress = vi.fn();
    await act(async () => {
      root.render(createElement('div', { onPointerDown: rowPress, onMouseDown: rowPress, onMouseUp: rowPress, onClick: rowPress },
        createElement(WorkspaceAgentRoster, { workspaceId: 'ws-owner', pulsingPaneId: null })));
    });
    const badges = [...container.querySelectorAll('[data-roster-requested]')] as HTMLButtonElement[];
    expect(badges.map((b) => b.textContent)).toEqual(['1 requested', '2 requested']);

    // A real press must not reach the workspace row (it selects / drags).
    await act(async () => {
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        badges[1].dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, detail: 1 }));
      }
    });
    expect(rowPress).not.toHaveBeenCalled();
    expect(useStore.getState().sidebarTaskGroupExpanded['ws-owner']).toBe(true);
  });
});
