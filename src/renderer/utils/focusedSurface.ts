import type { Workspace, Pane, PaneLeaf, Surface } from '../../shared/types';
import { classifySessionLocation, type SessionLocation } from '../../shared/sessionLocation';

/** Find the leaf pane matching the workspace's activePaneId. */
export function findActiveLeaf(workspace: Workspace): PaneLeaf | null {
  const walk = (pane: Pane): PaneLeaf | null => {
    if (pane.type === 'leaf') return pane.id === workspace.activePaneId ? pane : null;
    for (const child of pane.children) {
      const found = walk(child);
      if (found) return found;
    }
    return null;
  };
  return walk(workspace.rootPane);
}

export function sessionLocationForSurface(surface: Surface | undefined): SessionLocation | null {
  if (!surface?.cwd) return null;
  return surface.location ?? classifySessionLocation(surface.shell, surface.cwd);
}

/** Authoritative filesystem location for the active surface, including a
 * classification fallback for sessions persisted before `location`. */
export function activeSessionLocation(workspace: Workspace): SessionLocation | null {
  const leaf = findActiveLeaf(workspace);
  const surface = leaf?.surfaces.find((candidate) => candidate.id === leaf.activeSurfaceId);
  const surfaceLocation = sessionLocationForSurface(surface);
  if (surfaceLocation) return surfaceLocation;
  const cwd = workspace.metadata?.cwd ?? workspace.profile?.startupCwd;
  if (!cwd) return null;
  return classifySessionLocation(workspace.profile?.shell ?? '', cwd);
}

/**
 * Resolve the ptyId of the focused terminal surface, or null when no terminal
 * is focused (no workspace, non-terminal surface, or unbound ptyId). Toolbar
 * inject actions use null to disable themselves.
 */
export function focusedTerminalPtyId(workspace: Workspace | undefined): string | null {
  if (!workspace) return null;
  const leaf = findActiveLeaf(workspace);
  if (!leaf) return null;
  const surface = leaf.surfaces.find((s) => s.id === leaf.activeSurfaceId);
  if (!surface) return null;
  const type = surface.surfaceType ?? 'terminal';
  if (type !== 'terminal') return null;
  return surface.ptyId ? surface.ptyId : null;
}
