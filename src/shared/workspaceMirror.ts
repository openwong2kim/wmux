// Shared wire + storage shapes for the WorkspaceMirror (a main-process cache of
// the renderer's workspace tree + per-pane agent status, populated by renderer
// push). Kept in `shared/` so the renderer (which builds the push payload) and
// main (which stores it) agree on ONE type — the mirror re-exports these so
// downstream main consumers can import from either.
//
// The mirror is routing/snapshot-only: it is NEVER read by the renderer/UI and
// is never authoritative for focus. It exists to kill the hook-jank
// `workspace.list` renderer round-trip — a main→renderer IPC that a
// large-buffer flush storm starves (see hooks.rpc.ts WORKSPACE_LIST_CACHE_TTL_MS
// note). With the mirror, main serves the last renderer-pushed snapshot locally.

import type { AgentStatus } from './types';

/**
 * The exact per-workspace shape the hook resolvers consume (the same fields the
 * renderer's `workspace.list` reply carries — see useRpcBridge.ts). `metadata`
 * is a superset of the resolver's `{ cwd }` requirement so a richer snapshot
 * still drops into any consumer that only reads `metadata.cwd`.
 */
export interface WorkspaceListEntry {
  id: string;
  name: string;
  metadata?: {
    cwd?: string | null;
    gitBranch?: string | null;
    agentName?: string | null;
    agentStatus?: string | null;
    status?: string | null;
    progress?: number | null;
  };
  /** The active pane's active surface PTY id. Null when none has spawned. */
  activePtyId?: string | null;
  /**
   * Union of every surface's PTY id the workspace OWNS — including panes the
   * user has STASHED out of the layout, whose sessions are still running
   * (#977). Main's hook router uses this as the membership test for a signal's
   * `WMUX_PTY_ID`, so a stashed pane missing here would have its hooks
   * misrouted to the workspace's active pane. Visible panes come first.
   */
  ptyIds?: string[];
}

/** One pane's agent status, distilled from the renderer fleet selector
 *  (selectFleetPanes). `agentStatus` reuses the selector's status union rather
 *  than inventing a new one; `agentName` follows the selector's active-pane
 *  fidelity rule (null for background panes). */
export interface FleetSnapshotPane {
  ptyId: string;
  agentName: string | null;
  agentStatus: AgentStatus;
  cwd?: string;
  isActivePane: boolean;
  /**
   * TRUE when this PTY has an independently DETECTED agent identity
   * (`surfaceAgent[ptyId].name`, the #850 guard), false for a plain shell or
   * tool pane. It exists because `agentName` cannot answer this question: that
   * field follows the active-pane fidelity rule above, so a background worker
   * agent also reports `null` and "no name" can never mean "no agent".
   *
   * The gates read it through `isAgentPane` (main/deck/stopGate.ts). Optional
   * on the wire: an OLD renderer under a packaged update omits it, and
   * `undefined` means "unknown", which the gates treat as an agent — the
   * behaviour shipped before this field existed. Only an explicit `false` says
   * "this is a shell".
   */
  isAgent?: boolean;
}

/** Per-workspace agent-status snapshot. `ts` is the renderer push timestamp. */
export interface FleetSnapshot {
  workspaceId: string;
  ts: number;
  panes: FleetSnapshotPane[];
}

/**
 * The full snapshot the renderer pushes over IPC.WORKSPACE_MIRROR_PUSH. Full
 * replacement semantics (last write wins) — a partial/delta push is never sent,
 * so main never has to reconcile.
 */
export interface WorkspaceMirrorPushPayload {
  /** Renderer clock at build time (ms). */
  ts: number;
  entries: WorkspaceListEntry[];
  fleets: FleetSnapshot[];
  /**
   * ptyId → resolved role→model binding for every surface whose pane carries a
   * bound role (D2). COMPLETE when present: a ptyId absent from the map has no
   * binding, so main's resolver can answer "unbound" without a renderer
   * round-trip. An OLD renderer (stale preload under a packaged update) omits
   * the field entirely — main must treat `undefined` as "unknown, round-trip",
   * never as "unbound". Values are renderer-normalized but re-normalized at the
   * main read boundary (the store is hand-editable via session.json).
   */
  roleBindings?: Record<string, unknown>;
  /**
   * ptyId → paneId for EVERY live surface, stashed panes included. COMPLETE
   * when present, so main can resolve a caller's pane (per-pane Chrome
   * profile, `ChromeProfileStore.paneBindings`) without a renderer round-trip.
   * An old renderer omits it: `undefined` means "unknown, round-trip", never
   * "no panes".
   */
  panePtys?: Record<string, string>;
  /**
   * Every pane id in the layout, stashed panes included — a pane with no PTY
   * (browser-only, mid-respawn) too, which `panePtys` cannot name. COMPLETE
   * when present; `undefined` (old renderer) means unknown, so main never
   * prunes a pane binding from its absence.
   */
  paneIds?: string[];
  /**
   * True once this renderer has installed a SAVED session's workspaces (the
   * ids came from session.json). False after a failed or empty session load,
   * where the tree is a freshly generated default workspace whose id matches
   * nothing on disk. Destructive reconcilers keyed on workspace ids (the
   * startup Deck orphan pass) must require it. An old renderer omits it,
   * which counts as false.
   */
  sessionRestored?: boolean;
  /**
   * Workspace ids pinned to the top of the sidebar (`sidebarPinnedIds`). The
   * settle rules exempt a pinned workspace. An old renderer omits the field,
   * which main reads as "nothing pinned".
   */
  pinnedIds?: string[];
  /**
   * What the human is looking at: the active workspace and its active pane.
   * Feeds the HQ brain's context line (main/deck/viewContext.ts). An old
   * renderer omits it, which main reads as "unknown" (no context line).
   */
  viewed?: ViewedPointer;
}

/** The viewed workspace, its active pane, and that pane's active surface's own
 *  cwd and branch (absent when that surface never reported one). */
export interface ViewedPointer {
  workspaceId: string;
  paneId: string | null;
  cwd?: string;
  branch?: string;
}
