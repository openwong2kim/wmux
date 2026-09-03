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
// owner with no brain gets the event parked as `orphaned_event`, replayed when
// a brain boots for it and acknowledged only once a wake delivered it.

import { getWmuxDir } from '../../daemon/config';
import { TaskLedger, type LedgerTransition } from '../../daemon/ledger/TaskLedger';
import type { CoalescerInput } from './CommanderEventCoalescer';
import { loadLedgerGateEnabled } from './deckLedgerGateStore';
import type { StopGateLedgerInput } from './stopGate';

let ledger: TaskLedger | null = null;

/** taskId → mission channel id, learned from the projection / fan-out (step
 *  5 posts transitions there). Released when the entry leaves the ledger. */
const missionChannels = new Map<string, string>();

export function getTaskLedger(): TaskLedger {
  if (!ledger) {
    ledger = new TaskLedger({
      dir: getWmuxDir(),
      log: (line) => console.warn(line),
      onPrune: (id) => missionChannels.delete(id),
    });
  }
  return ledger;
}

/** Tests only: swap the hosted instance (null = re-create lazily). */
export function setTaskLedgerForTests(instance: TaskLedger | null): void {
  ledger = instance;
  missionChannels.clear();
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
 * If `ev.workspaceId` is the workspace of an OPEN fan-out task, deliver a copy
 * of the event to the owning workspace tagged `{taskId, taskWorkspaceId}`. A
 * finished task's workspace and non-task workspaces are left alone; the
 * caller keeps its existing push regardless.
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
    l.recordOrphanedEvent({ ownerWorkspaceId: entry.ownerWorkspaceId, seq: ev.seq, payload: tagged }).catch(
      (err) => console.warn(`[deck] could not park a worker event for ${entry.ownerWorkspaceId}: ${String(err)}`),
    );
  };
  const entry = l.findOpenByTaskWorkspace(ev.workspaceId);
  if (entry) {
    deliver(entry);
    return;
  }
  // Unknown workspace: it may be a task that materialized before the ledger
  // heard of it. Only a task that is still open after the reconcile routes.
  if (!ports.reconcile || l.findByTaskWorkspace(ev.workspaceId)) return;
  void ports
    .reconcile()
    .then(() => {
      const late = l.findOpenByTaskWorkspace(ev.workspaceId);
      if (late) deliver(late);
    })
    .catch(() => undefined);
}

function isCoalescerInput(v: unknown): v is CoalescerInput {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return typeof e.workspaceId === 'string' && typeof e.ptyId === 'string' && typeof e.kind === 'string' && typeof e.seq === 'number';
}

/** The parked worker events for a workspace whose brain is booting — a PEEK:
 *  nothing leaves the backlog until `ackOrphanBacklog` confirms a wake
 *  delivered it. */
export function peekOrphanBacklog(workspaceId: string, instance?: TaskLedger): CoalescerInput[] {
  const l = instance ?? getTaskLedger();
  const out: CoalescerInput[] = [];
  for (const o of l.peekOrphanedEvents(workspaceId)) {
    if (isCoalescerInput(o.payload)) out.push(o.payload);
  }
  return out;
}

/** Acknowledge parked events at or below `upToSeq` — they reached the brain. */
export function ackOrphanBacklog(workspaceId: string, upToSeq: number, instance?: TaskLedger): Promise<void> {
  const l = instance ?? getTaskLedger();
  return l.ackOrphanedEvents(workspaceId, upToSeq);
}

// ── Stop gate + decision prompt inputs (lane F step 4) ──────────────────────

/** The ledger's view for one Stop of `workspaceId`'s brain. `openTasks` is
 *  null when the ledger threw — the gate then falls back to the snapshot
 *  inference. Never throws. */
