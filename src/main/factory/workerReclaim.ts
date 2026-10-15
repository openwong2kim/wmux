// ─── A bot worker whose task ended stops holding memory, and can resume ────
//
// An interactive worker CLI stays resident after its last answer, with its
// MCP servers, until someone stops it. Once the task a bot started has ENDED
// in the ledger — `completed` (main's own gate passed, or the bot or the
// owner completed it), `failed` or `cancelled` — main stops that worker's
// agent (until then the agent budget counts it as live):
//   - the daemon stops the pane's verified claude and everything below it
//     (daemon/agentStop.ts); the worktree and the ledger row stay;
//   - before the stop main records, per worker pane, the conversation the
//     agent was running (the daemon's resume binding: session id, folder,
//     permission mode) in `<wmuxDir>/factory/reclaimed-workers.json`;
//   - one system card in the task's thread says the worker is done and
//     resumable;
//   - then the task is cleared: its task workspace closes (shells and
//     scrollback with it) through the renderer's workspace.close, once no
//     agent or command runs in any of its panes. A `failed` task keeps its
//     workspace until the owner has looked at it (the evidence is there), and
//     a workspace the owner is viewing closes only after they move away.
//     Only the task's own workspace is ever closed (createWorkerClear).
// A task that was reported for review (`review_requested`) and whose worker
// then sat idle (its turn ended, nothing typed since) for REPORTED_IDLE_MS has
// its worker's agent stopped and recorded the same way, so a report whose
// gate did not complete it (refused, failed) holds no memory and no agent
// slot. The task stays `review_requested` and its workspace stays open:
// closing that workspace closes the task's mission, which cancels the task.
// Resume continues the same conversation in the same pane. A record made for
// a report follows the task when it later ends (no second stop, no second
// card); a task that moved on from the report (sent back, a newer report)
// before the stop has nothing stopped.
// Never on anything else: a row that is working or needs input keeps its
// worker however long it is quiet, and a task the owner stopped is left to
// that stop (factoryStop.ts ends its panes itself).
//
// Resume (the owner's Resume, or the bot that started the task) types
// `claude --resume <that session> [its permission flag]` into the same pane,
// in the same folder, through the bot worker launch guard
// (agents/botWorkerMergeGuard.ts guardSessionLaunch: a bot worker's line
// carries its settings file or is not typed). Only into the recorded pane,
// only while it still runs in the recorded folder and no agent runs in it.
// When the pane is gone (the task was cleared), a new task workspace is
// opened in the recorded worktree through the bot worker spawn
// (FanOutService.spawnBotTaskPane: lineage stamp, launch guard, worker
// permission lists) with that line as its launch; a worktree that is gone is
// refused.
//
// At install every task that ended in the last day and was never reclaimed
// is reclaimed now (an app restart between the end and the stop), and looked
// at again a few times while the daemon may still be connecting. A resumed
// worker counts as live again until its agent exits.

import fs from 'node:fs';
import path from 'node:path';
import type { LedgerEntry } from '../../shared/ledger';
import { taskThreadOf, type ThreadId } from '../../shared/room';
import { isPlausibleResumeSessionId, normalizeResumeCwd, permissionFlagFor, type PermissionMode } from '../../shared/agentResume';
import { sessionsStartedIn } from '../worktask/stopSessionsInDir';
import { createFilePersister, readVersionedFile, type FilePersister } from './versionedFile';
import { STOPPED_BY_OWNER } from './factoryStop';

export const RECLAIMED_WORKERS_FILENAME = 'reclaimed-workers.json';
export const RECLAIMED_WORKERS_VERSION = 1 as const;
/** How far back an ended task is reclaimed at install. */
export const RECLAIM_CATCHUP_MS = 24 * 3_600_000;
/** How long a reported task's worker sits idle before it is stopped. */
export const REPORTED_IDLE_MS = 5 * 60_000;
/** A pane whose turn status main has not seen (as after a restart) counts
 *  as idle only once its task was reported this long ago. */
export const REPORTED_UNSEEN_IDLE_MS = 30 * 60_000;
/** Records kept (oldest dropped first). */
export const RECLAIMED_WORKERS_MAX = 500;
/** How long a resume waits for the relaunched agent before a message. */
export const RESUME_AGENT_WAIT_MS = 60_000;
export const RESUME_MESSAGE_MAX = 4000;

const PERMISSION_MODES: ReadonlySet<string> = new Set(['bypassPermissions', 'acceptEdits', 'plan', 'auto', 'default']);

/** One worker pane of a reclaimed task. */
export interface ReclaimedSession {
  /** The daemon session (the pane's pty id). */
  sessionId: string;
  /** The folder the pane was started in (its spawn cwd). */
  cwd: string;
  /** The claude conversation the worker ran, when the daemon knew it. */
  resumeSessionId?: string;
  permissionMode?: PermissionMode;
}

export interface ReclaimedWorker {
  taskId: string;
  botId: string;
  ownerWorkspaceId: string;
  taskWorkspaceId: string;
  title: string;
  /** The task's room thread (taskThreadOf at the reclaim). */
  threadId: ThreadId;
  /** The ledger status the task ended in; `reported`: the task was still
   *  `review_requested` (open) when its idle worker was stopped. */
  ended: 'completed' | 'cancelled' | 'failed' | 'reported';
  sessions: ReclaimedSession[];
  /** stopping: recorded, its agent not yet known to be stopped (a later look
   *  tries again; it still counts as live); stopped: the agent was stopped
   *  (or none ran); resumed: relaunched. */
  state: 'stopping' | 'stopped' | 'resumed';
  at: number;
  /** The workspace the worker's pane lives in when a resume opened a new
   *  one (absent: taskWorkspaceId). */
  paneWorkspaceId?: string;
  /** When the owner was first seen viewing the task's workspace after it
   *  ended (a `failed` task is cleared only after this). */
  seenAt?: number;
  /** The ledger rev of the end this record was made for (absent: older
   *  records, compared by time). */
  endRev?: number;
}

/** The workspace a reclaimed worker's pane lives in. Pure. */
export function workerWorkspaceOf(rec: Pick<ReclaimedWorker, 'taskWorkspaceId' | 'paneWorkspaceId'>): string {
  return rec.paneWorkspaceId || rec.taskWorkspaceId;
}

/** The daemon session fields this module reads (daemon.listSessions). */
export interface WorkerSessionInfo {
  id: string;
  pid?: number;
  spawnCwd?: string;
  /** The pane's live directory (OSC 7): where a typed line would run. */
  cwd?: string;
  agentProcessAlive?: boolean;
  /** OSC 133: a foreground command owns the pane (absent: unknown). */
  commandRunning?: boolean;
  resumeBinding?: { agent?: unknown; sessionId?: unknown; cwd?: unknown; permissionMode?: unknown };
}

