// ─── Task (mission) projections shared by the sidebar and the deck ──────────
//
// The sidebar used to render the task list a second time, next to the deck's
// ledger panel. It now renders a one-line SUMMARY instead (DESIGN.md Layout
// Contract: the left sidebar is navigation only), and the per-task rows — with
// their `#` channel jump — live in the deck panel alone. These two pure
// projections are what each surface needs from the task store.

import type { AgentStatus } from '../../../shared/types';
import type { WorkTask } from '../../../shared/workTask';
import { missionLedgerStatus, taskStatusDot } from '../../components/shared/taskStatusDot';

export interface MissionSummary {
  /** Tasks still open. */
  open: number;
  /** Of those, the ones whose worker is blocked on a human. */
  needYou: number;
}

/**
 * The counts the sidebar header states. `needYou` is decided by the SAME dot
 * helper the deck panel paints its rows with (`attention` tone), so the
 * sidebar's number and the deck's red dots can never disagree about which
 * tasks are waiting on somebody.
 *
 * A task with no materialized workspace (a fan-out still in flight) has no
 * agent status, which the helper reads as idle — correct: there is nothing to
 * answer yet.
 */
export function summarizeMissions(
  missions: readonly WorkTask[],
  agentStatusByWorkspace: Readonly<Record<string, AgentStatus>>,
): MissionSummary {
  let open = 0;
  let needYou = 0;
  for (const task of missions) {
    if (task.status !== 'open') continue;
    open += 1;
    const workerStatus = task.paneGroupId ? agentStatusByWorkspace[task.paneGroupId] ?? null : null;
    if (taskStatusDot(missionLedgerStatus(task.status), workerStatus).tone === 'attention') {
      needYou += 1;
    }
  }
  return { open, needYou };
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
