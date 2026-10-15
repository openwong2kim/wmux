// Production wiring for a bot worker's life after its answer: the report
// nudge (workerReportNudge.ts), the reclaim of an ended task's worker and its
// resume (workerReclaim.ts), the agent budget (agentSlots.ts) and the pane a
// bot's message to its live worker goes to (workerMessage.ts). Started by
// the wiring module once every factory module is up; kept apart so that
// module's imports stay free of the event bus and the pane status handler.

import { getConnectorStore } from './connectorStore';
import type { BrowserWindow } from 'electron';
import type { DaemonClient } from '../DaemonClient';
import type { ThreadId } from '../../shared/room';
import { BOT_EVENT } from '../../shared/bot';
import { sanitizePtyText } from '../../shared/types';
import { eventBus } from '../events/EventBus';
import { getLastBroadcastAgentStatus, hasOutstandingRunningClaim } from '../ipc/handlers/metadata.handler';
import { guardSessionLaunch } from '../agents/botWorkerMergeGuard';
import { getTaskLedger } from '../deck/taskLedgerHost';
import { getBotRuntime } from './BotRuntime';
import { getBotStore } from './botStore';
import { getFactorySettings } from './factorySettings';
import { getRoomWriter } from './roomWriter';
import { taskFolderFromMissions } from './verifyPreset';
import { AgentSlots, rowHoldsAgentSlot, setAgentSlots, setSlotLiveness, type SlotLiveness } from './agentSlots';
import { checkWorkers, recordWorkerEnd, recordWorkerStart } from './budget';
import { runningWakeTainted } from './wakeTaint';
import { installReportNudge, submitToWorkerPane } from './workerReportNudge';
import { setWorkerLivePane } from './workerMessage';
import {
  REPORTED_UNSEEN_IDLE_MS,
  ReclaimedWorkers,
  createWorkerClear,
  installWorkerReclaim,
  isReclaimedSince,
  isTaskWorkspaceOf,
  noteWorkerAgentExit,
  setResumedLiveCount,
  setWorkerResumePorts,
  type WorkerRespawnInput,
  type WorkerSessionInfo,
  unreclaimedEndedWorkers,
  workerWorkspaceOf,
} from './workerReclaim';
import { getWorkspaceMirror } from '../workspace/WorkspaceMirror';
import { STOPPED_BY_OWNER } from './factoryStop';
import { getFanOutGuards, setDormantTaskWorkspaces } from '../worktask/fanoutGuards';
import type { FanOutService } from '../worktask/FanOutService';
import { sendToRenderer } from '../pipe/handlers/_bridge';
import { isFanoutWorkerPermissionMode } from '../../shared/workerLaunch';

/** A resumed worker is checked for an exited agent this often. */
const RESUMED_SWEEP_MS = 60_000;
/** ...and not before its relaunch had this long to show up. */
const RESUMED_SETTLE_MS = 120_000;

export interface WorkerLifecycleDeps {
  wmuxDir: () => string;
  getDaemonClient?: () => DaemonClient | null;
  getMainWindow?: () => BrowserWindow | null;
  /** The one FanOutService: a resume whose pane was cleared opens it again
   *  on the bot worker spawn. Absent: such a resume is refused. */
  fanOutService?: Pick<FanOutService, 'spawnBotTaskPane'>;
}

/** Which open workspaces run no agent any more is read at most this often. */
const LIVENESS_REFRESH_MS = 10_000;
/** Holders a slot-wait card names, at most. */
const HOLDERS_SHOWN_MAX = 6;

/** The renderer's workspace.close answers this fast or not at all. */
const CLOSE_TIMEOUT_MS = 10_000;

function note(workspaceId: string, threadId: ThreadId, title: string, body: string): void {
  getRoomWriter()?.append({ workspaceId, threadId, kind: 'fact', actor: { kind: 'system' }, title, body });
}

