// ─── Fan-out worker event → the pane that started the fan-out ───────────────
//
// routeWorkerEventToOwner parks a worker event when the owner workspace has no
// brain (mode 'off', the default), so a pane agent that ran fanout_start was
// never told its workers finished. This is the accelerator beside that park:
// it hands the renderer a pointer — owner workspace, task, kind, seq, and the
// requester's stable pane/surface ids from the lineage stamp — and the
// renderer has one fixed line written into that pane if it can prove the pane
// is still there and idle (src/renderer/hooks/fanoutCallerNudge.ts).
//
// Two sources: a worker's agent turn end (stop / stop_failure, beside the
// park), and a worker moving its own ledger row to review_requested or failed
// — a worker that records `failed` in its last turn closes the row, so the
// Stop that follows is no longer routed or parked at all.
//
// No ack and no retry from here: the park stays the record. A pointer sent
// before the renderer subscribed (startup, reload) is lost by design; the park
// still holds the event. Fail-closed — any doubt about who asked means nothing
// is sent:
//   - the lineage stamp must name the same owner as the ledger,
//   - an owner that is itself a fan-out task (nested) is never addressed,
//   - only a 'pane' origin with at least one id (never gui / orchestrator),
//   - never a PTY id: the renderer re-resolves the ids against the owner's
//     live layout right before it writes,
//   - no window (headless) → nothing.

import type { FanoutOrigin } from '../../shared/fanoutOrigin';
import { isFanoutCallerKind, type FanoutCallerKind } from '../../shared/fanoutCallerNudge';
import type { TaskLedger } from '../../daemon/ledger/TaskLedger';
import { REMOTE_TASK_WORKSPACE_PREFIX, isRemoteTask, type LedgerEntry } from '../../shared/ledger';
import { taskThreadOf, type ThreadId } from '../../shared/room';
import { getFanOutGuards } from '../worktask/fanoutGuards';
import { isTaskGateReport } from '../factory/taskGate';
import { STOPPED_BY_OWNER } from '../factory/factoryStop';
import { WakeQueue, getWakeQueue } from '../factory/wakeQueue';
import { WORKER_ENDED } from '../factory/workerRunEnds';
import { getTaskLedger } from './taskLedgerHost';

export interface FanoutCallerEvent {
  ownerWorkspaceId: string;
  taskWorkspaceId: string;
  taskId: string;
  kind: FanoutCallerKind;
  /** Event seq for agent.* kinds, the ledger rev for ledger.* kinds. */
  seq: number;
  origin: { paneId?: string; surfaceId?: string };
}

export interface FanoutCallerPorts {
  /** The lineage stamp for a workspace, or undefined. Must not throw. */
  lineageOf?: (workspaceId: string) => { owner: string; origin?: FanoutOrigin } | undefined;
  /** Hand the event to the renderer; false when there is none (headless). */
  send: (ev: FanoutCallerEvent) => boolean;
  /** A task another PC runs: its owner and the pane that asked for it (its
   *  ledger row; it has no lineage stamp). Must not throw. */
  remoteOriginOf?: (taskId: string) => { owner: string; paneId: string } | undefined;
}

function defaultRemoteOriginOf(taskId: string): { owner: string; paneId: string } | undefined {
  const row = getTaskLedger().get(taskId);
  const paneId = row?.remote?.from?.paneId;
  return row && paneId ? { owner: row.ownerWorkspaceId, paneId } : undefined;
}

function defaultLineageOf(workspaceId: string): { owner: string; origin?: FanoutOrigin } | undefined {
  return getFanOutGuards().lineageFor([workspaceId])[workspaceId];
}

/**
 * Whether a worker lifecycle event is a real, first-of-kind agent turn end. An
 * osc133 stop is a shell command ending, often under a worker still running;
 * a 'dedup' event is a second report of a turn end already announced. Both
 * are still parked — they only do not nudge.
 */
export function shouldNotifyCaller(ev: { source: string; decision?: string }): boolean {
  return ev.source !== 'osc133' && ev.decision !== 'dedup' && ev.decision !== 'internal';
}

