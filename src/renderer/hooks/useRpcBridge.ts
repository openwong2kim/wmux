import { useEffect } from 'react';
import { useStore } from '../stores';
import { withDefaultShell, withWorkspaceProfile } from '../utils/ptyCreateOptions';
import type { Pane, PaneLeaf, Surface } from '../../shared/types';
import { validateMessage } from '../../shared/types';
import type { Message, Part, TaskState, Artifact, AgentSkill } from '../../shared/types';
import type { PaneSearchResult, PaneSearchResponse } from '../../shared/types';
import { generateId } from '../../shared/types';
import { handleCompanyRpc } from '../../company/renderer/rpcHandlers';
import { formatA2aMessage, formatA2aBroadcast } from '../utils/a2aFormat';
import type { A2aPriority } from '../utils/a2aFormat';
import { setExecuteApprovalResolver } from '../utils/executeApproval';
import { terminalRegistry } from './useTerminal';
import { searchInBuffer, type SearchableBuffer } from '../utils/searchEngine';
import { submitBracketedPasteToPty } from '../utils/ptyMessageDelivery';

// ---------------------------------------------------------------------------
// Pane tree utilities
// ---------------------------------------------------------------------------

function findLeafPanes(root: Pane): PaneLeaf[] {
  if (root.type === 'leaf') return [root];
  return root.children.flatMap(findLeafPanes);
}

/**
 * Resolve the ptyId of a workspace's active pane + active surface.
 *
 * Duplicated from StatusBar.tsx's local helper — kept inline here rather
 * than lifting to a shared module because both call sites read the active
 * pane through the renderer store and lifting would force a circular
 * dependency between renderer/utils and the store. Two tiny copies are
 * cheaper than the shared-module gymnastics.
 *
 * Used by the workspace.list RPC response so hook bridge scripts
 * (integrations/<agent>/bin/wmux-bridge.mjs) can resolve their hook
 * payload's cwd → workspace → activePtyId in a single round-trip.
 */
function findActivePtyId(rootPane: Pane | undefined, activePaneId: string): string | null {
  if (!rootPane) return null;
  const findLeaf = (pane: Pane): PaneLeaf | null => {
    if (pane.type === 'leaf') return pane.id === activePaneId ? pane : null;
    for (const child of pane.children) {
      const found = findLeaf(child);
      if (found) return found;
    }
    return null;
  };
  const leaf = findLeaf(rootPane);
  if (!leaf) return null;
  const surface = leaf.surfaces.find((s) => s.id === leaf.activeSurfaceId);
  return surface?.ptyId ?? null;
}

