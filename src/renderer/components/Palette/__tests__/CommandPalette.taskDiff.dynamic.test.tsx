// @vitest-environment jsdom
//
// #1461 — the palette's way back to a task diff. Show Git Diff opens the
// read-only workspace diff, so once the fan-out toast timed out, a task that
// was still running (or detached) had no entry point to its adoptable diff.
// Show Task Diff is listed only in a task workspace whose worktree is still
// there, and opens the same task diff surface the toast does.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../../stores';
import CommandPalette from '../CommandPalette';
import { hasAdoptableTaskDiff } from '../../../utils/openTaskDiff';
import type { Workspace, Pane, PaneLeaf } from '../../../../shared/types';
import type { WorkTask } from '../../../../shared/workTask';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function leaf(id: string): Pane {
  return {
    id,
    type: 'leaf',
    surfaces: [{ id: `s-${id}`, ptyId: `pty-${id}`, title: id, shell: 'pwsh', cwd: '/repo', surfaceType: 'terminal' }],
    activeSurfaceId: `s-${id}`,
  };
}
function workspace(id: string, name: string, pane: Pane): Workspace {
  return { id, name, rootPane: pane, activePaneId: pane.id };
}
function mission(extra: Partial<WorkTask> = {}): WorkTask {
  return {
    id: 'wtask-1',
    title: 'Fix login',
    status: 'open',
    missionChannelId: 'ch-1',
    createdAt: 1,
    createdBy: { principalId: 'ws-o', verifiedWorkspaceId: 'ws-o' },
    owner: { principalId: 'ws-o', verifiedWorkspaceId: 'ws-o' },
    branch: 'wmux/fix-login',
    worktreePath: '/wt/fix-login',
    ...extra,
  } as WorkTask;
}

let container: HTMLDivElement;
let root: Root;

function openPalette(activeWorkspaceId: string, task: WorkTask | undefined): void {
  act(() => {
    useStore.setState({
      ...useStore.getInitialState(),
      locale: 'en',
      workspaces: [
        workspace('ws-o', 'owner project', leaf('po')),
        workspace('ws-t', 'wtask: Fix login', leaf('pt')),
      ],
      activeWorkspaceId,
      missionByPaneGroup: task ? { 'ws-t': task } : {},
      commandPaletteVisible: true,
    });
  });
  act(() => root.render(createElement(CommandPalette)));
}

function taskDiffItem(): HTMLElement | undefined {
  return Array.from(container.querySelectorAll<HTMLElement>('.overflow-y-auto > div')).find(
    (row) => row.textContent?.includes('Show Task Diff'),
  );
}

function taskLeaf(): PaneLeaf {
  const ws = useStore.getState().workspaces.find((w) => w.id === 'ws-t');
  if (!ws) throw new Error('task workspace missing');
  return ws.rootPane as PaneLeaf;
}

beforeEach(() => {
  Element.prototype.scrollIntoView = () => {
    /* jsdom has no layout to scroll */
  };
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    plugins: { list: async () => ({ plugins: [], failures: [] }) },
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  act(() => useStore.setState(useStore.getInitialState()));
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('CommandPalette — Show Task Diff (#1461)', () => {
  it('opens the adoptable task diff of the active task workspace', () => {
    openPalette('ws-t', mission());
    const button = taskDiffItem()?.querySelector('button');
    if (!button) throw new Error('Show Task Diff not listed');

    act(() => {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const diff = taskLeaf().surfaces.find((s) => s.surfaceType === 'diff');
    expect(diff).toMatchObject({
      diffTaskId: 'wtask-1',
      // Close / PR / the task lookup are owner-scoped RPCs.
      diffOwnerWorkspaceId: 'ws-o',
      title: 'diff: Fix login',
    });
    // A task diff, not the read-only workspace diff.
    expect(diff?.diffRepoPath).toBeUndefined();
    expect(taskLeaf().activeSurfaceId).toBe(diff?.id);
    expect(useStore.getState().commandPaletteVisible).toBe(false);
  });

  it('is listed for a detached task, whose worktree is kept', () => {
    openPalette('ws-t', mission({ status: 'closed', closedAt: 2, detachedAt: 2 }));
    expect(taskDiffItem()).toBeDefined();
  });

  it('is not listed outside a task workspace', () => {
    openPalette('ws-o', mission());
    expect(taskDiffItem()).toBeUndefined();
    // The read-only workspace diff is still there.
    expect(container.textContent).toContain('Show Git Diff');
  });

  it('is not listed for a closed task, whose worktree was removed', () => {
    openPalette('ws-t', mission({ status: 'closed', closedAt: 2 }));
    expect(taskDiffItem()).toBeUndefined();
  });
});

describe('hasAdoptableTaskDiff', () => {
  it('holds for an open or detached task with a worktree only', () => {
    expect(hasAdoptableTaskDiff(mission())).toBe(true);
    expect(hasAdoptableTaskDiff(mission({ status: 'closed', detachedAt: 2 }))).toBe(true);
    expect(hasAdoptableTaskDiff(mission({ status: 'closed' }))).toBe(false);
    // Not materialized yet, or a worktree:false task (output folder only).
    expect(hasAdoptableTaskDiff(mission({ worktreePath: undefined }))).toBe(false);
    expect(hasAdoptableTaskDiff(mission({ worktreePath: undefined, branch: undefined, outputDir: '/out/1' }))).toBe(false);
  });
});
