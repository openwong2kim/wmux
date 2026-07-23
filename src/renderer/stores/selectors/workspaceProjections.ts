/**
 * A1 (NB2 wave 0) — minimal derived selectors replacing whole-tree `workspaces` subscriptions.
 *
 * Subscribing to `s.workspaces` wholesale causes immer to mint a new workspaces reference
 * whenever agent output updates metadata/surface fields, re-rendering every subscriber.
 * These projections pick only the fields components actually use; paired with `useShallow`,
 * re-renders happen only when those fields change.
 *
 * Usage: `useStore(selectWorkspaceIdName)` (wrapping with useShallow is harmless).
 *
 * Review fix (wave 0 panel): the first version created a fresh element object on every call,
 * so useShallow's per-element Object.is check always failed (defeating rerender reduction).
 * Array projections now keep **reference caches** for elements and arrays — when projected
 * fields are unchanged, prior element references are reused; when all elements match, the
 * prior array reference is reused. Zustand's default Object.is comparison then yields
 * re-renders only when watched fields actually change.
 */

import type { StoreState } from '../index';
import type { AgentStatus, Workspace } from '../../../shared/types';

/**
 * Reference-cache factory for array projections. Compares each element `project` produces
 * against the prior call's element with the same id via `equal`; reuses the prior reference
 * when equal. Reuses the array reference when every element is reused. When the whole-tree
 * reference is unchanged, returns the prior array immediately.
 * (Module-level cache — safe even with multiple stores because comparisons are fresh.)
 */
function makeCachedListProjection<E extends { id: string }>(
  project: (w: Workspace) => E,
  equal: (a: E, b: E) => boolean,
): (s: StoreState) => E[] {
  let prevWorkspaces: StoreState['workspaces'] | null = null;
  let prevById = new Map<string, E>();
  let prevArr: E[] = [];
  return (s) => {
    if (s.workspaces === prevWorkspaces) return prevArr;
    const nextById = new Map<string, E>();
    let changed = s.workspaces.length !== prevArr.length;
    const arr = s.workspaces.map((w, i) => {
      const fresh = project(w);
      const prev = prevById.get(w.id);
      const elem = prev !== undefined && equal(prev, fresh) ? prev : fresh;
      if (elem !== prevArr[i]) changed = true;
      nextById.set(w.id, elem);
      return elem;
    });
    prevWorkspaces = s.workspaces;
    prevById = nextById;
    if (changed) prevArr = arr;
    return prevArr;
  };
}

/** {id, name} summary — for list rendering (palette, mini sidebar, name resolution). */
export interface WorkspaceIdName {
  id: string;
  name: string;
}

export const selectWorkspaceIdName = makeCachedListProjection<WorkspaceIdName>(
  (w) => ({ id: w.id, name: w.name }),
  (a, b) => a.name === b.name,
);

/** Id-order signature — for subscribers that care only about "list structure (add/remove/reorder)".
 *  Does not react to individual item content changes (WorkspaceItem subscribes to its own content). */
export function selectWorkspaceIds(s: StoreState): string[] {
  return s.workspaces.map((w) => w.id);
}

/** 48px rail (MiniSidebar) summary — only fields needed for id/name + agent status dots.
 *  Does not react to cwd/git/port changes. */
export interface WorkspaceRailSummary {
  id: string;
  name: string;
  agentStatus: AgentStatus | undefined;
  agentName: string | undefined;
}

export const selectWorkspaceRailSummary = makeCachedListProjection<WorkspaceRailSummary>(
  (w) => ({
    id: w.id,
    name: w.name,
    agentStatus: w.metadata?.agentStatus,
    agentName: w.metadata?.agentName,
  }),
  (a, b) => a.name === b.name && a.agentStatus === b.agentStatus && a.agentName === b.agentName,
);

/** Active workspace display summary (name + git branch) — for StatusBar left side.
 *  Changes only when these two fields on the active ws change (ignores metadata on other ws).
 *  When no active ws yet (initial), name='' and branch=undefined. */
export interface ActiveWorkspaceSummary {
  name: string;
  branch: string | undefined;
}

export function selectActiveWorkspaceSummary(s: StoreState): ActiveWorkspaceSummary {
  const ws = s.workspaces.find((w) => w.id === s.activeWorkspaceId);
  return { name: ws?.name ?? '', branch: ws?.metadata?.gitBranch };
}

/**
 * The active workspace OBJECT itself — for active-ws-only subscribers that read
 * rootPane/metadata deeply (AgentToolbar, FileExplorerPopover, FileTreePanel).
 *
 * Returns the immer-managed ws reference as-is without creating a new object, so the
 * reference changes only when the active ws actually changes (switch or tree mutation on
 * that ws) — not on background ws churn. useShallow unnecessary (reference identity suffices).
 */
export function selectActiveWorkspace(s: StoreState): Workspace | undefined {
  return s.workspaces.find((w) => w.id === s.activeWorkspaceId);
}

/**
 * Selector factory to subscribe to a specific workspace OBJECT by id — lets list children
 * subscribe to "their own ws" only (WorkspaceItem). Parent (Sidebar) subscribes to list
 * structure only; each child re-renders on its ws changes via this selector.
 *
 * Returns the immer-managed ws reference as-is, so useShallow is unnecessary (reference identity).
 */
export function selectWorkspaceById(id: string) {
  return (s: StoreState): Workspace | undefined => s.workspaces.find((w) => w.id === id);
}

/** {id, name, notificationsMuted} — for notification mute toggle list (Settings). */
export interface WorkspaceMuteRow {
  id: string;
  name: string;
  notificationsMuted: boolean;
}

export const selectWorkspaceMuteRows = makeCachedListProjection<WorkspaceMuteRow>(
  (w) => ({
    id: w.id,
    name: w.name,
    notificationsMuted: w.metadata?.notificationsMuted ?? false,
  }),
  (a, b) => a.name === b.name && a.notificationsMuted === b.notificationsMuted,
);
