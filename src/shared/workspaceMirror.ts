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
  /** Union of every surface's PTY id across the whole workspace. */
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
}
