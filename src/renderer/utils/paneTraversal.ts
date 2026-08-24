// ─── Pane-tree traversal helpers (pure) ──────────────────────────────────────
// Extracted from useNotificationListener.ts (TODOS "findSurfaceByPtyId /
// findActiveLeaf dedup"). These are pure functions over the Pane tree with no
// React / store dependencies, so they live here and are shared by every
// notification/metadata routing path. Behavior is byte-for-byte identical to
// the previous in-file copies — the listener's regression tests (R1-R4) lock
// the routing semantics, so any change here must preserve them exactly.

import type { Pane, PaneLeaf, Surface } from '../../shared/types';
import { getWorkspaceLeafPanes, type WorkspacePaneOwner } from '../../shared/paneUtils';

/**
 * Locate the surface that owns a given ptyId anywhere in a pane tree.
 * Returns the owning surface id + the leaf pane id, or null if no surface in
 * the tree is bound to `ptyId`.
 */
export function findSurfaceByPtyId(
  root: Pane,
  ptyId: string,
): { surfaceId: string; paneId: string } | null {
  if (root.type === 'leaf') {
    const surface = root.surfaces.find((s) => s.ptyId === ptyId);
    if (surface) return { surfaceId: surface.id, paneId: root.id };
    return null;
  }
  for (const child of root.children) {
    const found = findSurfaceByPtyId(child, ptyId);
    if (found) return found;
  }
  return null;
}

/**
 * Locate a surface by its own id anywhere in a pane tree. Returns the owning
 * leaf pane id, or null when no leaf carries the surface. Fallback resolver
 * for notification click-jumps: surface ids outlive PTY reconnects, so a
 * panel entry whose originating ptyId has died can still land on its pane.
 */
export function findSurfaceById(
  root: Pane,
  surfaceId: string,
): { paneId: string } | null {
  if (root.type === 'leaf') {
    return root.surfaces.some((s) => s.id === surfaceId) ? { paneId: root.id } : null;
  }
  for (const child of root.children) {
    const found = findSurfaceById(child, surfaceId);
    if (found) return found;
  }
  return null;
}

/**
 * Collect every terminal surface in a pane tree, left-to-right / top-to-bottom
 * (the natural reading order of the split layout). Browser and editor surfaces
 * are skipped — they have no shell working directory. Used by the workspace
 * "Working directories" menu to list each powershell's cwd.
 */
export function collectTerminalSurfaces(root: Pane): Surface[] {
  if (root.type === 'leaf') {
    return root.surfaces.filter((s) => !s.surfaceType || s.surfaceType === 'terminal');
  }
  return root.children.flatMap(collectTerminalSurfaces);
}

/**
 * Find the active leaf pane in a tree — the leaf whose id matches
 * `activePaneId`. Returns null when the active pane is not a leaf in this tree
 * (or the tree has no such id).
 */
export function findActiveLeaf(pane: Pane, activePaneId: string): PaneLeaf | null {
  if (pane.type === 'leaf') return pane.id === activePaneId ? pane : null;
  for (const child of pane.children) {
    const found = findActiveLeaf(child, activePaneId);
    if (found) return found;
  }
  return null;
}

// ─── Workspace-wide variants (visible tree + stash) ──────────────────────────
//
// A stashed pane is unmounted but still owned and still running, so anything
// asking "what does this workspace hold" must see it. The tree-scoped functions
// above stay for the questions that are genuinely about the layout.

/**
 * Every terminal surface a workspace owns, visible panes first.
 * Used by the idle badge and the close-confirmation count — both would lie if
 * they only saw the layout (a stashed agent working alone would read as "idle
 * 2h", and the dialog would promise to close fewer panes than it kills).
 */
export function collectWorkspaceTerminalSurfaces(ws: WorkspacePaneOwner): Surface[] {
  return getWorkspaceLeafPanes(ws).flatMap((leaf) =>
    leaf.surfaces.filter((s) => !s.surfaceType || s.surfaceType === 'terminal'),
  );
}

/**
 * Locate the surface bound to `ptyId` anywhere a workspace owns it, reporting
 * whether the owning pane is stashed. Jump surfaces use the flag to unstash
 * before focusing — without it a notification for a stashed agent lands on a
 * silent no-op, because every focus path filters on the visible tree.
 */
export function findWorkspaceSurfaceByPtyId(
  ws: WorkspacePaneOwner,
  ptyId: string,
): { surfaceId: string; paneId: string; stashed: boolean } | null {
  const visible = findSurfaceByPtyId(ws.rootPane, ptyId);
  if (visible) return { ...visible, stashed: false };
  for (const entry of ws.stashedPanes ?? []) {
    const pane = entry?.pane;
    if (!pane || pane.type !== 'leaf') continue;
    const surface = pane.surfaces.find((s) => s.ptyId === ptyId);
    if (surface) return { surfaceId: surface.id, paneId: pane.id, stashed: true };
  }
  return null;
}

/** Surface-id counterpart of {@link findWorkspaceSurfaceByPtyId}. */
export function findWorkspaceSurfaceById(
  ws: WorkspacePaneOwner,
  surfaceId: string,
): { paneId: string; stashed: boolean } | null {
  const visible = findSurfaceById(ws.rootPane, surfaceId);
  if (visible) return { ...visible, stashed: false };
  for (const entry of ws.stashedPanes ?? []) {
    const pane = entry?.pane;
    if (!pane || pane.type !== 'leaf') continue;
    if (pane.surfaces.some((s) => s.id === surfaceId)) return { paneId: pane.id, stashed: true };
  }
  return null;
}