/** Start everything; returns the stop. */
export function startWorkerLifecycle(deps: WorkerLifecycleDeps): () => void {
  const offs: Array<() => void> = [];
  const ledger = getTaskLedger();
  const daemon = (): DaemonClient | null => deps.getDaemonClient?.() ?? null;
  const rpc = async (method: string, params: Record<string, unknown>): Promise<unknown> => {
    const c = daemon();
    if (!c) throw new Error('the daemon is not connected');
    return c.rpc(method as never, params);
  };
  const changed = (): void => {
    try {
      const win = deps.getMainWindow?.();
      if (win && !win.isDestroyed()) win.webContents.send(BOT_EVENT, { type: 'bots-changed' });
    } catch {
      /* best effort */
    }
  };
  const listSessions = async (): Promise<WorkerSessionInfo[]> => {
    const s = await rpc('daemon.listSessions', {});
    return Array.isArray(s) ? (s as WorkerSessionInfo[]) : [];
  };
  // What the agent budget knows of the workers' panes: the open workspaces
  // (the mirror, read now) and those whose panes all run no agent any more
  // (the daemon's sessions, read in the background at most every
  // LIVENESS_REFRESH_MS; until the first read, none).
  let idleWorkspaces: ReadonlySet<string> = new Set();
  let idleReadAt = 0;
  let idleReading = false;
  const refreshIdle = (): void => {
    if (idleReading || Date.now() - idleReadAt < LIVENESS_REFRESH_MS) return;
    idleReading = true;
    void listSessions().then((sessions) => {
      const byId = new Map(sessions.map((x) => [x.id, x]));
      const next = new Set<string>();
      for (const e of getWorkspaceMirror().getEntries() ?? []) {
        const ptys = Array.isArray(e.ptyIds) ? e.ptyIds : [];
        // Gone, or seen to exit; an agent never attributed is not known dead.
        if (ptys.length > 0 && ptys.every((id) => { const x = byId.get(id); return !x || x.agentProcessAlive === false; })) next.add(e.id);
      }
      idleWorkspaces = next;
      idleReadAt = Date.now();
    }).catch(() => undefined).finally(() => {
      idleReading = false;
    });
  };
  const liveness = (): SlotLiveness => {
    refreshIdle();
    const entries = getWorkspaceMirror().getEntries();
    return { workspaces: entries ? new Set(entries.map((e) => e.id)) : null, idleWorkspaces, now: Date.now() };
  };
  /** Open bot task rows whose worker holds an agent slot. */
  const slotRows = (): ReturnType<typeof ledger.list> => {
    const live = liveness();
    return ledger.list({ openOnly: true }).filter((r) => rowHoldsAgentSlot(r, live));
  };
  setSlotLiveness(liveness);
  offs.push(() => setSlotLiveness(null));
  /** Whether a task's row is open (a reclaimed task can reopen: failed → working). */
  const taskOpen = (taskId: string): boolean => {
    const st = ledger.get(taskId)?.status;
    return st === 'working' || st === 'input_required' || st === 'review_requested';
  };
  /** Resumed workers still live outside an open row: resumed after their
   *  task's last end (an open row, or an end not reclaimed yet, counts them
   *  already). */
  const resumedLive = (botId?: string): number => reclaimed.all().filter((r) => {
    if (r.state !== 'resumed' || (botId !== undefined && r.botId !== botId)) return false;
    const row = ledger.get(r.taskId);
    return !row || (!taskOpen(r.taskId) && isReclaimedSince(r, row));
  }).length;

  // Reclaim + resume. A record file this version cannot read leaves the
  // reclaim off (workers keep running, as before), never overwritten.
  const reclaimed = ReclaimedWorkers.at(deps.wmuxDir());
  let reclaimOn = true;
  try {
    reclaimed.load();
  } catch (err) {
    reclaimOn = false;
    console.warn(`[factory] worker reclaim off: ${String(err)}`);
  }
  if (reclaimOn) {
    // Clear: an ended task's workspace closes once its agent is stopped.
    const mirror = getWorkspaceMirror();
    const clear = createWorkerClear({
      store: reclaimed,
      openWorkspaces: () => {
        const entries = mirror.getEntries();
        return entries ? new Set(entries.map((e) => e.id)) : null;
      },
      viewedWorkspace: () => mirror.getViewed()?.workspaceId ?? null,
      workspacePtys: (workspaceId) => {
        const entry = mirror.getEntries()?.find((e) => e.id === workspaceId);
        return entry && Array.isArray(entry.ptyIds) ? entry.ptyIds : null;
      },
      listSessions,
      taskOpen,
      isTaskWorkspace: (rec, workspaceId) => isTaskWorkspaceOf(
        rec,
        workspaceId,
        (ws) => ledger.findByTaskWorkspace(ws)?.id ?? null,
        (ws) => getFanOutGuards().lineageFor([ws])[ws] ?? null,
      ),
      closeWorkspace: async (workspaceId) => {
        const res = await sendToRenderer(() => deps.getMainWindow?.() ?? null, 'workspace.close', { id: workspaceId }, { timeoutMs: CLOSE_TIMEOUT_MS });
        return !!res && typeof res === 'object' && (res as { ok?: unknown }).ok === true;
      },
      changed,
    });
    const reconcile = (): void => {
      void clear.reconcile();
    };
    offs.push(installWorkerReclaim({
      onTransition: (fn) => ledger.onTransition(fn),
      allRows: () => ledger.list({}),
      row: (taskId) => ledger.get(taskId),
      store: reclaimed,
      worktreeOf: (entry) => taskFolderFromMissions((m, p) => rpc(m, (p ?? {}) as Record<string, unknown>), entry),
      listSessions,
      stopAgent: async (sessionId) => (await rpc('session.stopAgent', { sessionId })) as { ok?: boolean; stopped?: boolean; code?: string },
      note,
      changed: () => {
        changed();
        reconcile();
      },
      retryMs: RESUMED_SWEEP_MS,
      // A reported task's worker is stopped once every pane of its
      // workspace was seen to end its turn, and only those panes are
      // stopped. A status main has not seen yet (right after a restart) is
      // taken as idle only for a task reported long ago.
      turnEnded: (entry) => {
        const ws = mirror.getEntries()?.find((e) => e.id === entry.taskWorkspaceId);
        const ptys = ws && Array.isArray(ws.ptyIds) ? ws.ptyIds : [];
        const longAgo = Date.now() - entry.updatedAt >= REPORTED_UNSEEN_IDLE_MS;
        return ptys.length > 0 && ptys.every((id) => {
          const st = getLastBroadcastAgentStatus(id);
          if (hasOutstandingRunningClaim(id) || st === 'running' || st === 'awaiting_input') return false;
          return st !== undefined || longAgo;
        });
      },
      workspacePanes: (workspaceId) => {
        const entries = mirror.getEntries();
        if (!entries) return null;
        const ws = entries.find((e) => e.id === workspaceId);
        return ws && Array.isArray(ws.ptyIds) ? ws.ptyIds : [];
      },
    }));
    // The viewed workspace moving (and every other tree push) may make a
    // deferred clear due; a pass with nothing due reads nothing.
    offs.push(mirror.onSnapshot(reconcile));
    setWorkerResumePorts({
      store: reclaimed,
      listSessions,
      // The same stage a resume typed from the pane takes (pty:write-launch):
      // a bot worker's line carries its settings file, or this throws.
      typeLine: (sessionId, line) => {
        const c = daemon();
        if (!c) return false;
        return c.writeToSession(sessionId, sanitizePtyText(guardSessionLaunch(sessionId, line)) + '\r');
      },
      agentAlive: async (sessionId) => (await listSessions()).find((s) => s.id === sessionId)?.agentProcessAlive === true,
      submit: submitToWorkerPane,
      stopAgent: async (sessionId) => (await rpc('session.stopAgent', { sessionId })) as { ok?: boolean; stopped?: boolean; code?: string },
      // A cleared pane opens again on the bot worker spawn, with the
      // recorded permission mode (any other mode keeps the line's own flag).
      ...(deps.fanOutService ? {
        respawn: async (input: WorkerRespawnInput) => {
          const svc = deps.fanOutService;
          if (!svc) return { ok: false as const, message: 'fan-out is not running' };
          // The task's connections that are still this bot's (the library
          // as it is now; one gone or out of scope since is left out).
          const named = ledger.get(input.taskId)?.dispatch?.connectors ?? [];
          const current = named.length > 0 ? getConnectorStore()?.forBot(input.botId) ?? [] : [];
          const connectors = current.filter((c) => named.includes(c.name));
          if (connectors.length < named.length) {
            console.log('[factory] resume: connections left out (gone or no longer this bot\'s)', { taskId: input.taskId, names: named.filter((n) => !connectors.some((c) => c.name === n)) });
          }
          const r = await svc.spawnBotTaskPane({
            ownerWorkspaceId: input.ownerWorkspaceId,
            botId: input.botId,
            taskId: input.taskId,
            title: input.title,
            cwd: input.cwd,
            command: input.line,
            workerPermissionMode: isFanoutWorkerPermissionMode(input.permissionMode) ? input.permissionMode : 'manual',
            // Unknown taint counts as tainted.
            tainted: ledger.get(input.taskId)?.dispatch?.origin.tainted !== false,
            ...(connectors.length > 0 ? { connectors } : {}),
          });
          return 'error' in r ? { ok: false as const, message: r.error } : { ok: true as const, workspaceId: r.workspaceId, sessionId: r.ptyId };
        },
      } : {}),
      // The reopened workspace is the task's from now on (a system write at
      // the rev just read; one retry when another write landed in between).
      rebindTask: async (taskId, workspaceId) => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const row = ledger.get(taskId);
          if (!row) return null;
          const r = await ledger.rebindTaskWorkspace({ id: taskId, taskWorkspaceId: workspaceId, actor: { kind: 'system', workspaceId: 'daemon' }, expectedRev: row.rev });
          if (r.ok) return { from: row.rev, to: r.entry.rev };
          if (r.error !== 'stale_rev') return null;
        }
        return null;
      },
      // A bot's message from a wake that carried outside text goes only to a
      // task started from outside text (unknown counts as outside text).
      taskTainted: (taskId) => ledger.get(taskId)?.dispatch?.origin.tainted !== false,
      senderTainted: runningWakeTainted,
      stoppedByOwner: (taskId) => {
        const row = ledger.get(taskId);
        return !!row && row.status === 'cancelled' && row.summary === STOPPED_BY_OWNER && row.updatedBy.kind === 'system';
      },
      // A bot's resume starts a worker: its own worker budget applies.
      botWorkerRefusal: (botId, starting) => {
        const store = getBotStore();
        const profile = store?.get(botId);
        if (!store || !profile) return 'the bot was removed';
        const open = slotRows().filter((r) => r.dispatch?.origin.botId === botId).length;
        const c = checkWorkers(profile.budget, store.usageOf(botId), open + resumedLive(botId) + starting, 1, Date.now());
        return c.ok ? null : `this bot's worker budget refuses another worker now (${c.reason})`;
      },
      note,
      changed,
    });
    // A reclaimed worker's workspace still open (a failed task the owner has
    // not looked at, one they are viewing, one with a busy pane) runs no
    // agent: it holds no live fan-out slot (unless its task reopened).
    // So does a reported task's stopped worker while its task waits for review.
    setDormantTaskWorkspaces(() => new Set(reclaimed.all().filter((r) => r.state === 'stopped'
      && (!taskOpen(r.taskId) || (r.ended === 'reported' && ledger.get(r.taskId)?.status === 'review_requested'))).map((r) => workerWorkspaceOf(r))));
    offs.push(() => setDormantTaskWorkspaces(null));
    offs.push(() => setWorkerResumePorts(null));
    // A resumed worker runs on its bot's worker budget: counted live by the
    // fan-out's check, and its run (resume to stop) in the bot's hours.
    setResumedLiveCount(resumedLive);
    offs.push(() => setResumedLiveCount(null));
    reclaimed.onStateChange = (rec, from, to, at) => {
      const store = getBotStore();
      if (!store?.get(rec.botId)) return;
      if (to === 'resumed') store.mutateUsage(rec.botId, (u) => recordWorkerStart(u, rec.taskId, at, { resumed: true }));
      else if (from === 'resumed') store.mutateUsage(rec.botId, (u) => { recordWorkerEnd(u, rec.taskId, at); });
    };
    offs.push(() => { reclaimed.onStateChange = null; });
    const sweep = setInterval(() => {
      const resumed = reclaimed.all().filter((r) => r.state === 'resumed' && Date.now() - r.at >= RESUMED_SETTLE_MS);
      if (resumed.length === 0) {
        reconcile();
        return;
      }
      void listSessions().then((sessions) => {
        let moved = false;
        for (const r of resumed) {
          const alive = r.sessions.some((p) => sessions.find((s) => s.id === p.sessionId)?.agentProcessAlive === true);
          if (!alive) moved = r.sessions.some((p) => noteWorkerAgentExit(reclaimed, p.sessionId)) || moved;
        }
        if (moved) changed();
      }).catch(() => undefined).finally(reconcile);
    }, RESUMED_SWEEP_MS);
    sweep.unref?.();
    offs.push(() => clearInterval(sweep));
    // Workspaces of tasks that ended before this start (an app restart).
    reconcile();
  }

  // The agent budget.
  const runningBotNames = (): string[] => {
    const rt = getBotRuntime();
    return rt ? (getBotStore()?.list({}) ?? []).filter((b) => rt.currentTurn(b.id) !== null).map((b) => b.name) : [];
  };
  const slots = new AgentSlots({
    cap: () => getFactorySettings().maxConcurrentAgents,
    runningBots: () => runningBotNames().length,
    // Open bot tasks whose worker still runs, ended bot tasks whose worker
    // is not reclaimed yet, resumed workers. The owner's own fan-outs and a
    // row whose worker is gone do not count (rowHoldsAgentSlot).
    liveWorkers: () => slotRows().length
      + (reclaimOn ? unreclaimedEndedWorkers(ledger.list({}), reclaimed, Date.now()) + resumedLive() : 0),
    // A spawned worker whose row was not written: while its workspace lives
    // and still no row names it.
    stillHeld: (workspaceId) => !ledger.findByTaskWorkspace(workspaceId)
      && (getWorkspaceMirror().getEntries()?.some((e) => e.id === workspaceId) ?? true),
    onWaiting: (w, inUse, cap) => note(
      w.ownerWorkspaceId,
      (w.threadId ?? `task:${w.taskId}`) as ThreadId,
      'Worker waiting, not started',
      `"${w.title}" is waiting for an agent slot and has not started; it starts when one frees. ${inUse} of ${cap} in use: ${slotHolders(inUse)}.`,
    ),
    changed,
  });
  /** What holds the slots, in words: bots in a turn, then workers by title. */
  function slotHolders(inUse: number): string {
    const bots = runningBotNames();
    const workers = slotRows().map((r) => `"${r.title}"`);
    const parts: string[] = [];
    const list = (names: string[]): string => names.length <= HOLDERS_SHOWN_MAX
      ? names.join(', ')
      : `${names.slice(0, HOLDERS_SHOWN_MAX).join(', ')} and ${names.length - HOLDERS_SHOWN_MAX} more`;
    if (bots.length > 0) parts.push(`${bots.length === 1 ? 'bot' : 'bots'} in a turn ${list(bots)}`);
    if (workers.length > 0) parts.push(`${workers.length === 1 ? 'worker' : 'workers'} ${list(workers)}`);
    const rest = inUse - bots.length - workers.length;
    if (rest > 0) parts.push(`${rest} other ${rest === 1 ? 'worker' : 'workers'} starting, resumed or not yet reclaimed`);
    return parts.length > 0 ? parts.join('; ') : 'nothing the factory can name';
  }
  setAgentSlots(slots);
  offs.push(ledger.onTransition(() => slots.kick()));
  offs.push(() => {
    slots.dispose();
    setAgentSlots(null);
  });

  // A bot's message to its live worker (workerMessage.ts): the task
  // workspace's pane whose agent process runs.
  const mirrorNow = getWorkspaceMirror();
  setWorkerLivePane(async (taskWorkspaceId) => {
    const entry = mirrorNow.getEntries()?.find((e) => e.id === taskWorkspaceId);
    const ptys = entry && Array.isArray(entry.ptyIds) ? entry.ptyIds : [];
    if (ptys.length === 0) return null;
    const sessions = await listSessions();
    return ptys.find((id) => sessions.find((s) => s.id === id)?.agentProcessAlive === true) ?? null;
  });
  offs.push(() => setWorkerLivePane(null));

  // The report nudge, on worker turn ends.
  const nudger = installReportNudge({
    ledger,
    isRunning: (ptyId) => getLastBroadcastAgentStatus(ptyId) === 'running' || hasOutstandingRunningClaim(ptyId),
    submit: submitToWorkerPane,
    note,
  });
  offs.push(eventBus.subscribe((ev) => {
    if (ev.type === 'agent.lifecycle') nudger.noteLifecycle(ev);
  }));
  offs.push(() => nudger.dispose());

  return () => {
    for (const off of offs.splice(0).reverse()) {
      try {
        off();
      } catch {
        /* best effort */
      }
    }
  };
}
