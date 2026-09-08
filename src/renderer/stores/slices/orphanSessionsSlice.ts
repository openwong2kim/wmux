/**
 * #1101 — orphaned daemon sessions: still running, owned by no pane.
 *
 * Sessions survive pane close by design (the daemon holds the PTY; quitting
 * detaches rather than kills), but nothing in the UI listed them — the only
 * visibility was the tray's background-session COUNT. This slice computes the
 * set (live daemon sessions minus every ptyId the workspaces own — visible
 * tree AND stash, the same totality getWorkspacePtyIds enforces), keeps it
 * fresh on a slow poll, and offers the two verbs the issue asks for: adopt
 * (a new pane bound to the session id — useTerminal's reconnect path owns the
 * attach) and dispose (the existing pty.dispose).
 *
 * The list lives at app scope, not per-workspace: an orphan's origin
 * workspace may itself be gone. Rows group under the origin workspace when it
 * still exists (the spawn-time env stamp), the active one otherwise.
 */
import type { StateCreator } from 'zustand';
import type { StoreState } from '../index';
import type { Pane, PaneLeaf, Workspace } from '../../../shared/types';
import { generateId } from '../../../shared/types';
import { getWorkspacePtyIds, getWorkspaceLeafPanes, findPane, getLeafPanes } from '../../../shared/paneUtils';
import { MAX_PANES_PER_WORKSPACE } from './paneSlice';
import { publishPaneCreated, publishPaneFocused } from '../../events/publisher';
import { saveSessionNow } from '../../utils/sessionSaveBridge';

export interface OrphanSession {
  /** Daemon session id — the address for adopt (surface.ptyId) and dispose. */
  id: string;
  /** Agent display name (daemon-derived) when known; shell label otherwise. */
  label: string;
  shell: string;
  cwd?: string;
  createdAt?: string;
  state: string;
  /** Origin workspace (spawn-time env stamp); absent → phone-created. */
  workspaceId?: string;
}

export interface OrphanSessionsSlice {
  orphanSessions: OrphanSession[];
  /** Diff the daemon's live sessions against everything the workspaces own.
   *  Pure store side of the computation; the IPC fetch lives in the refresher
   *  so tests can drive it without a preload. */
  setDaemonSessionInventory: (sessions: Array<{ id: string; shell: string; state?: string; cwd?: string; createdAt?: string; workspaceId?: string; agentName?: string }>) => void;
  refreshOrphanSessions: () => Promise<void>;
  /** Bind a new pane to the orphan's session id. Returns the new pane id, or
   *  null when the session vanished between listing and clicking. */
  adoptOrphanSession: (sessionId: string) => string | null;
  /** Kill the session outright (daemon.destroySession under the hood). */
  disposeOrphanSession: (sessionId: string) => Promise<void>;
}

function shellLabel(shell: string): string {
  const base = shell.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  if (base.includes('pwsh')) return 'PowerShell 7';
  if (base.includes('powershell')) return 'PowerShell';
  if (base.includes('wsl')) return 'WSL';
  if (base.includes('cmd')) return 'CMD';
  if (base.includes('bash')) return 'Bash';
  if (base.includes('zsh')) return 'Zsh';
  return base.replace(/\.exe$/i, '') || 'session';
}

/** Every ptyId the app still owns: visible tree + stash per workspace, PLUS
 *  the floating terminal's session — it is never in any workspace tree, and
 *  missing it listed the floating pane's live session as an orphan whose ✕
 *  would kill it out from under the pane (review P1). */
function ownedPtyIds(state: StoreState): Set<string> {
  const owned = new Set<string>();
  for (const ws of state.workspaces) {
    for (const ptyId of getWorkspacePtyIds(ws)) {
      if (ptyId) owned.add(ptyId);
    }
  }
  if (state.floatingPanePtyId) owned.add(state.floatingPanePtyId);
  return owned;
}