/** Whether a ledger move ends a bot task this module reclaims. Pure. */
export function isReclaimableEnd(entry: LedgerEntry, to: string): to is 'completed' | 'cancelled' | 'failed' {
  const origin = entry.dispatch?.origin;
  if (origin?.kind !== 'bot' || typeof origin.botId !== 'string' || !origin.botId) return false;
  if (to !== 'completed' && to !== 'cancelled' && to !== 'failed') return false;
  // The owner's stop ends the task's panes itself.
  return !(to === 'cancelled' && entry.summary === STOPPED_BY_OWNER && entry.updatedBy.kind === 'system');
}

/** Whether a row is a bot task reported for review whose idle worker this
 *  module stops (a verify task is closed by its verdict instead). Pure. */
export function isReclaimableReport(entry: LedgerEntry): boolean {
  const d = entry.dispatch;
  return entry.status === 'review_requested'
    && d?.origin.kind === 'bot' && typeof d.origin.botId === 'string' && d.origin.botId.length > 0
    && d.preset !== 'verify';
}

/** The resume line for one recorded pane, or null without a conversation. Pure. */
export function resumeLineFor(s: ReclaimedSession): string | null {
  if (!s.resumeSessionId || !isPlausibleResumeSessionId('claude', s.resumeSessionId)) return null;
  const flag = permissionFlagFor(s.permissionMode);
  return `claude --resume ${s.resumeSessionId}${flag ? ` ${flag}` : ''}`;
}

/** The recorded pane fields of a live session. Pure. */
export function reclaimedSessionOf(s: WorkerSessionInfo): ReclaimedSession | null {
  if (!s.id || typeof s.spawnCwd !== 'string' || !s.spawnCwd) return null;
  const b = s.resumeBinding;
  const out: ReclaimedSession = { sessionId: s.id, cwd: s.spawnCwd };
  // A conversation is recorded only with the folder it was started in: one
  // started elsewhere (a `cd` before the launch) resumes only there.
  const sameFolder = typeof b?.cwd !== 'string' || !b.cwd || normalizeResumeCwd(b.cwd) === normalizeResumeCwd(s.spawnCwd);
  if (b && sameFolder && b.agent === 'claude' && typeof b.sessionId === 'string' && isPlausibleResumeSessionId('claude', b.sessionId)) {
    out.resumeSessionId = b.sessionId;
    if (typeof b.permissionMode === 'string' && PERMISSION_MODES.has(b.permissionMode)) out.permissionMode = b.permissionMode as PermissionMode;
  }
  return out;
}

function isRecord(v: unknown): v is ReclaimedWorker {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.taskId === 'string' && typeof r.botId === 'string' && typeof r.ownerWorkspaceId === 'string'
    && typeof r.taskWorkspaceId === 'string' && typeof r.title === 'string' && typeof r.threadId === 'string'
    && (r.ended === 'completed' || r.ended === 'cancelled' || r.ended === 'failed' || r.ended === 'reported') && (r.state === 'stopping' || r.state === 'stopped' || r.state === 'resumed')
    && typeof r.at === 'number' && Array.isArray(r.sessions)
    && r.sessions.every((s) => !!s && typeof (s as ReclaimedSession).sessionId === 'string' && typeof (s as ReclaimedSession).cwd === 'string')
    && (r.paneWorkspaceId === undefined || typeof r.paneWorkspaceId === 'string')
    && (r.seenAt === undefined || typeof r.seenAt === 'number')
    && (r.endRev === undefined || typeof r.endRev === 'number');
}

/** The reclaimed workers, persisted under `<wmuxDir>/factory/`. */
export class ReclaimedWorkers {
  private readonly records = new Map<string, ReclaimedWorker>();
  private readonly persister: FilePersister;

  constructor(private readonly file: string) {
    this.persister = createFilePersister(file, () => ({ version: RECLAIMED_WORKERS_VERSION, workers: [...this.records.values()] }));
  }

  static at(wmuxDir: string): ReclaimedWorkers {
    return new ReclaimedWorkers(path.join(wmuxDir, 'factory', RECLAIMED_WORKERS_FILENAME));
  }

  /** Read the file (missing → empty). A file of another version throws. */
  load(): void {
    this.records.clear();
    const raw = readVersionedFile(this.file, RECLAIMED_WORKERS_VERSION);
    const list = raw && Array.isArray(raw.workers) ? raw.workers : [];
    for (const r of list) if (isRecord(r)) this.records.set(r.taskId, r);
  }

  get(taskId: string): ReclaimedWorker | null {
    const r = this.records.get(taskId);
    return r ? { ...r, sessions: r.sessions.map((s) => ({ ...s })) } : null;
  }

  all(): ReclaimedWorker[] {
    return [...this.records.values()].map((r) => ({ ...r, sessions: r.sessions.map((s) => ({ ...s })) }));
  }

  put(rec: ReclaimedWorker): Promise<void> {
    const prior = this.records.get(rec.taskId);
    this.records.delete(rec.taskId);
    this.records.set(rec.taskId, rec);
    if (prior && prior.state !== rec.state) this.notifyState(rec, prior.state, rec.state, rec.at);
    // Oldest first, never a live worker (resumed, or not yet stopped).
    for (const [id, r] of this.records) {
      if (this.records.size <= RECLAIMED_WORKERS_MAX) break;
      if (r.state === 'stopped') this.records.delete(id);
    }
    return this.persister.schedule();
  }

  remove(taskId: string): Promise<void> {
    if (!this.records.delete(taskId)) return Promise.resolve();
    return this.persister.schedule();
  }

  /** Told of every state change made through setState (the agent budget
   *  counts a resumed worker's run from these). */
  onStateChange: ((rec: { taskId: string; botId: string }, from: ReclaimedWorker['state'], to: ReclaimedWorker['state'], at: number) => void) | null = null;

  private notifyState(r: ReclaimedWorker, from: ReclaimedWorker['state'], to: ReclaimedWorker['state'], at: number): void {
    try {
      this.onStateChange?.({ taskId: r.taskId, botId: r.botId }, from, to, at);
    } catch (err) {
      console.warn(`[factory] reclaimed worker state listener threw: ${String(err)}`);
    }
  }

  /** The task's ended row moved to another workspace (a system write that
   *  bumps its rev, not a new end): the end this record was made for is now
   *  at `to`. Only when it was made for `from`. */
  advanceEndRev(taskId: string, from: number, to: number): void {
    const r = this.records.get(taskId);
    if (!r || r.endRev !== from || to === from) return;
    r.endRev = to;
    void this.persister.schedule().catch((err) => console.warn(`[factory] reclaimed workers not written: ${String(err)}`));
  }

  setState(taskId: string, state: ReclaimedWorker['state'], at: number): boolean {
    const r = this.records.get(taskId);
    if (!r || r.state === state) return false;
    const from = r.state;
    r.state = state;
    r.at = at;
    this.notifyState(r, from, state, at);
    void this.persister.schedule().catch((err) => console.warn(`[factory] reclaimed workers not written: ${String(err)}`));
    return true;
  }

