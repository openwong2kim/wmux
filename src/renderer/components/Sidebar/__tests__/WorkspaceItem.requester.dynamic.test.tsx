// @vitest-environment jsdom
//
// The fan-out task row says, at rest, which pane asked for the task: the live
// pane (a link that jumps to it), the launch-time name marked closed once the
// pane is gone, the GUI, the orchestrator, or "unknown" — never a guess.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
let onSelect = vi.fn();

async function render(origin?: FanoutOrigin, opts: { isActive?: boolean } = {}): Promise<void> {
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
      workspaceId: 'ws-task', isActive: opts.isActive ?? false, isMultiview: false, index: 1,
      onSelect, onCtrlSelect: noop, onRename: noop, onClose: noop, onArchive: noop,
      onCopyInfo: noop, onDuplicate: noop, onReorder: noop, taskRow: true,
    }));
  });
}

const line = () => container.querySelector('[data-task-requester]') as HTMLElement | null;

beforeEach(() => {
  onSelect = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => { root = createRoot(container); });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('task row requester line', () => {
  it('leads with the requesting pane\'s coordinate, on its own line outside the name row', async () => {
    const origin: FanoutOrigin = { kind: 'pane', paneId: 'p74', surfaceId: 's74', label: 'w115-74 · Compare' };
    for (const isActive of [false, true]) {
      await render(origin, { isActive });
      const el = line()!;
      expect(el.textContent).toBe('by w115-74 · Compare');
      // The coordinate comes before the name, so an end-truncation drops the
      // name first and never the part that tells two panes apart.
      expect(el.textContent!.indexOf('w115-74')).toBeLessThan(el.textContent!.indexOf('Compare'));
      // Its own line at the row's width: not inside the name/actions flex row.
      expect(el.closest('.flex.min-w-0.items-start')).toBeNull();
      // Nothing else shares the line.
      expect(el.querySelectorAll('[data-task-assignee]')).toHaveLength(0);
    }
  });

  it('a real press + release + click jumps to the requesting pane and never selects the task row', async () => {
    await render({ kind: 'pane', paneId: 'p74', surfaceId: 's74', label: 'w115-74 · Compare' });
    expect(useStore.getState().workspaces.find((w) => w.id === 'ws-owner')?.activePaneId).toBe('p62');
    const jump = container.querySelector('[data-task-requester-jump]') as HTMLButtonElement;
    expect(jump.getAttribute('aria-label')).toBe('Go to w115-74 · Compare');
    await act(async () => {
      for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
        jump.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, detail: 1 }));
      }
    });
    expect(onSelect).not.toHaveBeenCalled();
    const st = useStore.getState();
    expect(st.activeWorkspaceId).toBe('ws-owner');
    expect(st.workspaces.find((w) => w.id === 'ws-owner')?.activePaneId).toBe('p74');
  });

  it('keeps the launch-time name once the pane is closed, marked closed and not clickable', async () => {
    await render({ kind: 'pane', paneId: 'p-gone', surfaceId: 's-gone', label: 'w115-9 · Planner' });
    expect(line()?.textContent).toBe('by w115-9 · Planner· closed');
    expect(container.querySelector('[data-task-requester-jump]')).toBeNull();
  });

  it('says a GUI start, the orchestrator, or that the requester is unknown', async () => {
    await render({ kind: 'gui' });
    expect(line()?.textContent).toBe('Started by you');
    await render({ kind: 'orchestrator' });
    expect(line()?.textContent).toBe('by Orchestrator');
    await render(undefined);
    expect(line()?.getAttribute('data-task-requester')).toBe('unknown');
    expect(line()?.textContent).toBe('Requester unknown');
  });

  it('the glyph tooltip names the same requester as the line', async () => {
    await render({ kind: 'pane', paneId: 'p74', surfaceId: 's74', label: 'w115-74 · Compare' });
    const tip = container.querySelector('[data-task-provenance]')?.getAttribute('title') ?? '';
    expect(tip).toContain('w115-74 · Compare');
    act(() => { useStore.setState({ paneLabel: { p74: 'Renamed' } }); });
    expect(container.querySelector('[data-task-provenance]')?.getAttribute('title')).toContain('w115-74 · Renamed');
    expect(line()?.textContent).toBe('by w115-74 · Renamed');
  });
});