/** Returns true when an event was handed to the renderer. Never throws. */
export function notifyFanoutCaller(
  ownerWorkspaceId: string,
  taskWorkspaceId: string,
  taskId: string,
  kind: string,
  seq: number,
  ports: FanoutCallerPorts,
): boolean {
  try {
    if (!ownerWorkspaceId || !taskWorkspaceId || !taskId || !isFanoutCallerKind(kind)) return false;
    const lineageOf = ports.lineageOf ?? defaultLineageOf;
    // A nested owner (itself a fan-out task) has its own caller chain; its
    // workers are not announced into its panes.
    if (lineageOf(ownerWorkspaceId)) return false;
    // A task another PC runs: addressed to the pane that asked for it, by its row.
    if (taskWorkspaceId.startsWith(REMOTE_TASK_WORKSPACE_PREFIX)) {
      const asked = (ports.remoteOriginOf ?? defaultRemoteOriginOf)(taskId);
      if (!asked || asked.owner !== ownerWorkspaceId) return false;
      return ports.send({ ownerWorkspaceId, taskWorkspaceId, taskId, kind, seq, origin: { paneId: asked.paneId } });
    }
    const stamp = lineageOf(taskWorkspaceId);
    if (!stamp || stamp.owner !== ownerWorkspaceId) return false;
    const origin = stamp.origin;
    if (!origin || origin.kind !== 'pane' || (!origin.paneId && !origin.surfaceId)) return false;
    return ports.send({
      ownerWorkspaceId,
      taskWorkspaceId,
      taskId,
      kind,
      seq,
      origin: {
        ...(origin.paneId ? { paneId: origin.paneId } : {}),
        ...(origin.surfaceId ? { surfaceId: origin.surfaceId } : {}),
      },
    });
  } catch (err) {
    console.warn(`[deck] fan-out caller notify failed: ${String(err)}`);
    return false;
  }
}

/**
 * Tell the caller when a WORKER moves its own row to review_requested or
 * failed, or wmux moves it to input_required, while the owner has no brain.
 * Returns the unsubscribe.
 */
export function installFanoutCallerLedgerNotify(
  hasBrain: (ownerWorkspaceId: string) => boolean,
  notify: (ownerWorkspaceId: string, taskWorkspaceId: string, taskId: string, kind: string, seq: number) => void,
  instance?: TaskLedger,
): () => void {
  return (instance ?? getTaskLedger()).onTransition((t) => {
    // A worker's own failed / review_requested, or wmux itself moving the row
    // to input_required: the worker's agent never started (#1919) or sits on a
    // first-run screen. Either way nobody is working the task until someone
    // looks, and a worker that never started will never send a Stop.
    const byWorker = t.by.kind === 'worker' && (t.to === 'failed' || t.to === 'review_requested');
    const bySystem = t.by.kind === 'system' && t.to === 'input_required';
    // A task another PC runs has no worker here: wmux moves its row as that
    // PC reports. Its failure is told; its report is not (it already reached
    // the caller's pane as the A2A reply), and neither is a request refused
    // while fanout_start ran (still `sent`: that call's reply said so).
    const remoteFailed = t.by.kind === 'system' && t.to === 'failed' && isRemoteTask(t.entry) && t.entry.remote?.state !== 'sent';
    if (!byWorker && !bySystem && !remoteFailed) return;
    try {
      if (hasBrain(t.entry.ownerWorkspaceId)) return;
      notify(t.entry.ownerWorkspaceId, t.entry.taskWorkspaceId, t.entry.id, `ledger.${t.to}`, t.entry.rev);
    } catch {
      // best effort
    }
  });
}

/** What a bot-origin task transition wakes, by the status it moved to. */
const BOT_TASK_WAKE: Readonly<Partial<Record<string, 'task.done' | 'task.failed' | 'task.input_required'>>> = {
  review_requested: 'task.done',
  failed: 'task.failed',
  cancelled: 'task.failed',
  input_required: 'task.input_required',
};

/** Tasks the owner stopped (factory/factoryStop.ts), newest last, bounded. */
const STOPPED_BY_OWNER_MAX = 1000;
const stoppedByOwner = new Set<string>();

/** Mark a task the owner is stopping, before its row moves to `cancelled`:
 *  that move wakes nobody (the owner asked for the stop; a bot woken by it
 *  would only start the work again). */
export function markStoppedByOwner(taskId: string): void {
  stoppedByOwner.delete(taskId);
  stoppedByOwner.add(taskId);
  while (stoppedByOwner.size > STOPPED_BY_OWNER_MAX) {
    const oldest = stoppedByOwner.values().next().value as string | undefined;
    if (oldest === undefined) break;
    stoppedByOwner.delete(oldest);
  }
}

/** Undo markStoppedByOwner for a task whose stop did not move its row. */
export function unmarkStoppedByOwner(taskId: string): void {
  stoppedByOwner.delete(taskId);
}

