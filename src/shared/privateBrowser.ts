/**
 * Private ("incognito") browser tabs.
 *
 * Every private tab shares this ONE partition, the way Chrome's incognito
 * windows share one session. No `persist:` prefix, so Electron keeps it in
 * memory only; main additionally wipes it when the last private tab closes
 * (see countPrivateBrowserSurfaces). Private surfaces never enter the saved
 * session, so a restart cannot bring one back.
 */
import { getLeafPanes, getWorkspaceLeafPanes, type WorkspacePaneOwner } from './paneUtils';
import type { Pane, PaneLeaf, Surface } from './types';

export const PRIVATE_BROWSER_PARTITION = 'wmux-private';

export function isPrivateBrowserPartition(partition: string | undefined | null): boolean {
  return partition === PRIVATE_BROWSER_PARTITION;
}

export function isPrivateBrowserSurface(
  surface: Pick<Surface, 'surfaceType' | 'browserPartition'>,
): boolean {
  return surface.surfaceType === 'browser' && isPrivateBrowserPartition(surface.browserPartition);
}

/**
 * Private browser surfaces a set of workspaces still holds — the visible tree
 * AND stashed panes (a stashed private tab is still open). The renderer clears
 * the private session on the transition from >0 to 0, so a webview that merely
 * unmounts (hidden, discarded) never counts as a close: only the surface
 * leaving the store does.
 */
export function countPrivateBrowserSurfaces(workspaces: readonly WorkspacePaneOwner[]): number {
  let count = 0;
  for (const ws of workspaces) {
    for (const leaf of getWorkspaceLeafPanes(ws)) {
      for (const surface of leaf.surfaces) {
        if (isPrivateBrowserSurface(surface)) count += 1;
      }
    }
  }
  return count;
}

/**
 * Calls `onLastClosed` each time the private-tab count drops from above zero to
 * zero. Feed it every store update; unchanged workspace arrays are skipped.
 */
export function createPrivateSessionWatcher(
  onLastClosed: () => void,
): (workspaces: readonly WorkspacePaneOwner[]) => void {
  let lastWorkspaces: readonly WorkspacePaneOwner[] | null = null;
  let open = 0;
  return (workspaces) => {
    if (workspaces === lastWorkspaces) return;
    lastWorkspaces = workspaces;
    const count = countPrivateBrowserSurfaces(workspaces);
    if (open > 0 && count === 0) onLastClosed();
    open = count;
  };
}

/**
 * A copy of `pane` without private browser surfaces, for the saved session.
 *
 * A leaf that held ONLY private tabs is removed outright (siblings re-share its
 * size, a branch left with one child collapses into it) instead of being saved
 * empty — an empty leaf would come back as a fresh terminal pane the user never
 * had. Returns null when nothing is left; the caller decides what the root
 * becomes. Leaves that were already empty, and every other field, are left
 * exactly as they were.
 */
export function stripPrivateBrowserSurfaces(pane: Pane): Pane | null {
  if (pane.type === 'leaf') {
    if (!pane.surfaces.some(isPrivateBrowserSurface)) return pane;
    const surfaces = pane.surfaces.filter((s) => !isPrivateBrowserSurface(s));
    if (surfaces.length === 0) return null;
    const activeSurfaceId = surfaces.some((s) => s.id === pane.activeSurfaceId)
      ? pane.activeSurfaceId
      : surfaces[0].id;
    return { ...pane, surfaces, activeSurfaceId };
  }
  const kept: Pane[] = [];
  const keptSizes: number[] = [];
  pane.children.forEach((child, i) => {
    const stripped = stripPrivateBrowserSurfaces(child);
    if (!stripped) return;
    kept.push(stripped);
    keptSizes.push(pane.sizes?.[i] ?? 0);
  });
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0];
  if (kept.length === pane.children.length) return { ...pane, children: kept };
  const total = keptSizes.reduce((sum, s) => sum + s, 0);
  return {
    ...pane,
    children: kept,
    ...(pane.sizes
      ? { sizes: total > 0 ? keptSizes.map((s) => (s / total) * 100) : kept.map(() => 100 / kept.length) }
      : {}),
  };
}

/**
 * The session-save view of a workspace layout: `rootPane` without private
 * surfaces, plus an `activePaneId` that still names a leaf in it. A workspace
 * whose every pane held only private tabs keeps its first leaf, saved empty —
 * a workspace needs a root, and restore backfills an empty leaf with a
 * terminal, which is what a new workspace looks like anyway.
 */
export function sessionLayoutWithoutPrivate(
  rootPane: Pane,
  activePaneId: string,
): { rootPane: Pane; activePaneId: string } {
  const stripped =
    stripPrivateBrowserSurfaces(rootPane)
    ?? { ...getLeafPanes(rootPane)[0], surfaces: [], activeSurfaceId: '' };
  const leaves = getLeafPanes(stripped);
  return {
    rootPane: stripped,
    activePaneId: leaves.some((leaf) => leaf.id === activePaneId) ? activePaneId : leaves[0].id,
  };
}

/**
 * Stash entries for the saved session: private tabs removed, and an entry that
 * held only private tabs left out. A malformed entry passes through untouched
 * so the serializer's own fallback still sees it.
 */
export function stashedPanesWithoutPrivate<T extends { pane: PaneLeaf }>(stashed: readonly T[]): T[] {
  return stashed.flatMap((entry) => {
    const pane = entry?.pane;
    if (!pane || pane.type !== 'leaf' || !Array.isArray(pane.surfaces)) return [entry];
    const stripped = stripPrivateBrowserSurfaces(pane);
    return stripped ? [{ ...entry, pane: stripped as PaneLeaf }] : [];
  });
}
