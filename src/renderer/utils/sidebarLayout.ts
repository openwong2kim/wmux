// Sidebar geometry and ordering settings (#1481).
//
// Pure values and clamps, shared by the store (persist/restore), the sidebar
// (drag handle), the titlebar (its left segment is width-matched to the
// sidebar — DESIGN.md Window Chrome) and the tests.

import type { WorkTask } from '../../shared/workTask';
import { resolveTaskLink } from './fanoutProvenance';

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
 *   attention — the glance board (default, 2026-09-25): needs you → finished →
 *               running → unconfirmed → idle
 *   manual    — the order the user dragged
 *   recent    — most recent terminal/agent activity first
 * In every mode the pinned group comes first, in its stored order, and only
 * the rows below it sort (see pinnedFirst).
 */
export type SidebarSortMode = 'manual' | 'attention' | 'recent';

export const SIDEBAR_SORT_MODES: readonly SidebarSortMode[] = ['manual', 'attention', 'recent'];

export function isSidebarSortMode(value: unknown): value is SidebarSortMode {
  return typeof value === 'string' && (SIDEBAR_SORT_MODES as readonly string[]).includes(value);
}

/**
 * Resolve the persisted sort mode (owner decision 2026-09-25: Attention is the
 * default). A mode the user explicitly chose in Settings (`sidebarSortModeChosen`)
 * is kept, Manual included. 'recent' was only ever reachable by choosing it, so
 * it is kept too. Anything else — an old session with only the attention
 * flag, or a stored 'manual' that was merely the previous default — becomes
 * Attention.
 */
export function resolveSidebarSortMode(data: {
  sidebarSortMode?: unknown;
  sidebarSortModeChosen?: unknown;
  sidebarAttentionFirst?: unknown;
}): SidebarSortMode {
  if (data.sidebarSortModeChosen === true && isSidebarSortMode(data.sidebarSortMode)) return data.sidebarSortMode;
  if (data.sidebarSortMode === 'recent') return 'recent';
  return 'attention';
}

/**
 * The order a session was actually showing before the 2026-09-25 default flip
 * (what resolveSidebarSortMode's input meant under the old rules). Used to
 * tell a user once that their Manual list now sorts by attention.
 */
export function previousSidebarSortMode(data: {
  sidebarSortMode?: unknown;
  sidebarSortModeChosen?: unknown;
  sidebarAttentionFirst?: unknown;
}): SidebarSortMode {
  if (isSidebarSortMode(data.sidebarSortMode)) return data.sidebarSortMode;
  return data.sidebarAttentionFirst === true ? 'attention' : 'manual';
}

/** True when loading this session switches a Manual list to Attention. */
export function sortModeMigratedToAttention(data: Parameters<typeof previousSidebarSortMode>[0]): boolean {
  return previousSidebarSortMode(data) === 'manual' && resolveSidebarSortMode(data) === 'attention';
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

// ─── Pinned to top (owner decision 2026-09-26) ───────────────────────────────
//
// Pinned workspaces are a prefix of the stored order: `workspaces[0..k)` is the
// pinned group, in the order the user gave it. Keeping the group in the stored
// order (rather than beside it) means everything already defined on the stored
// order — Ctrl+N, the rail's numbers, the phone's `order` — reads pinned-first
// with no second ordering to keep in step.

/** Stable partition: pinned items first, each side keeping its order. */
export function pinnedFirst<T extends { id: string }>(items: readonly T[], pinned: ReadonlySet<string>): T[] {
  return [...items.filter((w) => pinned.has(w.id)), ...items.filter((w) => !pinned.has(w.id))];
}

/**
 * Move `items[fromIndex]` to `toIndex`, optionally setting its pin state, and
 * restore the pinned prefix. Returns null when nothing changes. `pin` is the
 * drop target's state: a drop beside a pinned row pins, beside an unpinned row
 * unpins, so a drag across the group boundary is a pin or an unpin.
 */
export function movePinned<T extends { id: string }>(
  items: readonly T[],
  pinnedIds: readonly string[],
  fromIndex: number,
  toIndex: number,
  pin?: boolean,
): { items: T[]; pinnedIds: string[] } | null {
  if (fromIndex < 0 || fromIndex >= items.length || toIndex < 0 || toIndex >= items.length) return null;
  const moved = items[fromIndex];
  const wasPinned = pinnedIds.includes(moved.id);
  const nextPinned = pin === undefined ? wasPinned : pin;
  if (fromIndex === toIndex && nextPinned === wasPinned) return null;
  const next = [...items];
  next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  const ids = nextPinned === wasPinned
    ? [...pinnedIds]
    : nextPinned ? [...pinnedIds, moved.id] : pinnedIds.filter((id) => id !== moved.id);
  return { items: pinnedFirst(next, new Set(ids)), pinnedIds: ids };
}

/**
 * Pin (to the end of the pinned group) or unpin (to the top of the rest).
 * Returns null for an unknown id.
 */
export function togglePinned<T extends { id: string }>(
  items: readonly T[],
  pinnedIds: readonly string[],
  id: string,
): { items: T[]; pinnedIds: string[] } | null {
  const from = items.findIndex((w) => w.id === id);
  if (from === -1) return null;
  const pinned = new Set(pinnedIds);
  const count = items.filter((w) => pinned.has(w.id)).length;
  // Pinning: the group grows by one and the row lands at its end. Unpinning:
  // with the row out of the group, the first unpinned slot is count - 1.
  return pinned.has(id)
    ? movePinned(items, pinnedIds, from, count - 1, false)
    : movePinned(items, pinnedIds, from, count, true);
}

/** The store maps that decide fan-out nesting (workTaskSlice). */
export interface FanoutNesting {
  missionByPaneGroup?: Readonly<Record<string, WorkTask>>;
  fanoutLineage?: Readonly<Record<string, string>>;
  fanoutSpawnOwner?: Readonly<Record<string, string>>;
}

/**
 * Whether a workspace renders nested under a fan-out owner (or in the
 * "From closed workspace" group) rather than as a top-level row — the same
 * rule the sidebar's nesting uses: any task link that is not detached.
 */
export function isNestedTask(
  state: FanoutNesting,
  id: string,
): boolean {
  const link = resolveTaskLink(state.missionByPaneGroup?.[id], state.fanoutLineage?.[id], state.fanoutSpawnOwner?.[id]);
  return !!link && !link.detached;
}

/**
 * Nesting wins over a pin: a nested task has no top-level slot, so it cannot
 * sit in the pinned group. Unpins every pinned workspace that is a nested
 * task and moves it to the top of the rest, keeping the pinned prefix. Nesting
 * is runtime state (missions, lineage, spawn stamps arrive after load), so the
 * store runs this wherever that state or the pins change. Mutates `state`
 * only when something was unpinned.
 */
export function unpinNestedTasks<W extends { id: string }>(
  state: FanoutNesting & { workspaces: W[]; sidebarPinnedIds?: string[] },
): void {
  const pinnedIds = state.sidebarPinnedIds;
  if (!pinnedIds || pinnedIds.length === 0) return;
  const kept = pinnedIds.filter((id) => !isNestedTask(state, id));
  if (kept.length === pinnedIds.length) return;
  state.sidebarPinnedIds = kept;
  state.workspaces = pinnedFirst(state.workspaces, new Set(kept));
}