  /** The owner looked at the task's workspace (once; false when already). */
  markSeen(taskId: string, at: number): boolean {
    const r = this.records.get(taskId);
    if (!r || r.seenAt !== undefined) return false;
    r.seenAt = at;
    void this.persister.schedule().catch((err) => console.warn(`[factory] reclaimed workers not written: ${String(err)}`));
    return true;
  }

  /** A resume opened a new pane for the task: it is the worker's pane now. */
  movePane(taskId: string, workspaceId: string, session: ReclaimedSession): Promise<void> {
    const r = this.records.get(taskId);
    if (!r) return Promise.resolve();
    r.paneWorkspaceId = workspaceId;
    r.sessions = [{ ...session }];
    return this.persister.schedule();
  }

  /** The task whose recorded pane `sessionId` is, or null. */
  taskOfSession(sessionId: string): string | null {
    for (const r of this.records.values()) if (r.sessions.some((s) => s.sessionId === sessionId)) return r.taskId;
    return null;
  }
}

export interface WorkerReclaimPorts {
  onTransition: (fn: (t: { entry: LedgerEntry; from: string | null; to: string }) => void) => () => void;
  /** Every ledger row, read once at install (catch-up). */
  allRows?: () => LedgerEntry[];
  /** The task's ledger row now: a row that reopened (failed → working)
   *  while the reclaim waited has nothing stopped. Absent: not re-read. */
  row?: (taskId: string) => LedgerEntry | null;
  store: ReclaimedWorkers;
  worktreeOf: (entry: LedgerEntry) => Promise<string | null>;
  listSessions: () => Promise<WorkerSessionInfo[]>;
  /** daemon `session.stopAgent`. */
  stopAgent: (sessionId: string) => Promise<{ ok?: boolean; stopped?: boolean; code?: string }>;
  note?: (workspaceId: string, threadId: ThreadId, title: string, body: string) => void;
  /** The Bots page re-reads (BOT_EVENT). */
  changed?: () => void;
  now?: () => number;
  log?: (msg: string) => void;
  /** Look again this often for recent ends that were not reclaimed (the
   *  daemon was not connected yet) and for reported tasks gone idle; each
   *  task at most RECLAIM_ATTEMPTS_MAX times per rev. Absent: only at install. */
  retryMs?: number;
  /** Whether the turn of every pane in the task's workspace has ended (no
   *  agent turn running or waiting on a prompt). Absent: a reported task's
   *  worker is never stopped. */
  turnEnded?: (entry: LedgerEntry) => boolean;
  /** How long a reported task sits before its idle worker is stopped
   *  (default REPORTED_IDLE_MS). */
  reportedIdleMs?: number;
  /** The panes a workspace owns, null when not known. A reported task's
   *  stop reaches only its own workspace's panes (whose turns turnEnded
   *  checked), never another pane opened in its folder; unknown: nothing is
   *  stopped. Absent: every pane started in the folder, as for an end. */
  workspacePanes?: (workspaceId: string) => readonly string[] | null;
}

/** Attempts per ended task before the reclaim gives it up. */
export const RECLAIM_ATTEMPTS_MAX = 3;

/** Whether the task moved on from the state its worker is being stopped
 *  for. An end: its row is open again (it reopened since it ended); a row
 *  that cannot be read is not counted as open. A report: its row is no
 *  longer that report (another status or rev, unreadable) or a turn runs
 *  again in its panes. Pure over its reads. */
function movedOn(ports: Pick<WorkerReclaimPorts, 'row' | 'turnEnded'>, entry: LedgerEntry, ended: ReclaimedWorker['ended']): boolean {
  if (ended === 'reported' && !ports.row) return false;
  let now: LedgerEntry | null = null;
  try {
    now = ports.row?.(entry.id) ?? null;
  } catch {
    now = null;
  }
  if (ended === 'reported') {
    if (!now || now.status !== 'review_requested' || now.rev !== entry.rev) return true;
    try {
      return ports.turnEnded?.(now) === false;
    } catch {
      return true;
    }
  }
  return !!now && (now.status === 'working' || now.status === 'input_required' || now.status === 'review_requested');
}

/**
 * Stop the worker of one ended bot task and record how to resume it. Never
 * throws; the record, or null when nothing was recorded (no worktree, no
 * pane started in it, a stop the daemon refused, or a task that reopened).
 * A record whose stops did not all succeed stays `stopping` (still live) and
 * is tried again.
 */
