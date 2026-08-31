import type { Workspace } from '../../../shared/types';
import { getWorkspacePtyIds } from '../../../shared/paneUtils';

/**
 * #1135 — recompute `ws.metadata.listeningPorts` as the UNION of the
 * per-surface `surfacePorts` map over the workspace's own ptyIds.
 *
 * The write path in `useNotificationListener` only recomputes this union when
 * a METADATA_UPDATE carrying `listeningPorts` arrives for a pty that still
 * belongs to the workspace. That means every way a port-owning surface can
 * DISAPPEAR (pane/surface close, ptyId wipe) left the workspace-level badge
 * frozen on the last value it ever saw: the daemon's PortWatcher drops the
 * diff state for a vanished session and emits nothing more for it, and no
 * surviving surface's update can subtract another surface's ports.
 *
 * Every teardown site that deletes `surfacePorts[ptyId]` calls this so the
 * sidebar chip follows the map it is derived from.
 */
export function recomputeWorkspacePorts(
  workspaces: Workspace[],
  surfacePorts: Record<string, number[]>,
): void {
  for (const ws of workspaces) {
    if (!ws.metadata || ws.metadata.listeningPorts === undefined) continue;
    const merged = new Set<number>();
    for (const id of getWorkspacePtyIds(ws)) {
      for (const p of surfacePorts?.[id] ?? []) merged.add(p);
    }
    ws.metadata.listeningPorts = [...merged].sort((a, b) => a - b);
  }
}
