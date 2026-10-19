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
// then sat idle for REPORTED_IDLE_MS (workerPanesIdle: its panes reported
// their turn's end and nothing happened in them since, counted from their own
// last turn end and input, never while the owner views them and typed
// into or focused them within VIEWED_ATTENTION_MS) has
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
// worker counts as live again until its agent exits, or until it sat idle (its
// turn ended, nothing typed into it) for RESUMED_IDLE_MS: then its agent is
// stopped again the same way (createResumedIdleSweep), resumable once more.

import { holderInputsChanged } from './holderInputs';
import fs from 'node:fs';
import path from 'node:path';
import { isResearchDispatch, type LedgerEntry } from '../../shared/ledger';
import { taskThreadOf, type CardNotice, type ThreadId } from '../../shared/room';
import { isPlausibleResumeSessionId, normalizeResumeCwd, permissionFlagFor, type PermissionMode } from '../../shared/agentResume';
import { sessionHostDir, sessionsStartedIn } from '../worktask/stopSessionsInDir';
import { createFilePersister, readVersionedFile, type FilePersister } from './versionedFile';
import { STOPPED_BY_OWNER } from './factoryStop';
import { fanoutTaskShortId } from '../../shared/fanoutCallerNudge';
import type { WorkerSlots } from './workerSlots';

export const RECLAIMED_WORKERS_FILENAME = 'reclaimed-workers.json';
export const RECLAIMED_WORKERS_VERSION = 1 as const;
/** How far back an ended task is reclaimed at install. */
export const RECLAIM_CATCHUP_MS = 24 * 3_600_000;
/** How long a reported task's worker sits idle before it is stopped. */
export const REPORTED_IDLE_MS = 5 * 60_000;
/** A pane whose turn status main has not seen (as after a restart) counts
 *  as idle only once its task was reported this long ago. */
export const REPORTED_UNSEEN_IDLE_MS = 30 * 60_000;
/** How long a resumed worker of an ended task sits idle (its turn ended,
 *  nothing typed into it) before its agent is stopped again: the same window
 *  as a reported task's worker. */
export const RESUMED_IDLE_MS = REPORTED_IDLE_MS;
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

/** The task a worker's lifecycle card names: its title, else its short id,
 *  so cards for several tasks that ended together can be told apart. Pure. */
export function lifecycleCardTask(title: string | undefined, taskId: string): string {
  return title?.trim() || fanoutTaskShortId(taskId);
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
  /** The daemon respawned the pane at its own restart and has seen no agent
   *  there since (absent from a daemon that does not say). */
  recoveredAgentUnconfirmed?: boolean;
  /** The pane runs in WSL (its Linux agent is not always attributed). */
  wslTarget?: { distribution?: unknown };
  /** An exec unit: the pane's process is the command itself. */
  exec?: unknown;
  resumeBinding?: { agent?: unknown; sessionId?: unknown; cwd?: unknown; permissionMode?: unknown };
}

/** Whether a pane is a WSL worker whose agent the daemon cannot stop
 *  (#2254): a WSL shell pane, not an exec unit, running a foreground
 *  command (the typed launch line) with no agent exit seen. Its Linux agent
 *  is not always attributed, so a stop closes its pane instead; a plain WSL
 *  shell at its prompt is no such worker. Pure. */
export function isWslWorkerPane(s: Pick<WorkerSessionInfo, 'wslTarget' | 'exec' | 'agentProcessAlive' | 'commandRunning'> | undefined): boolean {
  return !!s && !!s.wslTarget && !s.exec && s.agentProcessAlive !== false && s.commandRunning === true;
}

/** The part of a bot worker session record (botWorkerSessionRecord) that
 *  names the task whose own fan-out (or resume) launch created the pane. */
export type WorkerSessionRecordOf = (sessionId: string) => { taskId?: string } | null;

/**
 * Whether a pane is the task's own worker pane (#2266): its session is one
 * the task's reclaim record lists (`recordedSessionIds`), or its bot worker
 * session record names this task (written only for the task's own fan-out
 * or resume spawn, never for a split). A WSL pane's Linux agent is not always
 * attributed, so a WSL terminal the owner opened in the task folder looks
 * like a worker whenever it runs anything; only this identifies the worker.
 * A pane neither names (a record that cannot be read, a pane created before
 * session records carried a task) is not the task's: it is never closed and
 * never blocks a resume. Pure over its inputs.
 */
export function isTaskOwnWorkerPane(
  session: Pick<WorkerSessionInfo, 'id'>,
  taskId: string,
  recordedSessionIds: readonly string[],
  sessionRecordOf: WorkerSessionRecordOf | undefined,
): boolean {
  if (recordedSessionIds.includes(session.id)) return true;
  try {
    return sessionRecordOf?.(session.id)?.taskId === taskId;
  } catch {
    return false;
  }
}

/** A conversation whose mode no hook carried (a WSL worker whose task ended
 *  at its own report, before its first Stop) resumes in the mode wmux
 *  launched it in: only the conversation the pane's own launch line pinned.
 *  Fills `panes` in place. */
export function fillLaunchedModes(panes: ReclaimedSession[], launchedConversation: WorkerReclaimPorts['launchedConversation']): void {
  for (const p of panes) {
    if (!p.resumeSessionId || p.permissionMode) continue;
    let launched: { sessionId: string; permissionMode?: PermissionMode } | null = null;
    try {
      launched = launchedConversation?.(p.sessionId) ?? null;
    } catch {
      launched = null;
    }
    if (launched?.permissionMode && launched.sessionId === p.resumeSessionId) p.permissionMode = launched.permissionMode;
  }
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

  /** Every change is saved through here, and tells the holder set. */
  private save(): Promise<void> {
    holderInputsChanged();
    return this.persister.schedule();
  }

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
    return this.save();
  }

  remove(taskId: string): Promise<void> {
    if (!this.records.delete(taskId)) return Promise.resolve();
    return this.save();
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
    void this.save().catch((err) => console.warn(`[factory] reclaimed workers not written: ${String(err)}`));
  }

  setState(taskId: string, state: ReclaimedWorker['state'], at: number): boolean {
    const r = this.records.get(taskId);
    if (!r || r.state === state) return false;
    const from = r.state;
    r.state = state;
    r.at = at;
    this.notifyState(r, from, state, at);
    void this.save().catch((err) => console.warn(`[factory] reclaimed workers not written: ${String(err)}`));
    return true;
  }

  /** The owner looked at the task's workspace (once; false when already). */
  markSeen(taskId: string, at: number): boolean {
    const r = this.records.get(taskId);
    if (!r || r.seenAt !== undefined) return false;
    r.seenAt = at;
    void this.save().catch((err) => console.warn(`[factory] reclaimed workers not written: ${String(err)}`));
    return true;
  }

  /** A resume opened a new pane for the task: it is the worker's pane now. */
  movePane(taskId: string, workspaceId: string, session: ReclaimedSession): Promise<void> {
    const r = this.records.get(taskId);
    if (!r) return Promise.resolve();
    r.paneWorkspaceId = workspaceId;
    r.sessions = [{ ...session }];
    return this.save();
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
  stopAgent: (sessionId: string, opts?: { ifTurnClosed?: boolean }) => Promise<{ ok?: boolean; stopped?: boolean; code?: string }>;
  /** Close a pane (daemon `daemon.destroySession`): the stop of an agent the
   *  daemon cannot stop by itself (`unsupported`: a WSL pane's Linux agent).
   *  Absent: such a worker is not stopped. */
  closePane?: (sessionId: string) => Promise<void>;
  /** The conversation a pane's launch line pinned and the mode it started it
   *  in, as recorded when wmux created the pane as a bot worker; null when
   *  none was. Absent: no mode is filled in. */
  launchedConversation?: (sessionId: string) => { sessionId: string; permissionMode?: PermissionMode } | null;
  /** A pane's bot worker session record (its task), null when none. Given:
   *  only a pane whose record names the task is recorded, stopped or closed
   *  as its worker (a WSL pane too, isTaskOwnWorkerPane). Absent: every pane
   *  started in the task folder counts. */
  sessionRecordOf?: WorkerSessionRecordOf;
  note?: (workspaceId: string, threadId: ThreadId, title: string, body: string, notice?: CardNotice, taskId?: string) => void;
  /** The Bots page re-reads (BOT_EVENT). */
  changed?: () => void;
  now?: () => number;
  log?: (msg: string) => void;
  /** Look again this often for recent ends that were not reclaimed (the
   *  daemon was not connected yet) and for reported tasks gone idle; each
   *  task at most RECLAIM_ATTEMPTS_MAX times per rev. Absent: only at install. */
  retryMs?: number;
  /** Whether every pane in the task's workspace sat idle for the window
   *  (workerPanesIdle, its floor the report: each reported its turn's end and
   *  nothing happened in it since) and the owner is not viewing it. Absent: a
   *  reported task's worker is never stopped. */
  turnEnded?: (entry: LedgerEntry) => boolean;
  /** How long a reported task sits before its idle worker is stopped
   *  (default REPORTED_IDLE_MS). */
  reportedIdleMs?: number;
  /** The panes a workspace owns, null when not known. A reported task's
   *  stop reaches only its own workspace's panes (whose turns turnEnded
   *  checked), never another pane opened in its folder; unknown: nothing is
   *  stopped. Absent: every pane started in the folder, as for an end. */
  workspacePanes?: (workspaceId: string) => readonly string[] | null;
  /** The panes of a reported task whose idle turnEnded checked: its own
   *  worker panes (reportedWorkerPanes), null when not known. A reported
   *  task's stop reaches only these, never a shell in its workspace; none
   *  or unknown: nothing is stopped. Absent: workspacePanes. */
  reportedPanes?: (entry: LedgerEntry) => readonly string[] | null;
  /** Asked as the last step before each stop of a reported task's idle
   *  worker, after every other await: whether the daemon, read again now,
   *  still shows its turn over and the idle window still met with the
   *  times it reports (a turn start main missed leaves turnEnded true on
   *  stale evidence). false: not now, looked at again on the next pass, no
   *  attempt spent. The stop itself is also conditional (`ifTurnClosed`: a
   *  daemon that knows it refuses with `turn_open`, read the same way).
   *  Absent: not asked. */
  confirmIdle?: (entry: LedgerEntry) => Promise<boolean>;
}