export async function reclaimWorker(ports: WorkerReclaimPorts, entry: LedgerEntry, ended: ReclaimedWorker['ended']): Promise<ReclaimedWorker | null> {
  const log = ports.log ?? ((m: string) => console.warn(m));
  const now = ports.now ?? Date.now;
  try {
    const worktree = await ports.worktreeOf(entry);
    if (!worktree) {
      log(`[factory] reclaim: the worktree of ${entry.id} is not known; its worker keeps running`);
      return null;
    }
    const sessions = await ports.listSessions();
    const ids = new Set(await sessionsStartedIn([worktree], { listSessions: async () => sessions }));
    if (ended === 'reported' && ports.workspacePanes) {
      let own: readonly string[] | null = null;
      try {
        own = ports.workspacePanes(entry.taskWorkspaceId);
      } catch {
        own = null;
      }
      if (!own) return null;
      for (const id of [...ids]) if (!own.includes(id)) ids.delete(id);
    }
    const panes = sessions.filter((s) => ids.has(s.id)).map(reclaimedSessionOf).filter((s): s is ReclaimedSession => !!s);
    if (movedOn(ports, entry, ended)) return null;
    const prior = ports.store.get(entry.id);
    // Stopped already for a report, and no agent runs in its panes since:
    // the record follows the task (a gate written after the stop, the end
    // that came later), with no second stop and no second card.
    if (prior?.ended === 'reported' && prior.state === 'stopped' && !sessions.some((s) => ids.has(s.id) && s.agentProcessAlive === true)) {
      await ports.store.put({ ...prior, ended, endRev: entry.rev, at: now() });
      ports.changed?.();
      return ports.store.get(entry.id);
    }
    // An earlier attempt that did not finish: its recorded conversations are
    // kept (a stopped agent may no longer show its binding).
    const kept = prior?.state === 'stopping' ? prior.sessions : [];
    for (const p of panes) {
      const old = kept.find((k) => k.sessionId === p.sessionId);
      if (!p.resumeSessionId && old?.resumeSessionId) {
        p.resumeSessionId = old.resumeSessionId;
        if (old.permissionMode) p.permissionMode = old.permissionMode;
      }
    }
    const rec: ReclaimedWorker = {
      taskId: entry.id,
      botId: entry.dispatch?.origin.botId ?? '',
      ownerWorkspaceId: entry.ownerWorkspaceId,
      taskWorkspaceId: entry.taskWorkspaceId,
      title: entry.title,
      threadId: taskThreadOf(entry),
      ended,
      sessions: [...panes, ...kept.filter((k) => !panes.some((p) => p.sessionId === k.sessionId))],
      // No pane left in the worktree: nothing to stop.
      state: panes.length === 0 ? 'stopped' : 'stopping',
      at: now(),
      endRev: entry.rev,
      ...(prior?.paneWorkspaceId ? { paneWorkspaceId: prior.paneWorkspaceId } : {}),
    };
    // On disk before anything is stopped: a stopped worker always has its
    // conversation recorded. A write that fails stops nothing.
    try {
      await ports.store.put(rec);
    } catch (err) {
      await ports.store.remove(entry.id).catch(() => undefined);
      log(`[factory] reclaim: ${entry.id} not recorded, its worker keeps running: ${String(err)}`);
      return null;
    }
    // No pane left in the worktree: recorded so it no longer counts as a
    // live worker.
    if (panes.length === 0) return rec;
    let failed = 0;
    let attempted = 0;
    for (const p of panes) {
      // The task reopened (or moved on from its report) meanwhile: what
      // still runs is its worker again.
      if (movedOn(ports, entry, ended)) break;
      attempted++;
      try {
        const r = await ports.stopAgent(p.sessionId);
        if (r.ok !== true) {
          failed++;
          log(`[factory] reclaim: the agent of ${p.sessionId} (task ${entry.id}) was not stopped: ${r.code ?? 'refused'}`);
        }
      } catch (err) {
        failed++;
        log(`[factory] reclaim: the agent of ${p.sessionId} (task ${entry.id}) was not stopped: ${String(err)}`);
      }
    }
    if (attempted === 0) {
      // Reopened before any stop: nothing was stopped, the record is as it was.
      await (prior ? ports.store.put(prior) : ports.store.remove(entry.id)).catch(() => undefined);
      return null;
    }
    if (failed === attempted && !prior) {
      // Nothing was stopped: no record, so a later look tries again.
      await ports.store.remove(entry.id).catch(() => undefined);
      return null;
    }
    // Stopped only once every pane's stop succeeded; else it stays
    // `stopping` (still live for the agent budget) and a later look retries.
    if (failed > 0) return ports.store.get(entry.id);
    ports.store.setState(entry.id, 'stopped', now());
    // Reopened part way: the conversation stays recorded, no card (the
    // task is open again, and its open row counts what still runs).
    if (attempted < panes.length) return ports.store.get(entry.id);
    const resumable = panes.some((p) => resumeLineFor(p) !== null);
    const pane = ended === 'failed'
      ? 'Its pane stays open until you have looked at it, then closes.'
      : 'Its pane closes.';
    try {
      if (ended === 'reported') {
        ports.note?.(
          entry.ownerWorkspaceId,
          taskThreadOf(entry),
          resumable ? 'Worker paused (resumable)' : 'Worker paused',
          resumable
            ? 'The task is reported for review and its worker sat idle: its Claude stopped to free memory and its agent slot. The task stays open for review and its pane stays; the worktree and the conversation are kept, and Resume continues the same conversation.'
            : 'The task is reported for review and its worker sat idle: its Claude stopped to free memory and its agent slot. The task stays open for review and its pane stays; the worktree is kept, but no conversation was recorded to resume.',
        );
      } else {
        ports.note?.(
          entry.ownerWorkspaceId,
          taskThreadOf(entry),
          resumable ? 'Worker done (resumable)' : 'Worker done',
          resumable
            ? `Task ${ended}: its Claude stopped to free memory. ${pane} The worktree and the conversation are kept; Resume continues the same conversation.`
            : `Task ${ended}: its Claude stopped to free memory. ${pane} The worktree is kept; no conversation was recorded to resume.`,
        );
      }
    } catch {
      /* the card is best effort */
    }
    ports.changed?.();
    return ports.store.get(entry.id);
  } catch (err) {
    log(`[factory] reclaim of ${entry.id} failed: ${String(err)}`);
    return null;
  }
}

/** Whether a record already covers this end of the task: stopped, or
 *  resumed after it. A `stopping` record is tried again, and so is a task
 *  that reopened and ended again since (a newer rev). Pure. */
export function isReclaimedSince(rec: ReclaimedWorker | null, entry: Pick<LedgerEntry, 'updatedAt' | 'rev'>): boolean {
  if (!rec || rec.state === 'stopping') return false;
  return rec.endRev !== undefined ? rec.endRev >= entry.rev : rec.at >= entry.updatedAt;
}

/** Install the reclaim on bot task ends. Returns the unsubscribe. */
export function installWorkerReclaim(ports: WorkerReclaimPorts): () => void {
  const now = ports.now ?? Date.now;
  const inFlight = new Set<string>();
  const attempts = new Map<string, number>();
  const run = (entry: LedgerEntry, ended: ReclaimedWorker['ended']): void => {
    if (inFlight.has(entry.id) || isReclaimedSince(ports.store.get(entry.id), entry)) return;
    // Per end: a task that reopened and ended again is tried afresh.
    const key = `${entry.id}@${entry.rev}`;
    const n = attempts.get(key) ?? 0;
    if (n >= RECLAIM_ATTEMPTS_MAX) return;
    attempts.set(key, n + 1);
    inFlight.add(entry.id);
    void reclaimWorker(ports, entry, ended).finally(() => inFlight.delete(entry.id));
  };
  const off = ports.onTransition((t) => {
    if (isReclaimableEnd(t.entry, t.to)) run(t.entry, t.to);
  });
  const turnEndedIn = (e: LedgerEntry): boolean => {
    try {
      return ports.turnEnded?.(e) === true;
    } catch {
      return false;
    }
  };
  const catchUp = (): void => {
    let rows: LedgerEntry[] = [];
    try {
      rows = ports.allRows?.() ?? [];
    } catch {
      rows = [];
    }
    const at = now();
    const since = at - RECLAIM_CATCHUP_MS;
    const idleSince = at - (ports.reportedIdleMs ?? REPORTED_IDLE_MS);
    for (const e of rows) {
      if (e.updatedAt >= since && isReclaimableEnd(e, e.status)) run(e, e.status as 'completed' | 'cancelled' | 'failed');
      else if (ports.turnEnded && e.updatedAt <= idleSince && isReclaimableReport(e) && turnEndedIn(e)) run(e, 'reported');
    }
  };
  catchUp();
  let timer: ReturnType<typeof setInterval> | null = null;
  if (ports.retryMs && ports.retryMs > 0) {
    timer = setInterval(catchUp, ports.retryMs);
    timer.unref?.();
  }
  return () => {
    off();
    if (timer) clearInterval(timer);
  };
}

// ── Resume ──────────────────────────────────────────────────────────────────

export type WorkerResumeCode =
  | 'not_reclaimed'
  | 'not_yours'
  | 'no_conversation'
  | 'pane_gone'
  | 'moved'
  | 'already_running'
  | 'not_typed'
  | 'busy'
  | 'unknown_state'
  | 'operator_only'
  | 'invalid_argument'
  | 'not_started'
  | 'worktree_gone'
  | 'not_reopened'
  | 'not_now';

