// ─── Dead shells in a bot task's own workspace ─────────────────────────────
//
// When the daemon restarts (a cold start, e.g. after a reboot) it respawns
// every recovered pane as a fresh shell: a bot task's worker pane comes back
// with no agent in it (listSessions `recoveredAgentUnconfirmed`). And a task
// that ended keeps a plain shell in its workspace wherever the clear does not
// close it (a failed task the owner never opened, a task the owner stopped).
// Those shells hold nothing; this sweep is their housekeeping. Only a bot
// task's own workspace (its ledger row names it, workerReclaim.ts
// isTaskWorkspaceOf) is ever looked at, never an owner fan-out, a phone or a
// hand-made workspace. Nothing is posted in a room; one log line per pane.
//
//   - Task ended (completed, cancelled, failed, stopped by the owner): each
//     of the task's own panes (its reclaim record, or its bot worker session
//     record, names it; never any other pane, however idle) that runs no
//     agent and no command (a shell at its prompt, or one respawned at the
//     restart with nothing seen in it since) is closed through the renderer,
//     and the whole workspace when every pane in it is such a pane of the
//     task's (or its session is gone: the owner's stop destroys them and
//     leaves frozen tabs); any other pane keeps the workspace. An end the
//     reclaim records is handled only once it recorded it. A close counts
//     (and is logged) only once it shows: its sessions gone from the daemon
//     and its panes from the tree. Folders are left to taskFolderCleanup.ts.
//   - Task open (review_requested, working) whose worker pane is a shell
//     respawned at the restart, or whose agent was seen to exit: the worker's
//     resume record is written (workerReclaim.ts, the same record the idle
//     reclaim writes: the conversation, its permission mode, the pane), so it
//     holds no agent slot and Resume relaunches the same conversation. The
//     pane stays: a renderer cannot remove a workspace's last pane, a
//     destroyed session leaves a frozen tab, and a Resume into a new
//     workspace would leave the old one bound to the task's mission (closing
//     it later cancels the task).
//
// Never a pane that runs a command or a live agent, one typed into since its
// agent left (or since the restart), or one in the workspace the owner views
// (or the Bots worker panel shows); nothing while what the owner views is not
// known, and nothing while a resume or a clear of the task is under way.
// Idempotent: a closed pane leaves the daemon's list, a written record covers
// the row's rev.

import type { LedgerEntry } from '../../shared/ledger';
import { taskThreadOf } from '../../shared/room';
import { STOPPED_BY_OWNER } from './factoryStop';
import {
  CLEAR_FOREIGN_RETRY_MS,
  CLEAR_RETRY_MS,
  RECLAIM_CATCHUP_MS,
  fillLaunchedModes,
  holdWorkerPanes,
  isReclaimableEnd,
  isReclaimedSince,
  isTaskOwnWorkerPane,
  reclaimedSessionOf,
  workerWorkspaceOf,
  type ReclaimedSession,
  type ReclaimedWorker,
  type ReclaimedWorkers,
  type WorkerReclaimPorts,
  type WorkerSessionInfo,
  type WorkerSessionRecordOf,
} from './workerReclaim';

/** The daemon's session fields this sweep reads (daemon.listSessions). */
export interface DeadPaneSession extends WorkerSessionInfo {
  state?: unknown;
}

/** One pane's key input as the daemon reports it (DaemonClient.getAgentState):
 *  focus, pointer motion and terminal replies are not counted. */
export interface PaneKeyInput {
  /** Key writes since the pane's shell started (0: none). */
  keyInputRevision?: number;
  /** Milliseconds since the last of them. */
  keyInputIdleMs?: number;
}

/** Whether a task was stopped by the owner (factoryStop.ts). Pure. */
export function isStoppedByOwner(row: Pick<LedgerEntry, 'status' | 'summary' | 'updatedBy'>): boolean {
  return row.status === 'cancelled' && row.summary === STOPPED_BY_OWNER && row.updatedBy.kind === 'system';
}

/** A shell the daemon respawned at its restart, with no agent and no command
 *  seen in it since. Pure. */
