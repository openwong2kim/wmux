// ─── "This ended task's agent was seen gone", kept across restarts ─────────
//
// The fan-out live cap and the agent budget free an ended task's slot only
// once its agent is known gone (#2387, #2393). That used to be known only
// from the last live read of the daemon's sessions, in memory: after a cold
// restart there was no read yet, or the daemon could not answer while it
// recovered its WSL sessions, and every ended task counted as live again.
//
// A fact is written when a good read sees an ended task's workspace with no
// agent left, when the task's panes are gone (its workspace closed), and when
// the task is closed with its panes stopped. It names the sessions the task's
// workspace held then and when it was seen, under
// `<wmuxDir>/factory/agent-gone.json`.
//
// Updates are one-way: a live read may add a fact, and missing or failed data
// never removes one. A fact is cleared only when the task really runs again:
// its row goes back to an open status, its reclaim record becomes `resumed`,
// a new worker session is launched for it, or a good read sees an agent
// running in its workspace again. A task whose agent was running at shutdown
// has no fact, so it holds its slot until a read sees it exit.
//
// A file a newer version wrote means "no facts": nothing is written over it,
// and admission never fails for that reason. A file no version can read is
// moved aside, and facts are kept on disk again from then on.

import { holderInputsChanged } from './holderInputs';
import fs from 'node:fs';
import path from 'node:path';
import { atomicReadJSONSync } from '../../daemon/util/atomicWrite';
import { createFilePersister, readVersionedFile, type FilePersister } from './versionedFile';

export const AGENT_GONE_FILENAME = 'agent-gone.json';
export const AGENT_GONE_VERSION = 1 as const;
/** Facts kept (oldest dropped first). */
export const AGENT_GONE_MAX = 2000;
/** After an agent launch line is submitted in a pane, what the daemon says of
 *  that pane's agent may still be the previous one's: no fact names the pane
 *  until its new agent is seen running, or this long has passed. */
export const LAUNCH_SETTLE_MS = 2 * 60_000;

export interface AgentGoneFact {
  taskId: string;
  /** The task's workspace when its agent was seen gone. */
  taskWorkspaceId: string;
  /** The sessions that workspace held then ([]: its panes were gone). */
  sessions: string[];
  at: number;
}

function isFact(v: unknown): v is AgentGoneFact {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.taskId === 'string' && r.taskId.length > 0 && typeof r.taskWorkspaceId === 'string'
    && Array.isArray(r.sessions) && r.sessions.every((s) => typeof s === 'string')
    && typeof r.at === 'number' && Number.isFinite(r.at);
}

export class AgentGoneFacts {
  private readonly facts = new Map<string, AgentGoneFact>();
  private readonly persister: FilePersister;
  /** False once the file could not be read: facts then live in memory only. */
  private writable = true;
  private lastWrite: Promise<void> = Promise.resolve();
  /** When each task was last seen to run again (in memory): an observation
   *  started before that is stale and adds no fact. */
  private readonly taskRanAt = new Map<string, number>();
  /** Sessions an agent launch was submitted in, and when, until their new
   *  agent is seen running (in memory). */
  private readonly launchedAt = new Map<string, number>();
  /** The same, by the task a launched session is the worker of. */
  private readonly taskLaunchedAt = new Map<string, number>();

  constructor(
    private readonly file: string,
    private readonly warn: (line: string) => void = (l) => console.warn(l),
    private readonly now: () => number = Date.now,
    /** When the task's worker was last launched, on disk (workerSlots.ts):
     *  an observation that started before it is stale, across a restart too. */
    private readonly recordedLaunchAt: (taskId: string) => number | undefined = () => undefined,
  ) {
    this.persister = createFilePersister(file, () => ({ version: AGENT_GONE_VERSION, facts: [...this.facts.values()] }));
  }

  static at(wmuxDir: string, launchedAt?: (taskId: string) => number | undefined): AgentGoneFacts {
    return new AgentGoneFacts(path.join(wmuxDir, 'factory', AGENT_GONE_FILENAME), undefined, undefined, launchedAt);
  }