export type WorkerResumeResult =
  | {
      ok: true;
      taskId: string;
      sessionId: string;
      resumeSessionId: string;
      /** The workspace the resumed worker runs in (a new one when its pane
       *  was cleared). */
      workspaceId: string;
      messageDelivered?: boolean;
    }
  | { ok: false; code: WorkerResumeCode; message: string };

/** What a resume asks for when the worker's pane is gone. */
export interface WorkerRespawnInput {
  taskId: string;
  botId: string;
  ownerWorkspaceId: string;
  title: string;
  /** The recorded worktree (the pane's spawn folder). */
  cwd: string;
  /** The resume line (resumeLineFor). */
  line: string;
  permissionMode?: PermissionMode;
}

export interface WorkerResumePorts {
  store: ReclaimedWorkers;
  listSessions: () => Promise<WorkerSessionInfo[]>;
  /** Type the launch line + Enter into the pane through the bot worker
   *  launch guard; false when nothing was typed. */
  typeLine: (sessionId: string, line: string) => boolean;
  /** Whether the pane's agent runs (process truth), for a message. */
  agentAlive?: (sessionId: string) => Promise<boolean>;
  /** Deliver a message to the relaunched agent (waits while someone types). */
  submit?: (sessionId: string, text: string) => Promise<boolean>;
  /** daemon `session.stopAgent`, for the stop of a resumed worker. */
  stopAgent?: (sessionId: string) => Promise<{ ok?: boolean; stopped?: boolean; code?: string }>;
  /** Open a new task workspace in the recorded worktree with the resume line
   *  as its launch, through the bot worker spawn. Absent: a resume whose pane
   *  is gone is refused. */
  respawn?: (input: WorkerRespawnInput) => Promise<{ ok: true; workspaceId: string; sessionId: string } | { ok: false; message: string }>;
  /** Name the worker's workspace as the task's in its ledger row (a system
   *  write, nothing when it names it already), so the worker there reads and
   *  moves its own task: the row's rev before and after, or null when it
   *  could not be written. */
  rebindTask?: (taskId: string, workspaceId: string) => Promise<{ from: number; to: number } | null>;
  /** Whether a folder exists (default: fs). */
  folderExists?: (dir: string) => boolean;
  note?: (workspaceId: string, threadId: ThreadId, title: string, body: string) => void;
  changed?: () => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  agentWaitMs?: number;
  /** Whether the task was started from outside text (its dispatch taint;
   *  unknown counts as true). */
  taskTainted?: (taskId: string) => boolean;
  /** Whether the bot's running wake carried outside text (unknown: true). A
   *  bot's message from such a wake goes only to a task recorded as started
   *  from outside text. */
  senderTainted?: (botId: string) => boolean;
  /** Why the bot's own worker budget refuses one more worker now, or null
   *  (a bot's resume starts a worker like its fan-out does). `starting`:
   *  the bot's other resumes under way, not yet counted as resumed. */
  botWorkerRefusal?: (botId: string, starting: number) => string | null;
  /** Whether the owner stopped this task (Stop, or bots switched off): a
   *  bot does not start its worker again. Absent: never. */
  stoppedByOwner?: (taskId: string) => boolean;
}

/** The bot's resumed workers still live outside an open ledger row (the
 *  worker lifecycle host sets the count; 0 while it is not running).
 *  Without a bot id: every bot's. */
let resumedLiveCount: ((botId?: string) => number) | null = null;
export function setResumedLiveCount(fn: ((botId?: string) => number) | null): void {
  resumedLiveCount = fn;
}
export function resumedWorkersLive(botId?: string): number {
  return resumedLiveCount?.(botId) ?? 0;
}

/** Tasks whose resume is being typed now, or whose workspace is being
 *  cleared: one of either at a time per task. */
const resuming = new Set<string>();
const clearing = new Set<string>();
/** botId → its resumes past the budget check, until each is counted as
 *  resumed or ends. */
const botStarting = new Map<string, number>();

/** Bumped by every stop of resumed workers (all bots, or one): a resume
 *  that was under way when a stop ran launches nothing more. */
let stopAllSeq = 0;
const botStopSeq = new Map<string, number>();
function stopMark(botId: string): string {
  return `${stopAllSeq}:${botStopSeq.get(botId) ?? 0}`;
}

function refuse(code: WorkerResumeCode, message: string): WorkerResumeResult {
  return { ok: false, code, message };
}

/**
 * Relaunch the stopped worker of a reclaimed task with the same conversation,
 * in the same pane and folder. `by.botId`: only the bot that started the
 * task. A message (bots) is delivered once the agent is up.
 */
export async function resumeWorker(
  ports: WorkerResumePorts,
  taskId: string,
  by: { kind: 'owner' } | { kind: 'bot'; botId: string },
  message?: string,
  /** Called once the line is typed (a launch slot hands over to the
   *  resumed-worker count here). */
  onLaunched?: () => void,
): Promise<WorkerResumeResult> {
  if (resuming.has(taskId)) return refuse('busy', 'this worker is being resumed already');
  if (clearing.has(taskId)) return refuse('busy', 'this worker\'s pane is being closed; try again in a moment');
  resuming.add(taskId);
  const booking = { botId: '', done: true };
  const unbook = (): void => {
    if (booking.done) return;
    booking.done = true;
    const n = (botStarting.get(booking.botId) ?? 1) - 1;
    if (n > 0) botStarting.set(booking.botId, n);
    else botStarting.delete(booking.botId);
  };
  try {
    return await resumeOnce(ports, taskId, by, message, () => {
      unbook();
      onLaunched?.();
    }, (botId) => {
      booking.botId = botId;
      booking.done = false;
      botStarting.set(botId, (botStarting.get(botId) ?? 0) + 1);
    });
  } finally {
    unbook();
    resuming.delete(taskId);
  }
}

