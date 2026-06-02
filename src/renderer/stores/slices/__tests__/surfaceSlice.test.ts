import { describe, expect, it } from 'vitest';
import { createWorkspace, type Workspace } from '../../../../shared/types';
import { createSurfaceSlice } from '../surfaceSlice';

type TestState = {
  workspaces: Workspace[];
  activeWorkspaceId: string;
};

function createHarness() {
  const workspace = createWorkspace('Test');
  const otherWorkspace = createWorkspace('Other');
  const state: TestState = {
    workspaces: [workspace, otherWorkspace],
    activeWorkspaceId: workspace.id,
  };

  const set = (updater: (state: TestState) => void) => {
    updater(state);
  };

  const slice = createSurfaceSlice(set as never, (() => state) as never, {} as never);
  return { state, slice };
}

describe('surfaceSlice browser partition state', () => {
  it('adds terminal surfaces to an explicit workspace even when another workspace is active', () => {
    const { state, slice } = createHarness();
    const targetWorkspace = state.workspaces[1];
    const paneId = targetWorkspace.rootPane.id;

    slice.addSurface(paneId, 'pty-explicit', 'powershell.exe', 'C:\\Users\\LORD', targetWorkspace.id);

    const activePane = state.workspaces[0].rootPane;
    const targetPane = targetWorkspace.rootPane;
    if (activePane.type !== 'leaf' || targetPane.type !== 'leaf') {
      throw new Error('expected leaf panes');
    }
    expect(activePane.surfaces).toHaveLength(0);
    expect(targetPane.surfaces).toHaveLength(1);
    expect(targetPane.surfaces[0].ptyId).toBe('pty-explicit');
  });

  it('stores the provided partition on new browser surfaces', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;

    slice.addBrowserSurface(paneId, 'https://example.com', 'persist:wmux-login');

    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    expect(pane.surfaces[0].browserPartition).toBe('persist:wmux-login');
  });

  it('updates browser partitions across surfaces when a new profile is applied', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;

    slice.addBrowserSurface(paneId, 'https://one.example', 'persist:wmux-default');
    slice.addBrowserSurface(paneId, 'https://two.example', 'persist:wmux-default');
    slice.updateBrowserPartition('persist:wmux-login');

    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    expect(pane.surfaces.every((surface) => surface.browserPartition === 'persist:wmux-login')).toBe(true);
  });
});
