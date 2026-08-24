import type { Pane, PaneLeaf, PaneBranch } from './types';

/** Find a leaf pane by ID */
export function findLeaf(root: Pane, id: string): PaneLeaf | null {
  if (root.type === 'leaf' && root.id === id) return root;
  if (root.type === 'branch') {
    for (const child of root.children) {
      const found = findLeaf(child, id);
      if (found) return found;
    }
  }
  return null;
}

/** Find any pane (leaf or branch) by ID */
export function findPane(root: Pane, id: string): Pane | null {
  if (root.id === id) return root;
  if (root.type === 'branch') {
    for (const child of root.children) {
      const found = findPane(child, id);
      if (found) return found;
    }
  }
  return null;
}

/** Find the parent branch of a pane by ID */
export function findParent(root: Pane, id: string): PaneBranch | null {
  if (root.type === 'branch') {
    for (const child of root.children) {
      if (child.id === id) return root;
      const found = findParent(child, id);
      if (found) return found;
    }
  }
  return null;
}

/** Collect all leaf IDs from a pane tree */
export function collectLeafIds(pane: Pane): string[] {
  if (pane.type === 'leaf') return [pane.id];
  return pane.children.flatMap(collectLeafIds);
}

/** Collect all leaf panes from a pane tree */
export function getLeafPanes(root: Pane): PaneLeaf[] {
  if (root.type === 'leaf') return [root];
  return root.children.flatMap(getLeafPanes);
}

/**
 * The minimum shape `getWorkspaceLeafPanes` / `getWorkspacePtyIds` need. Kept
 * structural (rather than importing `Workspace`) so `shared/` stays free of the
 * store's full workspace type and so callers can pass session-file shapes that
 * have not been normalized into a `Workspace` yet.
 */
export interface WorkspacePaneOwner {
  rootPane: Pane;
  stashedPanes?: ReadonlyArray<{ pane?: Pane } | null | undefined>;
}

/**
 * Every leaf a workspace OWNS — the visible tree PLUS anything the user has
 * stashed out of the layout. Use this wherever the question is "what does this
 * workspace hold" (PTY reconcile, teardown/dispose, ordinal high-water marks,
 * the pane cap, A2A address resolution). Keep using `getLeafPanes(ws.rootPane)`
 * where the question is "what is on screen" (rendering, spatial navigation,
 * layout-relative operations).
 *
 * Shape-guarded on purpose: `stashedPanes` is an optional, persisted field, so a
 * hand-edited or downgrade-round-tripped session file can hand us holes. A
 * malformed entry is skipped rather than crashing the walk.
 */
export function getWorkspaceLeafPanes(ws: WorkspacePaneOwner): PaneLeaf[] {
  const stashed = (ws.stashedPanes ?? []).flatMap((entry) => {
    const pane = entry?.pane;
    return pane && pane.type === 'leaf' ? [pane] : [];
  });
  return [...getLeafPanes(ws.rootPane), ...stashed];
}

/**
 * Every ptyId bound to a surface anywhere in a pane tree, in tree order.
 * The traversal half of the app's several "dispose everything under here"
 * paths — each of those keeps its own dispose POLICY (which ipc call, what
 * else it tears down); only the walk is shared, so a new pane location can
 * never be visible to one teardown path and invisible to another.
 */
export function collectPaneTreePtyIds(root: Pane): string[] {
  return getLeafPanes(root).flatMap((leaf) =>
    leaf.surfaces.map((s) => s.ptyId).filter((id): id is string => Boolean(id)),
  );
}

/**
 * Every ptyId a workspace owns — visible tree plus stash. The workspace-level
 * counterpart of {@link collectPaneTreePtyIds}; teardown paths must use this
 * one, or stashed panes leave orphaned daemon sessions behind.
 */
export function getWorkspacePtyIds(ws: WorkspacePaneOwner): string[] {
  return getWorkspaceLeafPanes(ws).flatMap((leaf) =>
    leaf.surfaces.map((s) => s.ptyId).filter((id): id is string => Boolean(id)),
  );
}

// ─── Not consolidated here (deliberate) ──────────────────────────────────────
//
// The walks below look like the ones above but diverge in signature or in what
// they return, so folding them in would be a behavior change, not a cleanup.
// They are listed so the next person does not have to rediscover them:
//
//   - workspaceMirrorSnapshot.findActivePtyId  — leaf lookup by activePaneId,
//     returns a ptyId not a pane.
//   - paneTraversal.findSurfaceByPtyId / findSurfaceById / findActiveLeaf /
//     collectTerminalSurfaces — surface-level results, terminal-only filters.
//   - workspaceSlice.removeWorkspace's collectSurfaces — returns {id, ptyId}
//     pairs, not panes.
//   - company/provisioner.collectPtyIds — leaf-only entry shape.
//   - uiSlice / projectConfigSlice / wmuxProjectConfig template walks — they
//     REBUILD trees (clone, assign ordinals, count) rather than flatten them.
//   - SessionManager.collectPtyIds (main process) — walks the on-disk session
//     shape, which is `unknown`-typed until validated.
//   - browserPane / focusedSurface / EmptyLeafFunnel / GitTab / ReviewTab and
//     friends — active-pane-relative lookups that intentionally see only the
//     visible tree.