async function resumeOnce(
  ports: WorkerResumePorts,
  taskId: string,
  by: { kind: 'owner' } | { kind: 'bot'; botId: string },
  message: string | undefined,
  onLaunched: (() => void) | undefined,
  book: (botId: string) => void,
): Promise<WorkerResumeResult> {
  const rec = ports.store.get(taskId);
  if (!rec) return refuse('not_reclaimed', 'this task\'s worker was not stopped by wmux, so there is nothing to resume');
  if (by.kind === 'bot' && rec.botId !== by.botId) return refuse('not_yours', 'a bot resumes only the workers of tasks it started');
  if (by.kind === 'bot' && ports.stoppedByOwner?.(taskId) === true) {
    return refuse('not_now', 'the owner stopped this task; its worker is not started again by a bot');
  }
  if (rec.state === 'resumed') return refuse('already_running', 'this worker was resumed already');
  if (rec.state === 'stopping') return refuse('busy', 'this worker is still being stopped; try again in a moment');
  // Read in the same tick as the request: a stop of resumed workers from
  // here on ends this resume.
  const mark = stopMark(rec.botId);
  const stopped = (): boolean => stopMark(rec.botId) !== mark;
  if (by.kind === 'bot') {
    const text = typeof message === 'string' ? message.trim() : '';
    if (text && (ports.taskTainted?.(taskId) ?? true) === false && (ports.senderTainted?.(by.botId) ?? true) !== false) {
      return refuse('not_now', 'a message from a wake that carried outside text goes only to a task started from outside text; resume without a message, or write it from a clean wake');
    }
    let budget: string | null = null;
    try {
      budget = ports.botWorkerRefusal?.(by.botId, botStarting.get(by.botId) ?? 0) ?? null;
    } catch (err) {
      budget = `the worker budget could not be read: ${String(err)}`;
    }
    if (budget) return refuse('not_now', budget);
    // Counted against the bot's budget from here, in this same tick.
    book(by.botId);
  }
  const pane = rec.sessions.find((s) => resumeLineFor(s) !== null);
  const line = pane ? resumeLineFor(pane) : null;
  if (!pane || !line || !pane.resumeSessionId) return refuse('no_conversation', 'no conversation was recorded for this worker');
  const sessions = await ports.listSessions();
  if (stopped()) return refuse('not_now', 'the bot\'s work was stopped while this resume was under way');
  const live = sessions.find((s) => s.id === pane.sessionId);
  if (!live) return respawnOnce(ports, rec, pane, line, sessions, by, message, onLaunched, stopped);
  // Both the folder the pane was started in and the one its shell is in now
  // (a `cd` moves where a typed line runs) must be the task folder.
  const here = [live.spawnCwd, live.cwd].filter((d): d is string => typeof d === 'string' && d.length > 0);
  if (typeof live.spawnCwd !== 'string' || here.some((d) => normalizeResumeCwd(d) !== normalizeResumeCwd(pane.cwd))) {
    return refuse('moved', 'the worker\'s pane no longer runs in the task folder');
  }
  if (live.agentProcessAlive === true || live.commandRunning === true) {
    return refuse('already_running', 'an agent or another command is running in the worker\'s pane');
  }
  // No observed agent exit and no shell prompt seen: what runs there is not known.
  if (live.agentProcessAlive !== false && live.commandRunning !== false) {
    return refuse('unknown_state', 'what runs in the worker\'s pane cannot be told; open it and resume from there');
  }
  // A pane a resume opened earlier whose task was not moved to it then.
  if (!(await rebindTaskTo(ports, rec.taskId, workerWorkspaceOf(rec)))) {
    return refuse('not_reopened', 'the task could not be moved to the worker\'s pane; try again');
  }
  if (stopped()) return refuse('not_now', 'the bot\'s work was stopped while this resume was under way');
  let typed = false;
  try {
    typed = ports.typeLine(pane.sessionId, line);
  } catch {
    typed = false;
  }
  if (!typed) return refuse('not_typed', 'the resume line could not be typed into the worker\'s pane');
  return launched(ports, rec, pane.sessionId, pane.resumeSessionId, workerWorkspaceOf(rec), by, message, onLaunched, 'in the task folder');
}

/** The worker's pane is gone: open a new task workspace in the worktree. */
async function respawnOnce(
  ports: WorkerResumePorts,
  rec: ReclaimedWorker,
  pane: ReclaimedSession,
  line: string,
  sessions: readonly WorkerSessionInfo[],
  by: { kind: 'owner' } | { kind: 'bot'; botId: string },
  message: string | undefined,
  onLaunched: (() => void) | undefined,
  stopped: () => boolean,
): Promise<WorkerResumeResult> {
  if (!ports.respawn || !pane.resumeSessionId) return refuse('pane_gone', 'the worker\'s pane is closed');
  let exists = false;
  try {
    exists = (ports.folderExists ?? ((d: string) => fs.statSync(d).isDirectory()))(pane.cwd);
  } catch {
    exists = false;
  }
  if (!exists) return refuse('worktree_gone', 'the task\'s worktree is gone, so there is no folder to resume the worker in; start a new task instead');
  // Another pane already runs an agent in the worktree: a second process on
  // the same conversation is never started.
  const home = normalizeResumeCwd(pane.cwd);
  const busy = sessions.some((s) => s.agentProcessAlive === true
    && [s.spawnCwd, s.cwd].some((d) => typeof d === 'string' && d.length > 0 && normalizeResumeCwd(d) === home));
  if (busy) return refuse('already_running', 'an agent is already running in the task\'s worktree');
  if (stopped()) return refuse('not_now', 'the bot\'s work was stopped while this resume was under way');
  let r: Awaited<ReturnType<NonNullable<WorkerResumePorts['respawn']>>>;
  try {
    r = await ports.respawn({
      taskId: rec.taskId,
      botId: rec.botId,
      ownerWorkspaceId: rec.ownerWorkspaceId,
      title: rec.title,
      cwd: pane.cwd,
      line,
      ...(pane.permissionMode ? { permissionMode: pane.permissionMode } : {}),
    });
  } catch (err) {
    r = { ok: false, message: String(err) };
  }
  if (!r.ok) return refuse('not_reopened', `the worker's pane could not be opened again: ${r.message}`);
  await ports.store.movePane(rec.taskId, r.workspaceId, { ...pane, sessionId: r.sessionId }).catch((err) => {
    console.warn(`[factory] reclaimed workers not written: ${String(err)}`);
  });
  if (!(await rebindTaskTo(ports, rec.taskId, r.workspaceId))) {
    // A worker that cannot read or move its task does not run: its agent is
    // stopped once it is up, and a later resume (in this pane) tries again.
    await stopRelaunched(ports, rec.taskId, r.sessionId);
    return refuse('not_reopened', 'the task could not be moved to the worker\'s new pane; try again');
  }
  if (stopped()) {
    // The pane opened with the line as its launch after the stop ran: its
    // agent is stopped here once it is up.
    await stopRelaunched(ports, rec.taskId, r.sessionId);
    return refuse('not_now', 'the bot\'s work was stopped while this resume was under way');
  }
  return launched(ports, rec, r.sessionId, pane.resumeSessionId, r.workspaceId, by, message, onLaunched, 'in a new pane in the task worktree');
}

/** The task's ledger row names `workspaceId` (written now when it named
 *  another); the reclaim record's end follows the row's new rev. True
 *  without the port. */
async function rebindTaskTo(ports: WorkerResumePorts, taskId: string, workspaceId: string): Promise<boolean> {
  if (!ports.rebindTask) return true;
  const r = await ports.rebindTask(taskId, workspaceId).catch(() => null);
  if (!r) return false;
  ports.store.advanceEndRev(taskId, r.from, r.to);
  return true;
}

/** Wait (bounded) for an agent a resume launched after a stop, then stop it.
 *  Until that stop succeeds the worker counts as resumed (live), so a later
 *  stop reaches it. */
