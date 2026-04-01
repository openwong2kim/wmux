import { useEffect } from 'react';
import { useStore } from '../stores';
import type { Pane, PaneLeaf, Surface } from '../../shared/types';
import { validateMessage } from '../../shared/types';
import type { A2aTaskMessage, A2aPart } from '../../shared/types';
import { formatA2aMessage, formatA2aBroadcast } from '../utils/a2aFormat';
import type { A2aPriority } from '../utils/a2aFormat';

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
// PTY submit helper — paste text then press Enter after a short delay
// so Claude Code (and similar TUI apps) process the paste before submit.
// ---------------------------------------------------------------------------

function submitToPty(ptyId: string, text: string): void {
  const paste = `\x1b[200~${text}\x1b[201~`;
  window.electronAPI.pty.write(ptyId, paste);
  setTimeout(() => {
    window.electronAPI.pty.write(ptyId, '\r');
  }, 50);
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

    // A2A task garbage collection timer — prune terminal-state tasks every 5 min
    const gcTimer = setInterval(() => {
      useStore.getState().gcTerminalTasks();
    }, 5 * 60 * 1000);

    return () => {
      cleanupRpc();
      clearInterval(gcTimer);
    };
  }, []);
}

// ---------------------------------------------------------------------------
// PTY notification helper — delivers a formatted A2A message to a workspace's
// active terminal. Extracted to avoid duplication across send/reply/update.
// ---------------------------------------------------------------------------

