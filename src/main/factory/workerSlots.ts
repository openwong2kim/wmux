// ─── Each task's launch generation and its panes, on disk (#2393) ──────────
//
// The live-worker caps need to know, across a restart, which task a pane or a
// workspace belongs to and when the task's worker was last launched. Until
// now that was pieced together from ledger rows (whose edit time and revision
// move on any write), reclaim records and in-memory maps that a restart
// empties. This file records it where the launch happens:
//
//   - one entry per task: its launch generation (`gen`, bumped on every
//     launch, respawn and resume), when that launch began, who started it,
//     and its state;
//   - the task and generation of every task pane, bot worker or owner
//     fan-out, keyed by the pane's session, written at the pane's create
//     before the session exists: a pane moved to another workspace keeps
//     its record, so its task is read, never inferred;
//   - the same for every task workspace. The lineage stamp
//     (fanoutGuards.ts) carries it too, but an older build rewrites that
//     file without it; this one it never touches.
//
// An entry is written synchronously before the launch; a write that fails
// refuses the launch. A launch's later callback names its generation, and
// one from an older generation (a respawn ran since) is ignored.
//
// `<wmuxDir>/factory/worker-slots.json`, version 1. An older build ignores
// it. A file a newer version wrote is never written over: entries then live
// in memory only and launches go on. A file no version can read is moved
// aside, and while it cannot be, every launch is refused. With no file, the
// entries are rebuilt from the ledger rows once.

import { holderInputsChanged } from './holderInputs';
import fs from 'node:fs';
import path from 'node:path';
import { atomicReadJSONSync, atomicWriteJSONSync } from '../../daemon/util/atomicWrite';
import { readVersionedFile } from './versionedFile';
import { getWmuxDir } from '../../daemon/config';
import type { LedgerEntry } from '../../shared/ledger';
import { getTaskLedger } from '../deck/taskLedgerHost';
import { botWorkerSessionRecord } from '../agents/botWorkerMergeGuard';
import { getWorkspaceMirror } from '../workspace/WorkspaceMirror';
import { AGENT_ROWS, agentLauncherStem } from '../../shared/agentIdentity';
import { launcherStem, tokenize } from '../../shared/agentResume';
import { splitModelEnvMarker } from '../../shared/workerLaunch';

export const WORKER_SLOTS_FILENAME = 'worker-slots.json';
export const WORKER_SLOTS_VERSION = 1 as const;
/** Entries kept (released ones dropped first, then the oldest). */
export const WORKER_SLOTS_MAX = 1000;
/** Pane records kept (the oldest dropped first). */
export const WORKER_PANES_MAX = 1000;
/** An unreadable file is moved aside with this many tries at load (a lock
 *  an antivirus or backup tool holds is often brief), then once more at each
 *  launch while it still cannot be. */
const MOVE_ASIDE_TRIES = 3;
const MOVE_ASIDE_PAUSE_MS = 50;
/** Writes after a launch (its pane came up, it did not happen) are coalesced
 *  into one, this long after the first; a write that gates a launch is made
 *  at once and takes them with it. */
const PERSIST_DELAY_MS = 200;

export type TaskLaunchState = 'launching' | 'launched' | 'released';

export interface TaskLaunch {
  taskId: string;
  /** 1 for the first launch, +1 on each respawn and resume. */
  gen: number;
  /** When this generation's launch began (epoch ms). */
  launchedAt: number;
  origin: 'bot' | 'owner';
  botId?: string;
  ownerWorkspaceId: string;
  /** launching: written, the spawn under way; launched: its pane came up;
   *  released: the launch did not happen (refused or failed). */
  state: TaskLaunchState;
}

export interface TaskPane {
  taskId: string;
  gen: number;
  /** The workspace it was created in. */
  workspaceId: string;
}

const isState = (v: unknown): v is TaskLaunchState => v === 'launching' || v === 'launched' || v === 'released';

function isLaunch(v: unknown): v is TaskLaunch {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.taskId === 'string' && r.taskId.length > 0
    && typeof r.gen === 'number' && Number.isInteger(r.gen) && r.gen >= 1
    && typeof r.launchedAt === 'number' && Number.isFinite(r.launchedAt)
    && (r.origin === 'bot' || r.origin === 'owner')
    && (r.botId === undefined || typeof r.botId === 'string')
    && typeof r.ownerWorkspaceId === 'string' && isState(r.state);
}

