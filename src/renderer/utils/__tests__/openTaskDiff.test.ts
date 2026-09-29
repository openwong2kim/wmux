// One task, one diff panel. openTaskDiff used to look for the task's diff
// only in the pane it was about to open in, so with the diff already in one
// pane and focus in another, the palette, the fan-out toast or Fleet added a
// second panel. After a Close in one of them, the other kept the removed
// worktree's hunks with Adopt and Close still up (#1461 item 2 again).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { useStore } from '../../stores';
import { openTaskDiff } from '../openTaskDiff';
import type { Workspace, PaneLeaf, Surface } from '../../../shared/types';
import { getLeafPanes } from '../../../shared/paneUtils';

function terminal(id: string): Surface {
  return { id, ptyId: `pty-${id}`, title: id, shell: 'pwsh', cwd: '/repo', surfaceType: 'terminal' };
}
function taskDiff(id: string, taskId: string): Surface {
  // No diffOwnerWorkspaceId, like a surface opened before F1 added it.
  return { id, ptyId: '', title: `diff: ${taskId}`, shell: '', cwd: '', surfaceType: 'diff', diffTaskId: taskId };
}
function leaf(id: string, surfaces: Surface[]): PaneLeaf {
  return { id, type: 'leaf', surfaces, activeSurfaceId: surfaces[0].id };
}

/** The task workspace, split: pane A holds the agent and `extra`, pane B a shell. */
function taskWorkspace(activePaneId: string, extra: Surface[]): Workspace {
  return {
    id: 'ws-t',
    name: 'wtask: Fix login',
    rootPane: {
      id: 'split',
      type: 'branch',
      direction: 'horizontal',
      children: [leaf('pa', [terminal('s-a'), ...extra]), leaf('pb', [terminal('s-b')])],
    },
    activePaneId,
  };
}

function setUp(activePaneId: string, extra: Surface[], zoomedPaneId: string | null = null): void {
  useStore.setState({
    ...useStore.getInitialState(),
    workspaces: [
      { id: 'ws-o', name: 'owner project', rootPane: leaf('po', [terminal('s-o')]), activePaneId: 'po' },
      taskWorkspace(activePaneId, extra),
    ],
    activeWorkspaceId: 'ws-o',
    zoomedPaneId,
  });
}

function taskWs(): Workspace {
  const ws = useStore.getState().workspaces.find((w) => w.id === 'ws-t');
  if (!ws) throw new Error('task workspace missing');
  return ws;
}
function pane(id: string): PaneLeaf {
  const found = getLeafPanes(taskWs().rootPane).find((l) => l.id === id);
  if (!found) throw new Error(`pane ${id} missing`);
  return found;
}
/** Every diff surface for `taskId` in the task workspace, with its pane. */
function diffsOf(taskId: string): Array<{ paneId: string; surface: Surface }> {
  return getLeafPanes(taskWs().rootPane).flatMap((l) =>
    l.surfaces.filter((s) => s.surfaceType === 'diff' && s.diffTaskId === taskId).map((surface) => ({ paneId: l.id, surface })),
  );
}

beforeEach(() => useStore.setState(useStore.getInitialState()));
afterEach(() => useStore.setState(useStore.getInitialState()));

describe('openTaskDiff', () => {
  it('brings forward the diff another pane already holds instead of adding a second one', () => {
    // The diff is a background tab in pane A; focus is in pane B.
    setUp('pb', [taskDiff('s-diff', 'wtask-1')]);

    openTaskDiff('wtask-1', 'ws-t', 'Fix login', 'ws-o');

    const diffs = diffsOf('wtask-1');
    expect(diffs).toHaveLength(1);
    expect(diffs[0].paneId).toBe('pa');
    expect(diffs[0].surface.id).toBe('s-diff');
    // It is the one on screen: its pane has focus and it is that pane's tab.
    expect(useStore.getState().activeWorkspaceId).toBe('ws-t');
    expect(taskWs().activePaneId).toBe('pa');
    expect(pane('pa').activeSurfaceId).toBe('s-diff');
    expect(pane('pb').surfaces.map((s) => s.id)).toEqual(['s-b']);
    // The owner id is backfilled, as addDiffSurface does for a reused tab.
    expect(diffs[0].surface.diffOwnerWorkspaceId).toBe('ws-o');
  });

  it('un-zooms a pane of this workspace that would hide it, and leaves another workspace\'s zoom alone', () => {
    setUp('pb', [taskDiff('s-diff', 'wtask-1')], 'pb');
    openTaskDiff('wtask-1', 'ws-t', 'Fix login', 'ws-o');
    expect(diffsOf('wtask-1')).toHaveLength(1);
    expect(taskWs().activePaneId).toBe('pa');
    expect(useStore.getState().zoomedPaneId).toBeNull();

    setUp('pb', [taskDiff('s-diff', 'wtask-1')], 'po');
    openTaskDiff('wtask-1', 'ws-t', 'Fix login', 'ws-o');
    expect(diffsOf('wtask-1')).toHaveLength(1);
    expect(useStore.getState().zoomedPaneId).toBe('po');
  });

  it('adds the diff to the focused pane when no pane has this task\'s diff yet', () => {
    // Pane A holds a different task's diff, which does not count.
    setUp('pb', [taskDiff('s-other', 'wtask-2')]);

    openTaskDiff('wtask-1', 'ws-t', 'Fix login', 'ws-o');

    const diffs = diffsOf('wtask-1');
    expect(diffs).toHaveLength(1);
    expect(diffs[0].paneId).toBe('pb');
    expect(diffs[0].surface).toMatchObject({ title: 'diff: Fix login', diffOwnerWorkspaceId: 'ws-o' });
    expect(pane('pb').activeSurfaceId).toBe(diffs[0].surface.id);
    expect(taskWs().activePaneId).toBe('pb');
    expect(diffsOf('wtask-2')).toHaveLength(1);
    expect(useStore.getState().activeWorkspaceId).toBe('ws-t');
  });
});