/** Whether one pane of a reported task's workspace ended its turn, from the
 *  last agent status main broadcast for it. A turn that reported its end
 *  (`complete`, `waiting`, `error`) is over even while a 'running' claim it
 *  made is still outstanding: the Claude Stop hook's `complete` does not
 *  withdraw that claim, which would otherwise hold until the unseen-status
 *  window. A claim with no result after it (`unsettledClaim`), a running
 *  turn and a prompt waiting on the owner are not idle. A status main has
 *  not seen counts only once the report is `longAgo`. Pure. */
export function paneTurnEnded(status: string | undefined, unsettledClaim: boolean, longAgo: boolean): boolean {
  if (unsettledClaim || status === 'running' || status === 'awaiting_input') return false;
  return status !== undefined || longAgo;
}

/** What main knows of one worker pane's turns, for the idle stops
 *  (main/notification/turnEvidence.ts). Every time is main's clock; absent:
 *  none seen since main started. */
export interface PaneActivity {
  /** The last agent status main broadcast for it. */
  status?: string;
  /** Its last hook-reported turn start (a prompt, or a tool after a Stop). */
  turnStartAt?: number;
  /** Its last affirmative turn end (a reported complete / waiting / error,
   *  or the daemon's boot settle); never a latch expiry or a silence. */
  turnEndAt?: number;
  /** When someone last typed into it. */
  inputAt?: number;
}

/**
 * Whether a worker's panes have sat idle for `ms` at `now`: the one idle
 * test of both the reported-task stop and the resumed-worker stop. It needs
 * affirmative evidence, never a guess. Every pane must have reported a turn
 * end at or after its last turn start: a turn whose end never came (a silent
 * tool, a latch that expired into a synthetic idle) and a pane main knows
 * nothing of (as after a restart) are not idle, and the worker is left to
 * the owner. No pane may show a turn running or a prompt waiting. And
 * nothing may have happened for `ms`: not since that turn end, not since
 * the last input, not since `floor` (the report, the resume). No panes:
 * not idle. Pure.
 */
export function workerPanesIdle(panes: readonly PaneActivity[], floor: number, now: number, ms: number): boolean {
  if (panes.length === 0) return false;
  return panes.every((p) => p.turnEndAt !== undefined
    && (p.turnStartAt === undefined || p.turnEndAt >= p.turnStartAt)
    && p.status !== 'running' && p.status !== 'awaiting_input'
    && now - Math.max(floor, p.turnEndAt, p.inputAt ?? -Infinity) >= ms);
}

/** How long a worker the owner is shown (the active workspace, or the Bots
 *  worker panel) stays protected from the idle stops after the owner last
 *  typed into it or focused it (owner decision 2026-10-17): a worker left
 *  open in a panel does not live forever. */
export const VIEWED_ATTENTION_MS = 30 * 60_000;

/** Whether being shown still protects a worker at `now`: the owner focused
 *  it (`focusedAt`: it became the active workspace, its active pane changed,
 *  or the Bots panel opened on it) or typed into one of its panes
 *  (`inputAts`) within `ms`. Staying shown, or the panel closing, is no
 *  focus. After
 *  that the usual idle test decides; it never stops a pane with a live turn
 *  or a prompt waiting (workerPanesIdle). Pure. */
export function viewProtects(focusedAt: number | undefined, inputAts: ReadonlyArray<number | undefined>, now: number, ms: number = VIEWED_ATTENTION_MS): boolean {
  const last = [focusedAt, ...inputAts].reduce<number>((a, b) => (b !== undefined && b > a ? b : a), -Infinity);
  return now - last < ms;
}

/** When the owner last focused each shown workspace, from the renderer's
 *  pushes: the viewed (active) workspace or its active pane changing, or the
 *  Bots panel opening (or showing again) on it. The panel closing is no
 *  focus. A workspace no longer shown is forgotten. */
export interface ViewAttention {
  observe(viewed: { workspaceId: string; paneId: string | null } | null, panelWorkspaceId: string | null, at: number): void;
  /** Undefined: not focused while shown. */
  focusedAt(workspaceId: string): number | undefined;
}

export function createViewAttention(): ViewAttention {
  const focused = new Map<string, number>();
  let last: { workspaceId: string; paneId: string | null } | null = null;
  let lastPanel: string | null = null;
  return {
    observe(viewed, panelWorkspaceId, at) {
      if (viewed?.workspaceId && (viewed.workspaceId !== last?.workspaceId || viewed.paneId !== last.paneId)) focused.set(viewed.workspaceId, at);
      if (panelWorkspaceId && panelWorkspaceId !== lastPanel) focused.set(panelWorkspaceId, at);
      last = viewed?.workspaceId ? { workspaceId: viewed.workspaceId, paneId: viewed.paneId } : null;
      lastPanel = panelWorkspaceId || null;
      for (const id of [...focused.keys()]) if (id !== viewed?.workspaceId && id !== panelWorkspaceId) focused.delete(id);
    },
    focusedAt(workspaceId) {
      return focused.get(workspaceId);
    },
  };
}

/** One pane's turn as the daemon reports it (DaemonClient.getAgentState). */
export interface DaemonTurnState {
  agentStatus: string;
  /** A turn is open (a quiet one reads `idle` in agentStatus). Absent from an older daemon. */
  turnOpen?: boolean;
  /** The pane's current agent has delivered a hook. Absent from an older daemon. */
  hookReports?: boolean;
  /** Milliseconds since the last key input. Absent from an older daemon. */
  keyInputIdleMs?: number;
  /** Milliseconds since the pane's last settled result. Absent from an older
   *  daemon and when none settled since its agent started. */
  settledAgoMs?: number;
}

/** A worker pane whose read came back without an answer (no state, an
 *  older daemon) is read again after this, doubling per failure up to
 *  TURN_SEED_RETRY_MAX_MS; never given up on. */
export const TURN_SEED_RETRY_MS = 60_000;
export const TURN_SEED_RETRY_MAX_MS = 30 * 60_000;
/** A worker pane the daemon reported mid-turn (or with no hook seen) is read
 *  again this often. */
export const TURN_SEED_OPEN_RECHECK_MS = 5 * 60_000;

/**
 * The worker panes of one reported task, among its workspace's panes whose
 * agent the daemon reports running (agentProcessAlive, or a WSL worker's
 * launch line, isWslWorkerPane). With panes recorded for the task (its
 * reclaim record), only those. Otherwise the one pane its own fan-out (or
 * resume) launch created (`launched`: the bot worker session record names
 * the task), and only while it is the workspace's single agent pane. Anything
 * else (a recorded worker that exited beside another agent, two agents, an
 * agent the task did not launch) identifies no worker: the task is not idle
 * and nothing is stopped. A plain shell is never one. Pure.
 */
