// ─── Sidebar fan-out nesting (#1481) ─────────────────────────────────────────
//
// Pure: turns the (already ordered) workspace list into top-level rows with
// their fan-out tasks attached, plus the tasks whose owner no longer exists.
//
//   - A task whose owner is open renders indented under that owner.
//   - A detached task is an ordinary workspace again: top-level.
//   - A task whose owner is gone (or cannot be named) goes to the
//     "From closed workspace" group.
//   - Everything else is top-level, in the order it came in.
//
// Children keep the input order, so whatever sort the list is in applies
// inside a group too. Only one level of WORKSPACE nesting: an owner that is
// itself a nested task does not adopt children (fan-out is depth-1; this is
// the fallback if a record ever says otherwise) — its tasks render top-level.
// Inside an owner, `splitTasksByPane` then files each task under the roster
// row of the pane that requested it (2026-09-27).

import type { AgentStatus } from '../../../shared/types';
import type { TaskLink } from '../../utils/fanoutProvenance';
import type { FanoutOrigin } from '../../../shared/fanoutOrigin';
import type { WorkTask } from '../../../shared/workTask';
import type { TranslationKey } from '../../i18n/locales/en';
import { ORPHAN_GROUP_KEY } from '../../utils/sidebarLayout';

export interface SidebarTreeNode {
  id: string;
  /** Task workspace ids nested under this row, in list order. */
  taskIds: string[];
}

export interface SidebarTree {
  top: SidebarTreeNode[];
  /** Tasks whose owner workspace no longer exists. */
  orphanTaskIds: string[];
  /** Every workspace id that is a (non-detached) fan-out task. */
  taskIds: ReadonlySet<string>;
}

export function buildSidebarTree(
  ordered: readonly { id: string }[],
  linkOf: (id: string) => TaskLink | null,
  /** Every open workspace id — NOT just the rows in view: a search filter
   *  that hides an owner must not make its tasks look orphaned. */
  liveIds: ReadonlySet<string> = new Set(ordered.map((w) => w.id)),
): SidebarTree {
  const live = liveIds;
  const links = new Map<string, TaskLink>();
  for (const w of ordered) {
    const link = linkOf(w.id);
    if (link && !link.detached) links.set(w.id, link);
  }
  const isNestedTask = (id: string) => {
    const link = links.get(id);
    return !!link && !!link.ownerId && link.ownerId !== id && live.has(link.ownerId);
  };

  const top: SidebarTreeNode[] = [];
  const byId = new Map<string, SidebarTreeNode>();
  const orphanTaskIds: string[] = [];
  const pending: { id: string; ownerId: string }[] = [];

  for (const w of ordered) {
    const link = links.get(w.id);
    if (!link) {
      const node = { id: w.id, taskIds: [] };
      top.push(node);
      byId.set(w.id, node);
      continue;
    }
    if (!link.ownerId || !live.has(link.ownerId) || link.ownerId === w.id) {
      orphanTaskIds.push(w.id);
      continue;
    }
    pending.push({ id: w.id, ownerId: link.ownerId });
  }

  for (const { id, ownerId } of pending) {
    const owner = byId.get(ownerId);
    if (owner && !isNestedTask(ownerId)) {
      owner.taskIds.push(id);
    } else {
      // Owner is itself nested (or filtered out of this view): stand alone.
      const node = { id, taskIds: [] };
      top.push(node);
      byId.set(id, node);
    }
  }

  // Keep a stand-alone fallback row in list order rather than at the end.
  const position = new Map(ordered.map((w, i) => [w.id, i]));
  top.sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));

  return { top, orphanTaskIds, taskIds: new Set(links.keys()) };
}

/** The roster fields a task is matched on — stable ids, never the ptyId. */
export interface PaneTaskRow {
  paneId: string;
  surfaceId: string;
}

export interface PaneTaskSplit {
  /** Roster row surfaceId → the tasks that pane requested, in input order. */
  byRow: Map<string, string[]>;
  /** Tasks with no live requester row here: the requesting pane closed (or
   *  no longer runs an agent), the GUI or the orchestrator asked, or the
   *  stamp predates origins. They render in one trailing group. */
  closedPane: string[];
}

/**
 * File an owner's tasks under the roster rows of the panes that requested
 * them. An origin with a surfaceId matches only that surface's row — if no
 * row holds it any more the requester is gone, even when its old pane still
 * shows other tabs (the same rule `resolveTaskRequester` uses). An origin
 * recorded without a surfaceId matches the first row of its pane.
 */
export function splitTasksByPane(
  taskIds: readonly string[],
  originOf: (id: string) => FanoutOrigin | undefined,
  rows: readonly PaneTaskRow[],
): PaneTaskSplit {
  const bySurface = new Map<string, string>();
  const byPane = new Map<string, string>();
  for (const row of rows) {
    if (!bySurface.has(row.surfaceId)) bySurface.set(row.surfaceId, row.surfaceId);
    if (!byPane.has(row.paneId)) byPane.set(row.paneId, row.surfaceId);
  }
  const byRow = new Map<string, string[]>();
  const closedPane: string[] = [];
  for (const id of taskIds) {
    const origin = originOf(id);
    let key: string | undefined;
    if (origin?.kind === 'pane') {
      key = origin.surfaceId ? bySurface.get(origin.surfaceId) : origin.paneId ? byPane.get(origin.paneId) : undefined;
    }
    if (key === undefined) {
      closedPane.push(id);
      continue;
    }
    const list = byRow.get(key);
    if (list) list.push(id);
    else byRow.set(key, [id]);
  }
  return { byRow, closedPane };
}

