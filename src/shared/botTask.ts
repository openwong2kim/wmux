// ─── A bot's fan-out task as the owner sees it ─────────────────────────────
//
// The task ledger (shared/ledger.ts) says where a task is in its life; the
// owner wants to know how far its work got. One stage per task, derived by
// main from facts it holds (never from what a worker or a bot says):
//
//   coded             the worker reported its work (review_requested) and no
//                     system gate has passed on it yet;
//   checked           main's own gate passed on that report and the system
//                     completed the task;
//   waiting_to_merge  checked, and a pull request from the task's branch is
//                     open on GitHub (repo-watch facts) and not merged;
//   merged            that pull request was merged.
//
// Before a report a task is `working` or `needs_input`; a task that ended
// without a passing system gate is `closed` (completed by hand), `failed` or
// `cancelled`. A task that waits for an agent slot before its worker starts
// (main/factory/agentSlots.ts) has no ledger row yet: `waiting_slot`.

import type { LedgerEntry, LedgerGateResult, LedgerStatus } from './ledger';

export type BotTaskStage =
  | 'working'
  | 'needs_input'
  | 'coded'
  | 'checked'
  | 'waiting_to_merge'
  | 'merged'
  | 'closed'
  | 'failed'
  | 'cancelled'
  | 'waiting_slot';

/** The pull request opened from a task's branch, as repo-watch last saw it. */
export interface BotTaskPr {
  number: number;
  state: 'open' | 'merged' | 'closed';
}

/** One task of a bot (FactoryBotRow.tasks). */
export interface BotTaskView {
  taskId: string;
  /** The task's own workspace (the worker's), the key fanoutOrigin uses. */
  taskWorkspaceId: string;
  ownerWorkspaceId: string;
  botId: string;
  title: string;
  status: LedgerStatus;
  stage: BotTaskStage;
  /** The fan-out preset the task ran with. */
  preset?: string;
  /** The last system-recorded gate. `skipped` = nothing ran (no gate
   *  declared, or the task made no commits beyond its base). */
  gate?: { exitCode: number | null; at: number; skipped?: 'no_gate_command' | 'no_changes'; headSha?: string };
  pr?: BotTaskPr;
  /** The ledger row's latest summary, one line (≤ BOT_TASK_SUMMARY_MAX): for
   *  `needs_input`, what the worker is waiting for. Written by the worker or
   *  by main; shown as plain text. */
  summary?: string;
  /** The worker of an ended task (main/factory/workerReclaim.ts): stopped
   *  with a conversation to resume, stopped without one, or resumed. */
  worker?: 'resumable' | 'stopped' | 'resumed';
  /** The workspace the reclaimed worker's pane was last in (a resume may
   *  have opened a new one); it is closed once the task is cleared. */
  workerWorkspaceId?: string;
  /** The ended task's folder was kept because something in it is not
   *  committed (main/factory/taskFolderCleanup.ts); a clean one is removed. */
  folder?: 'kept_dirty';
  updatedAt: number;
}

/** The space bot task folders use now (Settings › Bots;
 *  main/factory/taskFolderCleanup.ts). */
export interface FactoryTaskFolderUsage {
  bytes: number;
  /** Folders on disk. */
  folders: number;
  /** Of those, ended tasks' folders kept for uncommitted changes. */
  dirty: number;
}

/** What Clean up now did to ended bot tasks' folders. */
export type FactoryTaskFolderCleanResult =
  | { ok: true; removed: number; keptDirty: number; busy: number; failed: number; notRemoved?: Array<{ path: string; reason: string }> }
  | { ok: false; code: string; message: string };

/** Longest BotTaskView.summary. */
export const BOT_TASK_SUMMARY_MAX = 300;

/** Whether a gate is a system-recorded run that passed (a recorded skip is not). */
export function isSystemGatePass(gate: LedgerGateResult | undefined): boolean {
  return !!gate && gate.recordedBy === 'system' && gate.exitCode === 0 && gate.skipped === undefined;
}

/** The stage of a task from its ledger row and its pull request. Pure. */
export function botTaskStage(entry: Pick<LedgerEntry, 'status' | 'gate'>, pr: BotTaskPr | null): BotTaskStage {
  switch (entry.status) {
    case 'working':
      return 'working';
    case 'input_required':
      return 'needs_input';
    case 'review_requested':
      return pr?.state === 'merged' ? 'merged' : 'coded';
    case 'completed':
      if (pr?.state === 'merged') return 'merged';
      if (!isSystemGatePass(entry.gate)) return 'closed';
      return pr?.state === 'open' ? 'waiting_to_merge' : 'checked';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'working';
  }
}
