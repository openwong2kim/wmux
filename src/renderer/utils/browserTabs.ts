import type { Pane, PaneLeaf, Surface, Workspace } from '../../shared/types';
import {
  BROWSER_TABS_ACTIONS,
  browserTabsError,
  type BrowserTabDescriptor,
  type BrowserTabsAction,
  type BrowserTabsResult,
} from '../../shared/browserTabs';
import {
  DEFAULT_BROWSER_URL,
  type OpenUrlOptions,
  type OpenUrlResult,
} from './browserPane';

export interface BrowserTabsStoreLike {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  focusPaneSurface: (workspaceId: string, paneId: string, surfaceId?: string) => boolean;
  closeSurface: (paneId: string, surfaceId: string, workspaceId?: string) => void;
  closePane: (paneId: string, workspaceId?: string) => void;
}

export interface BrowserTabsRendererDeps {
  getState: () => BrowserTabsStoreLike;
  openUrl: (url?: string, options?: OpenUrlOptions) => OpenUrlResult;
}

export interface BrowserTabsRendererParams {
  action?: unknown;
  workspaceId?: unknown;
  surfaceId?: unknown;
  url?: unknown;
  partition?: unknown;
}

interface BrowserTabTarget {
  workspace: Workspace;
  pane: PaneLeaf;
  surface: Surface;
}

function collectLeafPanes(pane: Pane): PaneLeaf[] {
  if (pane.type === 'leaf') return [pane];
  return pane.children.flatMap(collectLeafPanes);
}

function descriptor(target: BrowserTabTarget): BrowserTabDescriptor {
  return {
    surfaceId: target.surface.id,
    paneId: target.pane.id,
    url: target.surface.browserUrl || DEFAULT_BROWSER_URL,
    title: target.surface.title || 'Browser',
    selected:
      target.workspace.activePaneId === target.pane.id
      && target.pane.activeSurfaceId === target.surface.id,
  };
}

function findBrowserTab(
  workspaces: Workspace[],
  workspaceId: string,
  surfaceId: string,
): BrowserTabTarget | null {
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) return null;
  for (const pane of collectLeafPanes(workspace.rootPane)) {
    const surface = pane.surfaces.find(
      (candidate) => candidate.id === surfaceId && candidate.surfaceType === 'browser',
    );
    if (surface) return { workspace, pane, surface };
  }
  return null;
}

/**
 * Browser surfaces owned by one workspace, in pane-tree depth-first order.
 * Reads the logical surface tree only — a discarded guest (#517) has no live
 * CDP target but is still a tab, and the app shell / DevTools are not surfaces
 * so they cannot appear here.
 *
 * Returns `null` for an unknown workspace, which is NOT the same as `[]` ("the
 * workspace exists and owns no browser"). Callers must keep the two apart:
 * reporting an unresolvable workspace as an empty successful list would hide a
 * failed ownership check behind a plausible-looking answer.
 */
export function listBrowserTabs(
  workspaces: Workspace[],
  workspaceId: string,
): BrowserTabDescriptor[] | null {
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  if (!workspace) return null;

  const tabs: BrowserTabDescriptor[] = [];
  for (const pane of collectLeafPanes(workspace.rootPane)) {
    for (const surface of pane.surfaces) {
      if (surface.surfaceType !== 'browser') continue;
      tabs.push(descriptor({ workspace, pane, surface }));
    }
  }
  return tabs;
}

/**
 * Close one positively-owned browser surface and mirror the UI/browser.close
 * last-surface cascade. Lookup and mutation are synchronous so a stale list
 * result can never retarget a different surface by position. Keep closeSurface
 * and closePane adjacent with no async gap: exposing the intermediate empty
 * leaf lets AppLayout backfill it with a terminal. closePane intentionally
 * no-ops for a root leaf, matching the UI path for a workspace's final pane.
 */
export function closeBrowserTabInWorkspace(
  state: BrowserTabsStoreLike,
  workspaceId: string,
  surfaceId: string,
): BrowserTabDescriptor | null {
  const target = findBrowserTab(state.workspaces, workspaceId, surfaceId);
  if (!target) return null;

  const closed = descriptor(target);
  const wasLastSurface = target.pane.surfaces.length <= 1;
  state.closeSurface(target.pane.id, target.surface.id, target.workspace.id);
  if (wasLastSurface) {
    state.closePane(target.pane.id, target.workspace.id);
  }
  return closed;
}