function deliverPtyNotification(
  targetWs: { rootPane: Pane; activePaneId: string; name: string },
  senderName: string,
  message: string,
): void {
  const leaves = findLeafPanes(targetWs.rootPane);
  const activeLeaf = leaves.find((l) => l.id === targetWs.activePaneId)
    ?? leaves.find((l) => l.surfaces.some((s) => s.surfaceType !== 'browser'));
  if (activeLeaf) {
    const termSurface = activeLeaf.surfaces.find((s) => s.surfaceType !== 'browser' && s.ptyId);
    if (termSurface) {
      const formatted = formatA2aMessage(senderName, targetWs.name, message);
      submitToPty(termSurface.ptyId, formatted);
    }
  }
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
    // Search ALL leaf panes, not just active — so MCP can find browser surfaces anywhere
    const leaves = findLeafPanes(ws.rootPane);
    const surfaces = [];
    for (const leaf of leaves) {
      for (const s of leaf.surfaces) {
        surfaces.push({
          id: s.id,
          ptyId: s.ptyId,
          title: s.title,
          shell: s.shell,
          cwd: s.cwd,
          surfaceType: s.surfaceType || 'terminal',
          browserUrl: s.browserUrl,
          paneId: leaf.id,
          isActive: s.id === leaf.activeSurfaceId,
        });
      }
    }
    return surfaces;
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

    // Re-read state after async gap — paneId may have been removed.
    const freshAfterCreate = useStore.getState();
    const freshWsAfterCreate = freshAfterCreate.workspaces.find((w) => w.id === freshAfterCreate.activeWorkspaceId);
    if (!freshWsAfterCreate || !findPaneById(freshWsAfterCreate.rootPane, paneId)) {
      // Pane was removed during async gap — dispose the orphaned PTY
      try { await window.electronAPI.pty.dispose(ptyId); } catch { /* best-effort */ }
      return { error: 'pane was removed during PTY creation' };
    }
    freshAfterCreate.addSurface(paneId, ptyId, shell, cwd);

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
    const url = typeof params.url === 'string' ? params.url : undefined;

    // Check if a browser surface already exists anywhere — reuse it
    const leaves = findLeafPanes(ws.rootPane);
    for (const leaf of leaves) {
      const existingBrowser = leaf.surfaces.find((s) => s.surfaceType === 'browser');
      if (existingBrowser) {
        const surfaceId = existingBrowser.id;
        const paneIdForBrowser = leaf.id;
        // Navigate existing browser to the new URL if provided — must go through setState (Immer)
        useStore.setState((state) => {
          const w = state.workspaces.find((w2) => w2.id === state.activeWorkspaceId);
          if (!w) return;
          const p = findPaneById(w.rootPane, paneIdForBrowser);
          if (!p || p.type !== 'leaf') return;
          const surf = p.surfaces.find((s) => s.id === surfaceId);
          if (surf && url) {
            surf.browserUrl = url;
          }
          p.activeSurfaceId = surfaceId;
        });
        return { ok: true, surfaceId, url: url || existingBrowser.browserUrl, reused: true };
      }
    }

    // No existing browser — split the active pane horizontally,
    // then add browser surface to the new (right) pane.
    // This uses PaneContainer's proven split mechanism instead of
    // trying to render terminal+browser in the same leaf pane.
    const paneId = ws.activePaneId;
    store.splitPane(paneId, 'horizontal');

    // After split, the new pane becomes active
    const afterSplit = useStore.getState();
    const afterSplitWs = afterSplit.workspaces.find((w) => w.id === afterSplit.activeWorkspaceId);
    if (!afterSplitWs) return { ok: true };

    const newPaneId = afterSplitWs.activePaneId;
    afterSplit.addBrowserSurface(newPaneId, url);

    // Focus back to the original terminal pane so user can keep typing
    afterSplit.setActivePane(paneId);

    const updated = useStore.getState();
    const updatedWs = updated.workspaces.find((w) => w.id === updated.activeWorkspaceId);
    if (!updatedWs) return { ok: true };
    const newPane = findPaneById(updatedWs.rootPane, newPaneId);
    if (!newPane || newPane.type !== 'leaf') return { ok: true };
    const surface = newPane.surfaces[newPane.surfaces.length - 1];
    return { ok: true, surfaceId: surface?.id, url: url || 'https://google.com' };
  }

  if (method === 'browser.close') {
    const ws = store.workspaces.find((w) => w.id === store.activeWorkspaceId);
    if (!ws) return { error: 'no active workspace' };

    const surfaceId = typeof params.surfaceId === 'string' ? params.surfaceId : undefined;

    // Find the browser surface to close — by surfaceId or the active one
    const leaves = findLeafPanes(ws.rootPane);
    let targetLeaf: PaneLeaf | null = null;
    let targetSurfaceId: string | null = null;

    if (surfaceId) {
      // Find the specific browser surface
      for (const leaf of leaves) {
        const surface = leaf.surfaces.find((s) => s.id === surfaceId && s.surfaceType === 'browser');
        if (surface) {
          targetLeaf = leaf;
          targetSurfaceId = surface.id;
          break;
        }
      }
    } else {
      // Find any active browser surface
      for (const leaf of leaves) {
        const surface = leaf.surfaces.find((s) => s.surfaceType === 'browser');
        if (surface) {
          targetLeaf = leaf;
          targetSurfaceId = surface.id;
          break;
        }
      }
    }

    if (!targetLeaf || !targetSurfaceId) {
      return { error: 'browser.close: no browser surface found' };
    }

    store.closeSurface(targetLeaf.id, targetSurfaceId);
    return { ok: true };
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
      normalizedUrl.startsWith('file:') ||
      normalizedUrl.startsWith('blob:')
    ) {
      return { error: `browser.navigate: blocked URL scheme in "${url}"` };
    }
    const surfaceId = typeof params.surfaceId === 'string' ? params.surfaceId : undefined;
    return handleBrowserNavigate(store, url, surfaceId);
  }

  // -------------------------------------------------------------------------
  // a2a.*
  // -------------------------------------------------------------------------

  if (method === 'a2a.whoami') {
    const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : '';
    const ws = store.workspaces.find((w) => w.id === workspaceId);
    if (!ws) return { error: `no workspace found for ${workspaceId}` };
    return {
      workspaceId: ws.id,
      name: ws.name,
      metadata: ws.metadata ?? {},
    };
  }

  if (method === 'a2a.discover') {
    return {
      agents: store.workspaces.map((w) => ({
        workspaceId: w.id,
        name: w.name,
        description: w.metadata?.agentName ?? w.name,
        skills: store.getAgentSkills(w.id),
        status: (w.metadata?.agentStatus as string) ?? 'idle',
      })),
    };
  }

  if (method === 'a2a.task.send') {
    const taskId = typeof params.taskId === 'string' ? params.taskId : '';
    const rawMessage = typeof params.message === 'string' ? params.message : '';
    const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : '';

    if (!rawMessage) return { error: 'a2a.task.send: missing "message"' };
    let message: string;
    try { message = validateMessage(rawMessage); } catch (e) {
      return { error: `a2a.task.send: ${e instanceof Error ? e.message : 'invalid'}` };
    }

    // Build parts
    const parts: A2aPart[] = [{ type: 'text', text: message }];
    if (params.data && typeof params.data === 'object') {
      parts.push({
        type: 'data',
        mimeType: typeof params.dataMimeType === 'string' ? params.dataMimeType : 'application/json',
        data: params.data as Record<string, unknown>,
      });
    }

    // ── Reply branch: taskId exists → add message to existing task ──
    if (taskId) {
      const task = store.getTask(taskId);
      if (!task) return { error: `a2a.task.send: task "${taskId}" not found` };
      // Verify caller is sender or receiver of this task
      if (task.from.workspaceId !== workspaceId && task.to.workspaceId !== workspaceId) {
        return { error: 'a2a.task.send: not authorized to reply to this task' };
      }
      const role = task.from.workspaceId === workspaceId ? 'sender' : 'receiver';
      store.addTaskMessage(taskId, { role, parts, timestamp: Date.now() });

      // PTY notification to the other party
      const targetWsId = role === 'sender' ? task.to.workspaceId : task.from.workspaceId;
      const targetWs = store.workspaces.find((w) => w.id === targetWsId);
      if (targetWs) {
        const senderWs = store.workspaces.find((w) => w.id === workspaceId);
        const senderName = senderWs?.name ?? 'unknown';
        deliverPtyNotification(targetWs, senderName, message);
      }
      return { ok: true, taskId };
    }

    // ── New task branch ──
    const to = typeof params.to === 'string' ? params.to : '';
    const title = typeof params.title === 'string' ? params.title : '';
    if (!to) return { error: 'a2a.task.send: missing "to"' };

    const sender = store.workspaces.find((w) => w.id === workspaceId);
    const fromName = sender?.name ?? `unknown-${workspaceId.substring(0, 8)}`;

    const target = store.workspaces.find(
      (w) => w.id === to || w.name.toLowerCase() === to.toLowerCase(),
    );
    if (!target) return { error: `a2a.task.send: target "${to}" not found` };
    if (target.id === workspaceId) return { error: 'a2a.task.send: cannot send to yourself' };

    const initialMessage: A2aTaskMessage = { role: 'sender', parts, timestamp: Date.now() };

    const newTaskId = store.createA2aTask({
      title: title || message.slice(0, 100),
      status: 'submitted',
      from: { workspaceId, name: fromName },
      to: { workspaceId: target.id, name: target.name },
      messages: [initialMessage],
      artifacts: [],
    });

    // Deliver formatted message to target's active terminal PTY
    deliverPtyNotification(target, fromName, message);

    return { ok: true, taskId: newTaskId };
  }

  if (method === 'a2a.task.query') {
    const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : '';
    if (!workspaceId) return { error: 'a2a.task.query: missing "workspaceId"' };
    const status = typeof params.status === 'string' ? params.status as any : undefined;
    const role = typeof params.role === 'string' ? params.role as 'sender' | 'receiver' : undefined;
    const tasks = store.queryTasks(workspaceId, { status, role });
    return { workspaceId, tasks };
  }

  if (method === 'a2a.task.update') {
    const taskId = typeof params.taskId === 'string' ? params.taskId : '';
    const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : '';
    if (!taskId) return { error: 'a2a.task.update: missing "taskId"' };
    if (!workspaceId) return { error: 'a2a.task.update: missing "workspaceId"' };

    // Update status if provided
    if (typeof params.status === 'string') {
      // Block 'canceled' — must use a2a.task.cancel instead
      if (params.status === 'canceled') {
        return { error: 'a2a.task.update: use a2a.task.cancel instead' };
      }
      // Validate status value
      const validStatuses = ['working', 'completed', 'failed', 'input-required'];
      if (!validStatuses.includes(params.status)) {
        return { error: `a2a.task.update: invalid status "${params.status}"` };
      }
      const result = store.updateTaskStatus(taskId, params.status as any, workspaceId);
      if (!result.ok) return { error: `a2a.task.update: ${result.error}` };
    }

    // Add message if provided
    if (typeof params.message === 'string') {
      let message: string;
      try { message = validateMessage(params.message); } catch (e) {
        return { error: `a2a.task.update: ${e instanceof Error ? e.message : 'invalid'}` };
      }

      // Verify caller is sender or receiver of this task
      const task = store.getTask(taskId);
      if (!task) return { error: 'a2a.task.update: task not found' };
      if (task.from.workspaceId !== workspaceId && task.to.workspaceId !== workspaceId) {
        return { error: 'a2a.task.update: not authorized' };
      }
      const role = task.from.workspaceId === workspaceId ? 'sender' : 'receiver';

      const parts: A2aPart[] = [{ type: 'text', text: message }];
      store.addTaskMessage(taskId, { role, parts, timestamp: Date.now() });

      // Deliver to the other party's terminal
      const targetWsId = role === 'sender' ? task.to.workspaceId : task.from.workspaceId;
      const targetWs = store.workspaces.find((w) => w.id === targetWsId);
      if (targetWs) {
        const callerWs = store.workspaces.find((w) => w.id === workspaceId);
        const callerName = callerWs?.name ?? 'unknown';
        deliverPtyNotification(targetWs, callerName, message);
      }
    }

    // Add artifact if provided
    if (params.artifact && typeof params.artifact === 'object') {
      const artifact = params.artifact as { name?: string; parts?: A2aPart[] };
      if (artifact.name && artifact.parts) {
        store.addTaskArtifact(taskId, { name: artifact.name, parts: artifact.parts });
      }
    }

    return { ok: true, taskId };
  }

  if (method === 'a2a.task.cancel') {
    const taskId = typeof params.taskId === 'string' ? params.taskId : '';
    const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : '';
    if (!taskId) return { error: 'a2a.task.cancel: missing "taskId"' };
    if (!workspaceId) return { error: 'a2a.task.cancel: missing "workspaceId"' };
    const result = store.cancelTask(taskId, workspaceId);
    if (!result.ok) return { error: `a2a.task.cancel: ${result.error}` };
    return { ok: true, taskId };
  }

  if (method === 'a2a.broadcast') {
    const rawMessage = typeof params.message === 'string' ? params.message : '';
    const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : '';
    const priority = (typeof params.priority === 'string' ? params.priority : 'normal') as A2aPriority;
    if (!rawMessage) return { error: 'a2a.broadcast: missing "message"' };
    let message: string;
    try { message = validateMessage(rawMessage); } catch (e) {
      return { error: `a2a.broadcast: ${e instanceof Error ? e.message : 'invalid'}` };
    }

    const sender = store.workspaces.find((w) => w.id === workspaceId);
    const fromName = sender?.name ?? `unknown-${workspaceId.substring(0, 8)}`;

    let sent = 0;
    for (const ws of store.workspaces) {
      if (ws.id === workspaceId) continue;
      const leaves = findLeafPanes(ws.rootPane);
      for (const leaf of leaves) {
        const termSurface = leaf.surfaces.find((s) => s.surfaceType !== 'browser' && s.ptyId);
        if (termSurface) {
          const formatted = formatA2aBroadcast(fromName, message, priority);
          submitToPty(termSurface.ptyId, formatted);
          break;
        }
      }
      sent++;
    }
    return { ok: true, sent };
  }

  if (method === 'meta.setSkills') {
    const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : '';
    const skills = Array.isArray(params.skills) ? params.skills as string[] : [];
    if (!workspaceId) return { error: 'meta.setSkills: missing "workspaceId"' };
    store.setAgentSkills(workspaceId, skills);
    return { ok: true };
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