/** Fold-state key of one pane's task group (per owner, per requesting surface). */
export function paneTaskFoldKey(ownerId: string, surfaceId: string): string {
  return `pane:${ownerId}:${surfaceId}`;
}

/** Fold-state key of an owner's "From closed pane" group. */
export function closedPaneFoldKey(ownerId: string): string {
  return `closedPane:${ownerId}`;
}

/** A task status that asks for the user (the rollup's "need you"). */
export function taskNeedsYou(status: AgentStatus): boolean {
  return status === 'waiting' || status === 'awaiting_input';
}

/**
 * The owner row's rollup: how many tasks, how many need you, how many are
 * ready to review (`readyOf` is the shared review-queue predicate, so this
 * count and Fleet's "Ready to review" section agree). Null at zero tasks —
 * the row shows nothing then (no dead gauges).
 */
export function taskRollup(
  taskIds: readonly string[],
  statusOf: (id: string) => AgentStatus,
  readyOf: (id: string) => boolean = () => false,
): { tasks: number; needYou: number; toReview: number } | null {
  if (taskIds.length === 0) return null;
  let needYou = 0;
  let toReview = 0;
  for (const id of taskIds) {
    if (taskNeedsYou(statusOf(id))) needYou += 1;
    if (readyOf(id)) toReview += 1;
  }
  return { tasks: taskIds.length, needYou, toReview };
}

/**
 * Whether a task group is open. The user's own toggle wins; otherwise a group
 * is open while its owner is the active workspace or one of its tasks needs
 * you, and closed the rest of the time.
 */
export function isTaskGroupExpanded(args: {
  remembered: boolean | undefined;
  ownerActive: boolean;
  anyNeedsYou: boolean;
  /** One of the group's own tasks is the active workspace: always open, or
   *  the row you are working in would vanish from the list. */
  childActive?: boolean;
}): boolean {
  if (args.childActive) return true;
  if (args.remembered !== undefined) return args.remembered;
  return args.ownerActive || args.anyNeedsYou;
}

/**
 * #1481 review — a task is finished only when EVERY agent pane in it reports
 * `complete`, decided per pane (never from the workspace roll-up, where
 * `complete` outranks `running`). `idle` does not count — a booting, never
 * started or hook-less quiet agent looks idle. A task with no agent pane at
 * all is not finished either: there is nothing that said it was done. A
 * closed ledger record does not make a still-running task finished.
 */
export function paneRowsFinished(rows: readonly { status: AgentStatus }[]): boolean {
  return rows.length > 0 && rows.every((row) => row.status === 'complete');
}

export type CloseSkipReason = 'gone' | 'no-record' | 'detached' | 'moved' | 'not-finished';

/** Why a task was kept instead of closed — shared by the sidebar's
 *  close-finished action and Fleet's review rows. */
export const CLOSE_SKIP_KEY: Record<CloseSkipReason, TranslationKey> = {
  gone: 'sidebar.tasks.skipGone',
  'no-record': 'sidebar.tasks.noRecord',
  detached: 'sidebar.tasks.skipDetached',
  moved: 'sidebar.tasks.skipMoved',
  'not-finished': 'sidebar.tasks.skipNotFinished',
};

/**
 * Re-check one task right before it is closed, against the CURRENT store:
 * it still exists, still has a task record, is not detached, still belongs
 * to the group it was listed under, and all its agent panes are complete.
 */
export function revalidateTaskForClose(
  state: {
    workspaces: readonly { id: string }[];
    missionByPaneGroup: Record<string, WorkTask | undefined>;
  },
  taskWorkspaceId: string,
  groupKey: string,
  paneRows: (workspaceId: string) => readonly { status: AgentStatus }[],
): { ok: true; mission: WorkTask } | { ok: false; reason: CloseSkipReason } {
  const live = new Set(state.workspaces.map((w) => w.id));
  if (!live.has(taskWorkspaceId)) return { ok: false, reason: 'gone' };
  const mission = state.missionByPaneGroup[taskWorkspaceId];
  if (!mission) return { ok: false, reason: 'no-record' };
  if (mission.detachedAt !== undefined) return { ok: false, reason: 'detached' };
  const owner = mission.owner?.verifiedWorkspaceId ?? '';
  const belongs = groupKey === ORPHAN_GROUP_KEY ? !live.has(owner) : owner === groupKey;
  if (!belongs) return { ok: false, reason: 'moved' };
  if (!paneRowsFinished(paneRows(taskWorkspaceId))) return { ok: false, reason: 'not-finished' };
  return { ok: true, mission };
}

/** Settle within `ms` or reject with a timeout — a hung close must not hold the menu. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(ms / 1000)}s`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

export { ORPHAN_GROUP_KEY };
