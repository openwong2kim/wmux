// ─── Fan-out worker watch: tell the caller when a worker silently stops ─────
//
// The pane that started a fan-out hears about a worker's turn ends and its own
// ledger moves (fanoutCallerNotify.ts), but not about a worker that can no
// longer move at all: its agent process exited, its PTY ended, or it has sat
// idle long after its last turn while the row still says `working`. Nobody is
// working such a task until someone looks.
//
// This watch turns each of those into the one system move that already
// reaches the caller: `working → input_required` by the system actor (the
// same move markLaunchFailed makes). installFanoutCallerLedgerNotify then
// sends the usual "needs input" pointer; nothing here talks to the renderer.
//
// Every wake costs the parent a full agent turn, so it is spent sparingly and
// fail-closed:
//   - only a row that is `working` right now, compare-and-swap on its rev
//     (a row that moved meanwhile is skipped, never retried),
//   - at most ONE exit/PTY-end wake and ONE idle wake per task, ever (this
//     process lifetime); no re-arm,
//   - only the worker's own pane: the first PTY seen ending a turn for that
//     task, or the only terminal of the task workspace,
//   - an agent exit is confirmed after a short grace (a relaunch in the same
//     pane is not an exit); a PTY end waits out a supervised restart,
//   - never while an agent turn runs in the task workspace,
//   - never for an owner with a brain (Moa hears its workers another way).

import type { TaskLedger } from '../../daemon/ledger/TaskLedger';
import { getTaskLedger } from './taskLedgerHost';

/** A row still `working` this long after the worker's last turn end is flagged. */
export const FANOUT_WORKER_IDLE_MINUTES = 15;
const IDLE_MS = FANOUT_WORKER_IDLE_MINUTES * 60_000;
/** How long an agent exit waits before it counts (relaunch guard). */
export const FANOUT_WORKER_EXIT_GRACE_MS = 20_000;
/** How long a PTY end waits for a supervised restart (its backoff caps at 30 s,
 *  plus the time the restart itself takes on a loaded machine). */
export const FANOUT_WORKER_DIED_GRACE_MS = 60_000;

export const WORKER_EXIT_SUMMARY = 'worker agent exited';
export const WORKER_PTY_ENDED_SUMMARY = 'worker PTY ended';
export const WORKER_IDLE_SUMMARY = `worker idle ${FANOUT_WORKER_IDLE_MINUTES}m after its last turn`;

type SessionListener = (payload: { sessionId: string }) => void;
type WatchedEvent = 'session:agentProcessExit' | 'session:died' | 'session:restarted';

/** The slice of DaemonClient the watch subscribes to. */
export interface WorkerWatchDaemon {
  on(event: WatchedEvent, listener: SessionListener): unknown;
  off(event: WatchedEvent, listener: SessionListener): unknown;
}

export interface FanoutWorkerWatchPorts {
  /** The live daemon client, or null (not connected yet / reconnecting). */
  getDaemonClient: () => WorkerWatchDaemon | null;
  /** The workspace that owns a PTY, or null. May throw (caught). */
  resolveWorkspace: (ptyId: string) => Promise<string | null>;
  /** The terminal PTYs a workspace lists right now, or null when unknown. */
  workspacePtyIds: (workspaceId: string) => readonly string[] | null;
  /** True while the pane shows a running turn. */
  isRunning: (ptyId: string) => boolean;
  /** True when an agent is running in the pane again; undefined = can't tell. */
  agentRunning?: (ptyId: string) => Promise<boolean | undefined>;
  hasBrain: (ownerWorkspaceId: string) => boolean;
  ledger?: TaskLedger;
  now?: () => number;
  idleMs?: number;
  exitGraceMs?: number;
  diedGraceMs?: number;
}

export interface FanoutWorkerWatch {
  /** Feed a worker lifecycle event (the EventBus agent.lifecycle stream). */
  noteLifecycle(ev: { workspaceId: string; ptyId: string; kind: string; source?: string; decision?: string }): void;
  /** One idle pass (and daemon client re-attach). The host runs it once a
   *  minute, on the ledger reconcile timer. */
  tick(): Promise<void>;
  dispose(): void;
}

interface Tracked {
  ptyId: string;
  lastStopAt: number;
}