export function isRespawnedShell(s: DeadPaneSession | undefined): boolean {
  return !!s && !s.exec && s.recoveredAgentUnconfirmed === true && s.agentProcessAlive !== true && s.commandRunning !== true;
}

/** A shell at its prompt (OSC 133) with no agent running. Pure. */
export function isIdleShell(s: DeadPaneSession | undefined): boolean {
  return !!s && !s.exec && s.agentProcessAlive !== true && s.commandRunning === false;
}

/** A shell whose agent was seen to exit, at its prompt. Pure. */
function isAgentExitedShell(s: DeadPaneSession | undefined): boolean {
  return !!s && !s.exec && s.agentProcessAlive === false && s.commandRunning === false;
}

/** Whether someone typed into a pane since `floor` (the agent left): a
 *  respawned shell counts any key since the restart. A read without an
 *  answer counts as typed. Pure. */
export function typedSince(input: PaneKeyInput | null, floor: number, readAt: number, respawned: boolean): boolean {
  if (!input || input.keyInputRevision === undefined) return true;
  if (input.keyInputRevision === 0) return false;
  if (respawned || input.keyInputIdleMs === undefined) return true;
  return readAt - input.keyInputIdleMs >= floor;
}

export interface DeadPaneSweepPorts {
  /** Every ledger row. */
  rows: () => LedgerEntry[];
  store: ReclaimedWorkers;
  /** Whether the daemon can be asked now. */
  ready: () => boolean;
  listSessions: () => Promise<DeadPaneSession[]>;
  /** A pane's key input, null when it could not be read. */
  keyInput: (ptyId: string) => Promise<PaneKeyInput | null>;
  /** Every pty a workspace owns (stashed panes included); [] when it is not
   *  open; null while the tree is not known. */
  workspacePtys: (workspaceId: string) => readonly string[] | null;
  /** Whether `workspaceId` is the task's own workspace (isTaskWorkspaceOf). */
  isTaskWorkspace: (rec: Pick<ReclaimedWorker, 'taskId' | 'botId' | 'ownerWorkspaceId' | 'paneWorkspaceId'>, workspaceId: string) => boolean;
  /** The workspace the owner views, null when unknown (nothing closes). */
  viewedWorkspace: () => string | null;
  /** Whether the owner views the workspace (the active one, or the Bots
   *  worker panel's). */
  viewed: (workspaceId: string) => boolean;
  /** A pane's bot worker session record (the task whose own launch created
   *  it), null when none. */
  sessionRecordOf: WorkerSessionRecordOf;
  launchedConversation?: WorkerReclaimPorts['launchedConversation'];
  /** Close a workspace through the renderer's workspace.close; true when it closed. */
  closeWorkspace: (workspaceId: string) => Promise<boolean>;
  /** The workspace's layout panes (stashed ones included) as the renderer
   *  holds them: each one's tab count and its tabs' local terminal sessions
   *  (a remote terminal, a browser or an editor tab has none); null when it
   *  could not be read. */
  paneSurfaces: (workspaceId: string) => Promise<ReadonlyArray<{ id: string; surfaceCount: number; surfacePtyIds: readonly string[] }> | null>;
  /** Close a layout pane (all its tabs) through the renderer's pane.close;
   *  true when it closed. */
  closePane: (paneId: string) => Promise<boolean>;
  /** Whether a session is a pane of any open workspace (the tree). */
  inAnyWorkspace: (ptyId: string) => boolean;
  /** daemon.destroySession: a task's own dead session a close left behind
   *  with no pane any more. */
  destroySession: (ptyId: string) => Promise<void>;
  /** How long a close is waited for to show (its sessions gone from the
   *  daemon, its panes from the tree) before it counts as not done. */
  confirmMs?: number;
  sleep?: (ms: number) => Promise<void>;
  changed?: () => void;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface DeadPaneSweep {
  /** One look at every bot task. Never throws; how many panes it closed
   *  and how many resume records it wrote. A call during a pass does nothing. */
  pass(): Promise<{ closed: number; recorded: number }>;
}

/** How long a close is waited for to show, and how often it is read. */
const CLOSE_CONFIRM_MS = 10_000;
const CLOSE_CONFIRM_STEP_MS = 1_000;

const ENDED: ReadonlySet<string> = new Set(['completed', 'cancelled', 'failed']);
const OPEN: ReadonlySet<string> = new Set(['review_requested', 'working']);

export function createDeadPaneSweep(ports: DeadPaneSweepPorts): DeadPaneSweep {
  const now = ports.now ?? Date.now;
  const log = ports.log ?? ((m: string) => console.log(m));
  /** workspace → not before (a refused close). */
  const notBefore = new Map<string, number>();
  /** A task's own session a close was answered for but left in the daemon
   *  → its task and when to look again. */
  const leftBehind = new Map<string, { taskId: string; at: number }>();
  let running = false;

  const safe = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };

  /** The panes among `ids` nobody typed into since `floor`. */
  const untyped = async (ids: readonly string[], byId: Map<string, DeadPaneSession>, floor: number): Promise<string[]> => {
    const reads = await Promise.all(ids.map((id) => ports.keyInput(id).catch(() => null)));
    const at = now();
    return ids.filter((id, i) => !typedSince(reads[i], floor, at, isRespawnedShell(byId.get(id))));
  };

  const sleep = ports.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const confirmMs = ports.confirmMs ?? CLOSE_CONFIRM_MS;

  /** Whether a pane is the task's own: its bot worker session record names
   *  the task (written for the task's own fan-out or resume spawn only). The
   *  reclaim record alone is not enough here: one an older version wrote may
   *  hold a shell the owner started in the task folder. Nothing else,
   *  however idle: an owner's pane in the workspace is never one. */
  const ownPane = (taskId: string, id: string): boolean => isTaskOwnWorkerPane({ id }, taskId, [], ports.sessionRecordOf);

  /** Whether a close took effect: `ids` gone from the daemon and from the
   *  workspace's panes (the whole workspace, when `wholeWorkspace`), read
   *  again until `confirmMs`. A close the renderer answered but did not do
   *  is no close. */
  const closeShows = async (ws: string, ids: readonly string[], wholeWorkspace: boolean): Promise<boolean> => {
    const deadline = now() + confirmMs;
    for (;;) {
      const panes = safe(() => ports.workspacePtys(ws), null);
      const treeOk = !!panes && (wholeWorkspace ? panes.length === 0 : ids.every((id) => !panes.includes(id)));
      if (treeOk) {
        const live = await ports.listSessions().catch(() => null);
        if (live && ids.every((id) => !live.some((x) => x.id === id))) return true;
      }
      if (now() >= deadline) return false;
      await sleep(CLOSE_CONFIRM_STEP_MS);
    }
  };

  /** A close answered but not done: the task's own sessions it was for are
   *  looked at again from their ids (the tree may have dropped them). */
  const leaveBehind = (taskId: string, ids: readonly string[]): void => {
    for (const id of ids) if (ownPane(taskId, id)) leftBehind.set(id, { taskId, at: now() + CLEAR_FOREIGN_RETRY_MS });
  };

  /** The sessions a close left behind, once due: one still in a pane of an
   *  open workspace is the tree's again (the next close looks at it); one in
   *  no pane any more, still the task's own and running no agent and no
   *  command, is destroyed in the daemon directly, then read again. */
  const sweepLeftBehind = async (sessions: DeadPaneSession[]): Promise<number> => {
    let destroyed = 0;
    const at = now();
    for (const [id, p] of [...leftBehind]) {
      if (p.at > at) continue;
      const s = sessions.find((x) => x.id === id);
      if (!s || safe(() => ports.inAnyWorkspace(id), true) || !ownPane(p.taskId, id)) {
        leftBehind.delete(id);
        continue;
      }
      if (s.state !== 'dead' && (s.agentProcessAlive === true || s.commandRunning === true)) {
        leftBehind.delete(id);
        continue;
      }
      try {
        await ports.destroySession(id);
      } catch {
        /* read again below */
      }
      const live = await ports.listSessions().catch(() => null);
      if (live && !live.some((x) => x.id === id)) {
        leftBehind.delete(id);
        destroyed++;
        log(`[factory] dead panes: destroyed ${id} (task ${p.taskId}), left behind by a close with no pane any more`);
      } else {
        leftBehind.set(id, { taskId: p.taskId, at: now() + CLEAR_FOREIGN_RETRY_MS });
        log(`[factory] dead panes: ${id} (task ${p.taskId}) was not destroyed; looked at again later`);
      }
    }
    return destroyed;
  };