  /** Read the file (missing → none). One a newer version wrote leaves no
   *  facts and is never written over; one no version can read is moved
   *  aside, so a corrupt file does not stop facts from being kept for good.
   *  Never throws. */
  load(): void {
    this.facts.clear();
    try {
      const raw = readVersionedFile(this.file, AGENT_GONE_VERSION);
      const list = raw && Array.isArray(raw.facts) ? raw.facts : [];
      for (const f of list) if (isFact(f)) this.facts.set(f.taskId, { ...f, sessions: [...f.sessions] });
      this.writable = true;
    } catch (err) {
      if (this.newerVersionOnDisk()) {
        this.writable = false;
        this.warn(`[factory] agent-gone facts not read, none are kept on disk: ${String(err)}`);
        return;
      }
      try {
        fs.renameSync(this.file, `${this.file}.unreadable-${this.now()}`);
        this.writable = true;
        this.warn(`[factory] agent-gone facts unreadable, moved aside and started empty: ${String(err)}`);
      } catch (moveErr) {
        this.writable = false;
        this.warn(`[factory] agent-gone facts not read, none are kept on disk: ${String(err)}; ${String(moveErr)}`);
      }
    }
  }

  /** Whether what the reader recovers (the file, or its backup when the
   *  file is broken) names a version above this one's. */
  private newerVersionOnDisk(): boolean {
    try {
      const v = atomicReadJSONSync<{ version?: unknown }>(this.file)?.version;
      return typeof v === 'number' && v > AGENT_GONE_VERSION;
    } catch {
      return false;
    }
  }

  get(taskId: string): AgentGoneFact | null {
    const f = this.facts.get(taskId);
    return f ? { ...f, sessions: [...f.sessions] } : null;
  }

  all(): AgentGoneFact[] {
    return [...this.facts.values()].map((f) => ({ ...f, sessions: [...f.sessions] }));
  }

  /** Record that the task's agent was seen gone (`at`: when the observation
   *  started). One that started no later than the task or one of its
   *  sessions was last seen to run again is stale and dropped. A fact already
   *  held for the same workspace and sessions is kept as it is (no write). */
  note(fact: AgentGoneFact): void {
    if ((this.taskRanAt.get(fact.taskId) ?? -Infinity) >= fact.at) return;
    if ((this.recordedLaunchAt(fact.taskId) ?? -Infinity) >= fact.at) return;
    if (fact.sessions.some((s) => fact.at <= (this.launchedAt.get(s) ?? -Infinity) + LAUNCH_SETTLE_MS)) return;
    if (fact.at <= (this.taskLaunchedAt.get(fact.taskId) ?? -Infinity) + LAUNCH_SETTLE_MS) return;
    const prior = this.facts.get(fact.taskId);
    const sessions = [...new Set(fact.sessions)].sort();
    // The same fact again is kept as it is, unless the kept one predates the
    // task's last recorded launch (it says nothing of that worker): then the
    // newer observation replaces it.
    const priorStale = !!prior && (this.recordedLaunchAt(fact.taskId) ?? -Infinity) >= prior.at;
    if (prior && !priorStale && prior.taskWorkspaceId === fact.taskWorkspaceId && prior.sessions.length === sessions.length
      && prior.sessions.every((s, i) => s === sessions[i])) return;
    this.facts.delete(fact.taskId);
    this.facts.set(fact.taskId, { taskId: fact.taskId, taskWorkspaceId: fact.taskWorkspaceId, sessions, at: fact.at });
    while (this.facts.size > AGENT_GONE_MAX) {
      const oldest = this.facts.keys().next();
      if (oldest.done) break;
      this.facts.delete(oldest.value);
    }
    this.persist();
  }

  /** The task runs again (`why` is logged): its fact goes, and a read that
   *  started before now adds none. */
  clear(taskId: string, why: string, at: number = this.now()): void {
    remember(this.taskRanAt, taskId, at);
    if (!this.facts.delete(taskId)) return;
    console.log(`[factory] agent-gone fact cleared for ${taskId}: ${why}`);
    this.persist();
  }

  /** A read that started at `at` saw the task's agent running. A fact
   *  recorded after that read started (a close that stopped the panes while
   *  it was answered) is newer and stays. */
  seenRunning(taskId: string, at: number): void {
    const launched = this.taskLaunchedAt.get(taskId);
    if (launched !== undefined && launched < at) this.taskLaunchedAt.delete(taskId);
    const f = this.facts.get(taskId);
    if (f && f.at > at) return;
    this.clear(taskId, 'an agent was seen running in its workspace', at);
  }

  /** An agent launch line was submitted in a session (a resume typed into
   *  the pane): a fact naming that session goes, and none names it again
   *  until its new agent is seen running (sessionAgentSeen) or
   *  LAUNCH_SETTLE_MS has passed. */
  /** A worker session was launched for the task (a respawn or a resume):
   *  no read adds a fact for it until its agent is seen running or
   *  LAUNCH_SETTLE_MS has passed. */
  taskLaunched(taskId: string, at: number = this.now()): void {
    remember(this.taskLaunchedAt, taskId, at);
  }

