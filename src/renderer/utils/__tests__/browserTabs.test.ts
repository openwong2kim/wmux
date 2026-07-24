import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneLeaf, Surface, Workspace } from '../../../shared/types';
import {
  closeBrowserTabInWorkspace,
  handleBrowserTabsRpc,
  listBrowserTabs,
  type BrowserTabsStoreLike,
} from '../browserTabs';
import type { OpenUrlOptions, OpenUrlResult } from '../browserPane';

function surface(
  id: string,
  type: Surface['surfaceType'],
  url?: string,
): Surface {
  return {
    id,
    ptyId: type === 'terminal' ? `pty-${id}` : '',
    title: type === 'browser' ? 'Browser' : 'Terminal',
    shell: type === 'terminal' ? 'pwsh' : '',
    cwd: '',
    surfaceType: type,
    ...(url && { browserUrl: url }),
  };
}

function leaf(id: string, surfaces: Surface[], activeSurfaceId = surfaces[0]?.id ?? ''): PaneLeaf {
  return { id, type: 'leaf', surfaces, activeSurfaceId };
}

function fixtures() {
  const paneA1 = leaf(
    'pane-a1',
    [
      surface('terminal-a', 'terminal'),
      surface('browser-a1', 'browser', 'https://a1.example/'),
    ],
    'browser-a1',
  );
  const paneA2 = leaf(
    'pane-a2',
    [surface('browser-a2', 'browser', 'https://a2.example/')],
    'browser-a2',
  );
  const paneB = leaf(
    'pane-b',
    [surface('browser-b', 'browser', 'https://b.example/')],
    'browser-b',
  );
  const wsA: Workspace = {
    id: 'ws-a',
    name: 'A',
    activePaneId: 'pane-a1',
    rootPane: {
      id: 'branch-a',
      type: 'branch',
      direction: 'horizontal',
      children: [paneA1, paneA2],
    },
  };
  const wsB: Workspace = {
    id: 'ws-b',
    name: 'B',
    activePaneId: 'pane-b',
    rootPane: paneB,
  };

  const closeSurface = vi.fn();
  const closePane = vi.fn();
  const focusPaneSurface = vi.fn(
    (workspaceId: string, paneId: string, surfaceId?: string) => {
      const workspace = [wsA, wsB].find((candidate) => candidate.id === workspaceId);
      if (!workspace) return false;
      const target = workspace.rootPane.type === 'branch'
        ? workspace.rootPane.children.find((candidate) => candidate.id === paneId)
        : workspace.rootPane.id === paneId
          ? workspace.rootPane
          : undefined;
      if (!target || target.type !== 'leaf') return false;
      workspace.activePaneId = paneId;
      if (surfaceId && target.surfaces.some((candidate) => candidate.id === surfaceId)) {
        target.activeSurfaceId = surfaceId;
      }
      return true;
    },
  );
  const state: BrowserTabsStoreLike = {
    workspaces: [wsA, wsB],
    // The user is looking at B while A's agent operates: non-yank invariant.
    activeWorkspaceId: 'ws-b',
    focusPaneSurface,
    closeSurface,
    closePane,
  };
  return { state, wsA, wsB, paneA1, paneA2, closeSurface, closePane, focusPaneSurface };
}

describe('workspace-scoped browser tab inventory', () => {
  it('lists only logical browser surfaces in the requested workspace', () => {
    const { state } = fixtures();

    expect(listBrowserTabs(state.workspaces, 'ws-a')).toEqual([
      {
        surfaceId: 'browser-a1',
        paneId: 'pane-a1',
        url: 'https://a1.example/',
        title: 'Browser',
        selected: true,
      },
      {
        surfaceId: 'browser-a2',
        paneId: 'pane-a2',
        url: 'https://a2.example/',
        title: 'Browser',
        selected: false,
      },
    ]);
  });

  it('returns an empty list without requiring any live CDP target', () => {
    const { state, paneA1, paneA2 } = fixtures();
    paneA1.surfaces = paneA1.surfaces.filter((candidate) => candidate.surfaceType !== 'browser');
    paneA2.surfaces = [];

    expect(listBrowserTabs(state.workspaces, 'ws-a')).toEqual([]);
  });

  it('returns null for an unknown workspace instead of falling back to the active one', () => {
    const { state } = fixtures();
    expect(listBrowserTabs(state.workspaces, 'ws-missing')).toBeNull();
  });
});