/** All ptyIds in a workspace (every leaf, every surface). */
function collectAllPtyIds(root: Pane): string[] {
  const ids: string[] = [];
  const walk = (pane: Pane): void => {
    if (pane.type === 'leaf') {
      for (const s of pane.surfaces) {
        if (s.ptyId) ids.push(s.ptyId);
      }
      return;
    }
    for (const child of pane.children) walk(child);
  };
  walk(root);
  return ids;
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
// PTY submit helper — paste structured inter-agent messages through bracketed
// paste before submitting, so receiver-controlled shells/readline prompts treat
// the envelope as pasted data instead of executing embedded line breaks as
// individual keystrokes.
// ---------------------------------------------------------------------------

function submitToPty(ptyId: string, text: string): void {
  submitBracketedPasteToPty(ptyId, text);
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

    // ── In-renderer entry point for searchSlice ─────────────────────────────
    // The search engine reads from xterm.js Terminal instances which only
    // exist in the renderer. Exposing a thin global lets the zustand slice
    // invoke `pane.search` directly without a useless renderer→main→renderer
    // IPC round trip.
    (window as unknown as { __wmuxRunPaneSearch: (q: string, r: boolean) => Promise<RpcResult> })
      .__wmuxRunPaneSearch = (query: string, regex: boolean) =>
        handleRpcMethod('pane.search', { query, regex });

    // A2A task garbage collection timer — prune terminal-state tasks every 5 min
    const gcTimer = setInterval(() => {
      useStore.getState().gcTerminalTasks();
    }, 5 * 60 * 1000);

    return () => {
      cleanupRpc();
      clearInterval(gcTimer);
      delete (window as unknown as { __wmuxRunPaneSearch?: unknown }).__wmuxRunPaneSearch;
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

  // Fix 0 — block external RPC during startup reconcile. Even read-only
  // RPCs (workspace.list) return surface.ptyId fields that the external
  // caller may use for a follow-up write — and during the pending
  // window those ptyIds may be stale, cleared by reconcile mid-flight,
  // or about to be cleared by the fallback. Returning a structured
  // error lets the caller retry once the gate flips.
  if (store.paneGate !== 'ready') {
    return { error: 'wmux is still starting (paneGate=pending)', retryable: true };
  }

  // -------------------------------------------------------------------------
  // workspace.*
  // -------------------------------------------------------------------------

  if (method === 'workspace.list') {
    return store.workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      metadata: {
        cwd: w.metadata?.cwd ?? null,
        gitBranch: w.metadata?.gitBranch ?? null,
        agentName: w.metadata?.agentName ?? null,
        agentStatus: w.metadata?.agentStatus ?? null,
        status: w.metadata?.status ?? null,
        progress: w.metadata?.progress ?? null,
      },
      // Phase 1 hook plugin support — bridge scripts resolve hook payload's
      // cwd → workspace → activePtyId. activePtyId is the active pane's
      // active surface; ptyIds is the union over the whole workspace
      // (used when bridge needs to disambiguate via env if cwd alone is
      // ambiguous). Both fields are optional from the wire-format POV —
      // existing consumers that destructure metadata only are unaffected.
      activePtyId: findActivePtyId(w.rootPane, w.activePaneId),
      ptyIds: collectAllPtyIds(w.rootPane),
    }));
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
    // Dispose the workspace's PTY sessions before dropping it from the UI.
    // The UI close paths (Sidebar X, Ctrl+Shift+W, Settings reset) already
    // dispose every surface's PTY; without the same step here an external
    // CLI/MCP `workspace.close` would leave each pane's shell — and any agent
    // process running inside it — alive in the daemon with no UI to reattach,
    // accumulating until a full daemon shutdown. Best-effort: a failed dispose
    // (session already dead, daemon mid-respawn) must not block the removal.
    //
    // Guard on workspaces.length > 1: removeWorkspace refuses to drop the final
    // workspace (the store always keeps at least one). Without this check the
    // RPC would dispose the only workspace's PTYs — killing its shells and any
    // agent inside them — while the workspace stays in the UI with dead
    // surfaces. Mirror the slice's guard so dispose only runs when the removal
    // will actually happen. (codex review P2)
    const ws = store.workspaces.find((w) => w.id === id);
    if (ws && store.workspaces.length > 1) {
      for (const ptyId of collectAllPtyIds(ws.rootPane)) {
        // dispose() returns an IPC Promise, so a daemon-side failure (mid-
        // respawn, session already dead) rejects asynchronously — a plain
        // try/catch wouldn't catch it and workspace.close would emit an
        // unhandled rejection while still reporting success. Swallow the
        // rejection via .catch; the outer try guards a synchronous throw
        // (e.g. electronAPI missing). Best-effort either way. (codex review P2)
        try {
          void window.electronAPI.pty.dispose(ptyId).catch(() => { /* best-effort */ });
        } catch { /* best-effort */ }
      }
    }
    store.removeWorkspace(id);
    return { ok: true };
  }

  if (method === 'workspace.current') {
    const ws = store.workspaces.find((w) => w.id === store.activeWorkspaceId);
    return ws ? { id: ws.id, name: ws.name } : null;
  }

  if (method === 'mcp.claimWorkspace') {
    // Spawn a dedicated workspace + PTY for an external MCP caller without
    // stealing the user's focus. addWorkspace flips activeWorkspaceId to the
    // new workspace as a side effect, so we snapshot the prior active id and
    // restore it after PTY creation completes.
    const previousActiveId = store.activeWorkspaceId;
    const name = typeof params.name === 'string' && params.name.length > 0
      ? params.name
      : undefined;

    store.addWorkspace(name);

    const afterAdd = useStore.getState();
    const newWs = afterAdd.workspaces.find((w) => w.id === afterAdd.activeWorkspaceId);
    if (!newWs) {
      // Should never happen — addWorkspace just set activeWorkspaceId.
      return { error: 'mcp.claimWorkspace: workspace creation failed' };
    }

    const newWsId = newWs.id;
    const paneId = newWs.activePaneId;

    let ptyId: string;
    try {
      const created = await window.electronAPI.pty.create(
        withDefaultShell({ workspaceId: newWsId }, useStore.getState().defaultShell)
      );
      ptyId = created.id;
    } catch (err) {
      // Roll back: remove the empty workspace so we don't leave orphans.
      const rollback = useStore.getState();
      rollback.removeWorkspace(newWsId);
      rollback.setActiveWorkspace(previousActiveId);
      return { error: `mcp.claimWorkspace: PTY create failed — ${err instanceof Error ? err.message : String(err)}` };
    }

    // Re-read state: pane may have been removed during the async gap.
    const afterPty = useStore.getState();
    const freshWs = afterPty.workspaces.find((w) => w.id === newWsId);
    if (!freshWs || !findPaneById(freshWs.rootPane, paneId)) {
      try { await window.electronAPI.pty.dispose(ptyId); } catch { /* best-effort */ }
      afterPty.removeWorkspace(newWsId);
      afterPty.setActiveWorkspace(previousActiveId);
      return { error: 'mcp.claimWorkspace: pane disappeared during PTY creation' };
    }
    afterPty.addSurface(paneId, ptyId, '', '');

    // Restore focus to whatever the user was looking at before — claim must
    // never steal the active view.
    useStore.getState().setActiveWorkspace(previousActiveId);

    return { ptyId, workspaceId: newWsId, workspaceName: newWs.name };
  }

  // -------------------------------------------------------------------------
  // surface.*
  // -------------------------------------------------------------------------

  if (method === 'surface.list') {
    const targetWsId = typeof params.workspaceId === 'string' ? params.workspaceId : store.activeWorkspaceId;
    const ws = store.workspaces.find((w) => w.id === targetWsId);
    if (!ws) return [];
    // Search ALL leaf panes, not just active — so MCP can find browser surfaces anywhere
    const leaves = findLeafPanes(ws.rootPane);
    // Use workspace metadata cwd/gitBranch as the live values (updated via shell integration)
    const liveCwd = ws.metadata?.cwd;
    const liveGitBranch = ws.metadata?.gitBranch;
    const surfaces = [];
    for (const leaf of leaves) {
      for (const s of leaf.surfaces) {
        surfaces.push({
          id: s.id,
          ptyId: s.ptyId,
          title: s.title,
          shell: s.shell,
          cwd: liveCwd || s.cwd,
          gitBranch: liveGitBranch,
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

    const { id: ptyId } = await window.electronAPI.pty.create(
      withWorkspaceProfile(
        {
          ...withDefaultShell({ shell: shell || undefined }, store.defaultShell),
          cwd: cwd || undefined,
          workspaceId: ws.id,
        },
        ws.profile,
      ),
    );

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
    const targetWsId = typeof params.workspaceId === 'string' ? params.workspaceId : store.activeWorkspaceId;
    const ws = store.workspaces.find((w) => w.id === targetWsId);
    if (!ws) return [];
    const liveCwd = ws.metadata?.cwd;
    const liveGitBranch = ws.metadata?.gitBranch;
    const leaves = findLeafPanes(ws.rootPane);
    return leaves.map((l) => {
      // Use the first terminal surface's cwd as the pane's cwd, prefer live metadata
      const firstSurface = l.surfaces.find((s) => s.surfaceType !== 'browser');
      return {
        id: l.id,
        surfaceCount: l.surfaces.length,
        active: l.id === ws.activePaneId,
        cwd: liveCwd || firstSurface?.cwd,
        gitBranch: liveGitBranch,
        metadata: l.metadata,
      };
    });
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
    const ok = store.splitPane(ws.activePaneId, direction);
    if (!ok) return { error: 'pane cap reached (max 20 per workspace)' };
    return { ok: true };
  }

  if (method === 'pane.resolveActiveLeaf') {
    // M0-b internal IPC: main asks the renderer to resolve the active leaf
    // pane for a workspace. Used when an external RPC caller omits `paneId`
    // and we need to forward the active selection to MetadataStore. Read-only
    // — does not write to paneSlice; only returns the current active leaf id
    // and the resolved workspaceId so the next write hits the right pane.
    //
    // This channel keeps MetadataStore as the sole metadata writer: the
    // renderer never sees the patch, it only answers "which leaf is active?".
    const wsId = typeof params.workspaceId === 'string' && params.workspaceId.length > 0
      ? params.workspaceId
      : store.activeWorkspaceId;
    const ws = store.workspaces.find((w) => w.id === wsId);
    if (!ws) return { error: `pane.resolveActiveLeaf: workspace "${wsId}" not found` };
    const target = findPaneById(ws.rootPane, ws.activePaneId);
    if (!target || target.type !== 'leaf') {
      return { error: `pane.resolveActiveLeaf: active pane is not a leaf in workspace "${wsId}"` };
    }
    return { paneId: target.id, workspaceId: wsId };
  }

  if (method === 'pane.validateWorkspace') {
    // M0-d follow-up (codex P1): main asks the renderer to confirm that a
    // caller-supplied `paneId` actually belongs to the caller's `workspaceId`.
    // MetadataStore is keyed by paneId only, so without this check an MCP
    // scoped to workspace A could pass B's paneId together with its own
    // workspaceId and quietly read/write B's metadata via the paneId-present
    // branch of `resolveTarget` in `pane.rpc.ts`. The renderer holds the
    // authoritative pane tree, so we ask it.
    //
    // Read-only — does not mutate paneSlice. Returns the authoritative
    // workspaceId on success so the handler can scope events even if the
    // caller omitted `workspaceId` (paneId-only legacy calls).
    const paneId = typeof params.paneId === 'string' ? params.paneId : '';
    const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : '';
    if (paneId.length === 0) {
      return { error: 'pane.validateWorkspace: paneId required' };
    }
    // When the caller passed an explicit workspaceId, we MUST scope the
    // lookup to it — otherwise we'd defeat the whole check (finding the
    // pane in another workspace and then claiming it belonged to the
    // caller's). When workspaceId is omitted, we scan every workspace so
    // a legacy paneId-only call still works.
    const ws = workspaceId.length > 0
      ? store.workspaces.find((w) => w.id === workspaceId)
      : store.workspaces.find((w) => findPaneById(w.rootPane, paneId) !== null);
    if (!ws) {
      return {
        error: workspaceId.length > 0
          ? `pane.validateWorkspace: workspace "${workspaceId}" not found`
          : `pane.validateWorkspace: paneId "${paneId}" not in any workspace`,
      };
    }
    const target = findPaneById(ws.rootPane, paneId);
    if (!target || target.type !== 'leaf') {
      return {
        error: `pane.validateWorkspace: leaf "${paneId}" not in workspace "${ws.id}"`,
      };
    }
    return { paneId, workspaceId: ws.id };
  }

  // M0-d: pane.setMetadata / pane.getMetadata / pane.clearMetadata handlers
  // were removed. After M0-b the main process routes those RPCs straight
  // through MetadataStore and never calls sendToRenderer for them, so these
  // branches were unreachable dead code. MetadataStore is the sole writer.

  if (method === 'pane.search') {
    const query = String(params['query'] ?? '');
    const regex = params['regex'] === true;
    if (query.length === 0) return { error: 'pane.search: empty query' };

    // ─── Workspace scope (C1, decisions D9) ──────────────────────────────
    // External MCP callers pass `workspaceId` via T-D so the search is
    // scoped to the CALLING workspace, not whichever the user is currently
    // viewing in the UI. Internal renderer callers (SearchBar) omit
    // `workspaceId` and fall back to the active workspace.
    const requestedWsId =
      typeof params['workspaceId'] === 'string' && (params['workspaceId'] as string).length > 0
        ? (params['workspaceId'] as string)
        : store.activeWorkspaceId;
    const ws = store.workspaces.find((w) => w.id === requestedWsId);
    if (!ws) {
      // Validate explicitly so an external caller passing a stale/invalid
      // workspaceId gets a clear error instead of silently empty results.
      if (typeof params['workspaceId'] === 'string' && (params['workspaceId'] as string).length > 0) {
        return { error: `pane.search: workspace "${requestedWsId}" not found` };
      }
      return { error: 'pane.search: no active workspace' };
    }

    // Build ptyId → workspaceId reverse map (current ws only — D9, v1 scope='workspace')
    // and ptyId → paneId map for result tagging.
    const ptyToPaneId = new Map<string, string>();
    const ptyToSurfaceId = new Map<string, string>();
    const ptyToPaneLabel = new Map<string, string | undefined>();
    const leaves = findLeafPanes(ws.rootPane);
    for (const leaf of leaves) {
      // PR #16 may add `metadata.label` to PaneLeaf — read defensively so we
      // neither depend on the field's existence nor throw if it's missing.
      const leafMeta = (leaf as PaneLeaf & { metadata?: { label?: string } }).metadata;
      const leafLabel = leafMeta?.label;
      for (const s of leaf.surfaces) {
        if (s.ptyId) {
          ptyToPaneId.set(s.ptyId, leaf.id);
          ptyToSurfaceId.set(s.ptyId, s.id);
          ptyToPaneLabel.set(s.ptyId, leafLabel);
        }
      }
    }

    const TOTAL_BUDGET = 200;
    let remainingBudget = TOTAL_BUDGET;
    const results: PaneSearchResult[] = [];
    let totalMatches = 0;
    // ─── Truncation tracking (I1) ────────────────────────────────────────
    // We can't know "true total" without re-scanning post-cap, so semantics
    // are: truncated=true iff the budget hit zero AND there were panes left
    // to scan (or the per-pane engine returned exactly `remainingBudget`
    // matches, signalling more were available). This is the closest honest
    // approximation without a second-pass scan.
    let truncated = false;

    // Snapshot registry keys to make mutation during iteration safe (N2).
    const ptyIds = Array.from(terminalRegistry.keys());
    // Keep only ptyIds that belong to the resolved workspace so the
    // "panes-left" check below is meaningful.
    const scannablePtyIds = ptyIds.filter((id) => ptyToPaneId.has(id));
    for (let pIdx = 0; pIdx < scannablePtyIds.length; pIdx++) {
      const ptyId = scannablePtyIds[pIdx];
      if (remainingBudget <= 0) {
        // Budget exhausted before we got to this pane → more matches likely.
        truncated = true;
        break;
      }
      const paneId = ptyToPaneId.get(ptyId);
      if (!paneId) continue; // belt-and-braces; filtered above already
      const term = terminalRegistry.get(ptyId);
      if (!term) continue; // unmounted between snapshot and read
      try {
        // Adapt xterm Buffer to SearchableBuffer (it already conforms structurally)
        const requestedBudget = remainingBudget;
        const matches = searchInBuffer(
          term.buffer.active as unknown as SearchableBuffer,
          query,
          { regex, contextLines: 2, perBufferLineCap: 20_000, remainingBudget },
        );
        totalMatches += matches.length;
        for (const m of matches) {
          const label = ptyToPaneLabel.get(ptyId);
          const result: PaneSearchResult = {
            paneId,
            surfaceId: ptyToSurfaceId.get(ptyId)!,
            ptyId,
            lineIdx: m.lineIdx,
            physicalBaseY: m.physicalBaseY,
            text: m.text,
            contextBefore: m.contextBefore,
            contextAfter: m.contextAfter,
            ...(label !== undefined && { paneLabel: label }),
          };
          results.push(result);
          remainingBudget--;
          if (remainingBudget <= 0) break;
        }
        // If the engine returned EXACTLY the budget we gave it, more matches
        // may exist in this same buffer that were cut off — truncated.
        if (matches.length === requestedBudget && remainingBudget <= 0) {
          // There may also be unscanned panes after this — both flag as truncated.
          truncated = true;
        }
      } catch (err) {
        // SyntaxError from invalid regex — propagate as RPC error
        if (err instanceof SyntaxError) {
          return { error: `pane.search: invalid regex: ${err.message}` };
        }
        // Per-pane errors (e.g., disposed terminal): skip silently (N2)
      }
    }

    const response: PaneSearchResponse = {
      resultShapeVersion: 1,
      results,
      truncated,
      totalMatches,
      workspaceId: ws.id, // C1: echo the RESOLVED workspace, not the active one.
    };
    return response;
  }

  // -------------------------------------------------------------------------
  // input.*
  // -------------------------------------------------------------------------

  // input.findOwnerWorkspace — returns the workspace that owns a given ptyId,
  // or null if no surface in any workspace is bound to that PTY. Main-side
  // validators use this to gate cross-workspace terminal access (defense
  // against PTY-id leaks bypassing the metadata-layer isolation).
  if (method === 'input.findOwnerWorkspace') {
    const ptyId = typeof params.ptyId === 'string' ? params.ptyId : '';
    if (!ptyId) return { workspaceId: null };
    for (const ws of store.workspaces) {
      const leaves = findLeafPanes(ws.rootPane);
      for (const leaf of leaves) {
        for (const s of leaf.surfaces) {
          if (s.ptyId === ptyId) return { workspaceId: ws.id };
        }
      }
    }
    return { workspaceId: null };
  }

  if (method === 'input.readScreen') {
    // Workspace scoping: external MCP callers MUST pass workspaceId so reads
    // can't be hijacked into whichever workspace the user happens to focus.
    // Internal callers may omit it and fall back to the active workspace.
    const callerWsId =
      typeof params.workspaceId === 'string' && params.workspaceId.length > 0
        ? params.workspaceId
        : store.activeWorkspaceId;

    let ptyId: string | null = typeof params.ptyId === 'string' ? params.ptyId : null;
    if (!ptyId) {
      const ws = store.workspaces.find((w) => w.id === callerWsId);
      if (ws) {
        const activePane = findPaneById(ws.rootPane, ws.activePaneId);
        if (activePane && activePane.type === 'leaf') {
          const surface = activePane.surfaces.find(
            (s) => s.id === activePane.activeSurfaceId,
          );
          ptyId = surface?.ptyId ?? null;
        }
      }
    } else if (typeof params.workspaceId === 'string' && params.workspaceId.length > 0) {
      // Caller passed both — validate the PTY belongs to that workspace.
      const targetWs = store.workspaces.find((w) => w.id === callerWsId);
      const owned =
        targetWs &&
        findLeafPanes(targetWs.rootPane).some((leaf) =>
          leaf.surfaces.some((s) => s.ptyId === ptyId),
        );
      if (!owned) {
        return {
          error: `input.readScreen: PTY "${ptyId}" not in workspace "${callerWsId}"`,
        };
      }
    }
    if (!ptyId) return { ptyId: null, text: '' };

    const terminal = terminalRegistry.get(ptyId);
    if (!terminal) return { ptyId, text: '' };

    const buffer = terminal.buffer.active;
    const lastLine = buffer.baseY + buffer.cursorY;
    const lines: string[] = [];
    for (let i = 0; i <= lastLine && i < buffer.length; i++) {
      const line = buffer.getLine(i);
      if (line) lines.push(line.translateToString(true));
    }
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

    // Optional tail_lines cap — return only the last N non-empty lines.
    // Useful for AI agents that don't need the full viewport and want to
    // bound token cost per read.
    const rawTail = (params as Record<string, unknown>).tail_lines;
    if (typeof rawTail === 'number' && Number.isFinite(rawTail) && rawTail > 0) {
      const cap = Math.floor(rawTail);
      if (lines.length > cap) {
        return { ptyId, text: lines.slice(-cap).join('\n') };
      }
    }

    return { ptyId, text: lines.join('\n') };
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
    const targetWsId = typeof params.workspaceId === 'string'
      ? params.workspaceId
      : store.activeWorkspaceId;
    const ws = store.workspaces.find((w) => w.id === targetWsId);
    if (!ws) return { error: 'no active workspace' };
    const url = typeof params.url === 'string' ? params.url : undefined;
    const partition = typeof params.partition === 'string' ? params.partition : 'persist:wmux-default';

    // Check if a browser surface already exists anywhere — reuse it
    const leaves = findLeafPanes(ws.rootPane);
    for (const leaf of leaves) {
      const existingBrowser = leaf.surfaces.find((s) => s.surfaceType === 'browser');
      if (existingBrowser) {
        const surfaceId = existingBrowser.id;
        const paneIdForBrowser = leaf.id;
        // Navigate existing browser to the new URL if provided — must go through setState (Immer)
        useStore.setState((state) => {
          const w = state.workspaces.find((w2) => w2.id === targetWsId);
          if (!w) return;
          const p = findPaneById(w.rootPane, paneIdForBrowser);
          if (!p || p.type !== 'leaf') return;
          const surf = p.surfaces.find((s) => s.id === surfaceId);
          if (surf) {
            if (url) {
              surf.browserUrl = url;
            }
            surf.browserPartition = partition;
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
    const ok = store.splitPane(paneId, 'horizontal', targetWsId);
    // At the per-workspace leaf cap splitPane is a no-op (and pushes its own
    // toast). Bail out before addBrowserSurface so we don't drop a browser tab
    // on the still-active original terminal pane.
    if (!ok) return { error: 'pane cap reached (max 20 per workspace)' };

    // After split, the new pane becomes active
    const afterSplit = useStore.getState();
    const afterSplitWs = afterSplit.workspaces.find((w) => w.id === targetWsId);
    if (!afterSplitWs) return { ok: true };

    const newPaneId = afterSplitWs.activePaneId;
    afterSplit.addBrowserSurface(newPaneId, url, partition, targetWsId);

    // Focus back to the original terminal pane so user can keep typing
    afterSplit.setActivePane(paneId);

    const updated = useStore.getState();
    const updatedWs = updated.workspaces.find((w) => w.id === targetWsId);
    if (!updatedWs) return { ok: true };
    const newPane = findPaneById(updatedWs.rootPane, newPaneId);
    if (!newPane || newPane.type !== 'leaf') return { ok: true };
    const surface = newPane.surfaces[newPane.surfaces.length - 1];
    return { ok: true, surfaceId: surface?.id, url: url || 'https://google.com' };
  }

  if (method === 'browser.session.applyProfile') {
    const partition = typeof params.partition === 'string' ? params.partition : '';
    if (!partition) return { error: 'browser.session.applyProfile: missing partition' };
    const surfaceId = typeof params.surfaceId === 'string' ? params.surfaceId : undefined;
    store.updateBrowserPartition(partition, surfaceId);
    return { ok: true, partition, ...(surfaceId && { surfaceId }) };
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

  if (method === 'a2a.confirmExecute') {
    // Main process is asking the user whether to spawn a bypassPermissions
    // Claude CLI for this incoming task. We park the prompt in zustand so the
    // <ExecuteApprovalDialog/> can render it, and resolve once the user clicks
    // Approve/Deny — or after a 30s timeout (auto-deny).
    const taskId = typeof params.taskId === 'string' ? params.taskId : '';
    if (!taskId) return { approved: false };

    const senderWorkspaceId = typeof params.senderWorkspaceId === 'string' ? params.senderWorkspaceId : '';
    const receiverWorkspaceId = typeof params.receiverWorkspaceId === 'string' ? params.receiverWorkspaceId : '';
    const messagePreview = typeof params.messagePreview === 'string' ? params.messagePreview : '';
    const cwd = typeof params.cwd === 'string' ? params.cwd : null;
    const expiresAt = Date.now() + 30_000;

    return new Promise<{ approved: boolean }>((resolve) => {
      let settled = false;
      const settle = (approved: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        useStore.getState().setPendingExecuteApproval(null);
        resolve({ approved });
      };
      const timer = setTimeout(() => settle(false), 30_000);
      setExecuteApprovalResolver(settle);
      useStore.getState().setPendingExecuteApproval({
        taskId,
        senderWorkspaceId,
        receiverWorkspaceId,
        messagePreview,
        cwd,
        expiresAt,
      });
    });
  }

  if (method === 'a2a.resolve.identity') {
    // Resolve workspace from PTY workspace ID passed via env var
    const ptyWorkspaceId = typeof params.ptyWorkspaceId === 'string' ? params.ptyWorkspaceId : '';
    if (ptyWorkspaceId) {
      const ws = store.workspaces.find((w) => w.id === ptyWorkspaceId);
      if (ws) return { workspaceId: ws.id };
    }
    // Fallback: try to match by PID through surfaces' PTY IDs
    // (future: PTYManager could track PID→workspace mapping)
    return { workspaceId: '' };
  }

  if (method === 'a2a.whoami') {
    const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : '';
    if (!workspaceId) {
      return { error: 'a2a.whoami: workspaceId is required. Ensure WMUX_WORKSPACE_ID is set in the environment.' };
    }
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
      agents: store.workspaces.map((w) => {
        const skills = store.getAgentSkills(w.id);
        return {
          name: w.name,
          description: w.metadata?.agentName ?? w.name,
          url: w.id,
          version: '1.0',
          capabilities: { stateTransitionHistory: true },
          skills: skills
            ? skills.map((s) => (typeof s === 'string' ? { id: s, name: s } : s))
            : [],
          metadata: {
            workspaceId: w.id,
            status: (w.metadata?.agentStatus as string) ?? 'idle',
          },
        };
      }),
    };
  }

  if (method === 'a2a.task.send') {
    const taskId = typeof params.taskId === 'string' ? params.taskId : '';
    const rawMessage = typeof params.message === 'string' ? params.message : '';
    const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : '';
    if (!workspaceId) return { error: 'a2a.task.send: missing "workspaceId". Ensure WMUX_WORKSPACE_ID is set.' };

    if (!rawMessage) return { error: 'a2a.task.send: missing "message"' };
    let message: string;
    try { message = validateMessage(rawMessage); } catch (e) {
      return { error: `a2a.task.send: ${e instanceof Error ? e.message : 'invalid'}` };
    }

    // `silent: true` suppresses the PTY paste delivery so the receiver's
    // terminal (and any running TUI agent) is not disturbed. The task is
    // still persisted in the store and remains queryable via
    // a2a_task_query — this is the canonical "inbox" path that avoids
    // injecting message content into the receiver's prompt stream.
    const silent = params.silent === true;

    // Build parts (A2A standard: kind discriminant)
    const parts: Part[] = [{ kind: 'text', text: message }];
    if (params.data && typeof params.data === 'object') {
      parts.push({
        kind: 'data',
        data: params.data as Record<string, unknown>,
        metadata: { mimeType: typeof params.dataMimeType === 'string' ? params.dataMimeType : 'application/json' },
      });
    }

    // ── Reply branch: taskId exists → add message to existing task ──
    if (taskId) {
      const task = store.getTask(taskId);
      if (!task) return { error: `a2a.task.send: task "${taskId}" not found` };
      // Verify caller is sender or receiver of this task
      if (task.metadata.from.workspaceId !== workspaceId && task.metadata.to.workspaceId !== workspaceId) {
        return { error: 'a2a.task.send: not authorized to reply to this task' };
      }
      const role = task.metadata.from.workspaceId === workspaceId ? 'user' : 'agent';
      const msg: Message = { kind: 'message', messageId: generateId('msg'), role, parts };
      store.addTaskMessage(taskId, msg);

      // Deliver reply to the other party's terminal (unless silent)
      if (!silent) {
        const targetWsId = role === 'user' ? task.metadata.to.workspaceId : task.metadata.from.workspaceId;
        const targetWs = store.workspaces.find((w) => w.id === targetWsId);
        if (targetWs) {
          const senderWs = store.workspaces.find((w) => w.id === workspaceId);
          const senderName = senderWs?.name ?? 'unknown';
          deliverPtyNotification(targetWs, senderName, message);
        }
      }
      return { ok: true, taskId, silent };
    }

    // ── New task branch ──
    const to = typeof params.to === 'string' ? params.to : '';
    const title = typeof params.title === 'string' ? params.title : '';
    if (!to) return { error: 'a2a.task.send: missing "to"' };

    const sender = store.workspaces.find((w) => w.id === workspaceId);
    const fromName = sender?.name ?? `unknown-${workspaceId.substring(0, 8)}`;

    const toNorm = to.toLowerCase().trim();
    // Extract number from inputs like "3번", "3", "ws3", "workspace 3", "#3"
    const numMatch = toNorm.match(/^#?(?:ws|workspace\s*)?(\d+)(?:번)?$/);
    const targetNum = numMatch ? parseInt(numMatch[1], 10) : NaN;

    const target = store.workspaces.find((w) => {
      if (w.id === to) return true;
      if (w.name.toLowerCase() === toNorm) return true;
      // Match by workspace number (1-indexed)
      if (!isNaN(targetNum)) {
        const wsNumMatch = w.name.match(/(\d+)/);
        if (wsNumMatch && parseInt(wsNumMatch[1], 10) === targetNum) return true;
      }
      // Partial name match
      if (w.name.toLowerCase().includes(toNorm)) return true;
      return false;
    });
    if (!target) {
      const available = store.workspaces.map((w) => w.name).join(', ');
      return { error: `a2a.task.send: target "${to}" not found. Available: ${available}` };
    }
    if (target.id === workspaceId) return { error: 'a2a.task.send: cannot send to yourself' };

    const initialMessage: Message = { kind: 'message', messageId: generateId('msg'), role: 'user', parts };

    const newTaskId = store.createA2aTask({
      title: title || message.slice(0, 100),
      from: { workspaceId, name: fromName },
      to: { workspaceId: target.id, name: target.name },
      history: [initialMessage],
      artifacts: [],
    });

    // Deliver message to target workspace's terminal (unless silent).
    // When silent, the task is only persisted in the store and the
    // receiver must poll via a2a_task_query to discover it.
    if (!silent) {
      deliverPtyNotification(target, fromName, message);
    }

    return { ok: true, taskId: newTaskId, silent };
  }

  if (method === 'a2a.task.query') {
    const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : '';
    if (!workspaceId) return { error: 'a2a.task.query: missing "workspaceId". Ensure WMUX_WORKSPACE_ID is set.' };
    const status = typeof params.status === 'string' ? params.status as TaskState : undefined;
    const role = typeof params.role === 'string' ? params.role as 'user' | 'agent' : undefined;
    const tasks = store.queryTasks(workspaceId, { status, role });
    return { workspaceId, tasks };
  }

  if (method === 'a2a.task.update') {
    const taskId = typeof params.taskId === 'string' ? params.taskId : '';
    const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : '';
    if (!taskId) return { error: 'a2a.task.update: missing "taskId"' };
    if (!workspaceId) return { error: 'a2a.task.update: missing "workspaceId". Ensure WMUX_WORKSPACE_ID is set.' };

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
      const result = store.updateTaskStatus(taskId, params.status as TaskState, workspaceId);
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
      if (task.metadata.from.workspaceId !== workspaceId && task.metadata.to.workspaceId !== workspaceId) {
        return { error: 'a2a.task.update: not authorized' };
      }
      const role = task.metadata.from.workspaceId === workspaceId ? 'user' : 'agent';

      const parts: Part[] = [{ kind: 'text', text: message }];
      const msg: Message = { kind: 'message', messageId: generateId('msg'), role, parts };
      store.addTaskMessage(taskId, msg);

      // Deliver update to the other party's terminal
      const targetWsId = role === 'user' ? task.metadata.to.workspaceId : task.metadata.from.workspaceId;
      const targetWs = store.workspaces.find((w) => w.id === targetWsId);
      if (targetWs) {
        const callerWs = store.workspaces.find((w) => w.id === workspaceId);
        const callerName = callerWs?.name ?? 'unknown';
        deliverPtyNotification(targetWs, callerName, message);
      }
    }

    // Add artifact if provided
    if (params.artifact && typeof params.artifact === 'object') {
      const artifact = params.artifact as { name?: string; parts?: Part[] };
      if (artifact.parts) {
        store.addTaskArtifact(taskId, { name: artifact.name, parts: artifact.parts });
      }
    }

    return { ok: true, taskId };
  }

  if (method === 'a2a.task.cancel') {
    const taskId = typeof params.taskId === 'string' ? params.taskId : '';
    const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : '';
    if (!taskId) return { error: 'a2a.task.cancel: missing "taskId"' };
    if (!workspaceId) return { error: 'a2a.task.cancel: missing "workspaceId". Ensure WMUX_WORKSPACE_ID is set.' };
    const result = store.cancelTask(taskId, workspaceId);
    if (!result.ok) return { error: `a2a.task.cancel: ${result.error}` };
    return { ok: true, taskId };
  }

  if (method === 'a2a.broadcast') {
    const rawMessage = typeof params.message === 'string' ? params.message : '';
    const workspaceId = typeof params.workspaceId === 'string' ? params.workspaceId : '';
    if (!workspaceId) return { error: 'a2a.broadcast: missing "workspaceId". Ensure WMUX_WORKSPACE_ID is set.' };
    if (!rawMessage) return { error: 'a2a.broadcast: missing "message"' };
    let message: string;
    try { message = validateMessage(rawMessage); } catch (e) {
      return { error: `a2a.broadcast: ${e instanceof Error ? e.message : 'invalid'}` };
    }

    const sender = store.workspaces.find((w) => w.id === workspaceId);
    const fromName = sender?.name ?? workspaceId.substring(0, 8);

    // Deliver to all other workspaces via PTY paste
    let sent = 0;
    for (const ws of store.workspaces) {
      if (ws.id === workspaceId) continue;
      const leaves = findLeafPanes(ws.rootPane);
      for (const leaf of leaves) {
        const termSurface = leaf.surfaces.find((s) => s.surfaceType !== 'browser' && s.ptyId);
        if (termSurface) {
          const formatted = formatA2aBroadcast(fromName, message);
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
    const rawSkills = Array.isArray(params.skills) ? params.skills : [];
    if (!workspaceId) return { error: 'meta.setSkills: missing "workspaceId". Ensure WMUX_WORKSPACE_ID is set.' };
    // Accept string[] (from MCP) and convert to AgentSkill[]
    const skills: AgentSkill[] = rawSkills.map((s: unknown) =>
      typeof s === 'string' ? { id: s, name: s } : s as AgentSkill,
    );
    store.setAgentSkills(workspaceId, skills);
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // company.* — Company mode handlers
  // -------------------------------------------------------------------------

  if (method.startsWith('company.')) {
    const result = await handleCompanyRpc(method, params, store);
    if (result !== null) return result;
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