export interface BotFanoutWakePorts {
  /** The bot runtime's wake queue (wakeQueue.ts WakeSinkApi.enqueue). */
  enqueue: (input: {
    botId: string;
    workspaceId: string;
    reason: { kind: 'facts'; factIds: string[]; trigger: { kind: 'task.done' | 'task.failed' | 'task.input_required' } };
    priority: 1;
    /** The task's room thread (shared/room.ts taskThreadOf): the thread of
     *  the wake that started it, else `task:<taskId>`. */
    threadId: ThreadId;
  }) => unknown;
  /** The task's worker stopped working (for the bot's worker-hours). */
  onWorkerEnded?: (botId: string, taskId: string) => void;
  /** A transition whose wake another path sends (a bot verify task's report:
   *  the verify gate wakes the bot once the gate it runs is recorded). */
  wokenElsewhere?: (t: { entry: LedgerEntry; to: string }) => boolean;
  /** Whether the bot's wake queue already holds a wake for this fact id
   *  (any state but dropped). Default: the factory's wake queue. */
  wakeKnown?: (botId: string, factId: string) => boolean;
  now?: () => number;
}

function queueKnows(botId: string, factId: string): boolean {
  const q = getWakeQueue();
  if (!(q instanceof WakeQueue)) return false;
  return q.list({ botId }).some((i) => i.state !== 'dropped' && i.reason.kind === 'facts' && i.reason.factIds.includes(factId));
}

/** How far back, at install, a bot task's last move is woken again: a wake
 *  lost to an app exit between the move and the wake queue's write. The
 *  queue drops a wake it already holds (same task, status and rev). */
export const BOT_TASK_WAKE_RECOVER_MS = 3_600_000;

/**
 * A task a factory bot started reports to that bot through its wake queue,
 * never into a pane: the ledger row's `dispatch.origin` (written by main when
 * the task was registered) names the bot, and every move of the row to
 * review_requested, failed, cancelled or input_required queues one wake for
 * it. The wake names the task by a `task.<status>:<taskId>@<rev>` id; the bot reads
 * the row itself. It runs in the thread the task was started from (an issue
 * or PR thread stays one conversation), else the task's own thread.
 * Independent of whether the owner workspace has a brain.
 * Returns the unsubscribe.
 */
export function installBotFanoutWake(ports: BotFanoutWakePorts, instance?: TaskLedger): () => void {
  const ledger = instance ?? getTaskLedger();
  const wake = (t: { entry: LedgerEntry; to: string }, botId: string, recovering = false): void => {
    const trigger = BOT_TASK_WAKE[t.to];
    if (!trigger || ports.wokenElsewhere?.(t) === true) return;
    if (isTaskGateReport(t.entry, t.to)) return;
    if (t.to === 'cancelled' && stoppedByOwner.has(t.entry.id)) return;
    // The rev makes each transition its own wake: a task that asks for
    // input twice wakes its bot twice.
    const factId = `task.${t.to}:${t.entry.id}@${t.entry.rev}`;
    // A recovery never offers a wake the queue holds (not even as a
    // duplicate record, which would push older records out).
    if (recovering && (ports.wakeKnown ?? queueKnows)(botId, factId)) return;
    ports.enqueue({
      botId,
      workspaceId: t.entry.ownerWorkspaceId,
      reason: { kind: 'facts', factIds: [factId], trigger: { kind: trigger } },
      priority: 1,
      threadId: taskThreadOf(t.entry),
    });
  };
  // Recent moves whose wake may not have been written before the app exited.
  const since = (ports.now ?? Date.now)() - BOT_TASK_WAKE_RECOVER_MS;
  let rows: LedgerEntry[] = [];
  try {
    rows = ledger.list({});
  } catch {
    rows = [];
  }
  for (const entry of rows) {
    const origin = entry.dispatch?.origin;
    if (!origin || origin.kind !== 'bot' || !origin.botId || entry.updatedAt < since) continue;
    // The owner's stop wakes nobody (its in-memory mark is gone after a restart).
    if (entry.status === 'cancelled' && entry.summary === STOPPED_BY_OWNER && entry.updatedBy.kind === 'system') continue;
    try {
      wake({ entry, to: entry.status }, origin.botId, true);
    } catch (err) {
      console.warn(`[factory] could not wake bot ${origin.botId} for task ${entry.id}: ${String(err)}`);
    }
  }
  return ledger.onTransition((t) => {
    const origin = t.entry.dispatch?.origin;
    if (!origin || origin.kind !== 'bot' || !origin.botId) return;
    // Worker-hours accounting is best effort; its failure must not strand
    // the terminal task transition before the durable owner wake is queued.
    try {
      if (WORKER_ENDED.has(t.to)) ports.onWorkerEnded?.(origin.botId, t.entry.id);
    } catch (err) {
      console.warn(`[factory] could not account for bot ${origin.botId} worker ${t.entry.id}: ${String(err)}`);
    }
    try {
      wake(t, origin.botId);
    } catch (err) {
      console.warn(`[factory] could not wake bot ${origin.botId} for task ${t.entry.id}: ${String(err)}`);
    }
  });
}