describe('workspace-scoped browser tab mutations', () => {
  let data: ReturnType<typeof fixtures>;

  beforeEach(() => {
    data = fixtures();
  });

  it('selects an owned surface inside its background workspace without yanking the user', () => {
    const result = handleBrowserTabsRpc(
      { action: 'select', workspaceId: 'ws-a', surfaceId: 'browser-a2' },
      { getState: () => data.state, openUrl: vi.fn() },
    );

    expect(result).toMatchObject({
      ok: true,
      action: 'select',
      tab: { surfaceId: 'browser-a2', selected: true },
    });
    expect(data.wsA.activePaneId).toBe('pane-a2');
    expect(data.state.activeWorkspaceId).toBe('ws-b');
    expect(data.focusPaneSurface).toHaveBeenCalledWith('ws-a', 'pane-a2', 'browser-a2');
  });

  it('does not reveal whether a foreign surface exists', () => {
    const foreign = handleBrowserTabsRpc(
      { action: 'select', workspaceId: 'ws-a', surfaceId: 'browser-b' },
      { getState: () => data.state, openUrl: vi.fn() },
    );
    const missing = handleBrowserTabsRpc(
      { action: 'select', workspaceId: 'ws-a', surfaceId: 'does-not-exist' },
      { getState: () => data.state, openUrl: vi.fn() },
    );

    expect(foreign).toEqual(missing);
    expect(foreign).toMatchObject({
      ok: false,
      error: { code: 'BROWSER_TAB_NOT_FOUND' },
    });
    expect(data.focusPaneSurface).not.toHaveBeenCalled();
  });

  it('closes only an owned surface and applies the last-surface pane cascade', () => {
    const result = handleBrowserTabsRpc(
      { action: 'close', workspaceId: 'ws-a', surfaceId: 'browser-a2' },
      { getState: () => data.state, openUrl: vi.fn() },
    );

    expect(result).toMatchObject({
      ok: true,
      action: 'close',
      closed: { surfaceId: 'browser-a2', paneId: 'pane-a2' },
    });
    expect(data.closeSurface).toHaveBeenCalledWith('pane-a2', 'browser-a2', 'ws-a');
    expect(data.closePane).toHaveBeenCalledWith('pane-a2', 'ws-a');
  });

  it('does not close a pane when the browser shares it with another surface', () => {
    const closed = closeBrowserTabInWorkspace(data.state, 'ws-a', 'browser-a1');

    expect(closed?.surfaceId).toBe('browser-a1');
    expect(data.closeSurface).toHaveBeenCalledWith('pane-a1', 'browser-a1', 'ws-a');
    expect(data.closePane).not.toHaveBeenCalled();
  });

  it('makes foreign close indistinguishable from a missing id and performs no mutation', () => {
    const foreign = handleBrowserTabsRpc(
      { action: 'close', workspaceId: 'ws-a', surfaceId: 'browser-b' },
      { getState: () => data.state, openUrl: vi.fn() },
    );
    const missing = handleBrowserTabsRpc(
      { action: 'close', workspaceId: 'ws-a', surfaceId: 'does-not-exist' },
      { getState: () => data.state, openUrl: vi.fn() },
    );

    expect(foreign).toEqual(missing);
    expect(data.closeSurface).not.toHaveBeenCalled();
    expect(data.closePane).not.toHaveBeenCalled();
  });

  it('creates a distinct non-yanking browser surface with forceNew semantics', () => {
    const openUrl = vi.fn(
      (url: string | undefined, options: OpenUrlOptions | undefined): OpenUrlResult => {
        expect(url).toBe('https://new.example/');
        expect(options).toMatchObject({
          workspaceId: 'ws-a',
          partition: 'persist:test',
          forceNew: true,
          focusPane: false,
        });
        if (data.wsA.rootPane.type !== 'branch') throw new Error('expected branch');
        data.wsA.rootPane.children.push(
          leaf(
            'pane-a3',
            [surface('browser-a3', 'browser', 'https://new.example/')],
            'browser-a3',
          ),
        );
        return {
          ok: true as const,
          surfaceId: 'browser-a3',
          paneId: 'pane-a3',
          url: 'https://new.example/',
          reused: false,
        };
      },
    );

    const result = handleBrowserTabsRpc(
      {
        action: 'new',
        workspaceId: 'ws-a',
        url: 'https://new.example/',
        partition: 'persist:test',
      },
      { getState: () => data.state, openUrl },
    );

    expect(result).toMatchObject({
      ok: true,
      action: 'new',
      tab: { surfaceId: 'browser-a3', paneId: 'pane-a3', selected: false },
    });
    expect(data.wsA.activePaneId).toBe('pane-a1');
    expect(data.state.activeWorkspaceId).toBe('ws-b');
  });

  it('does not report success if the create path unexpectedly reuses a surface', () => {
    const result = handleBrowserTabsRpc(
      { action: 'new', workspaceId: 'ws-a' },
      {
        getState: () => data.state,
        openUrl: vi.fn((): OpenUrlResult => ({
          ok: true,
          surfaceId: 'browser-a1',
          paneId: 'pane-a1',
          url: 'https://a1.example/',
          reused: true,
        })),
      },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'BROWSER_TAB_CREATE_FAILED' },
    });
  });

  it('fails closed when the workspace is missing', () => {
    const result = handleBrowserTabsRpc(
      { action: 'list', workspaceId: 'ws-missing' },
      { getState: () => data.state, openUrl: vi.fn() },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'BROWSER_TABS_WORKSPACE_UNRESOLVED' },
    });
  });

  it('rejects an unknown action before invoking any effect', () => {
    const openUrl = vi.fn();

    const result = handleBrowserTabsRpc(
      { action: 'move', workspaceId: 'ws-a', surfaceId: 'browser-a1' },
      { getState: () => data.state, openUrl },
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'BROWSER_TABS_INVALID_ARGUMENT' },
    });
    expect(openUrl).not.toHaveBeenCalled();
    expect(data.focusPaneSurface).not.toHaveBeenCalled();
    expect(data.closeSurface).not.toHaveBeenCalled();
  });
});