function isPane(v: unknown): v is TaskPane {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.taskId === 'string' && r.taskId.length > 0
    && typeof r.gen === 'number' && Number.isInteger(r.gen) && r.gen >= 1
    && typeof r.workspaceId === 'string';
}

export interface LaunchRequest {
  taskId: string;
  origin: 'bot' | 'owner';
  botId?: string;
  ownerWorkspaceId: string;
  /** A relaunch in an existing pane: the pane and its workspace name the
   *  new generation in the same write, before the line is typed. */
  pane?: { sessionId: string; workspaceId: string };
}

/** The task and generation a workspace was created (or relaunched) for. */
export interface TaskRef {
  taskId: string;
  gen: number;
}

export class WorkerSlots {
  private readonly tasks = new Map<string, TaskLaunch>();
  private readonly panes = new Map<string, TaskPane>();
  private readonly workspaces = new Map<string, TaskRef>();
  /** `memory`: a newer version's file is on disk, entries live in memory and
   *  launches go on; `broken`: the file could not be read nor moved aside,
   *  so nothing can be recorded and every launch is refused. */
  private mode: 'disk' | 'memory' | 'broken' = 'disk';
  /** Launches begun in this run and not settled yet: task → generation. */
  private readonly underway = new Map<string, number>();
  /** Relaunches in an existing pane begun in this run: task → generation.
   *  Such a launch claims no workspace (see setWorkspace). */
  private readonly relaunches = new Map<string, number>();
  /** Workspaces a refused reassign was logged for (once each). */
  private readonly refusedWarned = new Set<string>();
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly file: string,
    private readonly rows: () => readonly LedgerEntry[] = () => [],
    private readonly warn: (line: string) => void = (l) => console.warn(l),
    private readonly now: () => number = Date.now,
  ) {}

  static at(wmuxDir: string, rows?: () => readonly LedgerEntry[]): WorkerSlots {
    return new WorkerSlots(path.join(wmuxDir, 'factory', WORKER_SLOTS_FILENAME), rows);
  }

  /** Read the file. Missing: rebuilt from the ledger rows and written. A
   *  newer version's: kept in memory only, never written over. Unreadable:
   *  moved aside, then rebuilt. Never throws. */
  load(): void {
    this.tasks.clear();
    this.panes.clear();
    this.workspaces.clear();
    let raw: Record<string, unknown> | null = null;
    try {
      raw = readVersionedFile(this.file, WORKER_SLOTS_VERSION);
      this.mode = 'disk';
    } catch (err) {
      if (this.newerVersionOnDisk()) {
        // Memory only, seeded from the ledger below; the file is never written.
        this.mode = 'memory';
        this.warn(`[factory] worker slots not read, kept in memory only: ${String(err)}`);
      } else {
        const moveErr = this.moveAside(MOVE_ASIDE_TRIES);
        if (moveErr) {
          this.mode = 'broken';
          this.warn(`[factory] worker slots unreadable and not moved aside; each launch tries again, and none starts until it can: ${String(err)}; ${String(moveErr)}`);
          return;
        }
        this.mode = 'disk';
        this.warn(`[factory] worker slots unreadable, moved aside and rebuilt from the task ledger: ${String(err)}`);
      }
      raw = null;
    }
    if (raw) {
      for (const t of Array.isArray(raw.tasks) ? raw.tasks : []) if (isLaunch(t)) this.tasks.set(t.taskId, { ...t });
      const panes = raw.panes && typeof raw.panes === 'object' && !Array.isArray(raw.panes) ? raw.panes as Record<string, unknown> : {};
      for (const [id, p] of Object.entries(panes)) if (id && isPane(p)) this.panes.set(id, { taskId: p.taskId, gen: p.gen, workspaceId: p.workspaceId });
      const spaces = raw.workspaces && typeof raw.workspaces === 'object' && !Array.isArray(raw.workspaces) ? raw.workspaces as Record<string, unknown> : {};
      for (const [id, w] of Object.entries(spaces)) if (id && isRef(w)) this.workspaces.set(id, { taskId: w.taskId, gen: w.gen });
    }
    // Rows this file does not name yet (none at the first start; tasks an
    // older build started after a downgrade): seeded from the ledger.
    this.seed();
  }

  /** Move the unreadable file aside, trying `tries` times; the last error, or
   *  null once it is moved (or gone). */
  private moveAside(tries: number): unknown {
    let last: unknown = null;
    for (let i = 0; i < tries; i++) {
      if (i > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, MOVE_ASIDE_PAUSE_MS);
      try {
        if (fs.existsSync(this.file)) fs.renameSync(this.file, `${this.file}.unreadable-${this.now()}`);
        return null;
      } catch (err) {
        last = err;
      }
    }
    return last;
  }

  /** One entry per ledger row the record does not hold yet, generation 1,
   *  timed by the row's last write, with its workspace: every open row, and
   *  the newest ended ones while the bound has room. Written when any was
   *  added. */
  private seed(): void {
    let rows: readonly LedgerEntry[] = [];
    try {
      rows = this.rows();
    } catch (err) {
      this.warn(`[factory] worker slots not rebuilt from the task ledger: ${String(err)}`);
    }
    const isOpen = (r: LedgerEntry): boolean => r.status === 'working' || r.status === 'input_required' || r.status === 'review_requested';
    // The rows kept: every open one, then the newest ended ones while the
    // bound has room. Inserted oldest first, as the bound drops the first.
    const order = [...rows].sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)) || b.updatedAt - a.updatedAt);
    const kept: LedgerEntry[] = [];
    let room = WORKER_SLOTS_MAX - this.tasks.size;
    for (const r of order) {
      if (this.tasks.has(r.id)) continue;
      if (!isOpen(r) && room <= 0) break;
      kept.push(r);
      room--;
    }
    kept.sort((a, b) => a.updatedAt - b.updatedAt);
    let added = false;
    for (const r of kept) {
      added = true;
      if (r.taskWorkspaceId && !this.workspaces.has(r.taskWorkspaceId)) this.workspaces.set(r.taskWorkspaceId, { taskId: r.id, gen: 1 });
      const origin = r.dispatch?.origin;
      const bot = origin?.kind === 'bot' && typeof origin.botId === 'string' && origin.botId.length > 0;
      const open = isOpen(r);
      this.tasks.set(r.id, {
        taskId: r.id,
        gen: 1,
        launchedAt: r.updatedAt,
        origin: bot ? 'bot' : 'owner',
        ...(bot ? { botId: origin.botId } : {}),
        ownerWorkspaceId: r.ownerWorkspaceId,
        state: open ? 'launched' : 'released',
      });
    }
    if (!added) return;
    this.bound();
    trim(this.workspaces, WORKER_PANES_MAX);
    try {
      this.write();
    } catch (err) {
      this.warn(`[factory] worker slots seeded from the task ledger but not written: ${String(err)}`);
    }
  }

  private newerVersionOnDisk(): boolean {
    try {
      const v = atomicReadJSONSync<{ version?: unknown }>(this.file)?.version;
      return typeof v === 'number' && v > WORKER_SLOTS_VERSION;
    } catch {
      return false;
    }
  }

  /** A task's launch now, or null. */
  launchOf(taskId: string): TaskLaunch | null {
    const t = this.tasks.get(taskId);
    return t ? { ...t } : null;
  }

  /** When the task's worker came up or is coming up now: a launched entry's
   *  launch time, or a launching one's while that launch is under way in
   *  this run. A released entry, or one left launching by a crash, starts
   *  nothing. */
  liveLaunchAt(taskId: string): number | undefined {
    const t = this.tasks.get(taskId);
    if (!t) return undefined;
    if (t.state === 'launched') return t.launchedAt;
    return t.state === 'launching' && this.underway.get(taskId) === t.gen ? t.launchedAt : undefined;
  }

  /** The task and generation a pane was created (or relaunched) for. */
  paneOf(sessionId: string): TaskPane | null {
    const p = this.panes.get(sessionId);
    return p ? { ...p } : null;
  }

  /** The task and generation a workspace was created (or relaunched) for. */
  workspaceOf(workspaceId: string): TaskRef | null {
    const w = this.workspaces.get(workspaceId);
    return w ? { ...w } : null;
  }

  /** The launch a task pane's create names (its spawn carried it), checked:
   *  THROWS when that launch was abandoned (its spawn timed out or failed)
   *  or a newer one replaced it, so its pane is not started. */
  claimLaunch(token: TaskRef): TaskRef {
    const t = this.tasks.get(token.taskId);
    if (!t || t.gen !== token.gen || t.state === 'released') {
      throw new Error(`PTY_CREATE: the launch this task pane is for was abandoned (${token.taskId}, generation ${token.gen})`);
    }
    return { taskId: token.taskId, gen: token.gen };
  }

  /** A launch (a first spawn, a respawn or a resume) is about to start: its
   *  generation is bumped and written now. THROWS when it cannot be written:
   *  the caller does not launch. */
  beginLaunch(req: LaunchRequest): { gen: number; launchedAt: number } {
    const prior = this.tasks.get(req.taskId);
    // Above every generation a pane or workspace of the task still names,
    // so a generation never goes back (an entry dropped by the bound).
    let top = prior?.gen ?? 0;
    for (const p of this.panes.values()) if (p.taskId === req.taskId && p.gen > top) top = p.gen;
    for (const w of this.workspaces.values()) if (w.taskId === req.taskId && w.gen > top) top = w.gen;
    const next: TaskLaunch = {
      taskId: req.taskId,
      gen: top + 1,
      launchedAt: this.now(),
      origin: req.origin,
      ...(req.botId ? { botId: req.botId } : {}),
      ownerWorkspaceId: req.ownerWorkspaceId,
      state: 'launching',
    };
    if (this.mode === 'broken') {
      // The file may be free again (a lock that held it at load is gone).
      const moveErr = this.moveAside(1);
      if (moveErr) throw new Error(`the task's launch could not be recorded: ${this.file} is unreadable and could not be moved aside: ${String(moveErr)}`);
      this.mode = 'disk';
      this.warn(`[factory] worker slots unreadable file moved aside; rebuilt from the task ledger`);
      this.tasks.clear();
      this.panes.clear();
      this.workspaces.clear();
      this.seed();
      return this.beginLaunch(req);
    }
    const before = this.snapshot();
    this.tasks.delete(req.taskId);
    this.tasks.set(req.taskId, next);
    if (req.pane) {
      this.setPane(req.pane.sessionId, { taskId: req.taskId, gen: next.gen, workspaceId: req.pane.workspaceId });
      if (req.pane.workspaceId) this.setWorkspace(req.pane.workspaceId, { taskId: req.taskId, gen: next.gen }, false);
    }
    this.bound();
    try {
      this.write();
    } catch (err) {
      this.restore(before);
      throw new Error(`the task's launch could not be recorded: ${String(err)}`);
    }
    this.underway.set(req.taskId, next.gen);
    if (req.pane) this.relaunches.set(req.taskId, next.gen);
    else this.relaunches.delete(req.taskId);
    return { gen: next.gen, launchedAt: next.launchedAt };
  }

  /** The launch of `gen` brought its pane up in `workspaceId`. Ignored (false)
   *  when a newer launch of the task began since. */
  launched(taskId: string, gen: number, workspaceId: string, sessionId?: string): boolean {
    const t = this.tasks.get(taskId);
    if (this.underway.get(taskId) === gen) this.underway.delete(taskId);
    const relaunch = this.relaunches.get(taskId) === gen;
    if (relaunch) this.relaunches.delete(taskId);
    if (!t || t.gen !== gen) return false;
    this.tasks.set(taskId, { ...t, state: 'launched' });
    if (sessionId) this.setPane(sessionId, { taskId, gen, workspaceId });
    this.setWorkspace(workspaceId, { taskId, gen }, !relaunch);
    this.persist();
    return true;
  }

  /** A task pane's create (pty:create): the pane and its workspace are the
   *  launch's its spawn named, recorded before the session exists. THROWS
   *  when that launch was abandoned or replaced (claimLaunch) or the record
   *  cannot be written: the create fails. */
  recordCreate(token: TaskRef, workspaceId: string, sessionId: string): TaskRef {
    const ref = this.claimLaunch(token);
    const before = this.snapshot();
    this.setPane(sessionId, { taskId: ref.taskId, gen: ref.gen, workspaceId });
    this.setWorkspace(workspaceId, ref);
    try {
      this.write();
    } catch (err) {
      this.restore(before);
      throw new Error(`PTY_CREATE: the task pane could not be recorded: ${String(err)}`);
    }
    return { ...ref };
  }

  /** The launch of `gen` did not happen. Ignored (false) when a newer launch
   *  began since. */
  released(taskId: string, gen: number): boolean {
    const t = this.tasks.get(taskId);
    if (this.underway.get(taskId) === gen) this.underway.delete(taskId);
    if (this.relaunches.get(taskId) === gen) this.relaunches.delete(taskId);
    if (!t || t.gen !== gen) return false;
    this.tasks.set(taskId, { ...t, state: 'released' });
    this.persist();
    return true;
  }

  /** The three maps as they are (entries and order), for a gating write
   *  that fails to put back, evictions by the bound included. */
  private snapshot(): { tasks: Map<string, TaskLaunch>; panes: Map<string, TaskPane>; workspaces: Map<string, TaskRef> } {
    return { tasks: new Map(this.tasks), panes: new Map(this.panes), workspaces: new Map(this.workspaces) };
  }

  private restore(s: ReturnType<WorkerSlots['snapshot']>): void {
    holderInputsChanged();
    for (const [from, to] of [[s.tasks, this.tasks], [s.panes, this.panes], [s.workspaces, this.workspaces]] as Array<[Map<string, unknown>, Map<string, unknown>]>) {
      to.clear();
      for (const [k, v] of from) to.set(k, v);
    }
  }

  private setPane(sessionId: string, pane: TaskPane): void {
    this.panes.delete(sessionId);
    this.panes.set(sessionId, { ...pane });
    trim(this.panes, WORKER_PANES_MAX);
  }

  /** Records a workspace as the task's. A workspace recorded for another
   *  task is never reassigned (an adopted pane resumed where it now is, in
   *  another task's workspace): the pane record alone names the task, so a
   *  workspace's record and its row never name two tasks. `claim` false (a
   *  relaunch in an existing pane): only a workspace already this task's is
   *  refreshed; one recorded for none (the owner's) is never claimed. */
  private setWorkspace(workspaceId: string, ref: TaskRef, claim = true): void {
    const cur = this.workspaces.get(workspaceId);
    if (cur && cur.taskId !== ref.taskId) {
      if (!this.refusedWarned.has(workspaceId)) {
        this.refusedWarned.add(workspaceId);
        this.warn(`[factory] worker slots: workspace ${workspaceId} stays task ${cur.taskId}'s; task ${ref.taskId} is recorded by its pane only`);
      }
      return;
    }
    if (!cur && !claim) return;
    this.workspaces.delete(workspaceId);
    this.workspaces.set(workspaceId, { taskId: ref.taskId, gen: ref.gen });
    trim(this.workspaces, WORKER_PANES_MAX);
  }


  /** Past the bound, released entries go first, then the oldest; a task
   *  whose pane or workspace is still recorded keeps its generation through
   *  them (beginLaunch). */
  private bound(): void {
    if (this.tasks.size <= WORKER_SLOTS_MAX) return;
    for (const [id, t] of this.tasks) {
      if (this.tasks.size <= WORKER_SLOTS_MAX) return;
      if (t.state === 'released') this.tasks.delete(id);
    }
    trim(this.tasks, WORKER_SLOTS_MAX);
  }

  private write(): void {
    holderInputsChanged();
    if (this.mode === 'memory') return;
    if (this.mode === 'broken') throw new Error(`${this.file} is unreadable and could not be moved aside`);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    atomicWriteJSONSync(this.file, {
      version: WORKER_SLOTS_VERSION,
      tasks: [...this.tasks.values()],
      panes: Object.fromEntries(this.panes),
      workspaces: Object.fromEntries(this.workspaces),
    });
    // Written: it took any coalesced write with it (one that failed leaves
    // that one pending).
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
  }

  /** A write after the launch, coalesced (PERSIST_DELAY_MS): a failure is
   *  logged, the entries stay in memory. */
  private persist(): void {
    holderInputsChanged();
    if (this.persistTimer) return;
    const t = setTimeout(() => {
      this.persistTimer = null;
      try {
        this.write();
      } catch (err) {
        this.warn(`[factory] worker slots not written: ${String(err)}`);
      }
    }, PERSIST_DELAY_MS);
    t.unref?.();
    this.persistTimer = t;
  }

  /** Tests: make a coalesced write now. */
  flushForTests(): void {
    if (this.persistTimer) this.write();
  }
}

