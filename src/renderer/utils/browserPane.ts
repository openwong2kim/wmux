// ─── Browser-pane helpers (pure) ─────────────────────────────────────────────
// X3 "embedded browser pane" glue. Pure functions over the pane tree plus the
// open-or-reuse algorithm shared by every "show this URL in a browser pane"
// caller: terminal link clicks, sidebar port badges, the browser.open RPC and
// the explicit Ctrl+Shift+L / palette entry points. No store / electron /
// document imports — vitest runs in a node environment where the renderer
// store cannot be imported (see useRpcBridge.browserClose.test.ts), so the
// store surface is injected via BrowserPaneDeps and bound in
// browserPaneActions.ts.

import type { Pane, PaneLeaf, Surface } from '../../shared/types';

/** CustomEvent name BrowserPanel listens on for imperative navigation. */
export const BROWSER_NAVIGATE_EVENT = 'wmux:browser-navigate';

export interface BrowserNavigateDetail {
  surfaceId: string;
  url: string;
}

/** Default page for a browser surface opened without a URL. Mirrors the
 * fallback baked into surfaceSlice.addBrowserSurface and Pane.tsx. */
export const DEFAULT_BROWSER_URL = 'https://google.com';

/** Only http: and https: may load in a browser pane. Single source for the
 * checks previously duplicated in BrowserPanel.tsx and BrowserToolbar.tsx. */
export function isSafeBrowserUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Loopback / local-dev host detection for the smart link-routing policy.
 * Matches localhost, *.localhost, [::1], the whole 127.0.0.0/8 block and
 * 0.0.0.0 (dev servers commonly print their bind address even though it is
 * not navigable on Windows — normalizeBrowserPaneUrl rewrites it).
 */
export function isLocalhostUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    if (host === 'localhost' || host.endsWith('.localhost')) return true;
    if (host === '[::1]' || host === '0.0.0.0') return true;
    return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  } catch {
    return false;
  }
}

/** 0.0.0.0 is a bind address, not a navigable host on Windows — rewrite it to
 * 127.0.0.1 so "open in browser pane" works on dev-server output verbatim. */
export function normalizeBrowserPaneUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === '0.0.0.0') {
      parsed.hostname = '127.0.0.1';
      return parsed.toString();
    }
  } catch {
    // fall through — caller validates separately
  }
  return url;
}

/**
 * Smart routing policy for URLs clicked inside a terminal: localhost URLs go
 * to the embedded browser pane (dev-server flow), everything else opens in
 * the system browser (real cookie jar for OAuth/logins). Holding the
 * modifier (Ctrl/Cmd) inverts the choice. Non-http(s) tokens always go
 * external — shell.openExternal is the existing security boundary for those.
 */
export function resolveTerminalUrlAction(
  url: string,
  modifierHeld: boolean,
): 'browser-pane' | 'external' {
  if (!isSafeBrowserUrl(url)) return 'external';
  return isLocalhostUrl(url) !== modifierHeld ? 'browser-pane' : 'external';
}

// ─── open-or-reuse ────────────────────────────────────────────────────────────

/** The slice of a Workspace the algorithm needs (StoreState satisfies it). */
export interface BrowserPaneWorkspaceLike {
  id: string;
  rootPane: Pane;
  activePaneId: string;
}

/** Narrow, injectable view of the zustand store (structural subset of
 * StoreState — the binder passes useStore.getState directly). */
export interface BrowserPaneStoreApi {
  workspaces: BrowserPaneWorkspaceLike[];
  activeWorkspaceId: string;
  zoomedPaneId: string | null;
  splitPane: (paneId: string, direction: 'horizontal' | 'vertical', workspaceId?: string) => string | false;
  addBrowserSurface: (paneId: string, url?: string, partition?: string, workspaceId?: string) => void;
  clearSplitCwdSeed: (paneId: string) => void;
  updateBrowserUrl: (surfaceId: string, url: string) => void;
  updateBrowserPartition: (partition: string, surfaceId?: string) => void;
  setActiveSurface: (paneId: string, surfaceId: string, workspaceId?: string) => void;
  setActivePane: (paneId: string) => void;
  togglePaneZoom: (paneId: string) => void;
}

export interface BrowserPaneDeps {
  getState: () => BrowserPaneStoreApi;
  dispatchNavigate: (detail: BrowserNavigateDetail) => void;
}

export interface OpenUrlOptions {
  /** Target workspace; defaults to the active one. */
  workspaceId?: string;
  /** Session partition — applied to a reused surface ONLY when explicitly
   * given (the old browser.open reuse path force-reset it to the default,
   * remounting the webview and dropping login sessions). */
  partition?: string;
  /** Make the browser pane the active pane (default true). browser.open
   * passes false so the user keeps typing in their terminal. */
  focusPane?: boolean;
  /** Skip reuse and always split a new pane — the explicit "Open Browser"
   * entry points (Ctrl+Shift+L / palette) keep their create-new semantics so
   * a second browser pane stays possible. */
  forceNew?: boolean;
}

export type OpenUrlResult =
  | { ok: true; surfaceId: string; paneId: string; url: string; reused: boolean }
  | { ok: false; error: 'workspace-not-found' | 'pane-cap' | 'invalid-url' };

