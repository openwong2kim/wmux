import { describe, it, expect, beforeEach, vi } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createPaneSlice, type PaneSlice, MAX_PANES_PER_WORKSPACE } from '../../stores/slices/paneSlice';
import { createSurfaceSlice, type SurfaceSlice } from '../../stores/slices/surfaceSlice';
import { createWorkspace, createLeafPane, type Workspace } from '../../../shared/types';
import { getLeafPanes, findLeaf } from '../../../shared/paneUtils';
import {
  isSafeBrowserUrl,
  isLocalhostUrl,
  normalizeBrowserPaneUrl,
  resolveTerminalUrlAction,
  openUrlInBrowserPaneImpl,
  type BrowserNavigateDetail,
  type BrowserPaneStoreApi,
} from '../browserPane';

// ---------------------------------------------------------------------------
// URL predicates
// ---------------------------------------------------------------------------

describe('isSafeBrowserUrl', () => {
  it('accepts http and https', () => {
    expect(isSafeBrowserUrl('http://localhost:3000')).toBe(true);
    expect(isSafeBrowserUrl('https://github.com/a/b')).toBe(true);
  });

  it('rejects other schemes and garbage', () => {
    expect(isSafeBrowserUrl('file:///C:/Windows')).toBe(false);
    expect(isSafeBrowserUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeBrowserUrl('chrome://settings')).toBe(false);
    expect(isSafeBrowserUrl('not a url')).toBe(false);
    expect(isSafeBrowserUrl('')).toBe(false);
  });
});

describe('isLocalhostUrl', () => {
  it('matches localhost, *.localhost, [::1], 127.0.0.0/8 and 0.0.0.0', () => {
    expect(isLocalhostUrl('http://localhost:3000')).toBe(true);
    expect(isLocalhostUrl('http://app.localhost/path')).toBe(true);
    expect(isLocalhostUrl('http://[::1]:8080')).toBe(true);
    expect(isLocalhostUrl('http://127.0.0.1')).toBe(true);
    expect(isLocalhostUrl('http://127.5.4.3:99')).toBe(true);
    expect(isLocalhostUrl('http://0.0.0.0:5173')).toBe(true);
  });

  it('rejects external and LAN hosts and garbage', () => {
    expect(isLocalhostUrl('https://github.com')).toBe(false);
    expect(isLocalhostUrl('http://192.168.0.10:3000')).toBe(false);
    expect(isLocalhostUrl('http://mylocalhost.dev')).toBe(false);
    expect(isLocalhostUrl('not a url')).toBe(false);
  });
});

describe('normalizeBrowserPaneUrl', () => {
  it('rewrites 0.0.0.0 to 127.0.0.1 preserving port and path', () => {
    expect(normalizeBrowserPaneUrl('http://0.0.0.0:5173/app?x=1')).toBe('http://127.0.0.1:5173/app?x=1');
  });

  it('leaves every other URL untouched', () => {
    expect(normalizeBrowserPaneUrl('http://localhost:3000/')).toBe('http://localhost:3000/');
    expect(normalizeBrowserPaneUrl('https://github.com')).toBe('https://github.com');
    expect(normalizeBrowserPaneUrl('not a url')).toBe('not a url');
  });
});

describe('resolveTerminalUrlAction', () => {
  it('routes localhost to the browser pane and external to the system browser', () => {
    expect(resolveTerminalUrlAction('http://localhost:3000', false)).toBe('browser-pane');
    expect(resolveTerminalUrlAction('https://github.com', false)).toBe('external');
  });

  it('inverts both directions when the modifier is held', () => {
    expect(resolveTerminalUrlAction('http://localhost:3000', true)).toBe('external');
    expect(resolveTerminalUrlAction('https://github.com', true)).toBe('browser-pane');
  });

  it('always sends non-http(s) tokens external regardless of modifier', () => {
    expect(resolveTerminalUrlAction('file:///C:/x', false)).toBe('external');
    expect(resolveTerminalUrlAction('file:///C:/x', true)).toBe('external');
  });
});

