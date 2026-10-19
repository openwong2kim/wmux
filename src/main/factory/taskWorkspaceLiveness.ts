// What the agent budget and the fan-out live cap know of the open task
// workspaces' panes (#2387, #2393): one read of the workspace mirror and the
// daemon's sessions, at most every `refreshMs` (IdleSnapshot), and the task
// workspaces that hold no live fan-out slot. An ended task's agent seen gone
// by a good read is kept as a durable fact (agentGoneFacts.ts), so a restart
// or a daemon that cannot answer yet never counts it as live again. Wired by
// the worker lifecycle host; kept apart so the read and the facts are testable.

import type { LedgerEntry } from '../../shared/ledger';
import type { WorkspaceListEntry } from '../../shared/workspaceMirror';
import { IdleSnapshot, paneRunsNoAgent, paneShowsWork } from './agentSlots';
import type { AgentGoneFact, AgentGoneFacts } from './agentGoneFacts';
import { endedTaskAgentRuns, isTaskOwnWorkerPane, type ReclaimedWorker, type WorkerSessionInfo, type WorkerSessionRecordOf } from './workerReclaim';

const isEndedStatus = (status: LedgerEntry['status']): boolean => status === 'completed' || status === 'cancelled' || status === 'failed';

/** After the daemon answered that it is still restoring its sessions, it is
 *  not asked again this soon (a cap check reads on every look). */
const RESTORING_RECHECK_MS = 2_000;
/** A last good read older than this many refresh periods is stale. */
const STALE_READ_PERIODS = 3;

/** One read of the daemon's sessions, and whether its startup recovery had
 *  finished when it answered. */
export interface SessionRead {
  sessions: WorkerSessionInfo[];
  recoveryDone: boolean;
}

/** The answer to `daemon.listSessions` asked with `withRecovery: true`. A
 *  daemon that knows the flag answers `{sessions, recoveryDone}`. An older
 *  one ignores it and answers the bare list: it is taken as recovered, which
 *  is how every read was taken before the flag existed. Throws on anything
 *  else (a failed read, not "no sessions"). Pure. */
export function parseSessionRead(reply: unknown): SessionRead {
  if (Array.isArray(reply)) return { sessions: reply as WorkerSessionInfo[], recoveryDone: true };
  const r = reply as { sessions?: unknown; recoveryDone?: unknown } | null;
  if (r && typeof r === 'object' && Array.isArray(r.sessions)) {
    return { sessions: r.sessions as WorkerSessionInfo[], recoveryDone: r.recoveryDone !== false };
  }
  throw new Error('daemon.listSessions answered no session list');
}

export interface TaskWorkspaceLivenessPorts {
  /** The open workspaces (the workspace mirror), or null before the renderer
   *  pushed its tree. */
  entries: () => WorkspaceListEntry[] | null;
  /** The daemon's sessions; throws when the daemon cannot be read. */
  readSessions: () => Promise<SessionRead>;
  /** The ledger row of a task workspace, and of a task. */
  workspaceRow: (workspaceId: string) => LedgerEntry | null;
  row: (taskId: string) => LedgerEntry | null;
  /** Ended rows that may still hold a slot (the agent budget's catch-up
   *  window): one whose workspace is closed has its panes gone. */
  endedRows: () => readonly LedgerEntry[];
  /** The reclaim records ([] while the reclaim is off): the sessions each names are that task's. */
  records: () => readonly ReclaimedWorker[];
  /** The session ids a task's reclaim record holds. */
  recordedSessions: (taskId: string) => string[];
  sessionRecordOf: WorkerSessionRecordOf | undefined;
  /** The task (and bot) a pane was created or relaunched for, by its launch
   *  record (factory/workerSlots.ts), or null. */
  paneTask?: (sessionId: string) => { taskId: string; botId?: string } | null;
  /** The task a workspace was created or relaunched for, by its launch
   *  record, or null: a workspace no row names is still that task's. */
  workspaceTask?: (workspaceId: string) => string | null;
  /** The durable "agent seen gone" facts (null: none are kept). */
  facts: AgentGoneFacts | null;
  refreshMs: number;
  now?: () => number;
}