const workspaceUnavailable = () =>
  browserTabsError(
    'BROWSER_TABS_WORKSPACE_UNRESOLVED',
    'The calling workspace is unavailable.',
  );

const tabNotFound = () =>
  browserTabsError(
    'BROWSER_TAB_NOT_FOUND',
    'Browser tab was not found in the calling workspace.',
  );

/**
 * Workspace-exact renderer implementation for the internal browser.tabs RPC.
 * The MCP layer supplies a strictly-resolved workspace id; this effect boundary
 * still scopes every lookup itself and never falls back to activeWorkspaceId.
 */
export function handleBrowserTabsRpc(
  params: BrowserTabsRendererParams,
  deps: BrowserTabsRendererDeps,
): BrowserTabsResult {
  const actionValue = typeof params.action === 'string' ? params.action : 'list';
  if (!(BROWSER_TABS_ACTIONS as readonly string[]).includes(actionValue)) {
    return browserTabsError(
      'BROWSER_TABS_INVALID_ARGUMENT',
      `Unknown browser_tabs action "${actionValue}".`,
    );
  }
  const action = actionValue as BrowserTabsAction;
  const workspaceId =
    typeof params.workspaceId === 'string' && params.workspaceId.length > 0
      ? params.workspaceId
      : '';
  if (!workspaceId) return workspaceUnavailable();

  const state = deps.getState();
  if (!state.workspaces.some((workspace) => workspace.id === workspaceId)) {
    return workspaceUnavailable();
  }

  if (action === 'list') {
    const tabs = listBrowserTabs(state.workspaces, workspaceId);
    return tabs ? { ok: true, action, tabs } : workspaceUnavailable();
  }

  if (action === 'new') {
    const url = typeof params.url === 'string' ? params.url : undefined;
    const partition = typeof params.partition === 'string' ? params.partition : undefined;
    const opened = deps.openUrl(url, {
      workspaceId,
      partition,
      forceNew: true,
      focusPane: false,
    });
    if (!opened.ok) {
      const message =
        opened.error === 'pane-cap'
          ? 'Browser tab could not be created because the workspace pane cap was reached.'
          : opened.error === 'invalid-url'
            ? 'Browser tab URL is not allowed.'
            : 'Browser tab could not be created in the calling workspace.';
      return browserTabsError(
        opened.error === 'invalid-url' ? 'BROWSER_TAB_URL_BLOCKED' : 'BROWSER_TAB_CREATE_FAILED',
        message,
      );
    }
    if (opened.reused) {
      return browserTabsError(
        'BROWSER_TAB_CREATE_FAILED',
        'Browser tab creation unexpectedly reused an existing surface.',
      );
    }

    const target = findBrowserTab(deps.getState().workspaces, workspaceId, opened.surfaceId);
    return target
      ? { ok: true, action, tab: descriptor(target) }
      : browserTabsError(
          'BROWSER_TAB_CREATE_FAILED',
          'Browser tab creation did not produce a logical browser surface.',
        );
  }

  const surfaceId =
    typeof params.surfaceId === 'string' && params.surfaceId.length > 0
      ? params.surfaceId
      : '';
  if (!surfaceId) {
    return browserTabsError(
      'BROWSER_TABS_INVALID_ARGUMENT',
      `browser_tabs ${action} requires a surfaceId returned by browser_tabs list.`,
    );
  }

  if (action === 'select') {
    const target = findBrowserTab(state.workspaces, workspaceId, surfaceId);
    if (!target) return tabNotFound();

    if (!state.focusPaneSurface(workspaceId, target.pane.id, surfaceId)) {
      return tabNotFound();
    }
    const selected = findBrowserTab(deps.getState().workspaces, workspaceId, surfaceId);
    return selected ? { ok: true, action, tab: descriptor(selected) } : tabNotFound();
  }

  if (action === 'close') {
    const closed = closeBrowserTabInWorkspace(state, workspaceId, surfaceId);
    return closed ? { ok: true, action, closed } : tabNotFound();
  }

  return browserTabsError('BROWSER_TABS_INVALID_ARGUMENT', 'Unknown browser_tabs action.');
}
