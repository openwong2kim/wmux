import { useEffect } from 'react';
import { useStore } from '../stores';
import type { Pane, PaneLeaf } from '../../shared/types';

// ---------------------------------------------------------------------------
// Pane tree utilities
// ---------------------------------------------------------------------------

function findLeafPanes(root: Pane): PaneLeaf[] {
  if (root.type === 'leaf') return [root];
  return root.children.flatMap(findLeafPanes);
}

function findPaneById(root: Pane, id: string): Pane | null {
  if (root.id === id) return root;
  if (root.type === 'branch') {
    for (const child of root.children) {
      const found = findPaneById(child, id);
      if (found) return found;
    }
  }
  return null;
}

/** Find which leaf pane contains the given surfaceId. */
function findLeafBySurfaceId(root: Pane, surfaceId: string): PaneLeaf | null {
  const leaves = findLeafPanes(root);
  return leaves.find((l) => l.surfaces.some((s) => s.id === surfaceId)) ?? null;
}

// ---------------------------------------------------------------------------
// RPC method handler type
// ---------------------------------------------------------------------------

type RpcParams = Record<string, unknown>;
type RpcResult = unknown;

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useRpcBridge(): void {
  useEffect(() => {
    // ── RPC command listener ─────────────────────────────────────────────────
    const cleanupRpc = window.electronAPI.rpc.onCommand(
      async (requestId: string, method: string, params: RpcParams) => {
        let result: RpcResult;
        try {
          result = await handleRpcMethod(method, params);
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
        }
        window.electronAPI.rpc.respond(requestId, result);
      },
    );

    return () => {
      cleanupRpc();
    };
  }, []);
}

// ---------------------------------------------------------------------------
// Dispatch table
// ---------------------------------------------------------------------------

