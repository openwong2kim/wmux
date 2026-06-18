import { describe, expect, it } from 'vitest';
import { createWorkspace, type Workspace } from '../../../../shared/types';
import { createSurfaceSlice } from '../surfaceSlice';

type TestState = {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  surfaceAgent: Record<string, { name: string; status: string }>;
  surfaceActivity: Record<string, string>;
};

function createHarness() {
  const workspace = createWorkspace('Test');
  const state: TestState = {
    workspaces: [workspace],
    activeWorkspaceId: workspace.id,
    surfaceAgent: {},
    surfaceActivity: {},
  };

  const set = (updater: (state: TestState) => void) => {
    updater(state);
  };

  const slice = createSurfaceSlice(set as never, (() => state) as never, {} as never);
  return { state, slice };
}

describe('surfaceSlice.addSurface — workspace targeting (#236)', () => {
  it('lands the surface in a background workspace when workspaceId is given', () => {
    const { state, slice } = createHarness();
    const ws1 = state.workspaces[0];
    const ws2 = createWorkspace('Background');
    state.workspaces.push(ws2);

    slice.addSurface(ws2.rootPane.id, 'pty-bg', 'pwsh', 'D:\\bg', ws2.id);

    const ws2Pane = state.workspaces.find((w) => w.id === ws2.id)!.rootPane;
    if (ws2Pane.type !== 'leaf') throw new Error('expected leaf');
    expect(ws2Pane.surfaces).toHaveLength(1);
    expect(ws2Pane.surfaces[0].ptyId).toBe('pty-bg');

    // ws1 (the active ws) must NOT receive the surface.
    const ws1Pane = ws1.rootPane;
    if (ws1Pane.type !== 'leaf') throw new Error('expected leaf');
    expect(ws1Pane.surfaces).toHaveLength(0);
    expect(state.activeWorkspaceId).toBe(ws1.id);
  });

  it('defaults to the active workspace when workspaceId is omitted (back-compat)', () => {
    const { state, slice } = createHarness();
    slice.addSurface(state.workspaces[0].rootPane.id, 'pty-1', 'pwsh', 'C:\\a');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf');
    expect(pane.surfaces).toHaveLength(1);
    expect(pane.surfaces[0].ptyId).toBe('pty-1');
  });
});

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

describe('surfaceSlice.updateSurfaceTitleByPty', () => {
  it('sets the title of the terminal surface bound to a ptyId', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\a');

    slice.updateSurfaceTitleByPty('pty-1', 'claude: feature-x');

    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    expect(pane.surfaces[0].title).toBe('claude: feature-x');
  });

  it('is a no-op for an unknown ptyId', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\a');
    const pane0 = state.workspaces[0].rootPane;
    if (pane0.type !== 'leaf') throw new Error('expected leaf pane');
    const before = pane0.surfaces[0].title;

    slice.updateSurfaceTitleByPty('ghost', 'nope');

    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    expect(pane.surfaces[0].title).toBe(before);
  });

  it('is ignored once the surface title is locked by a manual rename', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\a');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    const surfaceId = pane.surfaces[0].id;

    slice.updateSurfaceTitle(surfaceId, 'my-name'); // manual rename → locks
    slice.updateSurfaceTitleByPty('pty-1', 'shell-set'); // must be ignored

    expect(pane.surfaces[0].title).toBe('my-name');
    expect(pane.surfaces[0].titleLocked).toBe(true);
  });
});

describe('surfaceSlice.updateBrowserUrl', () => {
  function harnessWithBrowser() {
    const h = createHarness();
    const paneId = h.state.workspaces[0].rootPane.id;
    h.slice.addBrowserSurface(paneId, 'https://start.example', 'persist:wmux-default');
    const pane = h.state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    return { ...h, pane, surfaceId: pane.surfaces[0].id };
  }

  it('persists the navigated URL on the browser surface', () => {
    const { pane, slice, surfaceId } = harnessWithBrowser();

    slice.updateBrowserUrl(surfaceId, 'http://localhost:5173/app');

    expect(pane.surfaces[0].browserUrl).toBe('http://localhost:5173/app');
  });

  it('ignores non-http(s) URLs (about:blank must not survive into the session)', () => {
    const { pane, slice, surfaceId } = harnessWithBrowser();

    slice.updateBrowserUrl(surfaceId, 'about:blank');
    slice.updateBrowserUrl(surfaceId, 'devtools://devtools/x');

    expect(pane.surfaces[0].browserUrl).toBe('https://start.example');
  });

  it('ignores terminal surfaces and unknown surface ids', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\a');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');

    slice.updateBrowserUrl(pane.surfaces[0].id, 'http://localhost:1');
    slice.updateBrowserUrl('ghost', 'http://localhost:1');

    expect(pane.surfaces[0].browserUrl).toBeUndefined();
  });
});

