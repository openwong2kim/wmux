// @vitest-environment jsdom
//
// Company mode on the workspace row: line 2 is the mission, not the git line
// (with panes in different worktrees the branch, PR and sync are whichever
// pane reported last), the coordinator leads the roster with the CEO word,
// and a staff row's title is its pane label.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import WorkspaceItem from '../WorkspaceItem';
import { useStore } from '../../../stores';
import type { Pane, Surface, Workspace } from '../../../../shared/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const surface = (id: string, ptyId: string): Surface => ({
  id, ptyId, title: '', shell: 'zsh', cwd: '/repo', surfaceType: 'terminal',
});
const leaf = (id: string, ordinal: number, s: Surface): Pane =>
  ({ id, type: 'leaf', ordinal, surfaces: [s], activeSurfaceId: s.id }) as Pane;

const ws: Workspace = {
  id: 'ws-1',
  name: 'wmux',
  wsOrdinal: 1,
  activePaneId: 'p1',
  company: { v: 1, id: 'co-1', coordinatorPaneId: 'p2', mission: 'Ship 4.14 green, nothing lost' },
  metadata: {
    gitBranch: 'feat/last-reporter',
    pr: { number: 2882, state: 'open', checks: 'passing', url: 'https://example.invalid/pr/2882' },
    gitSync: { dirty: 3, ahead: 1, behind: 0, hasUpstream: true },
  },
  rootPane: {
    id: 'split', type: 'branch', direction: 'horizontal', sizes: [34, 33, 33],
    children: [
      leaf('p1', 1, surface('s1', 'pty-1')),
      leaf('p2', 2, surface('s2', 'pty-2')),
      leaf('p3', 3, surface('s3', 'pty-3')),
    ],
  } as unknown as Pane,
} as Workspace;

const noop = () => undefined;

async function render(isActive = false): Promise<void> {
  await act(async () => {
    root.render(createElement(WorkspaceItem, {
      workspaceId: 'ws-1', isActive, isMultiview: false, index: 0,
      onSelect: noop, onCtrlSelect: noop, onRename: noop, onClose: noop, onArchive: noop,
      onCopyInfo: noop, onDuplicate: noop, onReorder: noop,
    }));
  });
}

beforeEach(() => {
  useStore.setState({
    ...useStore.getInitialState(),
    locale: 'en',
    workspaces: [ws],
    activeWorkspaceId: 'ws-1',
    surfaceAgent: {
      'pty-1': { name: 'Claude Code', status: 'idle' },
      'pty-2': { name: 'Claude Code', status: 'idle' },
      'pty-3': { name: 'Claude Code', status: 'idle' },
    },
    paneLabel: { p2: 'pm', p3: 'Scout' },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => { root = createRoot(container); });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('company workspace row', () => {
  it('shows the mission under the name, and no branch, PR or sync', async () => {
    await render();
    expect(container.querySelector('[data-company-mission]')?.textContent).toBe('Ship 4.14 green, nothing lost');
    expect(container.textContent).not.toContain('feat/last-reporter');
    expect(container.textContent).not.toContain('#2882');
    expect(container.querySelector('[data-git-signal]')).toBeNull();
  });

  it('shows nothing in place of the git line when the company has no mission', async () => {
    useStore.setState({ workspaces: [{ ...ws, company: { v: 1, id: 'co-1', coordinatorPaneId: 'p2' } }] });
    await render();
    expect(container.querySelector('[data-company-mission]')).toBeNull();
    expect(container.textContent).not.toContain('feat/last-reporter');
  });

  it('leads the roster with the CEO and titles staff rows by their pane label', async () => {
    await render(true);
    const rows = [...container.querySelectorAll<HTMLElement>('[data-testid="sidebar-agent-row"]')];
    expect(rows.map((r) => r.querySelector('span.font-semibold')?.textContent)).toEqual(['pm', 'Claude Code', 'Scout']);
    expect(rows[0].querySelector('[data-roster-ceo]')?.textContent).toBe('CEO');
    expect(container.querySelectorAll('[data-roster-ceo]')).toHaveLength(1);
    // The label is the title, so the trailer keeps the coordinate instead.
    expect(rows[2].textContent).toContain('w1-3');
    expect(rows[2].textContent?.match(/Scout/g)).toHaveLength(1);
  });

  it('settings keep a vacant seat empty until a pane is picked, and focus returns to the row', async () => {
    useStore.setState({ workspaces: [{ ...ws, company: { v: 1, id: 'co-1', coordinatorPaneId: 'p-gone', mission: 'm' } }] });
    await render();
    const row = container.querySelector<HTMLElement>('[role="treeitem"]')!;
    act(() => {
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    act(() => { container.querySelector<HTMLButtonElement>('[data-workspace-action="company"]')!.click(); });
    const dialog = document.querySelector('[data-testid="company-dialog"]')!;
    expect([...dialog.querySelectorAll('[role="radio"]')].map((r) => r.getAttribute('aria-checked'))).toEqual(['false', 'false', 'false']);
    const save = [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Save')!;
    expect(save.disabled).toBe(false);
    act(() => { save.click(); });
    expect(useStore.getState().workspaces[0].company).toEqual({ v: 1, id: 'co-1', coordinatorPaneId: null, mission: 'm' });
    expect(document.activeElement).toBe(row);
  });

  it('offers Add a seat on another PC between Company settings and Dissolve, and disables it while the CEO seat is vacant', async () => {
    const openMenu = () => act(() => {
      container.querySelector('[role="treeitem"]')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    await render();
    openMenu();
    const actions = [...container.querySelectorAll<HTMLElement>('[data-workspace-action]')].map((b) => b.dataset.workspaceAction);
    expect(actions.indexOf('add-remote-seat')).toBe(actions.indexOf('company') + 1);
    expect(actions.indexOf('dissolve-company')).toBe(actions.indexOf('add-remote-seat') + 1);
    const item = container.querySelector<HTMLButtonElement>('[data-workspace-action="add-remote-seat"]')!;
    expect(item.disabled).toBe(false);
    expect(item.title).toBe('');

    act(() => useStore.setState({ workspaces: [{ ...ws, company: { v: 1, id: 'co-1', coordinatorPaneId: 'p-gone' } }] }));
    act(() => root.unmount());
    act(() => { root = createRoot(container); });
    await render();
    openMenu();
    const vacant = container.querySelector<HTMLButtonElement>('[data-workspace-action="add-remote-seat"]')!;
    expect(vacant.disabled).toBe(true);
    expect(vacant.title).not.toBe('');
  });

  it('dissolving from the row menu brings the git line back', async () => {
    await render();
    act(() => {
      container.querySelector('[role="treeitem"]')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    expect(container.querySelector('[data-workspace-action="company"]')?.textContent).toBe('Company settings…');
    act(() => { container.querySelector<HTMLButtonElement>('[data-workspace-action="dissolve-company"]')!.click(); });
    expect(useStore.getState().workspaces[0]).not.toHaveProperty('company');
    expect(container.querySelector('[data-company-mission]')).toBeNull();
    expect(container.textContent).toContain('feat/last-reporter');
  });
});
