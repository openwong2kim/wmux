// Pure builders for the WorkspaceMirror push payload (see
// ../../shared/workspaceMirror.ts and ../../main/workspace/WorkspaceMirror.ts).
//
// Extracted here — with no store/window imports — so the payload construction is
// unit-testable directly (the useWorkspaceMirrorPush hook itself pulls in the
// store/window and can't be imported under vitest). `findActivePtyId` /
// `collectAllPtyIds` were lifted out of useRpcBridge.ts so the mirror's `entries`
// payload is byte-identical to the `workspace.list` reply, with a single source
// of truth for the two helpers.

import type { Pane, PaneLeaf, Workspace } from '../../shared/types';
import type {
  WorkspaceListEntry,
  FleetSnapshot,
  FleetSnapshotPane,
  WorkspaceMirrorPushPayload,
} from '../../shared/workspaceMirror';
import { selectFleetPanes, type FleetSelectorState } from '../stores/selectors/fleet';

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
 * Roll `selectFleetPanes` up into one FleetSnapshot per workspace. Reuses the
 * canonical fleet selector (its 3-tier status gate + active-pane fidelity for
 * agentName) so the mirror's per-pane status agrees exactly with the cockpit.
 */
export function buildFleetSnapshots(state: FleetSelectorState, ts: number): FleetSnapshot[] {
  const byWs = new Map<string, FleetSnapshot>();
  for (const pane of selectFleetPanes(state)) {
    let snap = byWs.get(pane.workspaceId);
    if (!snap) {
      snap = { workspaceId: pane.workspaceId, ts, panes: [] };
      byWs.set(pane.workspaceId, snap);
    }
    const out: FleetSnapshotPane = {
      ptyId: pane.ptyId,
      // Selector exposes agentName only for the active pane (background-pane
      // fidelity rule); null everywhere else.
      agentName: pane.agentName ?? null,
      agentStatus: pane.agentStatus,
      isActivePane: pane.isActivePane,
    };
    if (pane.cwd !== undefined) out.cwd = pane.cwd;
    snap.panes.push(out);
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