  /** The task's row and record now: unchanged since the pass read them
   *  (same rev and status, a record in the same state), or null. */
  const unchanged = (row: LedgerEntry, rec: ReclaimedWorker | null): boolean => {
    const cur = safe(() => ports.rows().find((r) => r.id === row.id) ?? null, null);
    if (!cur || cur.rev !== row.rev || cur.status !== row.status) return false;
    const recNow = ports.store.get(row.id);
    return (recNow?.state ?? null) === (rec?.state ?? null) && (recNow?.at ?? null) === (rec?.at ?? null);
  };

  const closeEnded = async (row: LedgerEntry, rec: ReclaimedWorker | null, ws: string, ptys: readonly string[], byId: Map<string, DeadPaneSession>): Promise<number> => {
    const shellIn = (m: Map<string, DeadPaneSession>, id: string): boolean => {
      const s = m.get(id);
      return !!s && s.state !== 'dead' && (isRespawnedShell(s) || isIdleShell(s));
    };
    const own = (id: string): boolean => ownPane(row.id, id);
    const shells = ptys.filter((id) => own(id) && shellIn(byId, id));
    // Every pane the task's own and its session gone from the daemon (the
    // owner's stop destroys them, which leaves frozen tabs).
    const allGone = ptys.every((id) => own(id) && (!byId.get(id) || byId.get(id)?.state === 'dead'));
    if (shells.length === 0 && !allGone) return 0;
    // Typed into since the task ended (or since its worker last stopped):
    // the owner's now.
    const floor = Math.max(row.updatedAt, rec?.at ?? 0);
    const quiet = shells.length > 0 ? await untyped(shells, byId, floor) : [];
    if (quiet.length === 0 && !allGone) return 0;
    const release = holdWorkerPanes(row.id);
    if (!release) return 0;
    try {
      // Everything again right before the close, after the reads above: the
      // task (reopened, resumed), what the owner views, the workspace's panes
      // and what runs in them.
      if (!unchanged(row, rec)) return 0;
      if (safe(() => ports.viewedWorkspace(), null) === null || safe(() => ports.viewed(ws), true)) return 0;
      const nowPtys = safe(() => ports.workspacePtys(ws), null);
      if (!nowPtys || nowPtys.length === 0) return 0;
      const fresh = new Map((await ports.listSessions()).map((x) => [x.id, x]));
      const closable = quiet.filter((id) => nowPtys.includes(id) && shellIn(fresh, id));
      // A pane gone from the daemon counts as gone only when it was gone at
      // the pass's first read too (a terminal opened meanwhile is not).
      const gone = (id: string): boolean => {
        const was = byId.get(id);
        const is = fresh.get(id);
        return ptys.includes(id) && (!was || was.state === 'dead') && (!is || is.state === 'dead');
      };
      const why = isStoppedByOwner(row) ? 'stopped by owner' : row.status;
      const dead = (id: string): boolean => own(id) && (closable.includes(id) || gone(id));
      // Every tab of a layout pane, of any kind: one with no local session
      // of its own (a remote terminal, a browser, an editor) is not a dead
      // worker, and keeps its pane and the workspace.
      const layout = await ports.paneSurfaces(ws).catch(() => null);
      if (!layout) return 0;
      const paneDead = (p: { surfaceCount: number; surfacePtyIds: readonly string[] }): boolean =>
        p.surfaceCount > 0 && p.surfacePtyIds.length === p.surfaceCount && p.surfacePtyIds.every(dead);
      // The whole workspace only when every pane in it is the task's own
      // and dead: an unidentified pane or tab keeps it.
      if (nowPtys.every(dead) && layout.length > 0 && layout.every(paneDead)) {
        let ok = false;
        try {
          ok = await ports.closeWorkspace(ws);
        } catch (err) {
          log(`[factory] dead panes: ${ws} (task ${row.id}) was not closed: ${String(err)}`);
        }
        if (!ok) {
          notBefore.set(ws, now() + CLEAR_RETRY_MS);
          return 0;
        }
        if (!(await closeShows(ws, nowPtys, true))) {
          notBefore.set(ws, now() + CLEAR_FOREIGN_RETRY_MS);
          leaveBehind(row.id, nowPtys);
          log(`[factory] dead panes: the close of ${ws} (task ${row.id}) was answered but did not take effect; looked at again later`);
          return 0;
        }
        for (const id of nowPtys) log(`[factory] dead panes: closed ${id} with its workspace ${ws} (task ${row.id}, ${why}${closable.includes(id) ? '' : ', no session'})`);
        notBefore.delete(ws);
        return nowPtys.length;
      }
      if (closable.length === 0) return 0;
      // One layout pane at a time, and only one whose every tab is a dead
      // worker terminal of the task: closing a pane closes all its tabs.
      let closed = 0;
      for (const p of layout) {
        if (!paneDead(p) || !p.surfacePtyIds.every((id) => closable.includes(id))) continue;
        const ids = [...p.surfacePtyIds];
        let ok = false;
        try {
          ok = await ports.closePane(p.id);
        } catch {
          ok = false;
        }
        if (ok && !(await closeShows(ws, ids, false))) {
          notBefore.set(ws, now() + CLEAR_FOREIGN_RETRY_MS);
          leaveBehind(row.id, ids);
          log(`[factory] dead panes: the close of the pane of ${ids.join(', ')} in ${ws} (task ${row.id}) was answered but did not take effect; looked at again later`);
          continue;
        }
        if (ok) {
          closed += ids.length;
          for (const id of ids) log(`[factory] dead panes: closed ${id} in ${ws} (task ${row.id}, ${why})`);
        } else {
          // Refused (a workspace's root pane cannot close): looked at again
          // only much later.
          notBefore.set(ws, now() + CLEAR_FOREIGN_RETRY_MS);
          log(`[factory] dead panes: the pane of ${ids.join(', ')} in ${ws} (task ${row.id}) did not close; it stays`);
        }
      }
      return closed;
    } finally {
      release();
    }
  };

