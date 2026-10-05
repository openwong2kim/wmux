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

/** The first cached task, across every workspace, that matches. */
export function findMission(
  byWorkspace: Readonly<Record<string, WorkTask[]>>,
  match: (task: WorkTask) => boolean,
): WorkTask | undefined {
  for (const tasks of Object.values(byWorkspace)) {
    const found = tasks.find(match);
    if (found) return found;
  }
  return undefined;
}