async function stopRelaunched(ports: WorkerResumePorts, taskId: string, sessionId: string): Promise<void> {
  const now = ports.now ?? Date.now;
  ports.store.setState(taskId, 'resumed', now());
  ports.changed?.();
  if (!ports.stopAgent) return;
  const sleep = ports.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (ports.agentWaitMs ?? RESUME_AGENT_WAIT_MS);
  while (now() < deadline) {
    if (await (ports.agentAlive?.(sessionId) ?? Promise.resolve(true)).catch(() => false)) break;
    await sleep(1000);
  }
  // Stopped only when an agent was found and stopped: a launch not seen yet
  // stays resumed (live), for the exit sweep or a later stop.
  const r = await ports.stopAgent(sessionId).catch(() => null);
  if (r?.ok === true && r.stopped === true && ports.store.setState(taskId, 'stopped', now())) ports.changed?.();
}

/** The line runs: mark the worker resumed, then deliver the message. */
async function launched(
  ports: WorkerResumePorts,
  rec: ReclaimedWorker,
  sessionId: string,
  resumeSessionId: string,
  workspaceId: string,
  by: { kind: 'owner' } | { kind: 'bot'; botId: string },
  message: string | undefined,
  onLaunched: (() => void) | undefined,
  where: string,
): Promise<WorkerResumeResult> {
  const now = ports.now ?? Date.now;
  ports.store.setState(rec.taskId, 'resumed', now());
  onLaunched?.();
  try {
    ports.note?.(rec.ownerWorkspaceId, rec.threadId, 'Worker resumed', `${by.kind === 'owner' ? 'The owner' : 'The bot'} resumed the same conversation ${where}.`);
  } catch {
    /* best effort */
  }
  ports.changed?.();
  const out: WorkerResumeResult = { ok: true, taskId: rec.taskId, sessionId, resumeSessionId, workspaceId };
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text || !ports.submit) return out;
  const sleep = ports.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (ports.agentWaitMs ?? RESUME_AGENT_WAIT_MS);
  let up = false;
  while (now() < deadline) {
    if (await ports.agentAlive?.(sessionId).catch(() => false)) {
      up = true;
      break;
    }
    await sleep(1000);
  }
  const delivered = up ? await ports.submit(sessionId, text.slice(0, RESUME_MESSAGE_MAX)).catch(() => false) : false;
  return { ...out, messageDelivered: delivered };
}

/** Ended bot tasks (in the catch-up window) whose worker was not reclaimed
 *  yet: still live for the agent budget. Pure over its inputs. */
export function unreclaimedEndedWorkers(rows: readonly LedgerEntry[], store: Pick<ReclaimedWorkers, 'get'>, now: number): number {
  const since = now - RECLAIM_CATCHUP_MS;
  return rows.filter((e) => e.updatedAt >= since && isReclaimableEnd(e, e.status) && !isReclaimedSince(store.get(e.id), e)).length;
}

/** How the Bots page shows a reclaimed worker (BotTaskView.worker). Pure. */
export function reclaimedWorkerState(rec: ReclaimedWorker | null): 'resumable' | 'stopped' | 'resumed' | null {
  if (!rec || rec.state === 'stopping') return null;
  if (rec.state === 'resumed') return 'resumed';
  return rec.sessions.some((s) => resumeLineFor(s) !== null) ? 'resumable' : 'stopped';
}

/** Stop the resumed workers of one bot, or of every bot (the owner's stop,
 *  a bot's stop_my_work): their rows ended long ago, so the ledger stop does
 *  not reach them. A resume still under way launches nothing more. How many
 *  it stopped, and how many it could not (still resumed: a later stop tries
 *  again). */
export async function stopResumedWorkers(ports: WorkerResumePorts, botId?: string): Promise<{ stopped: number; failed: number }> {
  if (botId === undefined) stopAllSeq++;
  else botStopSeq.set(botId, (botStopSeq.get(botId) ?? 0) + 1);
  if (!ports.stopAgent) return { stopped: 0, failed: 0 };
  const now = ports.now ?? Date.now;
  let n = 0;
  let failed = 0;
  for (const rec of ports.store.all()) {
    if (rec.state !== 'resumed' || (botId !== undefined && rec.botId !== botId)) continue;
    let ok = true;
    for (const s of rec.sessions) {
      const r: { ok?: boolean; code?: string } = await ports.stopAgent(s.sessionId).catch(() => ({ ok: false }));
      // A pane that is gone took its agent with it (a stop of its open task
      // may have closed it first).
      if (r.ok !== true && r.code !== 'no_session') ok = false;
    }
    if (!ok) failed++;
    else if (ports.store.setState(rec.taskId, 'stopped', now())) n++;
  }
  if (n > 0) ports.changed?.();
  return { stopped: n, failed };
}

/** A resumed worker whose agent exited is stopped again (resumable). */
export function noteWorkerAgentExit(store: ReclaimedWorkers, sessionId: string, now: number = Date.now()): boolean {
  const taskId = store.taskOfSession(sessionId);
  return taskId ? store.setState(taskId, 'stopped', now) : false;
}

// ── Clear ───────────────────────────────────────────────────────────────────

/** A clear that was refused, or found a busy pane, waits this long. */
export const CLEAR_RETRY_MS = 15_000;
/** A workspace main could not show to be the task's own is looked at again
 *  only after this long (a lineage read may fail for a moment). */
export const CLEAR_FOREIGN_RETRY_MS = 10 * 60_000;

export type ClearVerdict = 'clear' | 'defer' | 'keep' | 'gone';

/**
 * What to do with a reclaimed worker's workspace now. Pure. `open`: whether
 * that workspace is still open; `viewed`: the workspace the owner views, null
 * when unknown (nothing closes then).
 *   keep  — a resumed worker, a task still open for review (`reported`), or
 *           a `failed` task the owner has not looked at;
 *   defer — the owner is viewing it (or what they view is unknown);
 *   gone  — already closed;
 *   clear — close it.
 */
export function clearVerdict(rec: ReclaimedWorker, open: boolean, viewed: string | null): ClearVerdict {
  // A reported task is still open: closing its workspace would close its
  // mission, and that cancels the task.
  if (rec.state !== 'stopped' || rec.ended === 'reported') return 'keep';
  if (!open) return 'gone';
  if (viewed === null || viewed === workerWorkspaceOf(rec)) return 'defer';
  if (rec.ended === 'failed' && rec.seenAt === undefined) return 'keep';
  return 'clear';
}

/** Whether `workspaceId` is the task's own workspace by main's records: the
 *  one its ledger row names, or the pane a resume opened for it, stamped as
 *  a task of the same owner started by the same bot. Pure over its reads. */