  sessionLaunched(sessionId: string, at: number = this.now(), taskId?: string): void {
    remember(this.launchedAt, sessionId, at);
    // The task the session is the worker of, wherever its workspace is now.
    if (taskId) {
      remember(this.taskLaunchedAt, taskId, at);
      this.clear(taskId, `an agent was launched in its worker session ${sessionId}`, at);
    }
    for (const f of [...this.facts.values()]) {
      if (f.sessions.includes(sessionId)) this.clear(f.taskId, `an agent was launched in ${sessionId}`, at);
    }
  }

  /** A read that started at `at` saw an agent running in the session: a
   *  launch there before that read is settled, and a later exit is a real
   *  one. A launch since is not. */
  sessionAgentSeen(sessionId: string, at: number): void {
    const launched = this.launchedAt.get(sessionId);
    if (launched !== undefined && launched < at) this.launchedAt.delete(sessionId);
  }

  /** Resolves once the writes scheduled so far are on disk (or failed). */
  written(): Promise<void> {
    return this.lastWrite;
  }

  private persist(): void {
    holderInputsChanged();
    if (!this.writable) return;
    this.lastWrite = this.persister.schedule().catch((err) => this.warn(`[factory] agent-gone facts not written: ${String(err)}`));
  }
}

/** Never moves back; bounded like the facts, the oldest entry going first. */
function remember(map: Map<string, number>, key: string, at: number): void {
  const prior = map.get(key);
  map.delete(key);
  map.set(key, prior !== undefined && prior > at ? prior : at);
  while (map.size > AGENT_GONE_MAX) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

let hosted: AgentGoneFacts | null = null;

/** Set by the worker lifecycle host (null: none). */
export function setAgentGoneFacts(next: AgentGoneFacts | null): void {
  hosted = next;
}

/** A new worker session was launched for `taskId` (a respawn or a resume):
 *  its agent runs again, so a fact that says it is gone goes. Never throws. */
export function noteTaskWorkerLaunched(taskId: string): void {
  try {
    // The new agent is not seen running yet: no read adds a fact for the
    // task until it is, or LAUNCH_SETTLE_MS has passed (as sessionLaunched).
    hosted?.taskLaunched(taskId);
    hosted?.clear(taskId, 'a new worker session was launched');
  } catch {
    /* best effort: the next good read decides */
  }
}

/** A task closed with its worktree's panes stopped (TaskCloseService): its
 *  agent is gone. Never throws. */
export function noteTaskPanesStopped(taskId: string, taskWorkspaceId: string, sessionIds: readonly string[], at: number = Date.now()): void {
  try {
    hosted?.note({ taskId, taskWorkspaceId, sessions: [...sessionIds], at });
  } catch {
    /* best effort: the next good read decides */
  }
}

/** Sessions an agent launch line was typed into without Enter
 *  (pty:write-launch, submit false): the Enter the owner types later starts it. */
const stagedLaunches = new Map<string, string | undefined>();
const STAGED_LAUNCHES_MAX = 200;

/** An agent launch line was typed into `sessionId` (pty:write-launch):
 *  submitted, or staged for the owner's Enter. Either way the facts of the
 *  session, and of `taskId` (the task it is the worker of, when its record
 *  says), go and the launch window starts; a staged one starts again at that
 *  Enter (noteSessionInput). Never throws. */
export function noteSessionAgentLaunched(sessionId: string, submitted: boolean, taskId?: string): void {
  try {
    stagedLaunches.delete(sessionId);
    if (!submitted) {
      stagedLaunches.set(sessionId, taskId);
      while (stagedLaunches.size > STAGED_LAUNCHES_MAX) {
        const oldest = stagedLaunches.keys().next();
        if (oldest.done) break;
        stagedLaunches.delete(oldest.value);
      }
    }
    hosted?.sessionLaunched(sessionId, undefined, taskId);
  } catch {
    /* best effort: the next good read decides */
  }
}

/** Input typed into a session (pty:write): an Enter in one holding a staged
 *  launch line submits it. Cheap when none is staged. Never throws. */
export function noteSessionInput(sessionId: string, data: string): void {
  if (stagedLaunches.size === 0 || !stagedLaunches.has(sessionId) || !data.includes('\r')) return;
  const taskId = stagedLaunches.get(sessionId);
  stagedLaunches.delete(sessionId);
  try {
    hosted?.sessionLaunched(sessionId, undefined, taskId);
  } catch {
    /* best effort: the next good read decides */
  }
}