function findFirstBrowserSurface(root: Pane): { paneId: string; surface: Surface } | null {
  if (root.type === 'leaf') {
    const surface = root.surfaces.find((s) => s.surfaceType === 'browser');
    return surface ? { paneId: root.id, surface } : null;
  }
  for (const child of root.children) {
    const found = findFirstBrowserSurface(child);
    if (found) return found;
  }
  return null;
}

function findLeafById(root: Pane, id: string): PaneLeaf | null {
  if (root.type === 'leaf') return root.id === id ? root : null;
  for (const child of root.children) {
    const found = findLeafById(child, id);
    if (found) return found;
  }
  return null;
}

function paneExistsInTree(root: Pane, id: string): boolean {
  if (root.id === id) return true;
  if (root.type === 'branch') return root.children.some((c) => paneExistsInTree(c, id));
  return false;
}

/**
 * Show `url` in a browser pane of the target workspace.
 *
 * Reuse path (default): the first browser surface in tree order is navigated
 * (store write first — the source of truth that survives a multiview unmount —
 * then a BROWSER_NAVIGATE_EVENT for the mounted webview), activated, and any
 * zoom hiding it is cleared (splitPane auto-unzooms per issue #182, but reuse
 * never splits, so without this the navigation would land invisibly).
 *
 * Create path (`forceNew` or no browser surface yet): split the workspace's
 * active pane horizontally and attach a browser surface; the URL travels as
 * `initialUrl`, so no navigate event is needed.
 *
 * With `url` undefined the existing surface is merely activated (or a new one
 * opens on DEFAULT_BROWSER_URL).
 */
export function openUrlInBrowserPaneImpl(
  url: string | undefined,
  opts: OpenUrlOptions,
  deps: BrowserPaneDeps,
): OpenUrlResult {
  if (url !== undefined && !isSafeBrowserUrl(url)) return { ok: false, error: 'invalid-url' };
  const targetUrl = url === undefined ? undefined : normalizeBrowserPaneUrl(url);

  const state = deps.getState();
  const targetWsId = opts.workspaceId || state.activeWorkspaceId;
  const ws = state.workspaces.find((w) => w.id === targetWsId);
  if (!ws) return { ok: false, error: 'workspace-not-found' };
  const focusPane = opts.focusPane ?? true;

  if (!opts.forceNew) {
    const existing = findFirstBrowserSurface(ws.rootPane);
    if (existing) {
      const { paneId, surface } = existing;
      if (targetUrl) state.updateBrowserUrl(surface.id, targetUrl);
      if (opts.partition) state.updateBrowserPartition(opts.partition, surface.id);
      state.setActiveSurface(paneId, surface.id, targetWsId);

      // Un-zoom only when another pane of THIS workspace hides the browser.
      const fresh = deps.getState();
      const freshWs = fresh.workspaces.find((w) => w.id === targetWsId);
      if (
        fresh.zoomedPaneId !== null &&
        fresh.zoomedPaneId !== paneId &&
        freshWs &&
        paneExistsInTree(freshWs.rootPane, fresh.zoomedPaneId)
      ) {
        fresh.togglePaneZoom(fresh.zoomedPaneId);
      }

      if (focusPane && targetWsId === state.activeWorkspaceId) {
        deps.getState().setActivePane(paneId);
      }
      if (targetUrl) deps.dispatchNavigate({ surfaceId: surface.id, url: targetUrl });
      return {
        ok: true,
        surfaceId: surface.id,
        paneId,
        url: targetUrl || surface.browserUrl || DEFAULT_BROWSER_URL,
        reused: true,
      };
    }
  }

  // Create: split the target workspace's active pane. splitPane no-ops at the
  // per-workspace leaf cap (and pushes its own toast) — bail so the browser
  // surface is not dropped onto the still-active original pane.
  const prevActivePaneId = ws.activePaneId;
  const newPaneId = state.splitPane(prevActivePaneId, 'horizontal', targetWsId);
  // splitPane returns the exact new leaf id. Deriving it from the post-split
  // `activePaneId` is wrong for a BACKGROUND workspace, where focus scoping
  // (#236) leaves activePaneId on the original terminal pane — the browser
  // would then merge into that terminal and strand the split leaf empty.
  if (!newPaneId) {
    return { ok: false, error: 'pane-cap' };
  }

  const after = deps.getState();
  after.addBrowserSurface(newPaneId, targetUrl, opts.partition, targetWsId);
  // splitPane seeds an inherited cwd for the new pane (paneSlice #173) so a
  // terminal funnel can start the shell there. A browser leaf never goes
  // through that funnel, so the seed would leak — clear it.
  after.clearSplitCwdSeed(newPaneId);

  if (!focusPane) {
    // Restore focus to the original pane (no-op when the target workspace is
    // not the active one — setActivePane only touches the active workspace).
    deps.getState().setActivePane(prevActivePaneId);
  }

  const finalWs = deps.getState().workspaces.find((w) => w.id === targetWsId);
  const newLeaf = finalWs ? findLeafById(finalWs.rootPane, newPaneId) : null;
  // Invariant: the browser surface must have landed on the new leaf.
  // addBrowserSurface silently no-ops on an unknown pane id, which would
  // otherwise leak a bogus `{ ok: true, surfaceId: '' }`.
  const surface = newLeaf?.surfaces.find((s) => s.surfaceType === 'browser');
  if (!surface) return { ok: false, error: 'workspace-not-found' };
  return {
    ok: true,
    surfaceId: surface.id,
    paneId: newPaneId,
    url: targetUrl || DEFAULT_BROWSER_URL,
    reused: false,
  };
}
