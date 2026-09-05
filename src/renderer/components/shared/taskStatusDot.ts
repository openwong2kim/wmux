// ─── One status vocabulary for a delegated task ─────────────────────────────
//
// A task showed up in two places with two different colour grammars: the
// sidebar painted every OPEN task green ("open ⇒ green"), while the deck's
// ledger panel painted the same task from its worker's agent status (gray for
// an idle worker). The same task therefore read as "done" on one edge and
// "idle" on the other, which is exactly the ambiguity DESIGN.md's dot
// vocabulary exists to prevent.
//
// This is the ONE mapping, pure and exported, so every surface that draws a
// task dot draws it from the same fact. DESIGN.md ("Component Rules"):
//
//   amber = running · green = ok/complete · gray = idle · red = needs input
//
// Four colours, no fifth. `review_requested` is deliberately amber, not a new
// steel-blue: the task is not finished, it is waiting on the BRAIN to look at
// it — that is "alive + attention", which is what warm amber means here. A
// failed or cancelled task is muted gray, not red: red is reserved for "a human
// or the brain has to answer something right now", and a task that already
// stopped is not asking anybody anything.

import type { LedgerStatus } from '../../../shared/ledger';
import type { AgentStatus } from '../../../shared/types';
import type { WorkTask } from '../../../shared/workTask';

/** The four meanings a task dot may carry. Nothing else gets a colour. */
export type TaskDotTone = 'running' | 'ok' | 'idle' | 'attention';

export interface TaskStatusDot {
  tone: TaskDotTone;
  /** Theme token for the dot fill (a CSS var, never a literal colour). */
  color: string;
  /** i18n key for the dot's title/label. */
  labelKey: string;
}

/** Tone → theme token. The single place a task dot's colour is decided. */
export const TASK_DOT_COLOR: Record<TaskDotTone, string> = {
  running: 'var(--accent-cursor)',
  ok: 'var(--accent-green)',
  idle: 'var(--text-muted)',
  attention: 'var(--accent-red)',
};

const TASK_DOT_LABEL: Record<TaskDotTone, string> = {
  running: 'taskStatus.running',
  ok: 'taskStatus.done',
  idle: 'taskStatus.idle',
  attention: 'taskStatus.needsYou',
};

function dot(tone: TaskDotTone, labelKey?: string): TaskStatusDot {
  return { tone, color: TASK_DOT_COLOR[tone], labelKey: labelKey ?? TASK_DOT_LABEL[tone] };
}

/**
 * Worker states that mean "somebody has to answer". `waiting` counts with
 * `awaiting_input` for the same reason the titlebar's "N need you" chip counts
 * it (stores/selectors/fleet.ts countNeedsAttention): the turn ended and the
 * agent is idle ON YOU. `error` counts too — a worker that died mid-task is the
 * loudest thing the panel can be asked to show.
 */
function workerNeedsSomebody(workerStatus: AgentStatus | null): boolean {
  return (
    workerStatus === 'awaiting_input' || workerStatus === 'waiting' || workerStatus === 'error'
  );
}

/**
 * The one dot for a task. `workerStatus` is the agent status rolled up from the
 * task's own workspace (null when nothing is known about it — a fan-out still
 * materializing, or a surface with no mirror).
 *
 * The ledger status wins for every TERMINAL state: once the brain has recorded
 * completed / failed / cancelled, what a leftover pane is doing is not the
 * task's status any more. Inside `working`, the worker decides — that is the
 * whole reason the worker status is passed at all.
 */
export function taskStatusDot(
  status: LedgerStatus,
  workerStatus: AgentStatus | null = null,
): TaskStatusDot {
  switch (status) {
    case 'completed':
      return dot('ok');
    case 'failed':
      return dot('idle', 'taskStatus.failed');
    case 'cancelled':
      return dot('idle', 'taskStatus.cancelled');
    case 'input_required':
      return dot('attention');
    case 'review_requested':
      return dot('running', 'taskStatus.review');
    case 'working':
    default:
      if (workerNeedsSomebody(workerStatus)) return dot('attention');
      if (workerStatus === 'running') return dot('running');
      return dot('idle');
  }
}

/**
 * The sidebar's WorkTask carries a two-value lifecycle (`open` / `closed`) that
 * predates the ledger. Mapping it here — instead of giving the sidebar its own
 * colour rule — is what keeps "one place per fact" true across the two stores.
 */
export function missionLedgerStatus(status: WorkTask['status']): LedgerStatus {
  return status === 'closed' ? 'completed' : 'working';
}
