// @vitest-environment jsdom
//
// Needs you → Dismiss: the workspace row's context menu offers "Dismiss
// question" only while a pane in it ended a turn on a question, and it clears
// every such question in the workspace. A live permission dialog is not a
// question to dismiss and stays.

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
const leaf = (id: string, s: Surface): Pane =>
  ({ id, type: 'leaf', surfaces: [s], activeSurfaceId: s.id }) as Pane;

const ws: Workspace = {
  id: 'ws-1',
  name: 'app',
  activePaneId: 'p1',
  rootPane: {
    id: 'split', type: 'branch', direction: 'horizontal', sizes: [34, 33, 33],
    children: [
      leaf('p1', surface('s1', 'pty-q1')),
      leaf('p2', surface('s2', 'pty-q2')),
      leaf('p3', surface('s3', 'pty-dialog')),
    ],
  } as unknown as Pane,
} as Workspace;

const noop = () => undefined;

async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(WorkspaceItem, {
      workspaceId: 'ws-1', isActive: false, isMultiview: false, index: 0,
      onSelect: noop, onCtrlSelect: noop, onRename: noop, onClose: noop, onArchive: noop,
      onCopyInfo: noop, onDuplicate: noop, onReorder: noop,
    }));
  });
}

function openMenu(): void {
  const row = container.querySelector('[role="treeitem"]')!;
  act(() => {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  });
}

const dismissItem = () => container.querySelector<HTMLButtonElement>('[data-workspace-action="dismiss-question"]');

beforeEach(() => {
  useStore.setState({
    ...useStore.getInitialState(),
    locale: 'en',
    workspaces: [ws],
    activeWorkspaceId: 'ws-other',
    surfaceAgent: {
      'pty-q1': { name: 'Claude Code', status: 'waiting' },
      'pty-q2': { name: 'Claude Code', status: 'waiting' },
      'pty-dialog': { name: 'Claude Code', status: 'awaiting_input' },
    },
    surfaceAgentStatus: { 'pty-q1': 'waiting', 'pty-q2': 'waiting', 'pty-dialog': 'awaiting_input' },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => { root = createRoot(container); });
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('workspace row — Dismiss question', () => {
  it('is not offered when only a live permission dialog needs you', async () => {
    await render();
    openMenu();
    expect(container.querySelector('[data-workspace-action="archive"]')).not.toBeNull();
    expect(dismissItem()).toBeNull();
  });

  it('clears every pending question in the workspace and leaves the live dialog', async () => {
    act(() => {
      useStore.setState({ surfacePendingQuestion: { 'pty-q1': 'Shall I merge?', 'pty-q2': 'Ship it?' } });
    });
    await render();
    openMenu();
    const item = dismissItem();
    // It clears every pane's question, so the label says how many.
    expect(item?.textContent).toBe('Dismiss 2 questions');
    act(() => { item!.click(); });

    const s = useStore.getState();
    expect(s.surfacePendingQuestion).toEqual({});
    expect(s.surfaceDismissedQuestion).toEqual({ 'pty-q1': 'Shall I merge?', 'pty-q2': 'Ship it?' });
    // The permission dialog still waits for an answer.
    expect(s.surfaceAgent['pty-dialog']?.status).toBe('awaiting_input');
    expect(s.surfaceAgentStatus['pty-dialog']).toBe('awaiting_input');
    // The menu closed, and a re-delivery of the same question stays dismissed.
    expect(dismissItem()).toBeNull();
    act(() => { useStore.getState().setSurfacePendingQuestion('pty-q1', 'Shall I merge?'); });
    expect(useStore.getState().surfacePendingQuestion['pty-q1']).toBeUndefined();
  });

  it('skips a pane whose agent reports a live prompt, even with a question text', async () => {
    act(() => {
      useStore.setState({ surfacePendingQuestion: { 'pty-q1': 'Shall I merge?', 'pty-dialog': 'Allow edit?' } });
    });
    await render();
    openMenu();
    expect(dismissItem()?.textContent).toBe('Dismiss question');
    act(() => { dismissItem()!.click(); });

    const s = useStore.getState();
    expect(s.surfacePendingQuestion).toEqual({ 'pty-dialog': 'Allow edit?' });
    expect(s.surfaceDismissedQuestion).toEqual({ 'pty-q1': 'Shall I merge?' });
  });
});