export function readLedgerGateInput(workspaceId: string, instance?: TaskLedger): StopGateLedgerInput {
  let enabled = false;
  try {
    enabled = loadLedgerGateEnabled();
  } catch {
    enabled = false;
  }
  if (!enabled) return { enabled: false, openTasks: null };
  try {
    const l = instance ?? getTaskLedger();
    return {
      enabled: true,
      openTasks: l
        .list({ ownerWorkspaceId: workspaceId, openOnly: true })
        .map((e) => ({ id: e.id, title: e.title, status: e.status })),
    };
  } catch {
    return { enabled: true, openTasks: null };
  }
}

// ── mission-channel emitter (lane F step 5) ─────────────────────────────────

/** `[ledger] <taskId> <from>→<to> <by> worker: "<summary>"` — one line per
 *  transition. The summary is text the ACTOR wrote (a worker, usually) and
 *  the post goes out under the owner's authorship, so it is quoted and
 *  labelled with its author kind: provenance stays visible in the transcript. */
export function formatLedgerTransition(t: LedgerTransition): string {
  const by = `${t.by.kind}@${t.by.workspaceId}`;
  const summary = t.summary
    ? ` ${t.by.kind}: "${t.summary.replace(/\s+/g, ' ').replace(/"/g, '”').trim().slice(0, 500)}"`
    : '';
  return `[ledger] ${t.entry.id} ${t.from ?? 'new'}→${t.to} ${by}${summary}`;
}

export interface LedgerChannelPort {
  /** Post `text` to `channelId` as the owner workspace (the mission channel's
   *  creator). Resolves to the daemon's envelope; rejections are swallowed. */
  post: (input: { channelId: string; ownerWorkspaceId: string; text: string; clientMsgId: string }) => Promise<unknown>;
}

/** Subscribe the hosted ledger to a mission-channel poster. Every transition
 *  whose task has a known mission channel is posted there; a task with no
 *  channel yet (not reconciled) is skipped. Returns the unsubscribe. */
export function installLedgerChannelEmitter(port: LedgerChannelPort, instance?: TaskLedger): () => void {
  const l = instance ?? getTaskLedger();
  return l.onTransition((t) => {
    const channelId = getMissionChannelId(t.entry.id);
    if (!channelId) return;
    void port
      .post({
        channelId,
        ownerWorkspaceId: t.entry.ownerWorkspaceId,
        text: formatLedgerTransition(t),
        clientMsgId: `ledger:${t.entry.id}:${t.entry.rev}`,
      })
      .catch(() => undefined);
  });
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

export function getMissionChannelId(taskId: string): string | null {
  return missionChannels.get(taskId) ?? null;
}

export function rememberMissionChannel(taskId: string, channelId: string): void {
  missionChannels.set(taskId, channelId);
}

/** A WorkTask was closed (task.mission.close succeeded, or the task was
 *  detached): force its ledger entry to `cancelled` NOW rather than on the
 *  next reconcile pass, and release its channel mapping. Never throws. */
export async function noteWorkTaskClosed(taskId: string, instance?: TaskLedger): Promise<void> {
  const l = instance ?? getTaskLedger();
  try {
    if (l.get(taskId)) await l.closeTask(taskId);
  } catch (err) {
    console.warn(`[deck] ledger close for ${taskId} failed: ${String(err)}`);
  }
  missionChannels.delete(taskId);
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
 * Runs from the periodic timer, before a Stop-gate evaluation and on an
 * unknown-workspace event; the throttle makes all three cheap.
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
          if (t.status === 'closed') {
            if (l.get(t.id)) await l.closeTask(t.id);
            missionChannels.delete(t.id);
            continue;
          }
          if (typeof t.missionChannelId === 'string') missionChannels.set(t.id, t.missionChannelId);
          if (!t.paneGroupId || l.get(t.id)) continue;
          try {
            await l.register({
              id: t.id,
              taskWorkspaceId: t.paneGroupId,
              ownerWorkspaceId: t.owner.verifiedWorkspaceId,
              title: typeof t.title === 'string' ? t.title : t.id,
            });
          } catch (err) {
            console.warn(`[deck] ledger register for ${t.id} failed: ${String(err)}`);
          }
        }
      }
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
