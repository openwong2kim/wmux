import type { Workspace } from '../../../shared/types';
import { getWorkspacePtyIds } from '../../../shared/paneUtils';

/**
 * #1135 — the ONE definition of "a workspace's listening ports are the union
 * of its surfaces' ports". The live write path (useNotificationListener) and
 * the teardown paths (closeSurface / closePane) both go through this, so the
 * value can never be computed one way going up and another way coming down.
 */
export function unionSurfacePorts(
  ptyIds: readonly string[],
  surfacePorts: Record<string, number[]> | undefined,
): number[] {
  const merged = new Set<number>();
  for (const id of ptyIds) {
    for (const p of surfacePorts?.[id] ?? []) merged.add(p);
  }
  return [...merged].sort((a, b) => a - b);
}

/**
 * Re-derive `ws.metadata.listeningPorts` from the per-surface `surfacePorts`
 * map for every workspace that currently shows a value.
 *
 * The live write path only recomputes the union when a METADATA_UPDATE
 * carrying `listeningPorts` arrives for a pty that still belongs to the
 * workspace. That means every way a port-owning surface can DISAPPEAR (pane /
 * surface close, ptyId wipe) left the workspace-level badge frozen on the last
 * value it ever saw: the daemon's PortWatcher drops the diff state for a
 * vanished session, and no surviving surface's update can subtract another
 * surface's ports.
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
    ws.metadata.listeningPorts = unionSurfacePorts(getWorkspacePtyIds(ws), surfacePorts);
  }
}
