// ─── Task ledger — main-process host + worker→owner event routing ───────────
//
// The TaskLedger (src/daemon/ledger) is a plain fs-backed class; every consumer
// that needs it lives in the main process (the event coalescer, the Stop gate,
// the pipe RPC, the fan-out service), so main hosts the single instance here.
// The data dir is the WMUX_DATA_SUFFIX-scoped wmux dir, same as the deck-*
// stores.
//
// Lane F step 1 — why the routing exists: a worker's agent.stop /
// agent.awaiting_input is pushed only to the EMITTING workspace, and a fan-out
// task workspace has no brain of its own (wakePolicy 'none'), so the parent
// brain that fanned out never learned its workers finished. `WorkTask.owner`
// is the missing link: resolve it through the ledger (which mirrors WorkTask —
// see the reconciler) and push a tagged COPY to the owner's coalescer. An
// owner with no brain gets the event parked as `orphaned_event` and replayed
// when a brain boots for it.

import { getWmuxDir } from '../../daemon/config';
import { TaskLedger } from '../../daemon/ledger/TaskLedger';
import type { CoalescerInput } from './CommanderEventCoalescer';

let ledger: TaskLedger | null = null;

export function getTaskLedger(): TaskLedger {
  if (!ledger) {
    ledger = new TaskLedger({ dir: getWmuxDir(), log: (line) => console.warn(line) });
  }
  return ledger;
}

/** Tests only: swap the hosted instance (null = re-create lazily). */
export function setTaskLedgerForTests(instance: TaskLedger | null): void {
  ledger = instance;
}

// ── worker event → owner ────────────────────────────────────────────────────

export interface WorkerEventRoutingPorts {
  /** True when the owner workspace has (or will boot) a brain: a live manager
   *  or a resting mode other than 'off'. False parks the event instead. */
  hasBrain: (ownerWorkspaceId: string) => boolean;
  push: (ev: CoalescerInput) => void;
  /** Bring the ledger up to date with WorkTask when the emitting workspace is
   *  unknown (a task materialized without a register call). Throttled by the
   *  caller; absent = no second look. */
  reconcile?: () => Promise<void>;
  ledger?: TaskLedger;
}

/**
 * If `ev.workspaceId` is a fan-out task workspace, deliver a copy of the event
 * to the owning workspace tagged `{taskId, taskWorkspaceId}`. Non-task
 * workspaces are left alone; the caller keeps its existing push regardless.
 */
export function routeWorkerEventToOwner(ev: CoalescerInput, ports: WorkerEventRoutingPorts): void {
  const l = ports.ledger ?? getTaskLedger();
  const deliver = (entry: { id: string; ownerWorkspaceId: string }): void => {
    if (entry.ownerWorkspaceId === ev.workspaceId) return;
    const tagged: CoalescerInput = {
      ...ev,
      workspaceId: entry.ownerWorkspaceId,
      task: { taskId: entry.id, taskWorkspaceId: ev.workspaceId },
    };
    if (ports.hasBrain(entry.ownerWorkspaceId)) {
      ports.push(tagged);
      return;
    }
    void l.recordOrphanedEvent({ ownerWorkspaceId: entry.ownerWorkspaceId, seq: ev.seq, payload: tagged });
  };
  const entry = l.findByTaskWorkspace(ev.workspaceId);
  if (entry) {
    deliver(entry);
    return;
  }
  if (!ports.reconcile) return;
  void ports
    .reconcile()
    .then(() => {
      const late = l.findByTaskWorkspace(ev.workspaceId);
      if (late) deliver(late);
    })
    .catch(() => undefined);
}

function isCoalescerInput(v: unknown): v is CoalescerInput {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return typeof e.workspaceId === 'string' && typeof e.ptyId === 'string' && typeof e.kind === 'string' && typeof e.seq === 'number';
}

/** Drain the parked worker events for a workspace whose brain just booted. */
export function takeOrphanBacklog(workspaceId: string, instance?: TaskLedger): CoalescerInput[] {
  const l = instance ?? getTaskLedger();
  const out: CoalescerInput[] = [];
  for (const o of l.takeOrphanedEvents(workspaceId)) {
    if (isCoalescerInput(o.payload)) out.push(o.payload);
  }
  return out;
}

// ── reconcile with WorkTask (the identity source) ───────────────────────────

/** The slice of the daemon's `task.mission.list` projection the ledger needs. */
export interface WorkTaskProjectionLike {
  id: string;
  title: string;
  status: 'open' | 'closed';
  owner: { verifiedWorkspaceId: string };
  paneGroupId?: string;
  missionChannelId?: string;
}

export interface WorkTaskReconcilerPorts {
  /** Workspaces that may own tasks (every workspace the mirror knows). */
  candidateOwners: () => string[];
  /** `task.mission.list` for one owner — the daemon's owner-scoped read. */
  listTasks: (ownerWorkspaceId: string) => Promise<unknown>;
  ledger?: TaskLedger;
  /** Minimum spacing between two full passes (default 10s). */
  minIntervalMs?: number;
  now?: () => number;
}

/** taskId → mission channel id, learned from the projection (step 5 posts
 *  transitions there). */
const missionChannels = new Map<string, string>();

export function getMissionChannelId(taskId: string): string | null {
  return missionChannels.get(taskId) ?? null;
}

export function rememberMissionChannel(taskId: string, channelId: string): void {
  missionChannels.set(taskId, channelId);
}

function projectTasks(res: unknown): WorkTaskProjectionLike[] {
  const r = res as { ok?: boolean; tasks?: unknown } | null;
  if (!r || r.ok !== true || !Array.isArray(r.tasks)) return [];
  return r.tasks.filter((t): t is WorkTaskProjectionLike => {
    if (!t || typeof t !== 'object') return false;
    const x = t as Record<string, unknown>;
    return (
      typeof x.id === 'string' &&
      (x.status === 'open' || x.status === 'closed') &&
      !!x.owner &&
      typeof (x.owner as Record<string, unknown>).verifiedWorkspaceId === 'string'
    );
  });
}

/**
 * Build a throttled "mirror WorkTask into the ledger" pass: every open,
 * materialized task (paneGroupId = its workspace) gets a `working` entry if it
 * has none; every closed task with a live entry is force-cancelled. The ledger
 * never invents a task — every entry here is a WorkTask the daemon returned.
 */
export function createWorkTaskReconciler(ports: WorkTaskReconcilerPorts): () => Promise<void> {
  const now = ports.now ?? Date.now;
  const minInterval = ports.minIntervalMs ?? 10_000;
  let lastRun = -Infinity;
  let inFlight: Promise<void> | null = null;
  return () => {
    if (inFlight) return inFlight;
    if (now() - lastRun < minInterval) return Promise.resolve();
    const l = ports.ledger ?? getTaskLedger();
    inFlight = (async () => {
      lastRun = now();
      const owners = [...new Set(ports.candidateOwners())];
      for (const owner of owners) {
        let tasks: WorkTaskProjectionLike[];
        try {
          tasks = projectTasks(await ports.listTasks(owner));
        } catch {
          continue;
        }
        for (const t of tasks) {
          if (typeof t.missionChannelId === 'string') missionChannels.set(t.id, t.missionChannelId);
          if (t.status === 'closed') {
            if (l.get(t.id)) await l.closeTask(t.id);
            continue;
          }
          if (!t.paneGroupId || l.get(t.id)) continue;
          await l.register({
            id: t.id,
            taskWorkspaceId: t.paneGroupId,
            ownerWorkspaceId: t.owner.verifiedWorkspaceId,
            title: typeof t.title === 'string' ? t.title : t.id,
          });
        }
      }
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