describe('surfaceSlice.setActiveSurface', () => {
  it('targets the active workspace when no workspaceId is given', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', '');
    slice.addSurface(paneId, 'pty-2', 'pwsh', '');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');

    slice.setActiveSurface(paneId, pane.surfaces[0].id);

    expect(pane.activeSurfaceId).toBe(pane.surfaces[0].id);
  });

  it('targets a non-active workspace via the workspaceId parameter', () => {
    const { state, slice } = createHarness();
    const other = createWorkspace('Other');
    state.workspaces.push(other);
    slice.addBrowserSurface(other.rootPane.id, 'https://x.example', undefined, other.id);
    const pane = other.rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    pane.surfaces.push({ ...pane.surfaces[0], id: 'surface-second' });

    slice.setActiveSurface(pane.id, pane.surfaces[0].id, other.id);

    expect(pane.activeSurfaceId).toBe(pane.surfaces[0].id);
    expect(state.activeWorkspaceId).not.toBe(other.id);
  });
});

describe('surfaceSlice.closeSurface', () => {
  it('targets the active workspace when no workspaceId is given', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', '');
    slice.addSurface(paneId, 'pty-2', 'pwsh', '');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    const firstId = pane.surfaces[0].id;

    slice.closeSurface(paneId, firstId);

    expect(pane.surfaces).toHaveLength(1);
    expect(pane.surfaces.find((s) => s.id === firstId)).toBeUndefined();
  });

  it('targets a non-active workspace via the workspaceId parameter', () => {
    const { state, slice } = createHarness();
    const other = createWorkspace('Other');
    state.workspaces.push(other);
    slice.addBrowserSurface(other.rootPane.id, 'https://x.example', undefined, other.id);
    const pane = other.rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    const surfaceId = pane.surfaces[0].id;

    slice.closeSurface(pane.id, surfaceId, other.id);

    expect(pane.surfaces).toHaveLength(0);
    expect(state.activeWorkspaceId).not.toBe(other.id);
  });

  it('is a no-op for a non-active workspace pane without the workspaceId parameter', () => {
    // Documents WHY callers must thread workspaceId: the pane lookup runs
    // inside one workspace tree, so a background-workspace pane silently
    // no-ops instead of closing (the browser.close asymmetry).
    const { state, slice } = createHarness();
    const other = createWorkspace('Other');
    state.workspaces.push(other);
    slice.addBrowserSurface(other.rootPane.id, 'https://x.example', undefined, other.id);
    const pane = other.rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');

    slice.closeSurface(pane.id, pane.surfaces[0].id);

    expect(pane.surfaces).toHaveLength(1);
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

describe('surfaceSlice.closeSurface — surfaceAgent cleanup (Part A leak-prevention)', () => {
  it('clears the surfaceAgent entry for the closed surface ptyId', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\a');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    const surfaceId = pane.surfaces.find((s) => s.ptyId === 'pty-1')!.id;
    state.surfaceAgent['pty-1'] = { name: 'Claude Code', status: 'running' };

    slice.closeSurface(paneId, surfaceId);

    expect(state.surfaceAgent['pty-1']).toBeUndefined();
  });
});

describe('surfaceSlice.closeSurface — surfaceActivity cleanup (Fleet activity teardown)', () => {
  it('clears the surfaceActivity entry for the closed surface ptyId (the OTHER real teardown site)', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\a');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    const surfaceId = pane.surfaces.find((s) => s.ptyId === 'pty-1')!.id;
    state.surfaceActivity['pty-1'] = '✎ fleet.ts';

    slice.closeSurface(paneId, surfaceId);

    expect(state.surfaceActivity['pty-1']).toBeUndefined();
  });

  it('leaves activity for other surfaces untouched when one closes', () => {
    const { state, slice } = createHarness();
    const paneId = state.workspaces[0].rootPane.id;
    slice.addSurface(paneId, 'pty-1', 'pwsh', 'C:\\a');
    slice.addSurface(paneId, 'pty-2', 'pwsh', 'C:\\b');
    const pane = state.workspaces[0].rootPane;
    if (pane.type !== 'leaf') throw new Error('expected leaf pane');
    const surfaceId1 = pane.surfaces.find((s) => s.ptyId === 'pty-1')!.id;
    state.surfaceActivity['pty-1'] = '$ build';
    state.surfaceActivity['pty-2'] = '✎ keep.ts';

    slice.closeSurface(paneId, surfaceId1);

    expect(state.surfaceActivity['pty-1']).toBeUndefined();
    expect(state.surfaceActivity['pty-2']).toBe('✎ keep.ts');
  });
});