export function taskWorkerPanes(panes: readonly string[], recorded: readonly string[], launched: readonly string[], sessions: readonly WorkerSessionInfo[]): string[] {
  const alive = panes.filter((id) => {
    const s = sessions.find((x) => x.id === id);
    return !!s && (s.agentProcessAlive === true || isWslWorkerPane(s));
  });
  if (recorded.length > 0) return alive.filter((id) => recorded.includes(id));
  return alive.length === 1 && launched.includes(alive[0]) ? alive : [];
}

/** Whether the daemon's read of a pane shows its turn over: a turn known
 *  closed, no running turn, no prompt waiting. No state, or an older daemon
 *  that does not say, is not. Pure. */
export function daemonTurnClosed(state: DaemonTurnState | null): boolean {
  return !!state && state.turnOpen === false && state.agentStatus !== 'running' && state.agentStatus !== 'awaiting_input';
}

/** The panes a reported task's idle stop looks at and stops: its identified
 *  worker panes still in its workspace; none (not idle, nothing stopped)
 *  when no worker pane was identified; null when the workspace tree is not
 *  known. Pure. */
export function reportedWorkerPanes(workers: readonly string[] | null, workspacePtys: readonly string[] | null): string[] | null {
  if (!workspacePtys) return null;
  return workers ? workers.filter((id) => workspacePtys.includes(id)) : [];
}

/** One pane's activity for the idle stops: main's own turn evidence and the
 *  daemon's reads, the later turn end and the later input of the two. Pure. */
export function mergePaneActivity(live: PaneActivity, seeded: Pick<PaneActivity, 'turnEndAt' | 'inputAt'> | null): PaneActivity {
  const later = (a: number | undefined, b: number | undefined): number | undefined => (a === undefined ? b : b === undefined ? a : Math.max(a, b));
  const turnEndAt = later(live.turnEndAt, seeded?.turnEndAt);
  const inputAt = later(live.inputAt, seeded?.inputAt);
  return {
    ...(live.status !== undefined ? { status: live.status } : {}),
    ...(live.turnStartAt !== undefined ? { turnStartAt: live.turnStartAt } : {}),
    ...(turnEndAt !== undefined ? { turnEndAt } : {}),
    ...(inputAt !== undefined ? { inputAt } : {}),
  };
}

export interface DaemonTurnSeedPorts {
  /** The open reported bot tasks not yet stopped for that report: their
   *  workspace's panes, the panes recorded for the task (its reclaim
   *  record), the panes its own launch created (taskWorkerPanes), and the
   *  report time; null when the workspace tree is not known yet (nothing is
   *  read or dropped). */
  tasks: () => ReadonlyArray<{ taskId: string; reportedAt: number; panes: readonly string[]; recorded: readonly string[]; launched: readonly string[] }> | null;
  /** Whether the daemon can be asked now (not connected: nothing is read). */
  ready: () => boolean;
  /** The daemon's sessions (daemon.listSessions). */
  listSessions: () => Promise<WorkerSessionInfo[]>;
  /** The pane's state, null when the daemon has none (no session, a failed
   *  or timed-out read). */
  readState: (ptyId: string) => Promise<DaemonTurnState | null>;
  /** Whether main saw a turn edge of the pane itself since it started. */
  liveEvidence: (ptyId: string) => boolean;
  now?: () => number;
}

export interface DaemonTurnSeed {
  /** The daemon's turn end for a worker pane, or null. */
  activity(ptyId: string): Pick<PaneActivity, 'turnEndAt' | 'inputAt'> | null;
  /** The task's worker panes as the last pass identified them
   *  (taskWorkerPanes), or null when none was. */
  workerPanes(taskId: string): readonly string[] | null;
  /** Identify the worker panes and read those still unknown. */
  pass(): Promise<void>;
  /** Read the panes again right before they are stopped: true only when the
   *  daemon shows every one's turn over (daemonTurnClosed). The times it
   *  reports (its last settled result, its last key input) are folded into
   *  the seed, so the caller checks the idle window again with them. A pane
   *  it shows mid-turn loses its seed (a turn start main missed) and is
   *  read again later. */
  confirmIdle(ptyIds: readonly string[]): Promise<boolean>;
}

/**
 * Which panes of a reported bot task are its worker, and, for those main has
 * no turn evidence of (after an app restart: it lived only in memory), the
 * daemon's view of their turn. A reported task's idle stop looks at and stops
 * only these panes (reportedWorkerPanes): a shell in the task's workspace,
 * which may be the owner's, is never counted and never stopped, and a task
 * whose worker pane cannot be identified is not idle.
 *
 * A worker pane whose agent's hooks reported and whose turn the daemon
 * reports closed (`turnOpen` false, `hookReports` true, no running turn, no
 * prompt waiting) counts as having ended its turn at its last settled result,
 * never before the report; the daemon's time since the last key input moves
 * the window too. An open turn is read again later (TURN_SEED_OPEN_RECHECK_MS);
 * no state and an older daemon that does not say are read again with a
 * growing delay (TURN_SEED_RETRY_MS), never given up on; a read lost to a
 * disconnect is not counted, and a reconnect reads again at once. Evidence
 * main sees itself is never overruled: the later turn end and input count,
 * a live hook turn start outweighs an older end, and a pane that shows live
 * evidence by the time its read returns is not seeded. Before any stop the
 * panes are read again (confirmIdle) and their fresh times folded in, so a
 * seed a missed turn start made stale stops nothing.
 */
export function createDaemonTurnSeed(ports: DaemonTurnSeedPorts): DaemonTurnSeed {
  const now = ports.now ?? Date.now;
  const seeds = new Map<string, { turnEndAt?: number; inputAt?: number }>();
  const workers = new Map<string, string[]>();
  /** Reads in a row that came back without an answer. */
  const failures = new Map<string, number>();
  const nextReadAt = new Map<string, number>();
  let wasReady = false;
  let running = false;

  const read = async (ptyId: string, reportedAt: number): Promise<void> => {
    let state: DaemonTurnState | null = null;
    try {
      state = await ports.readState(ptyId);
    } catch {
      state = null;
    }
    const readAt = now();
    if (!state || state.turnOpen === undefined) {
      // Lost to a disconnect: not counted.
      if (!state && !ports.ready()) return;
      const n = (failures.get(ptyId) ?? 0) + 1;
      failures.set(ptyId, n);
      nextReadAt.set(ptyId, readAt + Math.min(TURN_SEED_RETRY_MS * 2 ** (n - 1), TURN_SEED_RETRY_MAX_MS));
      return;
    }
    failures.delete(ptyId);
    if (!daemonTurnClosed(state) || state.hookReports !== true) {
      nextReadAt.set(ptyId, readAt + TURN_SEED_OPEN_RECHECK_MS);
      return;
    }
    // Live evidence that arrived while the read was out wins.
    if (ports.liveEvidence(ptyId)) return;
    const ago = (ms: number | undefined): number | undefined => (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? readAt - ms : undefined);
    const settledAt = ago(state.settledAgoMs);
    const inputAt = ago(state.keyInputIdleMs);
    seeds.set(ptyId, {
      turnEndAt: Math.max(reportedAt, settledAt ?? -Infinity),
      ...(inputAt !== undefined ? { inputAt } : {}),
    });
    nextReadAt.delete(ptyId);
  };

  return {
    activity(ptyId) {
      const s = seeds.get(ptyId);
      return s ? { ...s } : null;
    },
    workerPanes(taskId) {
      const w = workers.get(taskId);
      return w ? [...w] : null;
    },
    async pass() {
      if (running) return;
      running = true;
      try {
        let tasks: ReturnType<DaemonTurnSeedPorts['tasks']> = null;
        try {
          tasks = ports.tasks();
        } catch {
          tasks = null;
        }
        if (!tasks) return;
        const ready = ports.ready();
        // A (re)connect: reads that came back empty are tried again now.
        if (ready && !wasReady) {
          for (const id of failures.keys()) nextReadAt.delete(id);
          failures.clear();
        }
        wasReady = ready;
        if (!ready) return;
        let sessions: WorkerSessionInfo[];
        try {
          sessions = await ports.listSessions();
        } catch {
          return;
        }
        workers.clear();
        const reportedAt = new Map<string, number>();
        for (const t of tasks) {
          const w = taskWorkerPanes(t.panes, t.recorded, t.launched, sessions);
          if (w.length === 0) continue;
          workers.set(t.taskId, w);
          for (const id of w) reportedAt.set(id, t.reportedAt);
        }
        // A pane that is no longer a reported task's worker keeps nothing.
        for (const m of [seeds, failures, nextReadAt]) for (const id of [...m.keys()]) if (!reportedAt.has(id)) m.delete(id);
        const at = now();
        const due = [...reportedAt].filter(([id]) => seeds.get(id)?.turnEndAt === undefined && !ports.liveEvidence(id) && (nextReadAt.get(id) ?? -Infinity) <= at);
        await Promise.all(due.map(([id, t]) => read(id, t)));
      } finally {
        running = false;
      }
    },
    async confirmIdle(ptyIds) {
      if (ptyIds.length === 0 || !ports.ready()) return false;
      const states = await Promise.all(ptyIds.map(async (id) => {
        try {
          return await ports.readState(id);
        } catch {
          return null;
        }
      }));
      let ok = true;
      const readAt = now();
      states.forEach((state, i) => {
        if (state && daemonTurnClosed(state)) {
          // Its fresh times: a result that settled or a key typed since the
          // last look moves the window.
          const ago = (ms: number | undefined): number | undefined => (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? readAt - ms : undefined);
          const settledAt = ago(state.settledAgoMs);
          const inputAt = ago(state.keyInputIdleMs);
          const prior = seeds.get(ptyIds[i]) ?? {};
          const later = (a: number | undefined, b: number | undefined): number | undefined => (a === undefined ? b : b === undefined ? a : Math.max(a, b));
          const turnEndAt = later(prior.turnEndAt, settledAt);
          const input = later(prior.inputAt, inputAt);
          if (turnEndAt !== undefined || input !== undefined) {
            seeds.set(ptyIds[i], { ...(turnEndAt !== undefined ? { turnEndAt } : {}), ...(input !== undefined ? { inputAt: input } : {}) });
          }
          return;
        }
        ok = false;
        // Shown mid-turn: a turn start main missed. Its seed goes (main's own
        // turn end, if any, stays) and it is read again later.
        if (state && state.turnOpen !== undefined && seeds.delete(ptyIds[i])) nextReadAt.set(ptyIds[i], now() + TURN_SEED_OPEN_RECHECK_MS);
      });
      return ok;
    },
  };
}