/** Drop the oldest entries past `max`. */
function trim<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

/** Whether the launch a task pane's create named (its `fanoutLaunch`) is
 *  still the task's current one, right before its agent line is typed: a
 *  spawn that timed out meanwhile, or a newer launch, makes it stale and
 *  nothing is typed. True for a pane that named no launch. Never throws. */
export function launchStillCurrent(fanoutLaunch: unknown): boolean {
  const token = parseLaunchToken(fanoutLaunch);
  if (!token) return true;
  try {
    const t = getWorkerSlots().launchOf(token.taskId);
    return !!t && t.gen === token.gen && t.state !== 'released';
  } catch {
    return false;
  }
}

/** A launch token a spawn carries to its pane's create, or null. */
export function parseLaunchToken(v: unknown): TaskRef | null {
  return isRef(v) ? { taskId: v.taskId, gen: v.gen } : null;
}

function isRef(v: unknown): v is TaskRef {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return typeof r.taskId === 'string' && r.taskId.length > 0 && typeof r.gen === 'number' && Number.isInteger(r.gen) && r.gen >= 1;
}

let hosted: WorkerSlots | null = null;

/** The hosted store, loaded on first use (rebuilt from the hosted ledger
 *  when its file is missing). */
export function getWorkerSlots(): WorkerSlots {
  if (!hosted) {
    hosted = WorkerSlots.at(getWmuxDir(), () => getTaskLedger().list({}));
    hosted.load();
  }
  return hosted;
}