export interface TaskWorkspaceLiveness {
  /** Open workspaces whose panes all run no agent any more (last read). */
  idle: IdleSnapshot;
  /** Open workspaces with a pane at work, as of the last good read. */
  busyWorkspaces: () => ReadonlySet<string>;
  /** Ended tasks whose agent is known gone: they hold no agent slot. */
  goneTasks: () => ReadonlySet<string>;
  /** Workspaces an agent was seen running in (the last good read, less
   *  those a newer fact says are gone). */
  agentSeen: () => ReadonlySet<string>;
  /** The last good read: `ok` within a few refresh periods, `stale` older,
   *  `down` none yet. */
  readState: () => 'ok' | 'stale' | 'down';
  /** When the last good read started (undefined: none yet). */
  lastReadAt: () => number | undefined;
  /** Tasks whose own worker pane the last good read saw running, wherever
   *  it is, less those a newer fact says are gone. */
  agentSeenTasks: () => ReadonlyMap<string, string | undefined>;
  /** Resolves once the last read is no older than `refreshMs` (or failed). */
  refresh: () => Promise<void>;
}

export function createTaskWorkspaceLiveness(ports: TaskWorkspaceLivenessPorts): TaskWorkspaceLiveness {
  const now = ports.now ?? Date.now;
  const resumed = (taskId: string): boolean => ports.records().find((r) => r.taskId === taskId)?.state === 'resumed';
  let busyWorkspaces: ReadonlySet<string> = new Set();
  // Open task workspaces whose task ended (completed, cancelled, failed: the
  // owner's stop too) with no agent running in them (endedTaskAgentRuns), as
  // of the last good read: they hold no live fan-out slot, whether or not the
  // dead-pane sweep closed them yet. Each is written as a fact, and the
  // facts answer instead of this set when they are kept.
  let endedNoAgentWorkspaces: ReadonlySet<string> = new Set();
  // Open workspaces where an agent is seen running (endedTaskAgentRuns, a
  // silent pane not counted), as of the last good read: they hold their slot
  // even when a reclaim record says stopped or a fact says gone.
  let agentWorkspaces: ReadonlySet<string> = new Set();
  // The tasks whose own worker pane was seen running, wherever it is now
  // (a row or none), with their bot when known, as of the last good read.
  let agentTaskIds: ReadonlyMap<string, string | undefined> = new Map();
  // When the last good read started.
  let readAt = -Infinity;
  // Until when a daemon that said it is still restoring is not asked again.
  let restoringUntil = -Infinity;
  const read = async (): Promise<ReadonlySet<string>> => {
    // A mirror the renderer has not pushed yet, or pushed empty, is not "no
    // workspaces open": a read now would hold every ended task restored next
    // as live until the following read, so it fails and is not kept.
    const entries = ports.entries();
    if (!entries || entries.length === 0) throw new Error('the workspace list is not available yet');
    // When the observation started: a launch after this makes what it saw
    // of that task stale (AgentGoneFacts.note).
    const at = now();
    if (at < restoringUntil) throw new Error('the daemon is still restoring its sessions');
    const reply = await ports.readSessions();
    // While the daemon restores its sessions, a pane still waiting for its
    // WSL distribution reads as suspended (no agent) and the list may be
    // short: that is no proof any agent is gone, so the read fails and
    // writes nothing. Once recovery is done, an empty list is the truth.
    if (!reply.recoveryDone) {
      restoringUntil = now() + RESTORING_RECHECK_MS;
      throw new Error('the daemon is still restoring its sessions');
    }
    const byId = new Map(reply.sessions.map((x) => [x.id, x]));
    for (const x of reply.sessions) if (x.agentProcessAlive === true) ports.facts?.sessionAgentSeen(x.id, at);
    // A session no open workspace holds is at work: the tree may have come
    // back without some workspaces or panes while they still run.
    const inTree = new Set(entries.flatMap((e) => (Array.isArray(e.ptyIds) ? e.ptyIds : [])));
    const outsideAtWork = reply.sessions.some((x) => !inTree.has(x.id) && paneShowsWork(x));
    const next = new Set<string>();
    const busy = new Set<string>();
    const endedNoAgent = new Set<string>();
    const withAgent = new Set<string>();
    const withAgentTasks = new Map<string, string | undefined>();
    // A task's own worker pane seen running wherever it is now (adopted into
    // another workspace, or one the tree lost): the task runs again.
    const recordedOwner = new Map<string, { taskId: string; botId?: string }>();
    for (const r of ports.records()) for (const x of r.sessions) recordedOwner.set(x.sessionId, { taskId: r.taskId, botId: r.botId });
    /** The task (and bot) a pane is the worker of, or undefined: its launch
     *  record; a pane created before those were kept, by its reclaim record
     *  or its bot worker session record. */
    const paneOwner = (id: string): { taskId: string; botId?: string } | undefined => {
      try {
        const launched = ports.paneTask?.(id);
        if (launched) return launched;
      } catch {
        // fall through to the older records
      }
      const known = recordedOwner.get(id);
      if (known) return known;
      try {
        const rec = ports.sessionRecordOf?.(id) as { taskId?: unknown; botId?: unknown } | null | undefined;
        return typeof rec?.taskId === 'string' && rec.taskId
          ? { taskId: rec.taskId, ...(typeof rec.botId === 'string' && rec.botId ? { botId: rec.botId } : {}) }
          : undefined;
      } catch {
        return undefined;
      }
    };
    // The same owner as a session record: a pane its launch record names
    // is that task's own worker pane, also for a WSL agent no process
    // attributes (endedTaskAgentRuns asks which task's pane it is).
    const ownerRecordOf: WorkerSessionRecordOf = (id) => {
      const o = paneOwner(id);
      return o ? { taskId: o.taskId } : null;
    };
    /** Whether one of the task's own panes, wherever it is, still runs its agent. */
    const ownAgentRuns = (taskId: string): boolean => {
      const recorded = ports.recordedSessions(taskId);
      const own = reply.sessions.filter((x) => isTaskOwnWorkerPane(x, taskId, recorded, ownerRecordOf)).map((x) => x.id);
      return endedTaskAgentRuns(own, taskId, recorded, byId, ownerRecordOf);
    };
    /** The task a workspace's launch record names, or null. */
    const workspaceTask = (ws: string): string | null => {
      try {
        return ports.workspaceTask?.(ws) ?? null;
      } catch {
        return null;
      }
    };
    for (const x of reply.sessions) {
      const owner = paneOwner(x.id);
      const taskId = owner?.taskId;
      if (!taskId || !endedTaskAgentRuns([x.id], taskId, ports.recordedSessions(taskId), byId, ownerRecordOf, false)) continue;
      ports.facts?.seenRunning(taskId, at);
      withAgentTasks.set(taskId, owner?.botId);
      const ws = ports.row(taskId)?.taskWorkspaceId;
      if (ws) withAgent.add(ws);
    }
    for (const e of entries) {
      const ptys = Array.isArray(e.ptyIds) ? e.ptyIds : [];
      const row = ports.workspaceRow(e.id);
      const recorded = row ? ports.recordedSessions(row.id) : [];
      // In a task's workspace (its row's, or its launch record's when no row
      // names it), a pane another task's worker runs in (adopted here) is
      // that task's: it is seen running as that task's, never as this one's
      // work. A workspace's record and its row never name two tasks
      // (WorkerSlots never reassigns a recorded workspace).
      const own: string | null = row?.id ?? workspaceTask(e.id);
      const notForeign = own
        ? ptys.filter((id) => {
            const t = paneOwner(id)?.taskId;
            return !t || t === own;
          })
        : ptys;
      if (notForeign.some((id) => paneShowsWork(byId.get(id)))) busy.add(e.id);
      // Gone, seen to exit, or respawned by the daemon's restart with no agent
      // since; an agent never attributed otherwise is not known dead.
      if (ptys.length > 0 && notForeign.every((id) => paneRunsNoAgent(byId.get(id)))) next.add(e.id);
      if (endedTaskAgentRuns(notForeign, row?.id ?? '', recorded, byId, ownerRecordOf, false)) {
        withAgent.add(e.id);
        // Seen running again: the task holds its slot from now on, across a
        // restart too, until a read sees it exit.
        if (row) ports.facts?.seenRunning(row.id, at);
      } else if (row && isEndedStatus(row.status) && !endedTaskAgentRuns(notForeign, row.id, recorded, byId, ownerRecordOf)) {
        endedNoAgent.add(e.id);
        // Written only while none of the task's own panes runs its agent
        // anywhere, and, for a workspace that lists no pane, while nothing
        // outside the tree is at work.
        if (!resumed(row.id) && !ownAgentRuns(row.id) && (ptys.length > 0 || !outsideAtWork)) {
          ports.facts?.note({ taskId: row.id, taskWorkspaceId: e.id, sessions: [...ptys], at });
        }
      }
    }
    // An ended task whose workspace is closed: its panes are gone. Not when
    // a session no open workspace holds is at work (a tree that came back
    // without its workspaces, the panes still running), nor while one of the
    // task's own panes still runs its agent.
    if (!outsideAtWork) {
      const open = new Set(entries.map((e) => e.id));
      for (const row of ports.endedRows()) {
        if (!isEndedStatus(row.status) || open.has(row.taskWorkspaceId) || resumed(row.id) || ownAgentRuns(row.id)) continue;
        ports.facts?.note({ taskId: row.id, taskWorkspaceId: row.taskWorkspaceId, sessions: [], at });
      }
    }
    readAt = at;
    busyWorkspaces = busy;
    endedNoAgentWorkspaces = endedNoAgent;
    agentWorkspaces = withAgent;
    agentTaskIds = withAgentTasks;
    return next;
  };
  const idle = new IdleSnapshot(read, ports.refreshMs, now);

  /** Whether a fact still says what it said: its task's row is still the
   *  one of its workspace, and no pane it does not name opened there since
   *  (a closed workspace has none). Unknown workspaces: it holds. */
  const holds = (f: AgentGoneFact, entries: WorkspaceListEntry[] | null): boolean => {
    const ws = entries?.find((e) => e.id === f.taskWorkspaceId);
    if (!ws) return true;
    if (ports.workspaceRow(f.taskWorkspaceId)?.id !== f.taskId) return false;
    const ptys = Array.isArray(ws.ptyIds) ? ws.ptyIds : [];
    return ptys.every((id) => f.sessions.includes(id));
  };
  /** The workspaces the last good read saw an agent in, less those a fact
   *  written after that read says are gone (a close that stopped the panes):
   *  an older sighting never outweighs a newer stop. */
  const seenRunning = (): ReadonlySet<string> => {
    const entries = ports.entries();
    const newer = new Set((ports.facts?.all() ?? []).filter((f) => f.at > readAt && holds(f, entries)).map((f) => f.taskWorkspaceId));
    return newer.size === 0 ? agentWorkspaces : new Set([...agentWorkspaces].filter((ws) => !newer.has(ws)));
  };
  const goneTasks = (): ReadonlySet<string> => {
    idle.get();
    const entries = ports.entries();
    const running = seenRunning();
    const out = new Set<string>();
    for (const f of ports.facts?.all() ?? []) {
      const row = ports.row(f.taskId);
      if (!row || !isEndedStatus(row.status) || resumed(f.taskId) || running.has(f.taskWorkspaceId) || !holds(f, entries)) continue;
      out.add(f.taskId);
    }
    if (ports.facts) return out;
    for (const ws of endedNoAgentWorkspaces) {
      const row = ports.workspaceRow(ws);
      if (row && isEndedStatus(row.status) && !resumed(row.id)) out.add(row.id);
    }
    return out;
  };

  const readState = (): 'ok' | 'stale' | 'down' => {
    if (readAt === -Infinity) return 'down';
    return now() - readAt < STALE_READ_PERIODS * ports.refreshMs ? 'ok' : 'stale';
  };

  return {
    idle,
    busyWorkspaces: () => busyWorkspaces,
    goneTasks,
    agentSeen: seenRunning,
    readState,
    lastReadAt: () => (readAt === -Infinity ? undefined : readAt),
    agentSeenTasks: () => {
      const newer = new Set((ports.facts?.all() ?? []).filter((f) => f.at > readAt).map((f) => f.taskId));
      return newer.size === 0 ? agentTaskIds : new Map([...agentTaskIds].filter(([t]) => !newer.has(t)));
    },
    refresh: () => idle.fresh(),
  };
}