// ---------------------------------------------------------------------------
// openUrlInBrowserPaneImpl — real paneSlice + surfaceSlice store
// ---------------------------------------------------------------------------

type TestState = PaneSlice & SurfaceSlice & {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  pushToast: ReturnType<typeof vi.fn>;
  zoomedPaneId: string | null;
  togglePaneZoom: (paneId: string) => void;
};

function createTestStore() {
  const ws = createWorkspace('Test');
  return create<TestState>()(
    immer((...args) => {
      const set = args[0];
      return {
        workspaces: [ws],
        activeWorkspaceId: ws.id,
        pushToast: vi.fn(),
        zoomedPaneId: null,
        // Mirror of uiSlice.togglePaneZoom — uiSlice itself drags in too many
        // renderer-only dependencies for a node-env test store.
        togglePaneZoom: (paneId: string) =>
          set((state) => {
            state.zoomedPaneId = state.zoomedPaneId === paneId ? null : paneId;
          }),
        // @ts-expect-error — minimal test store doesn't match full StoreState
        ...createPaneSlice(...args),
        // @ts-expect-error — minimal test store doesn't match full StoreState
        ...createSurfaceSlice(...args),
      };
    })
  );
}

type TestStore = ReturnType<typeof createTestStore>;

function makeDeps(store: TestStore) {
  const dispatched: BrowserNavigateDetail[] = [];
  return {
    deps: {
      getState: () => store.getState() as unknown as BrowserPaneStoreApi,
      dispatchNavigate: (d: BrowserNavigateDetail) => dispatched.push(d),
    },
    dispatched,
  };
}

function activeWs(store: TestStore): Workspace {
  const s = store.getState();
  const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
  if (!ws) throw new Error('active workspace missing');
  return ws;
}

function firstBrowser(ws: Workspace) {
  for (const leaf of getLeafPanes(ws.rootPane)) {
    const surface = leaf.surfaces.find((s) => s.surfaceType === 'browser');
    if (surface) return { leaf, surface };
  }
  throw new Error('no browser surface in workspace');
}

