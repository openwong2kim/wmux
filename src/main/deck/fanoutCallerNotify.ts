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
import { getFanOutGuards } from '../worktask/fanoutGuards';
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
    if (!byWorker && !bySystem) return;
    try {
      if (hasBrain(t.entry.ownerWorkspaceId)) return;
      notify(t.entry.ownerWorkspaceId, t.entry.taskWorkspaceId, t.entry.id, `ledger.${t.to}`, t.entry.rev);
    } catch {
      // best effort
    }
  });
}