export function installFanoutWorkerWatch(ports: FanoutWorkerWatchPorts): FanoutWorkerWatch {
  const ledger = (): TaskLedger => ports.ledger ?? getTaskLedger();
  const now = ports.now ?? Date.now;
  const idleMs = ports.idleMs ?? IDLE_MS;
  const exitGraceMs = ports.exitGraceMs ?? FANOUT_WORKER_EXIT_GRACE_MS;
  const diedGraceMs = ports.diedGraceMs ?? FANOUT_WORKER_DIED_GRACE_MS;
  /** ptyId → whether a died pane came back (supervised restart) during its grace. */
  const diedRestarted = new Map<string, boolean>();
  /** taskId → the worker pane and its last turn end. */
  const tracked = new Map<string, Tracked>();
  /** ptyId → taskId, for panes seen ending a turn for a task. */
  const workerPty = new Map<string, string>();
  const exitWoken = new Set<string>();
  const idleWoken = new Set<string>();
  const inFlight = new Set<string>();
  const graceTimers = new Set<ReturnType<typeof setTimeout>>();
  let disposed = false;
  let attached: WorkerWatchDaemon | null = null;

  /** Move a still-working row to input_required. True when it moved. */
  const flag = async (taskId: string, expectedRev: number, summary: string): Promise<boolean> => {
    try {
      const entry = ledger().get(taskId);
      if (!entry || entry.status !== 'working' || entry.rev !== expectedRev) return false;
      if (ports.hasBrain(entry.ownerWorkspaceId)) return false;
      const res = await ledger().update({
        id: taskId,
        status: 'input_required',
        actor: { kind: 'system', workspaceId: entry.ownerWorkspaceId },
        expectedRev,
        summary,
      });
      return res.ok && !res.noop;
    } catch {
      return false;
    }
  };

  /** The task whose worker pane `ptyId` is, or null. Fail-closed. */
  const taskOfPty = async (ptyId: string): Promise<{ id: string; rev: number } | null> => {
    const l = ledger();
    const known = workerPty.get(ptyId);
    if (known) {
      const e = l.get(known);
      if (!e || e.status !== 'working') return null;
      // A pane moved to another workspace is no longer this task's worker. A
      // pane the renderer already dropped (it died) resolves to nothing.
      let owner: string | null = null;
      try {
        owner = await ports.resolveWorkspace(ptyId);
      } catch {
        owner = null;
      }
      if (owner && owner !== e.taskWorkspaceId) {
        workerPty.delete(ptyId);
        return null;
      }
      return { id: e.id, rev: e.rev };
    }
    let ws: string | null = null;
    try {
      ws = await ports.resolveWorkspace(ptyId);
    } catch {
      return null;
    }
    if (!ws) return null;
    const e = l.findOpenByTaskWorkspace(ws);
    if (!e || e.status !== 'working') return null;
    // A pane never seen ending a turn counts only as the workspace's sole terminal.
    const ptys = ports.workspacePtyIds(ws);
    if (!ptys || ptys.length !== 1 || ptys[0] !== ptyId) return null;
    return { id: e.id, rev: e.rev };
  };

  const wait = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        graceTimers.delete(t);
        resolve();
      }, ms);
      t.unref?.();
      graceTimers.add(t);
    });

  const onEnded = async (ptyId: string, kind: 'exit' | 'died'): Promise<void> => {
    if (disposed || !ptyId) return;
    // A supervised pane is re-created under the same id after a backoff:
    // listen for that from the moment it died.
    if (kind === 'died') diedRestarted.set(ptyId, false);
    // A running status left over from the killed turn (the exit edge does not
    // always settle it) is not a relaunch; only one that starts in the grace is.
    const runningAtEnd = ports.isRunning(ptyId);
    try {
      const task = await taskOfPty(ptyId);
      if (!task || exitWoken.has(task.id) || inFlight.has(task.id)) return;
      inFlight.add(task.id);
      try {
        if (kind === 'exit') {
          // An agent relaunched in the same pane is not an exit.
          await wait(exitGraceMs);
          if (disposed) return;
          if ((await ports.agentRunning?.(ptyId).catch(() => undefined)) === true) return;
          if (!runningAtEnd && ports.isRunning(ptyId)) return;
        } else {
          await wait(diedGraceMs);
          if (disposed || diedRestarted.get(ptyId) === true) return;
        }
        const moved = await flag(task.id, task.rev, kind === 'exit' ? WORKER_EXIT_SUMMARY : WORKER_PTY_ENDED_SUMMARY);
        if (moved) exitWoken.add(task.id);
      } finally {
        inFlight.delete(task.id);
      }
    } finally {
      if (kind === 'died') diedRestarted.delete(ptyId);
    }
  };

  const onExit: SessionListener = (p) => void onEnded(p?.sessionId, 'exit');
  const onDied: SessionListener = (p) => void onEnded(p?.sessionId, 'died');
  const onRestarted: SessionListener = (p) => {
    if (p?.sessionId && diedRestarted.has(p.sessionId)) diedRestarted.set(p.sessionId, true);
  };

  const detach = (client: WorkerWatchDaemon): void => {
    client.off('session:agentProcessExit', onExit);
    client.off('session:died', onDied);
    client.off('session:restarted', onRestarted);
  };

  /** Follow the current daemon client: it connects after install and is replaced on reconnect. */
  const ensureAttached = (): void => {
    if (disposed) return;
    let client: WorkerWatchDaemon | null = null;
    try {
      client = ports.getDaemonClient();
    } catch {
      client = null;
    }
    if (client && typeof client.on !== 'function') client = null;
    if (client === attached) return;
    if (attached) detach(attached);
    attached = client;
    if (client) {
      client.on('session:agentProcessExit', onExit);
      client.on('session:died', onDied);
      client.on('session:restarted', onRestarted);
    }
  };

  const forgetTask = (taskId: string): void => {
    const t = tracked.get(taskId);
    tracked.delete(taskId);
    if (t && workerPty.get(t.ptyId) === taskId) workerPty.delete(t.ptyId);
  };

  const offTransition = ledger().onTransition((t) => {
    if (t.to === 'completed' || t.to === 'cancelled' || t.to === 'failed') forgetTask(t.entry.id);
    // Final: these rows never reopen, so their once-only marks can go.
    if (t.to === 'completed' || t.to === 'cancelled') {
      exitWoken.delete(t.entry.id);
      idleWoken.delete(t.entry.id);
    }
  });

  const tick = async (): Promise<void> => {
    ensureAttached();
    if (disposed || tracked.size === 0) return;
    const at = now();
    for (const [taskId, t] of [...tracked]) {
      if (idleWoken.has(taskId) || inFlight.has(taskId) || at - t.lastStopAt < idleMs) continue;
      const entry = ledger().get(taskId);
      if (!entry) {
        forgetTask(taskId);
        continue;
      }
      // A row that moved since that turn end (e.g. back to working after a
      // question) starts its idle clock at the move.
      if (entry.status !== 'working' || at - entry.updatedAt < idleMs || ports.isRunning(t.ptyId)) continue;
      // Any agent turn running in the task workspace is work on the task.
      if (ports.workspacePtyIds(entry.taskWorkspaceId)?.some((p) => ports.isRunning(p))) continue;
      inFlight.add(taskId);
      try {
        if (await flag(taskId, entry.rev, WORKER_IDLE_SUMMARY)) idleWoken.add(taskId);
      } finally {
        inFlight.delete(taskId);
      }
    }
  };

  ensureAttached();

  return {
    noteLifecycle(ev) {
      if (disposed) return;
      ensureAttached();
      if (ev.kind !== 'agent.stop' && ev.kind !== 'agent.stop_failure') return;
      // A shell command end or a rejected turn-end candidate is not the agent's turn end.
      if (ev.source === 'osc133' || ev.decision === 'internal') return;
      try {
        const entry = ledger().findOpenByTaskWorkspace(ev.workspaceId);
        if (!entry) return;
        // The first pane to end a turn for the task is its worker; another
        // agent pane in the same workspace never takes that binding over.
        const prev = tracked.get(entry.id);
        if (prev && prev.ptyId !== ev.ptyId) return;
        tracked.set(entry.id, { ptyId: ev.ptyId, lastStopAt: now() });
        workerPty.set(ev.ptyId, entry.id);
      } catch {
        // best effort
      }
    },
    tick,
    dispose() {
      disposed = true;
      for (const t of graceTimers) clearTimeout(t);
      graceTimers.clear();
      offTransition();
      if (attached) detach(attached);
      attached = null;
      tracked.clear();
      workerPty.clear();
    },
  };
}