  const recordOpen = async (row: LedgerEntry, rec: ReclaimedWorker | null, ws: string, ptys: readonly string[], byId: Map<string, DeadPaneSession>): Promise<boolean> => {
    // A record that covers this rev already, or a worker being stopped or
    // running again.
    if (rec && (rec.state !== 'stopped' || isReclaimedSince(rec, row))) return false;
    // An agent alive anywhere in the workspace: the worker may be that one.
    if (ptys.some((id) => byId.get(id)?.agentProcessAlive === true)) return false;
    // Only the task's own worker panes: recorded for it, or created by its launch.
    const own = ptys.filter((id) => ownPane(row.id, id));
    const dead = own.filter((id) => isRespawnedShell(byId.get(id)) || isAgentExitedShell(byId.get(id)));
    if (dead.length === 0 || dead.length < own.length) return false;
    const quiet = await untyped(dead, byId, Math.max(row.updatedAt, rec?.at ?? 0));
    if (quiet.length < dead.length) return false;
    const panes = dead.map((id) => byId.get(id)).filter((s): s is DeadPaneSession => !!s).map(reclaimedSessionOf).filter((s): s is ReclaimedSession => !!s);
    if (panes.length === 0) return false;
    // A conversation an earlier record held stays (a respawned shell may not
    // show its binding any more).
    for (const p of panes) {
      const old = rec?.sessions.find((k) => k.sessionId === p.sessionId);
      if (!p.resumeSessionId && old?.resumeSessionId) {
        p.resumeSessionId = old.resumeSessionId;
        if (old.permissionMode) p.permissionMode = old.permissionMode;
      }
    }
    fillLaunchedModes(panes, ports.launchedConversation);
    const holds = holdWorkerPanes(row.id);
    if (!holds) return false;
    try {
      // The row and the record again, after the reads above: a task that moved
      // on, or a worker resumed meanwhile, is left to the next pass. So is a
      // pane that runs something now.
      if (!unchanged(row, rec)) return false;
      const fresh = new Map((await ports.listSessions()).map((x) => [x.id, x]));
      if (!dead.every((id) => isRespawnedShell(fresh.get(id)) || isAgentExitedShell(fresh.get(id)))) return false;
      if (!unchanged(row, rec)) return false;
      await ports.store.put({
        taskId: row.id,
        botId: row.dispatch?.origin.botId ?? '',
        ownerWorkspaceId: row.ownerWorkspaceId,
        taskWorkspaceId: row.taskWorkspaceId,
        title: row.title,
        threadId: taskThreadOf(row),
        // Still open: recorded like a reported task's paused worker.
        ended: 'reported',
        sessions: panes,
        state: 'stopped',
        at: now(),
        endRev: row.rev,
        ...(rec?.paneWorkspaceId ? { paneWorkspaceId: rec.paneWorkspaceId } : {}),
      });
    } catch (err) {
      log(`[factory] dead panes: the worker of ${row.id} was not recorded: ${String(err)}`);
      return false;
    } finally {
      holds();
    }
    for (const p of panes) log(`[factory] dead panes: recorded the worker of ${row.id} in ${p.sessionId} (${ws}) for Resume; its pane stays (task ${row.status})`);
    return true;
  };

