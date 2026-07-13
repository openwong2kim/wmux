// ─── AppLayout render-isolation selectors (2026-07-13, measured perf fix) ────
//
// AppLayout must NOT re-render on terminal metadata/surface churn (title, cwd,
// agentStatus, running) — that churn re-created its ~1300-line chrome JSX on
// every update and, at 5 workspaces, drove CPU to 53% (half React). See
// plans/applayout-render-isolation-2026-07-13.md.
//
// AppLayout subscribes ONLY to these DERIVED-STABLE values instead of the raw
// `workspaces` array. Each returns a primitive/string that stays byte-identical
// across metadata AND surface churn, so `useSyncExternalStore`'s Object.is check
// bails the AppLayout re-render. They traverse the tree on every store dispatch
// (n≈5 workspaces — negligible), but only CHANGE on the structural events that
// AppLayout actually cares about.

import type { StoreState } from '../index';
import type { Pane } from '../../../shared/types';
import { workspaceProbeCwd } from '../../utils/projectConfigProbe';

/** Empty leaves (a leaf pane with no surfaces) under a pane subtree. */
function collectEmptyLeafIds(pane: Pane, out: string[]): void {
  if (pane.type === 'leaf') {
    if (pane.surfaces.length === 0) out.push(pane.id);
    return;
  }
  for (const child of pane.children) collectEmptyLeafIds(child, out);
}

/**
 * Signature of the ACTIVE workspace's empty-leaf set. Stable across surface
 * title/cwd churn (which mutates surfaces inside rootPane → immer replaces
 * rootPane, but the SET of empty-leaf ids is unchanged) — only a split/close
 * changes it. This is the trigger the empty-leaf PTY funnel effect needs, minus
 * the churn. Empty string when there is no active workspace.
 *
 * IMPORTANT (eng review): do NOT subscribe AppLayout to `rootPane` itself —
 * `updateSurfaceCwd`/`updateSurfaceTitleByPty` replace it on every terminal OSC
 * update, so a rootPane subscription would still re-render AppLayout on
 * active-terminal churn (the exact thing we are eliminating).
 */
export function selectActiveEmptyLeafIdsKey(state: StoreState): string {
  const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
  if (!ws) return '';
  const ids: string[] = [];
  collectEmptyLeafIds(ws.rootPane, ids);
  return ids.join('|');
}

/**
 * Signature of every workspace's effective project cwd (metadata.cwd, seeded by
 * the first pane, else profile.startupCwd). Changes only when a workspace's cwd
 * first appears / changes — NOT on title/agentStatus churn. This MUST be a
 * subscribed selector (not a getState read inside the effect): the wmux.json
 * discovery effect's only trigger is this value changing; a getState read would
 * never schedule it, silently breaking auto-discovery (eng review, both voices).
 * Cheap: metadata.cwd is written exactly once per workspace lifetime.
 */
export function selectProjectCwdSignature(state: StoreState): string {
  return state.workspaces.map((w) => `${w.id}:${workspaceProbeCwd(w) ?? ''}`).join('|');
}