/** Whether a resumed worker's agent still runs in one of its recorded panes:
 *  an agent seen alive, or a WSL worker's pane, whose Linux agent the daemon
 *  does not always attribute (isWslWorkerPane). Pure. */
export function resumedAgentAlive(rec: Pick<ReclaimedWorker, 'sessions'>, sessions: readonly WorkerSessionInfo[]): boolean {
  return rec.sessions.some((p) => {
    const s = sessions.find((x) => x.id === p.sessionId);
    return !!s && (s.agentProcessAlive === true || isWslWorkerPane(s));
  });
}

/**
 * Whether an agent runs in a task workspace's panes, for the fan-out slot of
 * a task that ended: a pane whose agent the daemon sees alive, or one of the
 * task's own worker panes (isTaskOwnWorkerPane) not known to run none (a WSL
 * worker's launch line, isWslWorkerPane, an agent the daemon never
 * attributed, or a pane it says nothing about). A gone, dead or suspended
 * session, an agent seen to exit, a shell at its prompt, one the daemon
 * respawned at its restart with nothing run in it since, or a command in a
 * pane that is not the task's own is none. `silentRuns: false`: an own pane
 * the daemon says nothing about runs none (only what is seen running counts).
 * Pure.
 */
export function endedTaskAgentRuns(
  ptys: readonly string[],
  taskId: string,
  recordedSessionIds: readonly string[],
  sessions: ReadonlyMap<string, WorkerSessionInfo & { state?: unknown }>,
  sessionRecordOf: WorkerSessionRecordOf | undefined,
  silentRuns = true,
): boolean {
  return ptys.some((id) => {
    const s = sessions.get(id);
    if (!s || s.state === 'dead' || s.state === 'suspended') return false;
    if (s.agentProcessAlive === true) return true;
    if (s.agentProcessAlive === false || s.commandRunning === false) return false;
    if (!silentRuns && s.commandRunning !== true) return false;
    if (s.recoveredAgentUnconfirmed === true && s.commandRunning !== true) return false;
    return isTaskOwnWorkerPane(s, taskId, recordedSessionIds, sessionRecordOf);
  });
}

/** Attempts per ended task before the reclaim gives it up. */
export const RECLAIM_ATTEMPTS_MAX = 3;
/** A `stopping` record is looked at again this long after its stop began
 *  (one an earlier run left is looked at right away). */
export const STOPPING_SETTLE_MS = 2 * 60_000;

/** Whether the task moved on from the state its worker is being stopped
 *  for. An end: its row is open again (it reopened since it ended); a row
 *  that cannot be read is not counted as open. A report: its row is no
 *  longer that report (another status or rev, unreadable) or a turn runs
 *  again in its panes (`rowOnly`: the row alone). Pure over its reads. */
