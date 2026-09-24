// Sidebar geometry and ordering settings (#1481).
//
// Pure values and clamps, shared by the store (persist/restore), the sidebar
// (drag handle), the titlebar (its left segment is width-matched to the
// sidebar — DESIGN.md Window Chrome) and the tests.

/** Default expanded sidebar width. Double-clicking the edge handle returns here. */
export const SIDEBAR_DEFAULT_WIDTH = 264;
/** Narrowest drag stop: below this a workspace name no longer survives the row chrome. */
export const SIDEBAR_MIN_WIDTH = 220;
/** Widest drag stop: past this the sidebar starts competing with the terminals. */
export const SIDEBAR_MAX_WIDTH = 400;
/** The compact rail. Not resizable. */
export const SIDEBAR_COMPACT_WIDTH = 48;

/**
 * Clamp a requested width into the drag range. Anything that is not a finite
 * number (a torn session file, a string) falls back to the default rather than
 * to a bound, so a corrupt value never pins the sidebar at its narrowest.
 */
export function clampSidebarWidth(width: unknown): number {
  if (typeof width !== 'number' || !Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width)));
}

/**
 * How the workspace list is ordered. Display only — the stored order, Ctrl+N
 * labels and drag positions are defined on the manual order in every mode.
 *   manual    — the order the user dragged (default)
 *   attention — needs-you rows lifted to the top, otherwise manual
 *   recent    — most recent terminal/agent activity first
 */
export type SidebarSortMode = 'manual' | 'attention' | 'recent';

export const SIDEBAR_SORT_MODES: readonly SidebarSortMode[] = ['manual', 'attention', 'recent'];

export function isSidebarSortMode(value: unknown): value is SidebarSortMode {
  return typeof value === 'string' && (SIDEBAR_SORT_MODES as readonly string[]).includes(value);
}

/**
 * Resolve the persisted sort mode. Sessions written before the mode existed
 * carry only the old `sidebarAttentionFirst` boolean; that flag maps onto the
 * attention mode so nobody's list changes order on upgrade.
 */
export function resolveSidebarSortMode(data: {
  sidebarSortMode?: unknown;
  sidebarAttentionFirst?: unknown;
}): SidebarSortMode {
  if (isSidebarSortMode(data.sidebarSortMode)) return data.sidebarSortMode;
  return data.sidebarAttentionFirst === true ? 'attention' : 'manual';
}

/** Remembered-expansion key of the "From closed workspace" group. */
export const ORPHAN_GROUP_KEY = '__closed-owner__';

/**
 * #1481 — keep only the task-group expansion entries whose owner is still an
 * open workspace (plus the closed-owner group's own key), dropping malformed
 * values. Without this every owner ever closed would stay in the session file.
 */
export function pruneTaskGroupExpanded(
  map: unknown,
  liveIds: ReadonlySet<string>,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (!map || typeof map !== 'object') return out;
  for (const [ownerId, value] of Object.entries(map as Record<string, unknown>)) {
    if (typeof value !== 'boolean') continue;
    if (ownerId === ORPHAN_GROUP_KEY || liveIds.has(ownerId)) out[ownerId] = value;
  }
  return out;
}
