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
// inside a group too. Only one level: an owner that is itself a nested task
// does not adopt children (fan-out is depth-1; this is the fallback if a
// record ever says otherwise) — its tasks render top-level.

import type { AgentStatus } from '../../../shared/types';
import type { TaskLink } from '../../utils/fanoutProvenance';

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

function needsYou(status: AgentStatus): boolean {
  return status === 'waiting' || status === 'awaiting_input';
}

/**
 * The owner row's rollup: how many tasks, how many need you. Null at zero
 * tasks — the row shows nothing then (no dead gauges).
 */
export function taskRollup(
  taskIds: readonly string[],
  statusOf: (id: string) => AgentStatus,
): { tasks: number; needYou: number } | null {
  if (taskIds.length === 0) return null;
  let needYou = 0;
  for (const id of taskIds) if (needsYou(statusOf(id))) needYou += 1;
  return { tasks: taskIds.length, needYou };
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
}): boolean {
  if (args.remembered !== undefined) return args.remembered;
  return args.ownerActive || args.anyNeedsYou;
}

/**
 * A task counts as finished when its workspace's agents have all stopped
 * without an open problem — complete, or idle after the turn — or when its
 * ledger record is already closed. Running, needs-input and error tasks are
 * never offered for closing.
 */
export function isFinishedTask(status: AgentStatus, missionClosed: boolean): boolean {
  if (missionClosed) return true;
  return status === 'complete' || status === 'idle';
}

/** Storage key for the orphan group's remembered expansion. */
export const ORPHAN_GROUP_KEY = '__closed-owner__';
