// ─── Ready to review: finished fan-out tasks still waiting on the user ───────
//
// One selector for the Fleet "Ready to review" section and the sidebar's
// `N to review` rollup, so the two cannot disagree (#1508 parity).
//
// A task is ready to review when:
//   - its workspace carries an OPEN, non-detached task record, and
//   - every agent pane in it reports `complete` (the same per-pane rule the
//     sidebar's "Close finished tasks" uses — `paneRowsFinished`; idle never
//     counts, a task with no agent pane is not finished).
// It leaves the queue when an agent starts again, asks for input, or the task
// is closed or detached.

import type { PrStatus } from '../../../shared/types';
import type { StoreState } from '../index';
import { paneRowsFinished } from '../../components/Sidebar/sidebarTree';
import { displayWorkspaceName } from '../../utils/fanoutProvenance';
import { selectWorkspaceAgentRoster } from './workspaceAgentRoster';

export interface ReviewQueueEntry {
  /** The task's own workspace. */
  workspaceId: string;
  taskId: string;
  title: string;
  /** Workspace that fanned the task out (the close/PR authz anchor). */
  ownerWorkspaceId: string;
  /** Undefined when the owner workspace is gone. */
  ownerName?: string;
  branch?: string;
  worktreePath?: string;
  /** worktree:false fan-out: the task's output folder (no branch, no diff). */
  outputDir?: string;
  /** PR for the task branch from the metadata poll (PrStatusCache), if any. */
  pr?: PrStatus;
  /** The PR the task's own "Create PR" recorded, when the poll has none yet. */
  prUrl?: string;
  /** When the task's last agent finished (turn-end stamp, else last output). */
  completedAt?: number;
}

/** True when the workspace is an open fan-out task whose agents all finished. */
export function isTaskReadyForReview(state: StoreState, workspaceId: string): boolean {
  const mission = state.missionByPaneGroup[workspaceId];
  if (!mission || mission.status !== 'open' || mission.detachedAt !== undefined) return false;
  return paneRowsFinished(selectWorkspaceAgentRoster(state, workspaceId).rows);
}

/** Workspace ids of the tasks ready to review, in sidebar order. A plain id
 *  list so a shallow-compared subscription only re-renders on membership. */
export function selectReviewQueueIds(state: StoreState): string[] {
  const ids: string[] = [];
  for (const ws of state.workspaces) {
    if (isTaskReadyForReview(state, ws.id)) ids.push(ws.id);
  }
  return ids;
}

/** How many of `taskIds` are ready to review (the sidebar rollup count). */
export function countReadyToReview(state: StoreState, taskIds: readonly string[]): number {
  let n = 0;
  for (const id of taskIds) if (isTaskReadyForReview(state, id)) n += 1;
  return n;
}

/** The row data for one ready task. Null when it is not ready (any more). */
export function reviewQueueEntry(state: StoreState, workspaceId: string): ReviewQueueEntry | null {
  if (!isTaskReadyForReview(state, workspaceId)) return null;
  const mission = state.missionByPaneGroup[workspaceId];
  const ws = state.workspaces.find((w) => w.id === workspaceId);
  if (!mission || !ws) return null;
  const ownerId = mission.owner?.verifiedWorkspaceId ?? '';
  const owner = ownerId ? state.workspaces.find((w) => w.id === ownerId) : undefined;
  // When the last agent finished: each pane's turn-end stamp, falling back to
  // its last output only for a pane that went complete before it was stamped.
  let completedAt: number | undefined;
  for (const row of selectWorkspaceAgentRoster(state, workspaceId).rows) {
    const at = state.surfaceTurnEndAt?.[row.ptyId] ?? state.surfaceOutputAt?.[row.ptyId];
    if (typeof at === 'number' && Number.isFinite(at) && (completedAt === undefined || at > completedAt)) completedAt = at;
  }
  const pr = ws.metadata?.pr ?? undefined;
  return {
    workspaceId,
    taskId: mission.id,
    title: mission.title.trim() || displayWorkspaceName(ws.name, true),
    ownerWorkspaceId: ownerId,
    ...(owner ? { ownerName: displayWorkspaceName(owner.name, false) } : {}),
    ...(mission.branch ? { branch: mission.branch } : {}),
    ...(mission.worktreePath ? { worktreePath: mission.worktreePath } : {}),
    ...(mission.outputDir ? { outputDir: mission.outputDir } : {}),
    ...(pr ? { pr } : {}),
    ...(mission.prUrl ? { prUrl: mission.prUrl } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
  };
}

/** Every ready task, the most recently finished first. */
export function selectReviewQueue(state: StoreState): ReviewQueueEntry[] {
  const entries = selectReviewQueueIds(state)
    .map((id) => reviewQueueEntry(state, id))
    .filter((e): e is ReviewQueueEntry => e !== null);
  return entries.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
}