/** Tests only: swap the hosted store (null = re-create lazily). */
export function setWorkerSlotsForTests(next: WorkerSlots | null): void {
  hosted = next;
}

const AGENT_STEMS: ReadonlySet<string> = new Set(AGENT_ROWS.map(agentLauncherStem));

/** Whether a typed line starts an agent CLI (after any `VAR=value` and
 *  `env` words): text pasted into a running agent, or the arguments a
 *  second stage appends, is no launch. Pure. */
export function startsAgent(line: string): boolean {
  // A launch that pins its model starts with main's env marker.
  for (const t of tokenize(splitModelEnvMarker(line.trim()).command.trim())) {
    if (t.value === 'env' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t.value)) continue;
    return AGENT_STEMS.has(launcherStem(t.value));
  }
  return false;
}

/** A launch line is about to be typed into an existing pane (pty:write-launch,
 *  worktask:refire): when the pane is a task's, that is a new launch of the
 *  task, recorded now with the pane and its workspace. THROWS when it cannot
 *  be recorded (nothing is typed). Returns how to settle it once typed, or
 *  null for a pane no task is known for. */
export function beginPaneRelaunch(sessionId: string): ((typed: boolean) => void) | null {
  const slots = getWorkerSlots();
  const pane = slots.paneOf(sessionId);
  const bot = pane ? null : botWorkerSessionRecord(sessionId);
  // A pane created before panes were recorded: the task of the workspace
  // that holds it, only when that workspace is a task's and its record and
  // its ledger row agree on which (a pane moved into another task's or the
  // owner's workspace is not known, never taken as the wrong task's).
  const holder = pane || bot?.taskId ? null : getWorkspaceMirror().getEntries()?.find((e) => Array.isArray(e.ptyIds) && e.ptyIds.includes(sessionId))?.id;
  const held = holder ? slots.workspaceOf(holder) : null;
  const heldTask = held && getTaskLedger().findByTaskWorkspace(holder as string)?.id === held.taskId ? held.taskId : undefined;
  const taskId = pane?.taskId ?? bot?.taskId ?? heldTask;
  if (!taskId) return null;
  const prior = slots.launchOf(taskId);
  const workspaceId = pane?.workspaceId ?? bot?.workspaceId ?? holder ?? '';
  const { gen } = slots.beginLaunch({
    taskId,
    origin: prior?.origin ?? (bot ? 'bot' : 'owner'),
    ...(prior?.botId ? { botId: prior.botId } : {}),
    ownerWorkspaceId: prior?.ownerWorkspaceId ?? '',
    pane: { sessionId, workspaceId },
  });
  return (typed) => {
    if (typed) slots.launched(taskId, gen, workspaceId, sessionId);
    else slots.released(taskId, gen);
  };
}

/** The task and generation a pane belongs to: its own record, else the bot
 *  worker session record its create wrote (generation unknown). */
export function taskOfPane(sessionId: string): { taskId: string; gen?: number } | null {
  try {
    const p = getWorkerSlots().paneOf(sessionId);
    if (p) return { taskId: p.taskId, gen: p.gen };
    const t = botWorkerSessionRecord(sessionId)?.taskId;
    return t ? { taskId: t } : null;
  } catch {
    return null;
  }
}
