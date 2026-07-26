import type { Workspace, Pane, PaneLeaf, Surface } from '../../shared/types';
import {
  classifySessionLocation,
  resolveSessionLocation,
  type SessionLocation,
} from '../../shared/sessionLocation';

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

/**
 * The renderer's ONE surface→location derivation. Every file-reading surface
 * (file tree, explorer popover, editor, deck skill scan) resolves through this
 * or through `activeSessionLocation` below — hand-rolled pane walkers that
 * re-spell `location ?? classify(...)` are how the two drifted apart.
 *
 * Surfaces without a cwd (editor, browser, diff — created with `cwd: ''`) are
 * not classifiable from themselves and return null; their location is set by
 * whoever opened them.
 */
export function sessionLocationForSurface(surface: Surface | undefined): SessionLocation | null {
  if (!surface?.cwd) return null;
  return resolveSessionLocation({
    shell: surface.shell,
    cwd: surface.cwd,
    location: surface.location,
  });
}

/** Authoritative filesystem location for the active surface, including a
 * classification fallback for sessions persisted before `location`. */
export function activeSessionLocation(workspace: Workspace): SessionLocation | null {
  const leaf = findActiveLeaf(workspace);
  const surface = leaf?.surfaces.find((candidate) => candidate.id === leaf.activeSurfaceId);
  const surfaceLocation = sessionLocationForSurface(surface);
  if (surfaceLocation) return surfaceLocation;
  // Workspace-level fallback, for a workspace whose active pane holds no
  // terminal yet. `WorkspaceProfile.shell` is optional, and classifying with
  // '' would make every guest cwd look host-native — Windows would then
  // resolve a WSL `/home/me/proj` as `C:\home\me\proj` (issue #21 AC 6).
  // Without a real shell there is no honest answer, so decline.
  const shell = workspace.profile?.shell;
  const cwd = workspace.metadata?.cwd ?? workspace.profile?.startupCwd;
  if (!shell || !cwd) return null;
  return classifySessionLocation(shell, cwd);
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
