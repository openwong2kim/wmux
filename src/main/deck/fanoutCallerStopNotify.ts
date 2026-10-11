// ─── Worker turn ends → the caller pane, while Moa's runtime is off ─────────
//
// A worker's turn end ("updated" / "stopped on an error") reaches the pane
// that started the fan-out through the deck's EventBus handler
// (routeWorkerEventToOwner → notifyCaller). That handler is subscribed only
// while Moa's runtime runs, so with Moa off a brainless parent was never told
// its worker finished a turn.
//
// This sends the same pointer for exactly that gap. It rides the fan-out
// worker watch's always-on bus subscription (fanoutWorkerWatchHost.ts), stands
// down whenever the deck's own subscription is live (so a Moa-on app never
// sends it twice) and applies the same filters. The renderer's stop cooldown
// (STOP_COOLDOWN_MS) and every check in notifyFanoutCaller still apply.
// Nothing is parked: the park feeds a brain, and there is none.

import type { TaskLedger } from '../../daemon/ledger/TaskLedger';
import { shouldNotifyCaller } from './fanoutCallerNotify';
import { getTaskLedger } from './taskLedgerHost';
import { getFanOutGuards } from '../worktask/fanoutGuards';

function defaultIsFanoutTask(workspaceId: string): boolean {
  return getFanOutGuards().lineageFor([workspaceId])[workspaceId] !== undefined;
}

export interface WorkerLifecycleEvent {
  workspaceId: string;
  kind: string;
  source: string;
  decision?: string;
  seq: number;
}

export interface FanoutCallerStopNotifyPorts {
  /** True while the deck's own EventBus subscription runs (it notifies then). */
  deckRuntimeActive: () => boolean;
  hasBrain: (ownerWorkspaceId: string) => boolean;
  notify: (ownerWorkspaceId: string, taskWorkspaceId: string, taskId: string, kind: string, seq: number) => void;
  /** Bring the ledger up to date with WorkTask for a workspace it has never
   *  heard of (a task that materialized before its register call), as the
   *  deck path does. Absent = no second look. */
  reconcile?: () => Promise<void>;
  /** Whether a workspace carries a fan-out lineage stamp. Only such a
   *  workspace is worth a reconcile (a plain pane's turn end never is). */
  isFanoutTask?: (workspaceId: string) => boolean;
  ledger?: TaskLedger;
}

/** The handler for one agent.lifecycle event. Never throws. */
export function createFanoutCallerStopNotify(ports: FanoutCallerStopNotifyPorts): (ev: WorkerLifecycleEvent) => void {
  const deliver = (ev: WorkerLifecycleEvent, ledger: TaskLedger): void => {
    const entry = ledger.findOpenByTaskWorkspace(ev.workspaceId);
    if (!entry || entry.ownerWorkspaceId === ev.workspaceId) return;
    if (ports.hasBrain(entry.ownerWorkspaceId)) return;
    ports.notify(entry.ownerWorkspaceId, ev.workspaceId, entry.id, ev.kind, ev.seq);
  };
  const warn = (err: unknown): void => console.warn(`[deck] fan-out caller stop notify failed: ${String(err)}`);
  return (ev) => {
    if (ev.kind !== 'agent.stop' && ev.kind !== 'agent.stop_failure') return;
    if (!shouldNotifyCaller(ev)) return;
    try {
      if (ports.deckRuntimeActive()) return;
      const ledger = ports.ledger ?? getTaskLedger();
      const isFanoutTask = ports.isFanoutTask ?? defaultIsFanoutTask;
      if (ledger.findByTaskWorkspace(ev.workspaceId) || !ports.reconcile || !isFanoutTask(ev.workspaceId)) {
        deliver(ev, ledger);
        return;
      }
      // Unknown workspace: only a task that is open after the reconcile, and
      // only if the deck runtime did not start meanwhile.
      void ports
        .reconcile()
        .then(() => {
          if (!ports.deckRuntimeActive()) deliver(ev, ledger);
        })
        .catch(warn);
    } catch (err) {
      warn(err);
    }
  };
}