export const createOrphanSessionsSlice: StateCreator<
  StoreState,
  [['zustand/immer', never]],
  [],
  OrphanSessionsSlice
> = (set, get) => ({
  orphanSessions: [],

  setDaemonSessionInventory: (sessions) => set((state) => {
    const owned = ownedPtyIds(state);
    state.orphanSessions = sessions
      // 'detached' is the daemon's word for "no client owns me". Local mode
      // returns no state at all and has no orphan concept by construction
      // (PTYs die with their panes) — a state-less listing is the local
      // branch and contributes nothing.
      .filter((s) => s.state === 'detached')
      .filter((s) => !owned.has(s.id))
      .map((s) => ({
        id: s.id,
        label: s.agentName ?? shellLabel(s.shell),
        shell: s.shell,
        ...(s.cwd ? { cwd: s.cwd } : {}),
        ...(s.createdAt ? { createdAt: s.createdAt } : {}),
        state: s.state ?? 'detached',
        ...(s.workspaceId ? { workspaceId: s.workspaceId } : {}),
      }));
  }),

  refreshOrphanSessions: async () => {
    try {
      const sessions = await window.electronAPI?.pty?.list?.();
      if (sessions) get().setDaemonSessionInventory(sessions);
    } catch {
      // Daemon unreachable / older preload: an orphan list is a visibility
      // nicety, never worth surfacing an error for.
    }
  },

  adoptOrphanSession: (sessionId) => {
    const orphan = get().orphanSessions.find((o) => o.id === sessionId);
    if (!orphan) return null;
    // Re-check ownership NOW, not at list time: the row may be a boot-race
    // stale (pty.list resolved before loadSession restored the trees) or the
    // session may have been re-owned in the last ≤30s. Double-owning one pty
    // means closing either surface kills it under the other (review P1).
    if (ownedPtyIds(get()).has(sessionId)) {
      set((state) => {
        state.orphanSessions = state.orphanSessions.filter((o) => o.id !== sessionId);
      });
      return null;
    }
    let newPaneId: string | null = null;
    // Plain values captured INSIDE the producer (drafts must not escape
    // set()) for the post-transaction event publishes.
    let adopted: { wsId: string; paneId: string; previousActiveId: string } | null = null;
    set((state) => {
      // Prefer the origin workspace (the session keeps its env-stamped
      // identity: agent addresses, hooks routing); fall back to the active
      // workspace for phone-created sessions or a deleted origin.
      const ws: Workspace | undefined =
        state.workspaces.find((w) => w.id === orphan.workspaceId) ??
        state.workspaces.find((w) => w.id === state.activeWorkspaceId);
      if (!ws) { newPaneId = null; return; }

      // A surface BOUND to the existing session: ptyId set at birth is the
      // same shape a restored/stashed surface has, so useTerminal's
      // active-at-mount reconnect attaches instead of creating.
      // The 20-pane cap every other leaf-construction site enforces — an
      // adopted pane is a pane like any other.
      if (getWorkspaceLeafPanes(ws).length >= MAX_PANES_PER_WORKSPACE) {
        newPaneId = null;
        return;
      }
      const surfaceId = generateId('surface');
      // Ordinal from the owned high-water (visible + stash — the #977 rule
      // splitPane follows), so an adopted pane can never reuse a stashed
      // pane's number: the auto name doubles as the A2A address.
      const nextOrdinal = ws.nextPaneOrdinal
        ?? (getWorkspaceLeafPanes(ws).reduce((m, l) => Math.max(m, l.ordinal ?? 0), 0) + 1);
      const leaf: PaneLeaf = {
        id: generateId('pane'),
        type: 'leaf',
        surfaces: [{
          id: surfaceId,
          ptyId: sessionId,
          title: orphan.label,
          shell: orphan.shell,
          ...(orphan.cwd ? { cwd: orphan.cwd } : { cwd: '' }),
        }],
        activeSurfaceId: surfaceId,
        ordinal: nextOrdinal,
      };
      ws.nextPaneOrdinal = nextOrdinal + 1;

      const anchorLeaf = findPane(ws.rootPane, ws.activePaneId);
      if (anchorLeaf && anchorLeaf.type === 'leaf') {
        insertBeside(ws, anchorLeaf.id, leaf);
      } else {
        // No live anchor (empty workspace tree edge) — replace the root only
        // when it is a bare leaf with no surfaces; otherwise split the first
        // leaf of the root branch.
        const root = ws.rootPane;
        if (root.type === 'leaf' && root.surfaces.length === 0) {
          ws.rootPane = leaf;
        } else {
          const firstLeaf = root.type === 'leaf' ? root : getLeafPanes(root)[0];
          if (firstLeaf) insertBeside(ws, firstLeaf.id, leaf);
          else ws.rootPane = leaf;
        }
      }
      adopted = { wsId: ws.id, paneId: leaf.id, previousActiveId: ws.activePaneId };
      ws.activePaneId = leaf.id;
      state.activeWorkspaceId = ws.id;
      // A zoom pinned elsewhere must not swallow the adopted pane — the same
      // born-hidden un-zoom splitPane applies (#182).
      if (state.zoomedPaneId && findPane(ws.rootPane, state.zoomedPaneId)) {
        state.zoomedPaneId = null;
      }
      newPaneId = leaf.id;

      // The row leaves the list the moment it is owned again.
      state.orphanSessions = state.orphanSessions.filter((o) => o.id !== sessionId);
    });
    const adoptedInfo = adopted as { wsId: string; paneId: string; previousActiveId: string } | null;
    if (adoptedInfo) {
      // pane.list + events.poll is the documented complete recovery path for
      // external pollers (docs/api/stability.md): a pane appearing in the
      // layout silently would break that contract. Focus follows the same
      // rule every other activePaneId assignment obeys. And the tree change
      // rides the 5s autosave otherwise — adopt-then-quit must not lose it.
      publishPaneCreated(adoptedInfo.wsId, adoptedInfo.paneId);
      publishPaneFocused(adoptedInfo.wsId, adoptedInfo.paneId, adoptedInfo.previousActiveId);
      saveSessionNow();
    }
    return newPaneId;
  },

  disposeOrphanSession: async (sessionId) => {
    set((state) => {
      state.orphanSessions = state.orphanSessions.filter((o) => o.id !== sessionId);
    });
    try {
      await window.electronAPI?.pty?.dispose?.(sessionId);
    } catch {
      // Best-effort mirror of every other dispose call site; a failed kill
      // reappears on the next refresh rather than lying in the list.
    }
    void get().refreshOrphanSessions();
  },
});

/** Attach `node` beside leaf `targetLeafId` in a fresh 50/50 branch — the
 *  same structural shape unstashPane/movePane produce (attachBeside's
 *  discipline, kept local to avoid widening paneSlice's private surface). */
function insertBeside(ws: Workspace, targetLeafId: string, node: Pane): boolean {
  const parent = findParentOf(ws.rootPane, targetLeafId);
  const target = findPane(ws.rootPane, targetLeafId);
  if (!target) return false;
  const branch = {
    id: generateId('pane'),
    type: 'branch' as const,
    direction: 'horizontal' as const,
    children: [target, node],
    sizes: [50, 50],
  };
  if (parent) {
    const idx = parent.children.findIndex((c) => c.id === targetLeafId);
    if (idx === -1) return false;
    parent.children[idx] = branch;
  } else {
    ws.rootPane = branch;
  }
  return true;
}

function findParentOf(root: Pane, paneId: string): { children: Pane[] } | null {
  if (root.type === 'leaf') return null;
  for (const child of root.children) {
    if (child.id === paneId) return root;
    const found = findParentOf(child, paneId);
    if (found) return found;
  }
  return null;
}
