// @vitest-environment jsdom
//
// A workspace row carries one computer-use colour dot per pane that used
// computer use, in pane order (split panes, then each pane's tabs), at most
// three, then a muted "+N" for the rest. A row with no marked pane draws none.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import WorkspaceItem from '../WorkspaceItem';
import { useStore } from '../../../stores';
import type { Pane, Surface, Workspace } from '../../../../shared/types';

let container: HTMLDivElement;
let root: Root;

const surface = (id: string): Surface => ({
  id, ptyId: `pty-${id}`, title: id, shell: 'bash', cwd: '/repo', surfaceType: 'terminal',
});
const leaf = (id: string, surfaces: Surface[]): Pane => ({
  id, type: 'leaf', surfaces, activeSurfaceId: surfaces[0].id,
});
/** Two split panes: the first with three tabs, the second with two. */
const workspace = (): Workspace => ({
  id: 'ws',
  name: 'ws',
  rootPane: {
    id: 'ws-root',
    type: 'branch',
    direction: 'horizontal',
    sizes: [50, 50],
    children: [leaf('p1', [surface('s1'), surface('s2'), surface('s3')]), leaf('p2', [surface('s4'), surface('s5')])],
  },
  activePaneId: 'p1',
});

const noop = () => undefined;

async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(WorkspaceItem, {
      workspaceId: 'ws', isActive: false, isMultiview: false, index: 0,
      onSelect: noop, onCtrlSelect: noop, onRename: noop, onClose: noop, onArchive: noop,
      onCopyInfo: noop, onDuplicate: noop, onReorder: noop,
    }));
  });
}

function dotColors(): string[] {
  return [...container.querySelectorAll<HTMLElement>('[data-computer-use-dots] [data-computer-use-color]')]
    .map((el) => el.dataset.computerUseColor as string);
}
const more = () => container.querySelector<HTMLElement>('[data-computer-use-more]');

beforeEach(() => {
  useStore.setState({ workspaces: [workspace()], activeWorkspaceId: 'ws' });
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => { root = createRoot(container); });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  act(() => useStore.getState().setAgentMarkers([]));
});

describe('WorkspaceItem — computer-use colour dots', () => {
  it('draws nothing while no pane of the workspace has used computer use', async () => {
    useStore.getState().setAgentMarkers([{ ptyId: 'pty-elsewhere', color: '#5AA2FF' }]);
    await render();
    expect(container.querySelector('[data-computer-use-dots]')).toBeNull();
  });

  it('shows up to three dots in pane order, then +N, and follows the list', async () => {
    useStore.getState().setAgentMarkers([
      { ptyId: 'pty-s5', color: '#9BDB4D' },
      { ptyId: 'pty-s2', color: '#5AA2FF' },
    ]);
    await render();
    expect(dotColors()).toEqual(['#5AA2FF', '#9BDB4D']);
    expect(more()).toBeNull();

    act(() => useStore.getState().setAgentMarkers([
      { ptyId: 'pty-s1', color: '#FF8A3D' },
      { ptyId: 'pty-s2', color: '#5AA2FF' },
      { ptyId: 'pty-s3', color: '#A98BFF' },
      { ptyId: 'pty-s4', color: '#FF77B7' },
      { ptyId: 'pty-s5', color: '#9BDB4D' },
    ]));
    expect(dotColors()).toEqual(['#FF8A3D', '#5AA2FF', '#A98BFF']);
    expect(more()?.textContent).toBe('+2');
    expect(more()?.getAttribute('aria-label')).toBe('More panes with a computer use color: 2');
    // Each dot says which colour it is, so two agents' dots read differently.
    expect([...container.querySelectorAll('[data-computer-use-color]')].map((dot) => dot.getAttribute('aria-label'))).toEqual([
      'Computer use color: orange',
      'Computer use color: blue',
      'Computer use color: violet',
    ]);
  });
});
