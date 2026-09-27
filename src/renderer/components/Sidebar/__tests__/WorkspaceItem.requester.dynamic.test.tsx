// @vitest-environment jsdom
//
// The fan-out task row says, at rest, which pane asked for the task: the live
// pane (a link that jumps to it), the launch-time name marked closed once the
// pane is gone, the GUI, the orchestrator, or "unknown" — never a guess.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import WorkspaceItem from '../WorkspaceItem';
import { useStore } from '../../../stores';
import type { Pane, Surface, Workspace } from '../../../../shared/types';
import type { FanoutOrigin } from '../../../../shared/fanoutOrigin';

let container: HTMLDivElement;
let root: Root;

const surface = (id: string, ptyId: string): Surface => ({
  id, ptyId, title: '', shell: 'zsh', cwd: '/repo', surfaceType: 'terminal',
});
const leaf = (id: string, ordinal: number, s: Surface): Pane =>
  ({ id, type: 'leaf', ordinal, surfaces: [s], activeSurfaceId: s.id }) as Pane;

// The owner workspace w115 has two agent panes, 62 and 74.
const owner: Workspace = {
  id: 'ws-owner',
  name: 'app',
  wsOrdinal: 115,
  activePaneId: 'p62',
  rootPane: {
    id: 'split', type: 'branch', direction: 'horizontal', sizes: [50, 50],
    children: [leaf('p62', 62, surface('s62', 'pty-62')), leaf('p74', 74, surface('s74', 'pty-74'))],
  } as unknown as Pane,
} as Workspace;
const task: Workspace = {
  id: 'ws-task', name: 'wtask: compare', wsOrdinal: 200, activePaneId: 'tp',
  rootPane: leaf('tp', 1, surface('ts', 'pty-task')),
} as Workspace;

const noop = () => undefined;

async function render(origin?: FanoutOrigin): Promise<void> {
  useStore.setState({
    workspaces: [owner, task],
    activeWorkspaceId: 'ws-owner',
    paneLabel: { p74: 'Compare' },
    surfaceAgent: { 'pty-task': { name: 'Codex CLI', status: 'idle' } },
    fanoutLineage: { 'ws-task': 'ws-owner' },
    fanoutOrigin: origin ? { 'ws-task': origin } : {},
    fanoutProvenance: {},
  });
  await act(async () => {
    root.render(createElement(WorkspaceItem, {
      workspaceId: 'ws-task', isActive: false, isMultiview: false, index: 1,
      onSelect: noop, onCtrlSelect: noop, onRename: noop, onClose: noop, onArchive: noop,
      onCopyInfo: noop, onDuplicate: noop, onReorder: noop, taskRow: true,
    }));
  });
}

const line = () => container.querySelector('[data-task-requester]') as HTMLElement | null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => { root = createRoot(container); });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('task row requester line', () => {
  it('names the live requesting pane and the agent doing the task; a click jumps to that pane', async () => {
    await render({ kind: 'pane', paneId: 'p74', surfaceId: 's74', label: 'Compare · w115-74' });
    expect(line()?.textContent).toContain('Requested by Compare · w115-74');
    expect(container.querySelector('[data-task-assignee]')?.textContent).toBe('Codex CLI');
    // Not the workspace's active pane: the jump has to move focus.
    useStore.setState({ activeWorkspaceId: 'ws-task' });
    const jump = container.querySelector('[data-task-requester-jump]') as HTMLButtonElement;
    expect(jump.getAttribute('aria-label')).toBe('Go to Compare · w115-74');
    await act(async () => { jump.click(); });
    const st = useStore.getState();
    expect(st.activeWorkspaceId).toBe('ws-owner');
    expect(st.workspaces.find((w) => w.id === 'ws-owner')?.activePaneId).toBe('p74');
  });

  it('keeps the launch-time name once the pane is closed, marked closed and not clickable', async () => {
    await render({ kind: 'pane', paneId: 'p-gone', surfaceId: 's-gone', label: 'Planner · w115-9' });
    expect(line()?.textContent).toContain('Requested by Planner · w115-9 · closed');
    expect(container.querySelector('[data-task-requester-jump]')).toBeNull();
  });

  it('says a GUI start, the orchestrator, or that the requester is unknown', async () => {
    await render({ kind: 'gui' });
    expect(line()?.textContent).toContain('Started by you');
    await render({ kind: 'orchestrator' });
    expect(line()?.textContent).toContain('Requested by Orchestrator');
    await render(undefined);
    expect(line()?.getAttribute('data-task-requester')).toBe('unknown');
    expect(line()?.textContent).toContain('Requester unknown');
  });
});