export function isTaskWorkspaceOf(
  rec: Pick<ReclaimedWorker, 'taskId' | 'botId' | 'ownerWorkspaceId' | 'paneWorkspaceId'>,
  workspaceId: string,
  ledgerTaskOf: (workspaceId: string) => string | null,
  stampOf: (workspaceId: string) => { owner: string; origin?: { kind: string; botId?: string } } | null,
): boolean {
  if (!workspaceId || workspaceId === rec.ownerWorkspaceId) return false;
  if (ledgerTaskOf(workspaceId) === rec.taskId) return true;
  if (workspaceId !== rec.paneWorkspaceId) return false;
  const stamp = stampOf(workspaceId);
  return !!stamp && stamp.owner === rec.ownerWorkspaceId && stamp.origin?.kind === 'bot' && stamp.origin.botId === rec.botId;
}

export interface WorkerClearPorts {
  store: ReclaimedWorkers;
  /** The open workspace ids (the renderer's tree), null when unknown. */
  openWorkspaces: () => ReadonlySet<string> | null;
  /** The workspace the owner views, null when unknown. */
  viewedWorkspace: () => string | null;
  /** Every pty a workspace owns (stashed panes included), null when unknown. */
  workspacePtys: (workspaceId: string) => readonly string[] | null;
  listSessions: () => Promise<WorkerSessionInfo[]>;
  /** Whether `workspaceId` is this task's own workspace by main's records
   *  (its ledger row, or the lineage stamp of a pane a resume opened). */
  isTaskWorkspace: (rec: ReclaimedWorker, workspaceId: string) => boolean;
  /** Whether the task's row is open again (it reopened after it ended): its
   *  workspace is the worker's again and is never closed here. */
  taskOpen?: (taskId: string) => boolean;
  /** Close one workspace through the renderer's workspace.close (its guards
   *  apply); true only when it closed. */
  closeWorkspace: (workspaceId: string) => Promise<boolean>;
  changed?: () => void;
  now?: () => number;
  log?: (msg: string) => void;
}

export interface WorkerClear {
  /** Look at every reclaimed worker and close the workspaces that are due.
   *  Never throws; how many closed. A call during a pass runs one more. */
  reconcile(): Promise<number>;
}

export function createWorkerClear(ports: WorkerClearPorts): WorkerClear {
  const log = ports.log ?? ((m: string) => console.warn(m));
  const now = ports.now ?? Date.now;
  /** workspace → not before (a refusal or a busy pane). */
  const notBefore = new Map<string, number>();
  let running: Promise<number> | null = null;
  let again = false;

  const due = (open: ReadonlySet<string>, viewed: string | null, at: number): ReclaimedWorker[] => {
    const out: ReclaimedWorker[] = [];
    for (const rec of ports.store.all()) {
      const ws = workerWorkspaceOf(rec);
      if (clearVerdict(rec, open.has(ws), viewed) !== 'clear') continue;
      if ((notBefore.get(ws) ?? 0) > at) continue;
      out.push(rec);
    }
    return out;
  };

  // A failed task's workspace the owner is looking at counts as seen. Run on
  // every call, also one that joins a running pass, so a look while a pass
  // waits on the daemon is not lost.
  const noteSeen = (): void => {
    let viewed: string | null = null;
    try {
      viewed = ports.viewedWorkspace();
    } catch {
      viewed = null;
    }
    if (viewed === null) return;
    const at = now();
    for (const rec of ports.store.all()) {
      if (rec.state === 'stopped' && rec.ended === 'failed' && workerWorkspaceOf(rec) === viewed) ports.store.markSeen(rec.taskId, at);
    }
  };

  /** Every pane of the workspace is known to be idle: no agent, and the
   *  shell reported its prompt (no foreground command). A pane the daemon
   *  no longer has is gone; anything not known is busy. */
  const idle = (ptys: readonly string[] | null, sessions: readonly WorkerSessionInfo[]): boolean => !!ptys && ptys.every((id) => {
    const s = sessions.find((x) => x.id === id);
    return !s || (s.agentProcessAlive !== true && s.commandRunning === false);
  });

  const pass = async (): Promise<number> => {
    const open = ports.openWorkspaces();
    if (!open) return 0;
    const viewed = ports.viewedWorkspace();
    const at = now();
    const list = due(open, viewed, at);
    if (list.length === 0) return 0;
    let closed = 0;
    for (const rec of list) {
      const ws = workerWorkspaceOf(rec);
      if (resuming.has(rec.taskId) || clearing.has(rec.taskId)) continue;
      // Read again: a resume or a move may have happened meanwhile.
      const cur = ports.store.get(rec.taskId);
      const openNow = ports.openWorkspaces();
      if (!cur || !openNow || workerWorkspaceOf(cur) !== ws || clearVerdict(cur, openNow.has(ws), ports.viewedWorkspace()) !== 'clear') continue;
      let own = false;
      try {
        own = ports.isTaskWorkspace(cur, ws);
      } catch {
        own = false;
      }
      if (!own) {
        notBefore.set(ws, at + CLEAR_FOREIGN_RETRY_MS);
        log(`[factory] clear: ${ws} is not known as the workspace of task ${cur.taskId}; it stays open`);
        continue;
      }
      // Held from here: a resume of this task waits until the close is over.
      clearing.add(cur.taskId);
      try {
        // Read fresh for each close: an earlier close took time.
        const sessions = await ports.listSessions();
        // The owner may have opened it while the sessions were read.
        const viewedNow = ports.viewedWorkspace();
        if (viewedNow === null || viewedNow === ws) continue;
        if (!idle(ports.workspacePtys(ws), sessions)) {
          notBefore.set(ws, at + CLEAR_RETRY_MS);
          continue;
        }
        // Read right before the close: a task that reopened is the worker's
        // again.
        let reopenedNow = true;
        try {
          reopenedNow = ports.taskOpen?.(cur.taskId) ?? false;
        } catch {
          reopenedNow = true; // cannot tell: it stays
        }
        if (reopenedNow) continue;
        let ok = false;
        try {
          ok = await ports.closeWorkspace(ws);
        } catch (err) {
          log(`[factory] clear: ${ws} (task ${cur.taskId}) was not closed: ${String(err)}`);
        }
        if (ok) {
          closed++;
          notBefore.delete(ws);
        } else {
          notBefore.set(ws, at + CLEAR_RETRY_MS);
        }
      } finally {
        clearing.delete(cur.taskId);
      }
    }
    if (closed > 0) ports.changed?.();
    return closed;
  };

  return {
    reconcile(): Promise<number> {
      noteSeen();
      if (running) {
        again = true;
        return running;
      }
      running = (async () => {
        let n = 0;
        do {
          again = false;
          try {
            n += await pass();
          } catch (err) {
            log(`[factory] clear pass failed: ${String(err)}`);
          }
        } while (again);
        // Cleared here, not in a finally: a call that lands after the last
        // pass starts a new one instead of joining a pass that is over.
        running = null;
        return n;
      })();
      return running;
    },
  };
}

// ── Live ports (set by the wiring module) ───────────────────────────────────

let resumePorts: WorkerResumePorts | null = null;

export function setWorkerResumePorts(next: WorkerResumePorts | null): void {
  resumePorts = next;
}

export function getWorkerResumePorts(): WorkerResumePorts | null {
  return resumePorts;
}
