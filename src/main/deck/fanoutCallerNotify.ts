// ─── Fan-out worker event → the pane that started the fan-out ───────────────
//
// routeWorkerEventToOwner parks a worker event when the owner workspace has no
// brain (mode 'off', the default), so a pane agent that ran fanout_start was
// never told its workers finished. This is the accelerator beside that park:
// it hands the renderer a pointer — owner workspace, task, seq, and the
// requester's stable pane/surface ids from the lineage stamp — and the
// renderer types one fixed line into that pane if it can prove the pane is
// still there and idle (src/renderer/hooks/fanoutCallerNudge.ts).
//
// No ack and no retry from here: the park stays the record. Fail-closed — any
// doubt about who asked means nothing is sent:
//   - only a turn end (stop / stop_failure); a worker's awaiting_input is not
//     forwarded,
//   - the lineage stamp must name the same owner as the ledger,
//   - only a 'pane' origin with at least one id (never gui / orchestrator),
//   - never a PTY id: the renderer re-resolves the ids against the owner's
//     live layout right before it writes,
//   - no window (headless) → nothing.

import type { FanoutOrigin } from '../../shared/fanoutOrigin';
import { getFanOutGuards } from '../worktask/fanoutGuards';

export const FANOUT_CALLER_KINDS: ReadonlySet<string> = new Set(['agent.stop', 'agent.stop_failure']);

export interface FanoutCallerEvent {
  ownerWorkspaceId: string;
  taskWorkspaceId: string;
  taskId: string;
  kind: string;
  seq: number;
  origin: { paneId?: string; surfaceId?: string };
}

export interface FanoutCallerPorts {
  /** The lineage stamp for a task workspace, or undefined. Must not throw. */
  lineageOf?: (taskWorkspaceId: string) => { owner: string; origin?: FanoutOrigin } | undefined;
  /** Hand the event to the renderer; false when there is none (headless). */
  send: (ev: FanoutCallerEvent) => boolean;
}

function defaultLineageOf(taskWorkspaceId: string): { owner: string; origin?: FanoutOrigin } | undefined {
  return getFanOutGuards().lineageFor([taskWorkspaceId])[taskWorkspaceId];
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
    if (!ownerWorkspaceId || !taskWorkspaceId || !taskId || !FANOUT_CALLER_KINDS.has(kind)) return false;
    const stamp = (ports.lineageOf ?? defaultLineageOf)(taskWorkspaceId);
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