function movedOn(ports: Pick<WorkerReclaimPorts, 'row' | 'turnEnded'>, entry: LedgerEntry, ended: ReclaimedWorker['ended'], rowOnly = false): boolean {
  if (ended === 'reported' && !ports.row) return false;
  let now: LedgerEntry | null = null;
  try {
    now = ports.row?.(entry.id) ?? null;
  } catch {
    now = null;
  }
  if (ended === 'reported') {
    if (!now || now.status !== 'review_requested' || now.rev !== entry.rev) return true;
    if (rowOnly) return false;
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
export async function reclaimWorker(
  ports: WorkerReclaimPorts,
  entry: LedgerEntry,
  ended: ReclaimedWorker['ended'],
  /** Set `deferred` when a reported task's stop was held back because its
   *  turn is not over after all (confirmIdle, or the daemon's `turn_open`):
   *  not a failed attempt. */
  out?: { deferred?: boolean },
): Promise<ReclaimedWorker | null> {
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
    const panesOf = (workspaceId: string): readonly string[] | null => {
      try {
        return ports.workspacePanes?.(workspaceId) ?? null;
      } catch {
        return null;
      }
    };
    if (ended === 'reported' && ports.reportedPanes) {
      let own: readonly string[] | null = null;
      try {
        own = ports.reportedPanes(entry);
      } catch {
        own = null;
      }
      if (!own || own.length === 0) return null;
      for (const id of [...ids]) if (!own.includes(id)) ids.delete(id);
    } else if (ended === 'reported' && ports.workspacePanes) {
      const own = panesOf(entry.taskWorkspaceId);
      if (!own) return null;
      for (const id of [...ids]) if (!own.includes(id)) ids.delete(id);
    }
    // A WSL pane counts only in the worker's own workspace: its folder match
    // alone cannot tell the worker from a pane the owner opened there (a
    // stop of it closes the pane). An unknown tree: tried again later.
    const wsl = [...ids].filter((id) => sessions.some((x) => x.id === id && !!x.wslTarget));
    // The task's recorded panes (an earlier stop, a resume): with its bot
    // worker session record, what identifies its own WSL worker pane.
    const recorded = ports.store.get(entry.id)?.sessions.map((x) => x.sessionId) ?? [];
    if (wsl.length > 0) {
      const own = panesOf(workerWorkspaceOf({ taskWorkspaceId: entry.taskWorkspaceId, paneWorkspaceId: ports.store.get(entry.id)?.paneWorkspaceId }));
      if (!own) return null;
      for (const id of wsl) if (!own.includes(id)) ids.delete(id);
      // Nor does a WSL pane of that workspace count unless it is identified
      // as the task's own (#2266): the owner's WSL terminal there running vim
      // or a test is no worker. Its stop would be refused (`unsupported`) and
      // keep the record `stopping`. A WSL agent the daemon attributed is
      // stopped in the distro, its pane kept, like a Windows pane's. The
      // trade-off: an unattributed worker pane neither the record nor its
      // session record names (one created before session records carried a
      // task, a record that cannot be read) keeps running.
      for (const id of wsl) {
        const s = sessions.find((x) => x.id === id);
        if (s && s.agentProcessAlive !== true && !isTaskOwnWorkerPane(s, entry.id, recorded, ports.sessionRecordOf)) ids.delete(id);
      }
    }
    // Only the task's own worker panes: its bot worker session record names
    // the task (written for the task's fan-out or resume spawn only). A shell
    // the owner started in the task folder is never recorded, stopped or
    // closed as the worker, whatever runs in it; a record an older version
    // wrote with such a shell drops it here.
    const ownPane = (id: string): boolean => !ports.sessionRecordOf || isTaskOwnWorkerPane({ id }, entry.id, [], ports.sessionRecordOf);
    for (const id of [...ids]) if (!ownPane(id)) ids.delete(id);
    // A pane the record kept whose session is gone (a closed pane, whose
    // session record went with it) stays: nothing of it can be stopped or
    // closed any more, and its conversation is what Resume reopens.
    const keepRecorded = (id: string): boolean => ownPane(id) || !sessions.some((x) => x.id === id);
    const panes = sessions.filter((s) => ids.has(s.id)).map(reclaimedSessionOf).filter((s): s is ReclaimedSession => !!s);
    if (movedOn(ports, entry, ended)) return null;
    const prior = ports.store.get(entry.id);
    // Stopped already for a report, and no agent runs in its panes since:
    // the record follows the task (a gate written after the stop, the end
    // that came later), with no second stop and no second card.
    if (prior?.ended === 'reported' && prior.state === 'stopped' && !sessions.some((s) => ids.has(s.id) && s.agentProcessAlive === true)) {
      await ports.store.put({ ...prior, sessions: prior.sessions.filter((x) => keepRecorded(x.sessionId)), ended, endRev: entry.rev, at: now() });
      ports.changed?.();
      return ports.store.get(entry.id);
    }
    // An earlier attempt that did not finish: its recorded conversations are
    // kept (a stopped agent may no longer show its binding).
    const kept = prior?.state === 'stopping' ? prior.sessions.filter((x) => keepRecorded(x.sessionId)) : [];
    for (const p of panes) {
      const old = kept.find((k) => k.sessionId === p.sessionId);
      if (!p.resumeSessionId && old?.resumeSessionId) {
        p.resumeSessionId = old.resumeSessionId;
        if (old.permissionMode) p.permissionMode = old.permissionMode;
      }
    }
    fillLaunchedModes(panes, ports.launchedConversation);
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
    // A pane is closed only in the task's own workspace: a WSL terminal the
    // owner opened in the same folder elsewhere is never the worker's.
    let ownPanes: readonly string[] | null = null;
    try {
      ownPanes = ports.workspacePanes?.(workerWorkspaceOf({ taskWorkspaceId: entry.taskWorkspaceId, paneWorkspaceId: prior?.paneWorkspaceId })) ?? null;
    } catch {
      ownPanes = null;
    }
    // A pane whose stop was held back (its turn is not over after all):
    // the record stays `stopping`, live, for a later look.
    let heldBack = false;
    for (const p of panes) {
      // The task reopened (or moved on from its report) meanwhile: what
      // still runs is its worker again.
      if (movedOn(ports, entry, ended)) break;
      // A reported task's idle worker: the last step before its stop, after
      // every await above, reads the daemon again (a turn that started
      // meanwhile, its hook missed, stops nothing).
      if (ended === 'reported' && ports.confirmIdle) {
        let still = false;
        try {
          still = await ports.confirmIdle(entry);
        } catch {
          still = false;
        }
        if (!still) {
          heldBack = true;
          if (out) out.deferred = true;
          break;
        }
        // The row is read again after that read: one that moved on (back to
        // working, a newer report) while it was out has nothing stopped.
        if (movedOn(ports, entry, ended)) break;
      }
      attempted++;
      try {
        // Only an end whose card says its pane closes closes a WSL worker's
        // pane; a reported (still open) or failed task keeps it. Only the
        // task's own pane (isTaskOwnWorkerPane) is ever closed.
        const closable = (ended === 'completed' || ended === 'cancelled')
          && !!ownPanes?.includes(p.sessionId)
          && isWslWorkerPane(sessions.find((x) => x.id === p.sessionId))
          && isTaskOwnWorkerPane({ id: p.sessionId }, entry.id, recorded, ports.sessionRecordOf);
        const r = await stopOrClose(ports.stopAgent, closable ? ports.closePane : undefined, p.sessionId, ended === 'reported' ? { ifTurnClosed: true } : undefined);
        // The daemon found the turn open at the stop itself: nothing was
        // signalled, and it is no failed stop.
        if (r.code === 'turn_open') {
          attempted--;
          heldBack = true;
          if (out) out.deferred = true;
          break;
        }
        // A pane gone since the read took its agent with it: no failed stop
        // (counted as one, it kept the record `stopping` for good).
        if (r.ok !== true && r.code !== 'no_session') {
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
    // Stopped only when every pane was. A pane left running while the row
    // itself has not moved on (a stop held back, a turn that opened in it
    // after another pane was stopped) keeps the record `stopping`, live, and
    // the next sweep looks again.
    if (attempted < panes.length && !movedOn(ports, entry, ended, true)) heldBack = true;
    if (heldBack) {
      if (out) out.deferred = true;
      return ports.store.get(entry.id);
    }
    ports.store.setState(entry.id, 'stopped', now());
    // Reopened part way: the conversation stays recorded, no card (the
    // task is open again, and its open row counts what still runs).
    if (attempted < panes.length) return ports.store.get(entry.id);
    const resumable = panes.some((p) => resumeLineFor(p) !== null);
    // A research task works in a task folder, not a worktree.
    const research = isResearchDispatch(entry.dispatch);
    const keptText = `${research ? 'task folder' : 'worktree'} and the conversation are kept`;
    const pane = ended === 'failed'
      ? 'Its pane stays open until you have looked at it, then closes.'
      : 'Its pane closes.';
    const task = lifecycleCardTask(entry.title, entry.id);
    try {
      if (ended === 'reported') {
        ports.note?.(
          entry.ownerWorkspaceId,
          taskThreadOf(entry),
          `${resumable ? 'Worker paused (resumable)' : 'Worker paused'}: ${task}`,
          resumable
            ? `The task is reported for review and its worker sat idle: its Claude stopped to free memory and its agent slot. The task stays open for review and its pane stays; the ${keptText}, and Resume continues the same conversation.`
            : 'The task is reported for review and its worker sat idle: its Claude stopped to free memory and its agent slot. The task stays open for review and its pane stays; the worktree is kept, but no conversation was recorded to resume.',
          { code: resumable ? 'worker.pausedResumable' : 'worker.paused', args: { title: task, ...(resumable && research ? { kind: 'research' } : {}) } },
          entry.id,
        );
      } else {
        // The stop's cause is the task's end, whoever ended it (the bot's
        // ledger_update, its gate, a merge, a close). Freeing memory is the
        // idle sweeps' cause (the cards above and createResumedIdleSweep's),
        // not this one's.
        ports.note?.(
          entry.ownerWorkspaceId,
          taskThreadOf(entry),
          `${resumable ? 'Worker done (resumable)' : 'Worker done'}: ${task}`,
          resumable
            ? `Task ${ended}: its Claude stopped because the task ended. ${pane} The ${keptText}; Resume continues the same conversation.`
            : `Task ${ended}: its Claude stopped because the task ended. ${pane} The worktree is kept; no conversation was recorded to resume.`,
          { code: resumable ? 'worker.doneResumable' : 'worker.done', args: { status: ended, title: task, ...(resumable && research ? { kind: 'research' } : {}) } },
          entry.id,
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

/** Whether `sessionId` is a pane of `workspaceId` by main's workspace tree;
 *  false when the tree is not known. */
function ownPane(workspacePanes: ((workspaceId: string) => readonly string[] | null) | undefined, workspaceId: string, sessionId: string): boolean {
  try {
    return workspacePanes?.(workspaceId)?.includes(sessionId) === true;
  } catch {
    return false;
  }
}

/** Stop a pane's agent; one the daemon cannot stop by itself (a WSL pane's
 *  Linux agent, #2254) goes with its pane, closed here when `closePane` is
 *  given (the caller checked isWslWorkerPane). */
async function stopOrClose(
  stopAgent: WorkerReclaimPorts['stopAgent'],
  closePane: WorkerReclaimPorts['closePane'],
  sessionId: string,
  opts?: { ifTurnClosed?: boolean },
): Promise<{ ok?: boolean; stopped?: boolean; code?: string }> {
  const r = await (opts ? stopAgent(sessionId, opts) : stopAgent(sessionId));
  if (r.code !== 'unsupported' || !closePane) return r;
  await closePane(sessionId);
  return { ok: true, stopped: true };
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
  const log = ports.log ?? ((m: string) => console.warn(m));
  const installedAt = now();
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
    const out: { deferred?: boolean } = {};
    void reclaimWorker(ports, entry, ended, out).finally(() => {
      inFlight.delete(entry.id);
      // Held back because the turn is not over: no attempt spent.
      if (out.deferred && attempts.get(key) === n + 1) attempts.set(key, n);
    });
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
    void settleStopping();
  };
  // A record left `stopping` (a stop that failed or was cut off by a quit, a
  // reported stop held back whose worker then exited, or a task whose end
  // moved on to one this reclaim does not take, such as the owner's stop or
  // one past the catch-up window) is never tried again by the above. Once
  // stale (left by an earlier run, or begun STOPPING_SETTLE_MS ago) it is
  // read again: no agent left in its panes, it is stopped; one still running
  // in an ended task is stopped once more through the reclaim, per end.
  const retried = new Set<string>();
  let settling = false;
  const settleStopping = async (): Promise<void> => {
    if (settling || !ports.row) return;
    const at = now();
    const stale = ports.store.all().filter((r) => r.state === 'stopping' && !inFlight.has(r.taskId)
      && (r.at < installedAt || at - r.at >= STOPPING_SETTLE_MS));
    if (stale.length === 0) return;
    settling = true;
    try {
      const byId = new Map((await ports.listSessions()).map((x) => [x.id, x]));
      let moved = false;
      for (const rec of stale) {
        // Read again after the await: a reclaim that started meanwhile owns it.
        const cur = ports.store.get(rec.taskId);
        if (!cur || cur.state !== 'stopping' || cur.at !== rec.at || inFlight.has(rec.taskId)) continue;
        let row: LedgerEntry | null;
        try {
          row = ports.row(rec.taskId);
        } catch {
          continue;
        }
        // An open task's worker is its row's: the reclaim of its next end
        // looks at the record again.
        if (row && (row.status === 'working' || row.status === 'input_required')) continue;
        // Its recorded panes and every pane of its workspace: an agent in
        // another pane there keeps it (a stopped record frees the slot).
        const recorded = cur.sessions.map((x) => x.sessionId);
        let panes: readonly string[] | null = [];
        try {
          panes = ports.workspacePanes ? ports.workspacePanes(workerWorkspaceOf(cur)) : [];
        } catch {
          panes = null;
        }
        if (!panes) continue;
        const ptys = [...new Set([...recorded, ...panes])];
        if (!endedTaskAgentRuns(ptys, cur.taskId, recorded, byId, ports.sessionRecordOf)) {
          if (ports.store.setState(rec.taskId, 'stopped', now())) {
            moved = true;
            log(`[factory] reclaim: ${rec.taskId} was left stopping with no agent running; marked stopped`);
          }
          continue;
        }
        // Its agent still runs. A reported task still in review is the
        // reported stop's to retry; an ended one is stopped once more.
        if (!row || (row.status !== 'completed' && row.status !== 'cancelled' && row.status !== 'failed')) continue;
        const key = `${row.id}@${row.rev}`;
        if (retried.has(key)) continue;
        retried.add(key);
        attempts.delete(key);
        log(`[factory] reclaim: ${rec.taskId} was left stopping with its agent running; its stop is tried again`);
        run(row, row.status);
      }
      if (moved) ports.changed?.();
    } catch (err) {
      log(`[factory] reclaim: a look at workers left stopping failed: ${String(err)}`);
    } finally {
      settling = false;
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
  | 'not_now'
  | 'no_slot';

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
  | { ok: false; code: WorkerResumeCode; message: string; /** no_slot: the agent cap in force. */ cap?: number };

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
  /** Each task's launch generation on disk (workerSlots.ts): a resume typed
   *  into the worker's pane is a new launch, recorded before the line is
   *  typed. Absent: not recorded. */
  launches?: Pick<WorkerSlots, 'beginLaunch' | 'launched' | 'released'>;
  /** Whether the pane's agent runs (process truth), for a message. */
  agentAlive?: (sessionId: string) => Promise<boolean>;
  /** Deliver a message to the relaunched agent (waits while someone types). */
  submit?: (sessionId: string, text: string) => Promise<boolean>;
  /** daemon `session.stopAgent`, for the stop of a resumed worker. */
  stopAgent?: (sessionId: string) => Promise<{ ok?: boolean; stopped?: boolean; code?: string }>;
  /** Close a pane whose agent the daemon cannot stop (WorkerReclaimPorts.closePane). */
  closePane?: (sessionId: string) => Promise<void>;
  /** The panes a workspace owns, null when not known: only a pane of the
   *  worker's own workspace is closed. Absent: none is. */
  workspacePanes?: (workspaceId: string) => readonly string[] | null;
  /** Default: process.platform (a WSL pane's recorded Linux folder is read
   *  as its Windows folder on win32). */
  platform?: NodeJS.Platform;
  /** A pane's bot worker session record (WorkerReclaimPorts.sessionRecordOf):
   *  only the task's own WSL worker pane makes a resume wait. */
  sessionRecordOf?: WorkerSessionRecordOf;
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
  /** Put the task's folder back at this path when its end removed it
   *  (taskFolderCleanup.ts: the worktree on its kept branch, or an empty
   *  research folder); true when it is there now. Absent: a removed folder
   *  refuses the resume. */
  restoreFolder?: (taskId: string, folder: string) => Promise<boolean>;
  /** Hold the task's folder for the resume (taskFolderCleanup.ts
   *  holdTaskFolder): no cleanup removes it meanwhile. Returns the release. */
  holdFolder?: (taskId: string) => Promise<() => void>;
  /** The resumed worker uses the task's folder again (taskFolderCleanup.ts
   *  forgetKeptFolder: a folder a stop kept is no longer only kept). */
  folderResumed?: (taskId: string) => void;
  note?:(workspaceId: string, threadId: ThreadId, title: string, body: string, notice?: CardNotice, taskId?: string) => void;
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
   *  the bot's other resumes under way, not yet counted as resumed;
   *  `taskId`: the task this resume is for. */
  botWorkerRefusal?: (botId: string, starting: number, taskId?: string) => string | null;
  /** Whether the owner stopped this task (Stop, or bots switched off): a
   *  bot does not start its worker again. Absent: never. */
  stoppedByOwner?: (taskId: string) => boolean;
}

/** Tasks whose resume is being typed now, or whose workspace is being
 *  cleared: one of either at a time per task. */
const resuming = new Set<string>();
const clearing = new Set<string>();
/** Hold a task's worker panes for a close made elsewhere (deadWorkerPanes.ts),
 *  as a clear holds them: a resume of the task waits until the close is over.
 *  null while a resume or a clear of it is under way. Returns the release. */
export function holdWorkerPanes(taskId: string): (() => void) | null {
  if (resuming.has(taskId) || clearing.has(taskId)) return null;
  clearing.add(taskId);
  return () => {
    clearing.delete(taskId);
  };
}

/** botId → its resumes past the budget check, until each is counted as
 *  resumed or ends. */
const botStarting = new Map<string, number>();

/** Bumped by every stop of resumed workers (all bots, one bot, or one
 *  task's): a resume that was under way when a stop ran launches nothing
 *  more. */
let stopAllSeq = 0;
const botStopSeq = new Map<string, number>();
const taskStopSeq = new Map<string, number>();
function stopMark(botId: string, taskId: string): string {
  return `${stopAllSeq}:${botStopSeq.get(botId) ?? 0}:${taskStopSeq.get(taskId) ?? 0}`;
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
  // The task's folder is held for the resume: a cleanup cannot remove it
  // between the checks below and the worker's pane opening in it.
  let release: (() => void) | null = null;
  try {
    release = (await ports.holdFolder?.(taskId)) ?? null;
  } catch {
    release = null;
  }
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
    release?.();
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
  const mark = stopMark(rec.botId, rec.taskId);
  const stopped = (): boolean => stopMark(rec.botId, rec.taskId) !== mark;
  if (by.kind === 'bot') {
    const text = typeof message === 'string' ? message.trim() : '';
    if (text && (ports.taskTainted?.(taskId) ?? true) === false && (ports.senderTainted?.(by.botId) ?? true) !== false) {
      return refuse('not_now', 'a message from a wake that carried outside text goes only to a task started from outside text; resume without a message, or write it from a clean wake');
    }
    let budget: string | null = null;
    try {
      budget = ports.botWorkerRefusal?.(by.botId, botStarting.get(by.botId) ?? 0, taskId) ?? null;
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
  // No observed agent exit and no shell prompt seen: what runs there is not
  // known. A shell the daemon respawned at its restart, with no agent seen
  // since, runs no agent (a fresh shell reports its prompt only after its
  // first command).
  if (live.agentProcessAlive !== false && live.recoveredAgentUnconfirmed !== true && live.commandRunning !== false) {
    return refuse('unknown_state', 'what runs in the worker\'s pane cannot be told; open it and resume from there');
  }
  // A pane a resume opened earlier whose task was not moved to it then.
  if (!(await rebindTaskTo(ports, rec.taskId, workerWorkspaceOf(rec)))) {
    return refuse('not_reopened', 'the task could not be moved to the worker\'s pane; try again');
  }
  if (stopped()) return refuse('not_now', 'the bot\'s work was stopped while this resume was under way');
  // A new launch of the task, on disk before the line is typed.
  let gen: number | null = null;
  try {
    gen = ports.launches?.beginLaunch({
      taskId: rec.taskId, origin: 'bot', botId: rec.botId, ownerWorkspaceId: rec.ownerWorkspaceId,
      pane: { sessionId: pane.sessionId, workspaceId: workerWorkspaceOf(rec) },
    }).gen ?? null;
  } catch (err) {
    return refuse('not_typed', `the resume was not typed: ${(err as Error).message}`);
  }
  let typed = false;
  try {
    typed = ports.typeLine(pane.sessionId, line);
  } catch {
    typed = false;
  }
  if (gen !== null) {
    if (typed) ports.launches?.launched(rec.taskId, gen, workerWorkspaceOf(rec), pane.sessionId);
    else ports.launches?.released(rec.taskId, gen);
  }
  if (!typed) return refuse('not_typed', 'the resume line could not be typed into the worker\'s pane');
  return launched(ports, rec, pane.sessionId, pane.resumeSessionId, workerWorkspaceOf(rec), by, message, onLaunched, 'folder');
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
  // A WSL pane recorded the Linux path of its folder (/mnt/c/…): the folder
  // is looked at, restored and reopened as this process names it.
  const platform = ports.platform ?? process.platform;
  const folder = sessionHostDir(pane.cwd, {}, platform);
  let exists = false;
  try {
    exists = (ports.folderExists ?? ((d: string) => fs.statSync(d).isDirectory()))(folder);
  } catch {
    exists = false;
  }
  // A folder the task's end removed comes back at the same path, so the
  // agent's per-folder conversation resumes there.
  if (!exists && ports.restoreFolder) exists = await ports.restoreFolder(rec.taskId, folder).catch(() => false);
  if (!exists) return refuse('worktree_gone', 'the task\'s worktree is gone, so there is no folder to resume the worker in; start a new task instead');
  // Another pane already runs an agent in the worktree: a second process on
  // the same conversation is never started.
  const home = normalizeResumeCwd(folder);
  // A WSL worker's agent is never attributed (agentProcessAlive unknown):
  // its running foreground command counts (isWslWorkerPane), but only in the
  // task's own pane (isTaskOwnWorkerPane, #2266): the owner's WSL terminal
  // in the folder running vim or a test does not hold the resume back.
  const recorded = rec.sessions.map((x) => x.sessionId);
  const busy = sessions.some((s) => (s.agentProcessAlive === true || (isWslWorkerPane(s) && isTaskOwnWorkerPane(s, rec.taskId, recorded, ports.sessionRecordOf)))
    && [s.spawnCwd, s.cwd].some((d) => typeof d === 'string' && d.length > 0 && normalizeResumeCwd(sessionHostDir(d, s, platform)) === home));
  if (busy) return refuse('already_running', 'an agent is already running in the task\'s worktree');
  if (stopped()) return refuse('not_now', 'the bot\'s work was stopped while this resume was under way');
  let r: Awaited<ReturnType<NonNullable<WorkerResumePorts['respawn']>>>;
  try {
    r = await ports.respawn({
      taskId: rec.taskId,
      botId: rec.botId,
      ownerWorkspaceId: rec.ownerWorkspaceId,
      title: rec.title,
      cwd: folder,
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
  return launched(ports, rec, r.sessionId, pane.resumeSessionId, r.workspaceId, by, message, onLaunched, 'newPane');
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
  where: 'folder' | 'newPane',
): Promise<WorkerResumeResult> {
  const now = ports.now ?? Date.now;
  ports.store.setState(rec.taskId, 'resumed', now());
  try {
    ports.folderResumed?.(rec.taskId);
  } catch {
    /* best effort: the folder stays kept */
  }
  onLaunched?.();
  try {
    const task = lifecycleCardTask(rec.title, rec.taskId);
    ports.note?.(rec.ownerWorkspaceId, rec.threadId, `Worker resumed: ${task}`, `${by.kind === 'owner' ? 'The owner' : 'The bot'} resumed the same conversation ${where === 'folder' ? 'in the task folder' : 'in a new pane in the task worktree'}.`, { code: 'worker.resumed', args: { by: by.kind, where, title: task } }, rec.taskId);
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

/** How the Bots page shows a reclaimed worker (BotTaskView.worker). Pure. */
export function reclaimedWorkerState(rec: ReclaimedWorker | null): 'resumable' | 'stopped' | 'resumed' | null {
  if (!rec || rec.state === 'stopping') return null;
  if (rec.state === 'resumed') return 'resumed';
  return rec.sessions.some((s) => resumeLineFor(s) !== null) ? 'resumable' : 'stopped';
}

/** Stop the resumed workers of one bot, or of every bot (the owner's stop,
 *  a bot's stop_my_work): their rows ended long ago, so the ledger stop does
 *  not reach them. A resume still under way launches nothing more. How many
 *  this call stopped (`taskIds`: their tasks, so a stop that also reached
 *  the task by its row counts the worker once), and how many it could not
 *  (still resumed: a later stop tries again). A worker whose agent was
 *  already gone (its pane closed, its agent exited) is marked stopped but
 *  not counted. */
export async function stopResumedWorkers(ports: WorkerResumePorts, botId?: string): Promise<{ stopped: number; failed: number; taskIds: string[] }> {
  if (botId === undefined) stopAllSeq++;
  else botStopSeq.set(botId, (botStopSeq.get(botId) ?? 0) + 1);
  return stopResumedWhere(ports, (rec) => botId === undefined || rec.botId === botId);
}

/** The same for one task's resumed worker (the owner's Stop worker): a
 *  task that reopened after its worker was resumed keeps the resume record
 *  `resumed`, which the idle stop, the exit sweep and Resume read, so its
 *  stop marks it stopped too. A resume of that task under way launches
 *  nothing more; the bot's other resumes go on. */
export async function stopResumedWorker(ports: WorkerResumePorts, taskId: string): Promise<{ stopped: number; failed: number; taskIds: string[] }> {
  taskStopSeq.set(taskId, (taskStopSeq.get(taskId) ?? 0) + 1);
  return stopResumedWhere(ports, (rec) => rec.taskId === taskId);
}

async function stopResumedWhere(ports: WorkerResumePorts, which: (rec: ReclaimedWorker) => boolean): Promise<{ stopped: number; failed: number; taskIds: string[] }> {
  if (!ports.stopAgent) return { stopped: 0, failed: 0, taskIds: [] };
  const now = ports.now ?? Date.now;
  const taskIds: string[] = [];
  let marked = false;
  let failed = 0;
  // Read only when a pane may be closed (a WSL worker, isWslWorkerPane).
  let live: WorkerSessionInfo[] | null = null;
  for (const rec of ports.store.all()) {
    if (rec.state !== 'resumed' || !which(rec)) continue;
    if (ports.closePane && !live) live = await ports.listSessions().catch(() => []);
    const { ok, stoppedHere } = await stopRecordedPanes(ports, rec, live, true);
    if (!ok) failed++;
    else if (ports.store.setState(rec.taskId, 'stopped', now())) {
      marked = true;
      if (stoppedHere) taskIds.push(rec.taskId);
    }
  }
  if (marked) ports.changed?.();
  return { stopped: taskIds.length, failed, taskIds };
}

/** Stop the agent of every recorded pane of a resumed worker. A WSL worker's
 *  pane (isWslWorkerPane in `live`) of its own workspace is closed instead
 *  when `mayClose`. `ok`: every pane's agent is stopped or its pane is gone;
 *  `stoppedHere`: an agent was found and stopped. */
async function stopRecordedPanes(
  ports: Pick<WorkerResumePorts, 'stopAgent' | 'closePane' | 'workspacePanes'>,
  rec: ReclaimedWorker,
  live: readonly WorkerSessionInfo[] | null,
  mayClose: boolean,
): Promise<{ ok: boolean; stoppedHere: boolean }> {
  const stopAgent = ports.stopAgent;
  if (!stopAgent) return { ok: false, stoppedHere: false };
  let ok = true;
  let stoppedHere = false;
  for (const s of rec.sessions) {
    const closable = mayClose && isWslWorkerPane(live?.find((x) => x.id === s.sessionId))
      && ownPane(ports.workspacePanes, workerWorkspaceOf(rec), s.sessionId);
    const r: { ok?: boolean; stopped?: boolean; code?: string } = await stopOrClose(stopAgent, closable ? ports.closePane : undefined, s.sessionId).catch(() => ({ ok: false }));
    // A pane that is gone took its agent with it (a stop of its open task
    // may have closed it first).
    if (r.ok !== true && r.code !== 'no_session') ok = false;
    if (r.ok === true && r.stopped === true) stoppedHere = true;
  }
  return { ok, stoppedHere };
}

export interface ResumedIdlePorts extends Pick<WorkerResumePorts, 'store' | 'stopAgent' | 'closePane' | 'workspacePanes' | 'note' | 'changed' | 'now'> {
  /** The task's ledger row now (null: gone). */
  row: (taskId: string) => LedgerEntry | null;
  /** What main knows of a pane's activity (workerPanesIdle). */
  paneActivity: (sessionId: string) => PaneActivity;
  /** Whether the owner is viewing the workspace now (the active one, or the
   *  one the Bots worker panel shows; unknown: false) and typed into it or
   *  focused it within VIEWED_ATTENTION_MS (viewProtects): such a worker
   *  is not stopped as idle. Absent: never. */
  viewed?: (workspaceId: string) => boolean;
  /** Default RESUMED_IDLE_MS. */
  idleMs?: number;
  log?: (msg: string) => void;
}

export interface ResumedIdleSweep {
  /** Look at every resumed worker against `sessions` (daemon.listSessions,
   *  read once by the caller) and stop those idle for the window. Never
   *  throws; the tasks whose worker this pass stopped. A call while a pass
   *  runs does nothing. */
  sweep(sessions: readonly WorkerSessionInfo[]): Promise<string[]>;
}

/**
 * The idle stop of resumed workers. A resumed worker of an ended task counts
 * against the agent cap until its agent exits, and an idle Claude never
 * exits; so a resumed worker is stopped again once it has sat idle for
 * `idleMs`, by the reported-task stop's test (workerPanesIdle, its floor the
 * resume): each recorded pane whose agent runs (or a WSL worker's pane,
 * isWslWorkerPane) reported the end of its last turn (a command the agent
 * runs is part of its turn), nothing happened in it for `idleMs` since, and
 * the owner is not viewing its workspace (the active one, or the one the Bots
 * worker panel shows). Silence alone never is.
 * Only a worker whose task is still the end it was resumed from (a task that
 * reopened is its open row's worker again; one still reported for review is
 * stopped like a reported worker), with no resume or clear of it under way.
 * The stop is the reclaim's: session.stopAgent keeps the pane and its resume
 * binding; a WSL worker's pane of a completed or cancelled task is closed
 * instead (#2260). The record goes back to `stopped` (resumable), which frees
 * its agent slot, and one card in the task's thread says so.
 */
export function createResumedIdleSweep(ports: ResumedIdlePorts): ResumedIdleSweep {
  const now = ports.now ?? Date.now;
  const log = ports.log ?? ((m: string) => console.warn(m));
  const idleMs = ports.idleMs ?? RESUMED_IDLE_MS;
  let running = false;

  const rowOf = (taskId: string): LedgerEntry | null | undefined => {
    try {
      return ports.row(taskId);
    } catch {
      return undefined;
    }
  };

  /** Whether the record's task is still the end it was resumed from. */
  const sameEnd = (rec: ReclaimedWorker): boolean => {
    const row = rowOf(rec.taskId);
    if (row === undefined) return false;
    if (row === null) return true;
    if (!isReclaimedSince(rec, row)) return false;
    if (row.status === 'working' || row.status === 'input_required') return false;
    return row.status !== 'review_requested' || rec.ended === 'reported';
  };

  const idle = (rec: ReclaimedWorker, panes: readonly WorkerSessionInfo[], at: number): boolean => {
    try {
      if (ports.viewed?.(workerWorkspaceOf(rec)) === true) return false;
      return workerPanesIdle(panes.map((s) => ports.paneActivity(s.id)), rec.at, at, idleMs);
    } catch {
      return false;
    }
  };

  const stop = async (rec: ReclaimedWorker, sessions: readonly WorkerSessionInfo[]): Promise<boolean> => {
    const mayClose = rec.ended === 'completed' || rec.ended === 'cancelled';
    const { ok } = await stopRecordedPanes(ports, rec, sessions, mayClose);
    if (!ok) {
      log(`[factory] idle stop: the resumed worker of ${rec.taskId} was not stopped; it is tried again`);
      return false;
    }
    if (!ports.store.setState(rec.taskId, 'stopped', now())) return false;
    // A research task works in a task folder, not a worktree.
    const research = isResearchDispatch(rowOf(rec.taskId)?.dispatch);
    const task = lifecycleCardTask(rec.title, rec.taskId);
    try {
      ports.note?.(
        rec.ownerWorkspaceId,
        rec.threadId,
        `Worker paused (resumable): ${task}`,
        `The resumed worker sat idle after its turn: its Claude stopped again to free memory and its agent slot. The ${research ? 'task folder' : 'worktree'} and the conversation are kept; Resume continues the same conversation.`,
        { code: 'worker.idlePausedResumable', args: { title: task, ...(research ? { kind: 'research' } : {}) } },
        rec.taskId,
      );
    } catch {
      /* the card is best effort */
    }
    return true;
  };

  return {
    async sweep(sessions) {
      if (running) return [];
      running = true;
      const out: string[] = [];
      try {
        for (const rec of ports.store.all()) {
          if (rec.state !== 'resumed' || resuming.has(rec.taskId) || clearing.has(rec.taskId) || !sameEnd(rec)) continue;
          const panes = rec.sessions
            .map((p) => sessions.find((s) => s.id === p.sessionId))
            .filter((s): s is WorkerSessionInfo => !!s && (s.agentProcessAlive === true || isWslWorkerPane(s)));
          // No agent left: the exit sweep marks it stopped.
          if (panes.length === 0 || !idle(rec, panes, now())) continue;
          // Read again right before the stop: a resume or a clear may have
          // started while an earlier stop of this pass ran.
          const cur = ports.store.get(rec.taskId);
          if (!cur || cur.state !== 'resumed' || resuming.has(rec.taskId) || clearing.has(rec.taskId)) continue;
          if (await stop(cur, sessions)) out.push(rec.taskId);
        }
        if (out.length > 0) ports.changed?.();
      } catch (err) {
        log(`[factory] idle stop of resumed workers failed: ${String(err)}`);
      } finally {
        running = false;
      }
      return out;
    },
  };
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

/** The workspaces the reclaimed workers of `botId`'s tasks in `owner` run
 *  in (a resume may open a new one): panes of the bot's own tasks after
 *  their row ended. */
export function reclaimedWorkerWorkspaces(botId: string, owner: string, store: Pick<ReclaimedWorkers, 'all'> | null | undefined = resumePorts?.store): string[] {
  return (store?.all() ?? [])
    .filter((r) => r.botId === botId && r.ownerWorkspaceId === owner)
    .map((r) => workerWorkspaceOf(r));
}

/** Whether `ptyId` is the recorded pane of a reclaimed worker of `botId`'s
 *  task in `owner`, in the workspace that worker runs in: that pane only,
 *  never another one opened there since. */
export function isReclaimedWorkerPane(botId: string, owner: string, workspaceId: string, ptyId: string, store: Pick<ReclaimedWorkers, 'all'> | null | undefined = resumePorts?.store): boolean {
  return (store?.all() ?? []).some((r) => r.botId === botId && r.ownerWorkspaceId === owner
    && workerWorkspaceOf(r) === workspaceId && r.sessions.some((s) => s.sessionId === ptyId));
}

/** The reclaimed worker of a bot's task whose recorded pane `ptyId` is, in
 *  the workspace that worker runs in (that pane only), or null. */
export function reclaimedWorkerOfPane(workspaceId: string, ptyId: string, store: Pick<ReclaimedWorkers, 'all'> | null | undefined = resumePorts?.store): ReclaimedWorker | null {
  return (store?.all() ?? []).find((r) => workerWorkspaceOf(r) === workspaceId && r.sessions.some((s) => s.sessionId === ptyId)) ?? null;
}
