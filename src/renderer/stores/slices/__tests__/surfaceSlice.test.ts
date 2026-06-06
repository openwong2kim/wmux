import { describe, expect, it } from 'vitest';
import { createWorkspace, type Workspace } from '../../../../shared/types';
import { createSurfaceSlice } from '../surfaceSlice';

type TestState = {
  workspaces: Workspace[];
  activeWorkspaceId: string;
};

function createHarness() {
  const workspace = createWorkspace('Test');
  const state: TestState = {
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
  };

  const set = (updater: (state: TestState) => void) => {
    updater(state);
  };

  const slice = createSurfaceSlice(set as never, (() => state) as never, {} as never);
  return { state, slice };
}

describe('surfaceSlice.updateSurfaceCwd', () => {
  it('updates the cwd of the surface bound to a ptyId', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\start');

    slice.updateSurfaceCwd('pty-1', 'D:\\proj\\api');

    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    expect(pane.surfaces[0].cwd).toBe('D:\\proj\\api');
  });

  it('only touches the surface that owns the ptyId', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\a');
    slice.addSurface(paneId, 'pty-2', 'pwsh', 'C:\\b');

    slice.updateSurfaceCwd('pty-2', 'D:\\moved');

    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    expect(pane.surfaces.find((s) => s.ptyId === 'pty-1')?.cwd).toBe('C:\\a');
    expect(pane.surfaces.find((s) => s.ptyId === 'pty-2')?.cwd).toBe('D:\\moved');
  });

  it('is a no-op for an empty or unknown ptyId', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\a');

    slice.updateSurfaceCwd('', 'D:\\nope');
    slice.updateSurfaceCwd('ghost', 'D:\\nope');

    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    expect(pane.surfaces[0].cwd).toBe('C:\\a');
  });
});

describe('surfaceSlice.updateSurfaceTitle', () => {
  it('renames the surface with the given id (the tab "mark")', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\a');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    const surfaceId = pane.surfaces[0].id;

    slice.updateSurfaceTitle(surfaceId, 'api-server');

    expect(pane.surfaces[0].title).toBe('api-server');
  });
});

describe('surfaceSlice browser partition state', () => {
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
