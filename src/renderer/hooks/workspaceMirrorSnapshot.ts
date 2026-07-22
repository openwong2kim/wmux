// Pure builders for the WorkspaceMirror push payload (see
// ../../shared/workspaceMirror.ts and ../../main/workspace/WorkspaceMirror.ts).
//
// Extracted here — with no store/window imports — so the payload construction is
// unit-testable directly (the useWorkspaceMirrorPush hook itself pulls in the
// store/window and can't be imported under vitest). `findActivePtyId` /
// `collectAllPtyIds` were lifted out of useRpcBridge.ts so the mirror's `entries`
// payload is byte-identical to the `workspace.list` reply, with a single source
// of truth for the two helpers.

import type { AgentStatus, Pane, PaneLeaf, Workspace } from '../../shared/types';
import { getLeafPanes } from '../../shared/paneUtils';
import type {
  WorkspaceListEntry,
  FleetSnapshot,
  FleetSnapshotPane,
  WorkspaceMirrorPushPayload,
} from '../../shared/workspaceMirror';
import { selectFleetPanes, type FleetPane, type FleetSelectorState } from '../stores/selectors/fleet';

/**
 * Resolve the ptyId of a workspace's active pane + active surface.
 *
 * Used by the workspace.list RPC response so hook bridge scripts
 * (integrations/<agent>/bin/wmux-bridge.mjs) can resolve their hook
 * payload's cwd → workspace → activePtyId in a single round-trip.
 */
export function findActivePtyId(rootPane: Pane | undefined, activePaneId: string): string | null {
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
export function collectAllPtyIds(root: Pane): string[] {
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

/**
 * Build the `workspace.list`-shaped entries. MUST stay identical to the
 * renderer's `workspace.list` reply (useRpcBridge.ts) — both call this so the
 * mirror and the round-trip can never diverge.
 */
export function buildWorkspaceListEntries(workspaces: Workspace[]): WorkspaceListEntry[] {
  return workspaces.map((w) => ({
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
    // cwd → workspace → activePtyId. activePtyId is the active pane's active
    // surface; ptyIds is the union over the whole workspace.
    activePtyId: findActivePtyId(w.rootPane, w.activePaneId),
    ptyIds: collectAllPtyIds(w.rootPane),
  }));
}

/**
 * Roll the fleet selector up into one FleetSnapshot per workspace — but
 * SURFACE-accurate, which is where this deliberately diverges from the cockpit.
 *
 * The UI rollup (`selectFleetPanes`, fleet.ts) returns one row per leaf pane:
 * ptyId is the ACTIVE surface, but agentStatus is the most-urgent attention
 * status rolled across ALL of the leaf's surfaces — correct for a pane CARD (a
 * background tab awaiting input must light the card). For the mirror it is
 * wrong: the heartbeat's `[fleet-snapshot]` prompt tells the orchestrator
 * "pane=<ptyId> state=<status> — verify then press", so pairing the active
 * surface's ptyId with a background tab's attention status would aim the brain
 * at the wrong terminal (possible mis-approval). UI lights the pane; actuation
 * must target the surface.
 *
 * So per leaf we emit:
 *   1. one row per surface that holds its OWN retained attention status
 *      (ptyId = THAT surface, agentStatus = its `surfaceAgentStatus` entry), and
 *   2. for the pane's ACTIVE surface, when it carries no attention entry of its
 *      own, one row with the pane-level non-attention status (running/idle) —
 *      so single-surface panes are byte-identical to before and the fleet tail
 *      counts stay meaningful.
 *
 * `isActivePane` stays true only for a row whose surface is the workspace's
 * active pane's ACTIVE surface (a background tab of the active pane is false).
 * `agentName` follows the same active-pane/active-surface fidelity rule.
 *
 * Reuse: `selectFleetPanes` supplies the per-leaf derived status + agentName;
 * running it again over the SAME state with the attention map emptied collapses
 * each pane to its non-attention derivation (metaStatus / hookRunning / idle),
 * which is exactly the base status the active surface must carry when a
 * background surface holds the attention.
 */
export function buildFleetSnapshots(state: FleetSelectorState, ts: number): FleetSnapshot[] {
  // Pane-level derived row per leaf (active-surface ptyId, agentName, cwd,
  // isActivePane) — the canonical selector, keyed by paneId.
  const derivedByPane = new Map<string, FleetPane>();
  for (const p of selectFleetPanes(state)) derivedByPane.set(p.paneId, p);
  // Attention-stripped base status per leaf: the same selector with no retained
  // attention statuses collapses each pane to running/idle (its non-attention
  // derivation). This is what the active surface carries when the attention
  // actually belongs to a background surface.
  const baseByPane = new Map<string, AgentStatus>();
  for (const p of selectFleetPanes({ ...state, surfaceAgentStatus: {} })) {
    baseByPane.set(p.paneId, p.agentStatus);
  }

  const byWs = new Map<string, FleetSnapshot>();
  for (const ws of state.workspaces) {
    for (const leaf of getLeafPanes(ws.rootPane)) {
      const derived = derivedByPane.get(leaf.id);
      if (!derived) continue; // selectFleetPanes emits every leaf → always present
      let snap = byWs.get(ws.id);
      if (!snap) {
        snap = { workspaceId: ws.id, ts, panes: [] };
        byWs.set(ws.id, snap);
      }
      const activePtyId = derived.ptyId; // selector's active-surface pty ('' if unspawned)
      const emitted = new Set<string>();
      // (1) One row per surface holding its OWN retained attention status.
      for (const s of leaf.surfaces) {
        if (!s.ptyId) continue;
        const att = state.surfaceAgentStatus[s.ptyId];
        if (att === undefined) continue;
        const isActiveSurface = s.id === leaf.activeSurfaceId;
        const row: FleetSnapshotPane = {
          ptyId: s.ptyId,
          // agentName is workspace-level (active-pane derived) → only the active
          // pane's ACTIVE surface may carry it; null everywhere else.
          agentName: derived.isActivePane && isActiveSurface ? (derived.agentName ?? null) : null,
          agentStatus: att,
          isActivePane: derived.isActivePane && isActiveSurface,
        };
        if (s.cwd !== undefined) row.cwd = s.cwd;
        snap.panes.push(row);
        emitted.add(s.ptyId);
      }
      // (2) Active surface's own row with the pane-level non-attention status,
      //     unless it already emitted an attention row of its own above.
      if (!emitted.has(activePtyId)) {
        const out: FleetSnapshotPane = {
          ptyId: activePtyId,
          agentName: derived.agentName ?? null,
          agentStatus: baseByPane.get(leaf.id) ?? 'idle',
          isActivePane: derived.isActivePane,
        };
        if (derived.cwd !== undefined) out.cwd = derived.cwd;
        snap.panes.push(out);
      }
    }
  }
  return [...byWs.values()];
}

/** Assemble the full push payload from the live store state at `now()`. */
export function buildWorkspaceMirrorPayload(
  state: FleetSelectorState,
  now: () => number = Date.now,
): WorkspaceMirrorPushPayload {
  const ts = now();
  return {
    ts,
    entries: buildWorkspaceListEntries(state.workspaces),
    fleets: buildFleetSnapshots(state, ts),
  };
}