async function handleRpcMethod(method: string, params: RpcParams): Promise<RpcResult> {
  // Always read the freshest state via getState() to avoid stale closures.
  const store = useStore.getState();

  // -------------------------------------------------------------------------
  // workspace.*
  // -------------------------------------------------------------------------

  if (method === 'workspace.list') {
    return store.workspaces.map((w) => ({ id: w.id, name: w.name }));
  }

  if (method === 'workspace.new') {
    const name = typeof params.name === 'string' ? params.name : undefined;
    store.addWorkspace(name);
    // After mutation, fetch updated state.
    const updated = useStore.getState();
    const created = updated.workspaces.find((w) => w.id === updated.activeWorkspaceId);
    return created ? { id: created.id, name: created.name } : null;
  }

  if (method === 'workspace.focus') {
    const id = String(params.id ?? '');
    store.setActiveWorkspace(id);
    return { ok: true };
  }

  if (method === 'workspace.close') {
    const id = String(params.id ?? '');
    store.removeWorkspace(id);
    return { ok: true };
  }

  if (method === 'workspace.current') {
    const ws = store.workspaces.find((w) => w.id === store.activeWorkspaceId);
    return ws ? { id: ws.id, name: ws.name } : null;
  }

  // -------------------------------------------------------------------------
  // surface.*
  // -------------------------------------------------------------------------

  if (method === 'surface.list') {
    const ws = store.workspaces.find((w) => w.id === store.activeWorkspaceId);
    if (!ws) return [];
    const activePane = findPaneById(ws.rootPane, ws.activePaneId);
    if (!activePane || activePane.type !== 'leaf') return [];
    return activePane.surfaces.map((s) => ({
      id: s.id,
      ptyId: s.ptyId,
      title: s.title,
      shell: s.shell,
      cwd: s.cwd,
    }));
  }

  if (method === 'surface.new') {
    const ws = store.workspaces.find((w) => w.id === store.activeWorkspaceId);
    if (!ws) return { error: 'no active workspace' };

    const paneId = ws.activePaneId;
    const shell = typeof params.shell === 'string' ? params.shell : '';
    const cwd = typeof params.cwd === 'string' ? params.cwd : '';

    const { id: ptyId } = await window.electronAPI.pty.create({
      shell: shell || undefined,
      cwd: cwd || undefined,
    });

    // Re-read state after async gap.
    store.addSurface(paneId, ptyId, shell, cwd);

    const fresh = useStore.getState();
    const freshWs = fresh.workspaces.find((w) => w.id === fresh.activeWorkspaceId);
    if (!freshWs) return { ptyId };
    const pane = findPaneById(freshWs.rootPane, paneId);
    if (!pane || pane.type !== 'leaf') return { ptyId };
    const surface = pane.surfaces.find((s) => s.ptyId === ptyId);
    return surface
      ? { id: surface.id, ptyId: surface.ptyId, title: surface.title, shell: surface.shell, cwd: surface.cwd }
      : { ptyId };
  }

  if (method === 'surface.focus') {
    const surfaceId = String(params.id ?? '');
    const ws = store.workspaces.find((w) => w.id === store.activeWorkspaceId);
    if (!ws) return { error: 'no active workspace' };

    const targetLeaf = findLeafBySurfaceId(ws.rootPane, surfaceId);
    if (!targetLeaf) return { error: `surface ${surfaceId} not found` };

    store.setActivePane(targetLeaf.id);
    store.setActiveSurface(targetLeaf.id, surfaceId);
    return { ok: true };
  }

  if (method === 'surface.close') {
    const surfaceId = String(params.id ?? '');
    const ws = store.workspaces.find((w) => w.id === store.activeWorkspaceId);
    if (!ws) return { error: 'no active workspace' };

    const targetLeaf = findLeafBySurfaceId(ws.rootPane, surfaceId);
    if (!targetLeaf) return { error: `surface ${surfaceId} not found` };

    const surface = targetLeaf.surfaces.find((s) => s.id === surfaceId);
    const ptyId = surface?.ptyId;

    store.closeSurface(targetLeaf.id, surfaceId);

    if (ptyId) {
      try {
        await window.electronAPI.pty.dispose(ptyId);
      } catch {
        // Best-effort: PTY may already be gone.
      }
    }

    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // pane.*
  // -------------------------------------------------------------------------

  if (method === 'pane.list') {
    const ws = store.workspaces.find((w) => w.id === store.activeWorkspaceId);
    if (!ws) return [];
    const leaves = findLeafPanes(ws.rootPane);
    return leaves.map((l) => ({
      id: l.id,
      surfaceCount: l.surfaces.length,
      active: l.id === ws.activePaneId,
    }));
  }

  if (method === 'pane.focus') {
    const paneId = String(params.id ?? '');
    store.setActivePane(paneId);
    return { ok: true };
  }

  if (method === 'pane.split') {
    const ws = store.workspaces.find((w) => w.id === store.activeWorkspaceId);
    if (!ws) return { error: 'no active workspace' };
    const direction =
      params.direction === 'vertical' ? 'vertical' : 'horizontal';
    store.splitPane(ws.activePaneId, direction);
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // input.*
  // -------------------------------------------------------------------------

  if (method === 'input.readScreen') {
    // xterm buffer access requires a ref wired in the terminal component.
    // Deferred to a future implementation.
    return { text: 'readScreen not yet implemented' };
  }

  if (method === 'input.getActivePtyId') {
    const ws = store.workspaces.find((w) => w.id === store.activeWorkspaceId);
    if (!ws) return { ptyId: null };
    const activePane = findPaneById(ws.rootPane, ws.activePaneId);
    if (!activePane || activePane.type !== 'leaf') return { ptyId: null };
    const surface = activePane.surfaces.find(
      (s) => s.id === activePane.activeSurfaceId,
    );
    return { ptyId: surface?.ptyId ?? null };
  }

  // -------------------------------------------------------------------------
  // meta.*
  // -------------------------------------------------------------------------

  if (method === 'meta.setStatus') {
    const text = String(params.text ?? '');
    store.updateWorkspaceMetadata(store.activeWorkspaceId, { status: text });
    return { ok: true };
  }

  if (method === 'meta.setProgress') {
    const value = typeof params.value === 'number' ? params.value : Number(params.value ?? 0);
    store.updateWorkspaceMetadata(store.activeWorkspaceId, { progress: value });
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // browser.*
  // -------------------------------------------------------------------------

  if (method === 'browser.open') {
    const ws = store.workspaces.find((w) => w.id === store.activeWorkspaceId);
    if (!ws) return { error: 'no active workspace' };
    const paneId = ws.activePaneId;
    const url = typeof params.url === 'string' ? params.url : undefined;
    store.addBrowserSurface(paneId, url);

    const fresh = useStore.getState();
    const freshWs = fresh.workspaces.find((w) => w.id === fresh.activeWorkspaceId);
    if (!freshWs) return { ok: true };
    const pane = findPaneById(freshWs.rootPane, paneId);
    if (!pane || pane.type !== 'leaf') return { ok: true };
    const surface = pane.surfaces[pane.surfaces.length - 1];
    return { ok: true, surfaceId: surface?.id, url: url || 'https://google.com' };
  }

  if (method === 'browser.snapshot') {
    const surfaceId = typeof params.surfaceId === 'string' ? params.surfaceId : undefined;
    return handleBrowserSnapshot(store, surfaceId);
  }

  if (method === 'browser.click') {
    const selector = typeof params.selector === 'string' ? params.selector : '';
    if (!selector) return { error: 'browser.click: missing selector' };
    const surfaceId = typeof params.surfaceId === 'string' ? params.surfaceId : undefined;
    return handleBrowserExec(store, `
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('Element not found: ' + ${JSON.stringify(selector)});
      el.click();
      return { ok: true, selector: ${JSON.stringify(selector)} };
    `, surfaceId);
  }

  if (method === 'browser.fill') {
    const selector = typeof params.selector === 'string' ? params.selector : '';
    const text = typeof params.text === 'string' ? params.text : '';
    if (!selector) return { error: 'browser.fill: missing selector' };
    const surfaceId = typeof params.surfaceId === 'string' ? params.surfaceId : undefined;
    return handleBrowserExec(store, `
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) throw new Error('Element not found: ' + ${JSON.stringify(selector)});
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
        || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(el, ${JSON.stringify(text)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        el.value = ${JSON.stringify(text)};
      }
      return { ok: true };
    `, surfaceId);
  }

  if (method === 'browser.eval') {
    const code = typeof params.code === 'string' ? params.code : '';
    if (!code) return { error: 'browser.eval: missing code' };
    // Security: block obviously dangerous patterns that could escape
    // the webview sandbox or access Electron internals.
    const dangerousPatterns = [
      /\brequire\s*\(/i,
      /\bprocess\s*\./i,
      /\b__dirname\b/i,
      /\b__filename\b/i,
      /\bchild_process\b/i,
      /\bglobal\s*\.\s*process\b/i,
      /\belectron\b/i,
    ];
    for (const pat of dangerousPatterns) {
      if (pat.test(code)) {
        return { error: 'browser.eval: code contains blocked pattern' };
      }
    }
    const surfaceId = typeof params.surfaceId === 'string' ? params.surfaceId : undefined;
    return handleBrowserExec(store, code, surfaceId);
  }

  if (method === 'browser.navigate') {
    const url = typeof params.url === 'string' ? params.url : '';
    if (!url) return { error: 'browser.navigate: missing url' };
    // Security: block dangerous URL schemes that could execute code
    const normalizedUrl = url.trim().toLowerCase();
    if (
      normalizedUrl.startsWith('javascript:') ||
      normalizedUrl.startsWith('data:') ||
      normalizedUrl.startsWith('vbscript:') ||
      normalizedUrl.startsWith('file:')
    ) {
      return { error: `browser.navigate: blocked URL scheme in "${url}"` };
    }
    const surfaceId = typeof params.surfaceId === 'string' ? params.surfaceId : undefined;
    return handleBrowserNavigate(store, url, surfaceId);
  }

  // -------------------------------------------------------------------------
  // Unknown method
  // -------------------------------------------------------------------------

  return { error: `unknown method: ${method}` };
}

// ---------------------------------------------------------------------------
// Browser Surface helpers
// ---------------------------------------------------------------------------

/**
 * Finds the active browser Surface in the given workspace state.
 * Returns the surface's ptyId (used as a DOM element ID key) and the webview
 * element, or an error string when nothing is found.
 */
function findActiveBrowserWebview(
  store: ReturnType<typeof import('../stores').useStore.getState>,
): HTMLElement | { error: string } {
  const ws = store.workspaces.find((w) => w.id === store.activeWorkspaceId);
  if (!ws) return { error: 'browser: no active workspace' };

  // Walk through all leaf panes and look for a browser surface.
  function findLeaves(pane: import('../../shared/types').Pane): import('../../shared/types').PaneLeaf[] {
    if (pane.type === 'leaf') return [pane];
    return pane.children.flatMap(findLeaves);
  }

  const leaves = findLeaves(ws.rootPane);
  for (const leaf of leaves) {
    const activeSurface = leaf.surfaces.find((s) => s.id === leaf.activeSurfaceId);
    if (activeSurface?.surfaceType === 'browser') {
      // The Pane component renders a webview with data-surface-id attribute.
      // Escape surfaceId to prevent CSS selector injection
      const safeSurfaceId = CSS.escape(activeSurface.id);
      const webview = document.querySelector<HTMLElement>(
        `webview[data-surface-id="${safeSurfaceId}"]`,
      );
      if (webview) return webview;
    }
  }

  return { error: 'browser: no active browser surface found' };
}

/**
 * Finds a specific browser Surface's webview by surfaceId.
 * Falls back to findActiveBrowserWebview if surfaceId is not provided.
 */
function findBrowserWebviewBySurfaceId(
  store: ReturnType<typeof import('../stores').useStore.getState>,
  surfaceId?: string,
): HTMLElement | { error: string } {
  if (!surfaceId) return findActiveBrowserWebview(store);

  const safeSurfaceId = CSS.escape(surfaceId);
  const webview = document.querySelector<HTMLElement>(
    `webview[data-surface-id="${safeSurfaceId}"]`,
  );
  if (webview) return webview;
  return { error: `browser: surface ${surfaceId} not found or not a browser` };
}

async function handleBrowserSnapshot(
  store: ReturnType<typeof import('../stores').useStore.getState>,
  surfaceId?: string,
): Promise<unknown> {
  const webview = findBrowserWebviewBySurfaceId(store, surfaceId);
  if ('error' in webview) return webview;

  // Electron's <webview> exposes executeJavaScript as a method.
  const wv = webview as HTMLElement & { executeJavaScript: (code: string) => Promise<unknown> };
  const html = await wv.executeJavaScript('document.documentElement.outerHTML');
  return { html };
}

async function handleBrowserExec(
  store: ReturnType<typeof import('../stores').useStore.getState>,
  code: string,
  surfaceId?: string,
): Promise<unknown> {
  const webview = findBrowserWebviewBySurfaceId(store, surfaceId);
  if ('error' in webview) return webview;

  const wv = webview as HTMLElement & { executeJavaScript: (code: string) => Promise<unknown> };
  const result = await wv.executeJavaScript(code);
  return { result };
}

async function handleBrowserNavigate(
  store: ReturnType<typeof import('../stores').useStore.getState>,
  url: string,
  surfaceId?: string,
): Promise<unknown> {
  const webview = findBrowserWebviewBySurfaceId(store, surfaceId);
  if ('error' in webview) return webview;

  const wv = webview as HTMLElement & { loadURL: (url: string) => Promise<void> };
  await wv.loadURL(url);
  return { ok: true, url };
}
