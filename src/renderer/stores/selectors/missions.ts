// ─── Task (mission) projections shared by the sidebar and the deck ──────────
//
// The sidebar used to render the task list a second time, next to the deck's
// ledger panel. It now renders a one-line SUMMARY instead (DESIGN.md Layout
// Contract: the left sidebar is navigation only), and the per-task rows — with
// their `#` channel jump — live in the deck panel alone. These pure projections
// are what each surface needs from the task store.

import type { WorkTask } from '../../../shared/workTask';

export interface MissionSummary {
  /** Tasks still open, across every workspace. */
  open: number;
  /** Tasks that have closed and are still in the cache. */
  finished: number;
}

/**
 * The counts the sidebar header states. Deliberately NOT an attention count:
 * "N need you" already has two renditions (the titlebar vitals chip and the
 * deck's red dots), and DESIGN.md allows two. A third one here would also have
 * had to be derived from the pane mirror while the deck derives its dots from
 * the ledger — two rollups that can disagree about the same task.
 */
export function summarizeMissions(missions: readonly WorkTask[]): MissionSummary {
  let open = 0;
  let finished = 0;
  for (const task of missions) {
    if (task.status === 'open') open += 1;
    else finished += 1;
  }
  return { open, finished };
}

/**
 * `taskId → mission channel id`, so the deck's ledger rows can carry the `#`
 * jump the deleted sidebar rows had. The ledger summary is built in main from
 * the ledger alone and does not know about channels; the task record in the
 * renderer store does, and it is keyed by the same WorkTask id the ledger rows
 * use.
 */
export function selectMissionChannelIds(
  byWorkspace: Readonly<Record<string, WorkTask[]>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tasks of Object.values(byWorkspace)) {
    for (const task of tasks) {
      if (task.missionChannelId) out[task.id] = task.missionChannelId;
    }
  }
  return out;
}

/**
 * Which workspace's deck should the sidebar's task line open?
 *
 * The summary counts EVERY workspace's tasks, but the deck panel is
 * per-workspace: it reads the ledger of the workspace that is active. Landing
 * on an empty panel after clicking "3 open" is the dead link that made this
 * function necessary.
 *
 *   - the active workspace owns a matching task → null (stay where you are).
 *   - it does not → the owner of the most recent matching task.
 *   - nothing matches anywhere → null (the caller renders no line at all).
 *
 * "Most recent" is `createdAt`: WorkTask carries no updatedAt, and a task's
 * creation is the only ordering the record actually has.
 */
export function ownerForTaskLedger(
  byWorkspace: Readonly<Record<string, WorkTask[]>>,
  activeWorkspaceId: string | null | undefined,
  wanted: WorkTask['status'],
  isLive: (task: WorkTask) => boolean,
): string | null {
  let bestOwner: string | null = null;
  let bestAt = -Infinity;
  for (const [ownerId, tasks] of Object.entries(byWorkspace)) {
    for (const task of tasks) {
      if (task.status !== wanted || !isLive(task)) continue;
      // The active workspace has one — the deck is already pointed at it.
      if (ownerId === activeWorkspaceId) return null;
      if (task.createdAt > bestAt) {
        bestAt = task.createdAt;
        bestOwner = ownerId;
      }
    }
  }
  return bestOwner;
}