describe('openUrlInBrowserPaneImpl', () => {
  let store: TestStore;

  beforeEach(() => {
    store = createTestStore();
  });

  describe('input validation', () => {
    it('rejects non-http(s) URLs without touching the store', () => {
      const { deps, dispatched } = makeDeps(store);
      const before = activeWs(store).rootPane;

      const result = openUrlInBrowserPaneImpl('file:///C:/x', {}, deps);

      expect(result).toEqual({ ok: false, error: 'invalid-url' });
      expect(activeWs(store).rootPane).toBe(before);
      expect(dispatched).toHaveLength(0);
    });

    it('fails closed for an unknown workspace id', () => {
      const { deps } = makeDeps(store);
      const result = openUrlInBrowserPaneImpl('http://localhost:1', { workspaceId: 'ghost' }, deps);
      expect(result).toEqual({ ok: false, error: 'workspace-not-found' });
    });
  });

  describe('create path (no browser surface yet)', () => {
    it('splits the active pane and attaches a browser surface carrying the URL', () => {
      const { deps, dispatched } = makeDeps(store);
      const rootId = activeWs(store).rootPane.id;

      const result = openUrlInBrowserPaneImpl('http://localhost:5173', {}, deps);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.reused).toBe(false);
      const ws = activeWs(store);
      const leaves = getLeafPanes(ws.rootPane);
      expect(leaves).toHaveLength(2);
      const { leaf, surface } = firstBrowser(ws);
      expect(surface.browserUrl).toBe('http://localhost:5173');
      expect(surface.id).toBe(result.surfaceId);
      expect(leaf.id).toBe(result.paneId);
      expect(leaf.id).not.toBe(rootId);
      // URL travels as initialUrl — no navigate event needed on create.
      expect(dispatched).toHaveLength(0);
      // Default focusPane: the new browser pane is active.
      expect(ws.activePaneId).toBe(leaf.id);
    });

    it('focusPane:false restores the original active pane (browser.open semantics)', () => {
      const { deps } = makeDeps(store);
      const rootId = activeWs(store).rootPane.id;

      const result = openUrlInBrowserPaneImpl('http://localhost:5173', { focusPane: false }, deps);

      expect(result.ok).toBe(true);
      expect(activeWs(store).activePaneId).toBe(rootId);
    });

    it('returns pane-cap and adds nothing when the workspace is at the leaf cap', () => {
      const { deps } = makeDeps(store);
      store.setState((state) => {
        const ws = state.workspaces[0];
        ws.rootPane = {
          id: 'branch-full',
          type: 'branch',
          direction: 'horizontal',
          children: Array.from({ length: MAX_PANES_PER_WORKSPACE }, () => createLeafPane()),
        };
        ws.activePaneId = ws.rootPane.type === 'branch' ? ws.rootPane.children[0].id : '';
      });

      const result = openUrlInBrowserPaneImpl('http://localhost:1', {}, deps);

      expect(result).toEqual({ ok: false, error: 'pane-cap' });
      const leaves = getLeafPanes(activeWs(store).rootPane);
      expect(leaves).toHaveLength(MAX_PANES_PER_WORKSPACE);
      expect(leaves.every((l) => l.surfaces.every((s) => s.surfaceType !== 'browser'))).toBe(true);
    });

    it('forceNew splits even when a browser surface already exists', () => {
      const { deps, dispatched } = makeDeps(store);
      const rootId = activeWs(store).rootPane.id;
      store.getState().addBrowserSurface(rootId, 'https://old.example');

      const result = openUrlInBrowserPaneImpl('http://localhost:9', { forceNew: true }, deps);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.reused).toBe(false);
      const leaves = getLeafPanes(activeWs(store).rootPane);
      expect(leaves).toHaveLength(2);
      const browserCount = leaves.flatMap((l) => l.surfaces).filter((s) => s.surfaceType === 'browser').length;
      expect(browserCount).toBe(2);
      expect(dispatched).toHaveLength(0);
    });

    it('normalizes a 0.0.0.0 bind address to 127.0.0.1', () => {
      const { deps } = makeDeps(store);

      const result = openUrlInBrowserPaneImpl('http://0.0.0.0:5173/', {}, deps);

      expect(result.ok).toBe(true);
      expect(firstBrowser(activeWs(store)).surface.browserUrl).toBe('http://127.0.0.1:5173/');
    });
  });

  describe('background create path (#531)', () => {
    // Build a second workspace B that holds a single terminal pane, leave the
    // original workspace A active, and return the ids the assertions need.
    function backgroundWsWithTerminal(cwd = 'D:\\proj') {
      const other = createWorkspace('Background');
      store.setState((state) => {
        state.workspaces.push(other);
      });
      const terminalPaneId = other.rootPane.id;
      store.getState().addSurface(terminalPaneId, 'pty-b', 'pwsh', cwd, other.id);
      return { wsId: other.id, terminalPaneId };
    }

    it('routes the browser into the freshly split pane, not the agent terminal', () => {
      const { deps } = makeDeps(store);
      const activeBefore = store.getState().activeWorkspaceId;
      const { wsId, terminalPaneId } = backgroundWsWithTerminal();

      const result = openUrlInBrowserPaneImpl(
        'http://localhost:5173',
        { workspaceId: wsId, focusPane: false },
        deps,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.reused).toBe(false);

      const state = store.getState();
      const wsB = state.workspaces.find((w) => w.id === wsId)!;

      // 1. No focus hijack — the user's active workspace is untouched.
      expect(state.activeWorkspaceId).toBe(activeBefore);
      // 2. B's own selection stays on the original terminal pane (focus scoping).
      expect(wsB.activePaneId).toBe(terminalPaneId);
      // 3. The browser landed on the returned NEW pane; the terminal pane keeps
      //    exactly its one terminal surface (no 1:1 clone merge).
      const newLeaf = findLeaf(wsB.rootPane, result.paneId)!;
      expect(newLeaf.id).not.toBe(terminalPaneId);
      expect(newLeaf.surfaces.map((s) => s.surfaceType)).toEqual(['browser']);
      const terminalLeaf = findLeaf(wsB.rootPane, terminalPaneId)!;
      expect(terminalLeaf.surfaces).toHaveLength(1);
      expect(terminalLeaf.surfaces[0].surfaceType ?? 'terminal').toBe('terminal');
      // 4. No stray empty leaf left for EmptyLeafFunnel to fill with a PTY.
      const emptyLeaves = getLeafPanes(wsB.rootPane).filter((l) => l.surfaces.length === 0);
      expect(emptyLeaves).toHaveLength(0);
      // 5. The inherited-cwd seed for the browser pane is cleared (it never
      //    reaches the terminal funnel, so it would otherwise leak).
      expect(state.splitCwdSeed[result.paneId]).toBeUndefined();
    });

    it('clears the inherited-cwd seed even when the source terminal has a cwd', () => {
      const { deps } = makeDeps(store);
      const { wsId } = backgroundWsWithTerminal('D:\\src\\app');

      const result = openUrlInBrowserPaneImpl(
        'http://localhost:5173',
        { workspaceId: wsId, focusPane: false },
        deps,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(store.getState().splitCwdSeed[result.paneId]).toBeUndefined();
    });

    it('active create still routes the browser into the new pane (no regression)', () => {
      const { deps } = makeDeps(store);
      // A single-workspace store: the active workspace holds one terminal pane.
      const activeWsId = store.getState().activeWorkspaceId;
      const terminalPaneId = activeWs(store).rootPane.id;
      store.getState().addSurface(terminalPaneId, 'pty-a', 'pwsh', 'D:\\proj', activeWsId);

      const result = openUrlInBrowserPaneImpl('http://localhost:5173', {}, deps);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const ws = activeWs(store);
      const newLeaf = findLeaf(ws.rootPane, result.paneId)!;
      expect(newLeaf.id).not.toBe(terminalPaneId);
      expect(newLeaf.surfaces.map((s) => s.surfaceType)).toEqual(['browser']);
      // Active split: the browser pane becomes the active selection.
      expect(ws.activePaneId).toBe(result.paneId);
      expect(store.getState().splitCwdSeed[result.paneId]).toBeUndefined();
    });
  });

  describe('reuse path (browser surface exists)', () => {
    it('navigates and activates the existing surface without splitting', () => {
      const { deps, dispatched } = makeDeps(store);
      const rootId = activeWs(store).rootPane.id;
      store.getState().addBrowserSurface(rootId, 'https://old.example', 'persist:wmux-special');
      const surfaceId = firstBrowser(activeWs(store)).surface.id;

      const result = openUrlInBrowserPaneImpl('http://localhost:3000', {}, deps);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result).toMatchObject({ reused: true, surfaceId, paneId: rootId, url: 'http://localhost:3000' });
      const ws = activeWs(store);
      expect(getLeafPanes(ws.rootPane)).toHaveLength(1);
      const { leaf, surface } = firstBrowser(ws);
      expect(surface.browserUrl).toBe('http://localhost:3000');
      // Partition untouched when not explicitly given (a reset would remount
      // the webview and drop the login session).
      expect(surface.browserPartition).toBe('persist:wmux-special');
      expect(leaf.activeSurfaceId).toBe(surfaceId);
      expect(dispatched).toEqual([{ surfaceId, url: 'http://localhost:3000' }]);
    });

    it('applies the partition only when explicitly provided', () => {
      const { deps } = makeDeps(store);
      const rootId = activeWs(store).rootPane.id;
      store.getState().addBrowserSurface(rootId, 'https://old.example', 'persist:wmux-special');
      const surfaceId = firstBrowser(activeWs(store)).surface.id;

      openUrlInBrowserPaneImpl('http://localhost:3000', { partition: 'persist:wmux-login' }, deps);

      const { surface } = firstBrowser(activeWs(store));
      expect(surface.id).toBe(surfaceId);
      expect(surface.browserPartition).toBe('persist:wmux-login');
    });

    it('activates without navigating when no URL is given', () => {
      const { deps, dispatched } = makeDeps(store);
      const rootId = activeWs(store).rootPane.id;
      store.getState().addBrowserSurface(rootId, 'https://old.example');

      const result = openUrlInBrowserPaneImpl(undefined, {}, deps);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.reused).toBe(true);
      expect(result.url).toBe('https://old.example');
      expect(firstBrowser(activeWs(store)).surface.browserUrl).toBe('https://old.example');
      expect(dispatched).toHaveLength(0);
    });

    it('focuses the browser pane by default and keeps focus with focusPane:false', () => {
      const { deps } = makeDeps(store);
      const rootId = activeWs(store).rootPane.id;
      store.getState().splitPane(rootId, 'horizontal');
      const browserPaneId = activeWs(store).activePaneId; // new pane after split
      store.getState().addBrowserSurface(browserPaneId);
      store.getState().setActivePane(rootId);

      openUrlInBrowserPaneImpl('http://localhost:3000', { focusPane: false }, deps);
      expect(activeWs(store).activePaneId).toBe(rootId);

      openUrlInBrowserPaneImpl('http://localhost:3000', {}, deps);
      expect(activeWs(store).activePaneId).toBe(browserPaneId);
    });

    it('clears a zoom that would hide the browser pane (same workspace only)', () => {
      const { deps } = makeDeps(store);
      const rootId = activeWs(store).rootPane.id;
      store.getState().splitPane(rootId, 'horizontal');
      const browserPaneId = activeWs(store).activePaneId;
      store.getState().addBrowserSurface(browserPaneId);
      store.setState({ zoomedPaneId: rootId }); // sibling terminal is zoomed

      openUrlInBrowserPaneImpl('http://localhost:3000', {}, deps);

      expect(store.getState().zoomedPaneId).toBeNull();
    });

    it('keeps the zoom when the browser pane itself is zoomed', () => {
      const { deps } = makeDeps(store);
      const rootId = activeWs(store).rootPane.id;
      store.getState().addBrowserSurface(rootId);
      store.setState({ zoomedPaneId: rootId });

      openUrlInBrowserPaneImpl('http://localhost:3000', {}, deps);

      expect(store.getState().zoomedPaneId).toBe(rootId);
    });

    it('does not touch a zoom belonging to another workspace', () => {
      const { deps } = makeDeps(store);
      const rootId = activeWs(store).rootPane.id;
      store.getState().addBrowserSurface(rootId);
      store.setState({ zoomedPaneId: 'pane-elsewhere' });

      openUrlInBrowserPaneImpl('http://localhost:3000', {}, deps);

      expect(store.getState().zoomedPaneId).toBe('pane-elsewhere');
    });

    it('targets a non-active workspace without switching the active one', () => {
      const { deps, dispatched } = makeDeps(store);
      const other = createWorkspace('Other');
      store.setState((state) => {
        state.workspaces.push(other);
      });
      store.getState().addBrowserSurface(other.rootPane.id, 'https://old.example', undefined, other.id);

      const result = openUrlInBrowserPaneImpl('http://localhost:4000', { workspaceId: other.id }, deps);

      expect(result.ok).toBe(true);
      const state = store.getState();
      expect(state.activeWorkspaceId).not.toBe(other.id);
      const otherWs = state.workspaces.find((w) => w.id === other.id);
      if (!otherWs) throw new Error('other workspace missing');
      const { leaf, surface } = firstBrowser(otherWs);
      expect(surface.browserUrl).toBe('http://localhost:4000');
      expect(leaf.activeSurfaceId).toBe(surface.id);
      expect(dispatched).toEqual([{ surfaceId: surface.id, url: 'http://localhost:4000' }]);
    });
  });
});