  const pass = async (): Promise<{ closed: number; recorded: number }> => {
    let closed = 0;
    let recorded = 0;
    if (!ports.ready() || safe(() => ports.viewedWorkspace(), null) === null) return { closed, recorded };
    const sessions = await ports.listSessions();
    closed += await sweepLeftBehind(sessions);
    const byId = new Map(sessions.map((s) => [s.id, s]));
    const at = now();
    for (const row of ports.rows()) {
      const origin = row.dispatch?.origin;
      if (origin?.kind !== 'bot' || typeof origin.botId !== 'string' || !origin.botId) continue;
      const ended = ENDED.has(row.status);
      if (!ended && !OPEN.has(row.status)) continue;
      const rec = ports.store.get(row.id);
      // A resumed worker runs; a stop under way is the reclaim's.
      if (rec && rec.state !== 'stopped') continue;
      const ws = rec ? workerWorkspaceOf(rec) : row.taskWorkspaceId;
      if (!ws || (notBefore.get(ws) ?? 0) > at) continue;
      const id = { taskId: row.id, botId: origin.botId, ownerWorkspaceId: row.ownerWorkspaceId, ...(rec?.paneWorkspaceId ? { paneWorkspaceId: rec.paneWorkspaceId } : {}) };
      if (!safe(() => ports.isTaskWorkspace(id, ws), false)) continue;
      const ptys = safe(() => ports.workspacePtys(ws), null);
      if (!ptys || ptys.length === 0) continue;
      if (ended) {
        // An end the reclaim records first (its conversation, for Resume):
        // only once it did, or gave up.
        if (isReclaimableEnd(row, row.status) && !isReclaimedSince(rec, row) && at - row.updatedAt < RECLAIM_CATCHUP_MS) continue;
        if (safe(() => ports.viewed(ws), true)) continue;
        closed += await closeEnded(row, rec, ws, ptys, byId);
      } else if (await recordOpen(row, rec, ws, ptys, byId)) {
        recorded++;
      }
    }
    if (closed > 0 || recorded > 0) ports.changed?.();
    return { closed, recorded };
  };

  return {
    async pass() {
      if (running) return { closed: 0, recorded: 0 };
      running = true;
      try {
        return await pass();
      } catch (err) {
        log(`[factory] dead panes pass failed: ${String(err)}`);
        return { closed: 0, recorded: 0 };
      } finally {
        running = false;
      }
    },
  };
}
