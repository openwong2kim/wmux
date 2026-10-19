// ─── Fan-out runaway brakes: lineage mark, global caps, audit log ───────────
//
// Fan-out over the pipe runs without a human approval by default (owner
// decision 2026-09-24), so three main-side records take over the job the
// dialog used to do as a side effect:
//
//   lineage — every task workspace is stamped with the workspace that fanned
//             it out, BEFORE its agent launches. A caller whose workspace
//             carries a stamp cannot fan out again (depth-1), whatever its
//             ledger row says. A workspace a stamped caller creates inherits
//             the stamp.
//   caps    — at most FANOUT_LIVE_TASK_CAP live tasks and
//             FANOUT_HOURLY_TASK_CAP started tasks per rolling hour, app-wide.
//             Checked and reserved synchronously at claim time; over a cap the
//             call is refused (no dialog, so nothing queues up behind it).
//   audit   — one jsonl line per fan-out that is about to run: who, where,
//             what (prompt hashes, not bodies), and whether a person approved;
//             then one line with what each task actually launched.
//
// Threat model: these are brakes against loops and accidental amplification on
// the HONEST paths, not a defence against hostile local code — anything
// running as the user can edit these files or call `claude` directly. They are
// built to be correct and fail closed where the answer is uncertain (an
// unreadable lineage store refuses the fan-out, a torn caps file counts as a
// full hour), not to be spoof-proof.
//
// Storage sits beside the task ledger in the WMUX_DATA_SUFFIX-scoped wmux dir.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getWmuxDir } from '../../daemon/config';
import { atomicWriteJSONSync } from '../../daemon/util/atomicWrite';
import { getTaskLedger } from '../deck/taskLedgerHost';
import { getWorkspaceMirror } from '../workspace/WorkspaceMirror';
import { sanitizeFanoutOrigin, type FanoutLineageEntry, type FanoutOrigin } from '../../shared/fanoutOrigin';
import { BOT_ID_RE } from '../../shared/bot';
import { getWorkerSlots, parseLaunchToken, type WorkerSlots } from '../factory/workerSlots';
import { holderCounts, liveHolders, type LiveHolders, type ReservedTask } from '../factory/workerHolders';
import { holderInputsChanged } from '../factory/holderInputs';

export const FANOUT_LIVE_TASK_CAP = 8;
export const FANOUT_HOURLY_TASK_CAP = 24;
export const FANOUT_CAP_WINDOW_MS = 60 * 60 * 1000;

/** Oldest lineage stamps are dropped past this many. Task workspaces are
 *  closed long before a store this size could fill; the bound only keeps a
 *  pathological loop from growing the file without limit. */
const LINEAGE_MAX_ENTRIES = 10_000;
/** The audit log rolls to `<name>.1` past this size. */
const AUDIT_MAX_BYTES = 1024 * 1024;
/** How much of the audit log's tail the sidebar's provenance read looks at. */
const AUDIT_TAIL_BYTES = 256 * 1024;

export const FANOUT_LINEAGE_FILENAME = 'fanout-lineage.json';
export const FANOUT_CAPS_FILENAME = 'fanout-caps.json';
export const FANOUT_AUDIT_FILENAME = 'fanout-audit.jsonl';
/** Suffix a torn store is renamed to (followed by a timestamp). */
const CORRUPT_SUFFIX = '.corrupt-';

interface LineageStamp {
  owner: string;
  at: number;
  /** Who asked for the task (additive: older stamps lack it, and an older
   *  reader ignores it). Display only — the depth-1 check reads `owner`. */
  origin?: FanoutOrigin;
  /** The task the workspace was created for, and its launch generation
   *  (factory/workerSlots.ts). Additive, like `origin`. */
  taskId?: string;
  gen?: number;
}

/** The task a workspace was created for, as its stamp names it. */
export interface StampTask {
  taskId: string;
  gen: number;
}

const isStampTask = (t: unknown): t is StampTask => !!t && typeof t === 'object'
  && typeof (t as StampTask).taskId === 'string' && (t as StampTask).taskId.length > 0
  && typeof (t as StampTask).gen === 'number' && Number.isInteger((t as StampTask).gen) && (t as StampTask).gen >= 1;

interface HourlyStamp {
  /** The fan-out's scoped idempotency key (informational; not unique). */
  id: string;
  at: number;
  count: number;
}

export interface FanOutAuditRecord {
  at: number;
  /** Absent/'start' = the pre-spawn record; 'launched' = what each task ran. */
  kind?: 'start' | 'launched';
  /** The caller's own idempotency key (not the workspace-scoped one). */
  idempotencyKey: string;
  ownerWorkspaceId: string;
  /** How the caller proved who it is (`gui` = the renderer's fan-out dialog). */
  callerIdentity: 'pty' | 'commander' | 'gui';
  /** #1481 — the calling pane's ptyId when callerIdentity is 'pty'. Optional
   *  (additive): older records lack it and the sidebar falls back to a
   *  generic "an agent pane". Display only, never an authority. */
  callerPtyId?: string;
  repoPath: string;
  titles: string[];
  roles: string[];
  /** What each role resolves to under the operator's bindings, as the
   *  renderer expanded it. Empty when no task carries a role. */
  roleCommands: string[];
  /** sha256 of each task's effective prompt, index-aligned with `titles`. */
  promptSha256: string[];
  approvedBy: 'auto' | 'human';
  /** The worker permission mode the tasks launch with (Settings → Agents). */
  workerPermissionMode: string;
  /** The operator preset the caller named, when it named one (additive). */
  preset?: string;
  /** Per task: the agent CLI (+ model, + unattended) a preset or the caller's
   *  `agents[]` chose, index-aligned with `titles` (additive). */
  agents?: string[];
  /** worktree:false — the batch folder the tasks write into (additive). */
  outputBatchDir?: string;
  /** kind 'launched': the line each task's pane was actually started with. */
  launched?: FanOutLaunchedTask[];
}

/** One task of a 'launched' record. `started: false` = the task got no
 *  workspace, so nothing ran and no command is recorded. */
export type FanOutLaunchedTask =
  | { title: string; workspaceId: string; command?: string; error?: string }
  | { title: string; started: false; error?: string };

/**
 * A task's entry in the 'launched' record. A task that got no workspace (its
 * pane could not be created, its worktree preflight failed) launched nothing:
 * it is marked `started: false` and carries no command, so the record cannot
 * be read as a run.
 */
export function launchedAuditTask(t: {
  title: string;
  workspaceId?: string;
  initialCommand?: string;
  error?: string;
}): FanOutLaunchedTask {
  const error = t.error ? { error: t.error } : {};
  if (!t.workspaceId) return { title: t.title, started: false, ...error };
  return {
    title: t.title,
    workspaceId: t.workspaceId,
    ...(t.initialCommand ? { command: t.initialCommand } : {}),
    ...error,
  };
}

export type CapReservation = { ok: true } | { ok: false; message: string };

export interface FanOutGuardsOptions {
  /** Data dir. Defaults to the wmux dir. */
  dir?: string;
  now?: () => number;
  /** Open workspace ids, or null when unknown (renderer not up yet). Defaults
   *  to the main-side workspace mirror. */
  openWorkspaceIds?: () => string[] | null;
  /** Override for the live-task count (tests). Defaults to "stamped task
   *  workspaces that are still open". */
  countLiveTasks?: () => number;
  /** Owner of `workspaceId` if the ledger knows it as a task workspace (any
   *  status). Defaults to the hosted ledger. */
  ledgerTaskOwner?: (workspaceId: string) => string | null;
  /** The ledger row of `workspaceId`'s task when a factory bot dispatched it
   *  (dispatch origin `bot`), else null. Defaults to the hosted ledger. */
  ledgerBotTask?: (workspaceId: string) => { owner: string; botId: string; at: number } | null;
  /** The title and status of `workspaceId`'s task (any status), or null: what
   *  a live-cap refusal names. Defaults to the hosted ledger. */
  ledgerTaskOf?: (workspaceId: string) => { title: string; status: string } | null;
}

function hostedLedgerTaskOf(workspaceId: string): { title: string; status: string } | null {
  const row = getTaskLedger().findByTaskWorkspace(workspaceId);
  return row ? { title: row.title, status: row.status } : null;
}

/** What holds the live fan-out slots, for the cap's refusal. */
export interface LiveSlotHolders {
  /** Titles of open (not yet ended) tasks: they hold a slot whether or not
   *  an agent runs in them. */
  open: string[];
  /** Titles of tasks that ended (completed, cancelled, failed) whose
   *  workspace is not known to run no agent. */
  ended: string[];
  /** Open task workspaces whose task row is not known (a launch under way,
   *  or one whose row was never written). */
  untracked: number;
  /** Tasks of fan-outs still being started. */
  starting: number;
}

/** Names shown per group of a live-cap refusal; the rest are counted. */
const HOLDER_TITLES_SHOWN = 3;

function titleList(titles: readonly string[]): string {
  const shown = titles.slice(0, HOLDER_TITLES_SHOWN).map((t) => `"${t}"`).join(', ');
  return titles.length > HOLDER_TITLES_SHOWN ? `${shown} and ${titles.length - HOLDER_TITLES_SHOWN} more` : shown;
}

/** The live cap's refusal: what holds the slots (when known) and how one
 *  frees. Pure. */
export function liveCapMessage(live: number, count: number, holders: LiveSlotHolders | null): string {
  const head =
    `fan-out refused: at most ${FANOUT_LIVE_TASK_CAP} fan-out tasks may be live at once across wmux ` +
    `(${live} live now, ${count} requested).`;
  // A task that ended and runs no agent holds no slot, so every holder named
  // here frees its slot this way.
  const frees = ' A slot frees when a task ends and its agent stops, or when its task workspace is closed.';
  if (!holders) return `${head}${frees}`;
  const parts: string[] = [];
  if (holders.open.length > 0) parts.push(`${holders.open.length} open (${titleList(holders.open)})`);
  if (holders.ended.length > 0) {
    parts.push(`${holders.ended.length} ended whose agent is not known to have stopped (${titleList(holders.ended)})`);
  }
  if (holders.untracked > 0) parts.push(`${holders.untracked} task ${holders.untracked === 1 ? 'workspace' : 'workspaces'} with no task record`);
  if (holders.starting > 0) parts.push(`${holders.starting} starting`);
  const held = parts.length > 0 ? ` Held by: ${parts.join('; ')}.` : '';
  return `${head}${held}${frees}`;
}

function hostedLedgerBotTask(workspaceId: string): { owner: string; botId: string; at: number } | null {
  const row = getTaskLedger().findByTaskWorkspace(workspaceId);
  const origin = row?.dispatch?.origin;
  if (!row || origin?.kind !== 'bot' || typeof origin.botId !== 'string' || !BOT_ID_RE.test(origin.botId)) return null;
  return { owner: row.ownerWorkspaceId, botId: origin.botId, at: row.updatedAt };
}

/** sha256 hex of a prompt body — what the audit log records instead of it. */
export function promptDigest(prompt: string): string {
  return createHash('sha256').update(prompt, 'utf8').digest('hex');
}

function formatClock(ms: number): string {
  return new Date(ms).toISOString().slice(11, 16) + ' UTC';
}

export class FanOutGuards {
  private readonly dir: string;
  private readonly now: () => number;
  private readonly openWorkspaceIds: () => string[] | null;
  private readonly countLiveOverride?: () => number;
  private readonly ledgerTaskOwner: (workspaceId: string) => string | null;
  private readonly ledgerBotTask: (workspaceId: string) => { owner: string; botId: string; at: number } | null;
  private readonly ledgerTaskOf: (workspaceId: string) => { title: string; status: string } | null;

  /** null until first read. */
  private lineage: Map<string, LineageStamp> | null = null;
  private hourly: HourlyStamp[] | null = null;
  /** The bookings, one per task (#2393). `pending`: claim-time
   *  reservations, counted against BOTH caps until the fan-out starts or is
   *  dropped; `spawning`: a started fan-out's tasks not yet through their
   *  spawn (each leaves as it settles, see taskSettled). Process memory only
   *  — a booking stands for tasks that have not started, and after a restart
   *  they never will. What the holder set reads
   *  (factory/workerHolders.ts), so a booked task, the workspace it is
   *  spawned in and its ledger row are one holder. A task minted by the
   *  fan-out names its booking (bindTask) before its launch is recorded; its
   *  workspace is then the task's by that record (factory/workerSlots.ts). */
  private reserved: ReservedTask[] = [];

  constructor(opts: FanOutGuardsOptions = {}) {
    this.dir = opts.dir ?? getWmuxDir();
    this.now = opts.now ?? Date.now;
    this.openWorkspaceIds =
      opts.openWorkspaceIds ?? (() => getWorkspaceMirror().getEntries()?.map((e) => e.id) ?? null);
    this.countLiveOverride = opts.countLiveTasks;
    this.ledgerTaskOwner =
      opts.ledgerTaskOwner ??
      ((ws) => getTaskLedger().findByTaskWorkspace(ws)?.ownerWorkspaceId ?? null);
    this.ledgerBotTask = opts.ledgerBotTask ?? hostedLedgerBotTask;
    this.ledgerTaskOf = opts.ledgerTaskOf ?? hostedLedgerTaskOf;
  }

  /** Rename a torn store out of the way, so the next write starts clean and
   *  the evidence survives. Returns the new path, or null if the rename failed. */
  private quarantine(p: string): string | null {
    const dest = `${p}${CORRUPT_SUFFIX}${this.now()}`;
    try {
      fs.renameSync(p, dest);
      console.warn(`[fanout] ${path.basename(p)} was unreadable; moved it to ${dest}`);
      return dest;
    } catch (err) {
      console.warn(`[fanout] ${path.basename(p)} is unreadable and could not be moved: ${String(err)}`);
      return null;
    }
  }

  // ── lineage ──────────────────────────────────────────────────────────────

  private lineagePath(): string {
    return path.join(this.dir, FANOUT_LINEAGE_FILENAME);
  }

  /** Quarantined lineage stores still on disk. While one exists, the stamps it
   *  held are lost, so no wire caller can be shown not to be a task. */
  private quarantinedLineage(): string | null {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return null;
    }
    const hit = names.find((n) => n.startsWith(FANOUT_LINEAGE_FILENAME + CORRUPT_SUFFIX));
    return hit ? path.join(this.dir, hit) : null;
  }

  /** Load the lineage store. A file that exists but does not parse is moved
   *  aside (and reported by fanoutOwnerOf until the operator removes it), and
   *  a fresh, empty store takes its place — so markTask keeps working. */
  private loadLineage(): Map<string, LineageStamp> {
    if (this.lineage) return this.lineage;
    const p = this.lineagePath();
    const map = new Map<string, LineageStamp>();
    if (fs.existsSync(p)) {
      try {
        const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown;
        const tasks = (raw as { tasks?: unknown } | null)?.tasks;
        if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) {
          throw new Error('no tasks map');
        }
        for (const [ws, v] of Object.entries(tasks as Record<string, unknown>)) {
          const s = v as Partial<LineageStamp> | null;
          if (s && typeof s.owner === 'string' && s.owner.length > 0) {
            // A malformed origin drops the origin, never the stamp.
            const origin = sanitizeFanoutOrigin(s.origin);
            const task = isStampTask(s) ? { taskId: s.taskId, gen: s.gen } : {};
            map.set(ws, { owner: s.owner, at: typeof s.at === 'number' ? s.at : 0, ...(origin ? { origin } : {}), ...task });
          }
        }
      } catch {
        if (!this.quarantine(p)) throw new Error(`${FANOUT_LINEAGE_FILENAME} is unreadable and could not be moved aside`);
      }
    }
    this.lineage = map;
    return map;
  }

  /**
   * The workspace that fanned `workspaceId` out, or null when it is not a
   * fan-out task. Reads the stamp first, then the ledger (status-independent:
   * a worker that marked itself `failed` is still a task). THROWS when the
   * stamps cannot be trusted — an unreadable store, or one that was torn and
   * moved aside — and the depth-1 check refuses on a throw.
   */
  fanoutOwnerOf(workspaceId: string): string | null {
    const map = this.loadLineage();
    const lost = this.quarantinedLineage();
    if (lost) {
      throw new Error(
        `the fan-out lineage store was unreadable and was moved to ${lost}; the task stamps it held are lost. ` +
          'Delete that file once no fan-out task is still running to allow agent fan-out again',
      );
    }
    const stamp = map.get(workspaceId);
    if (stamp) return stamp.owner;
    return this.ledgerTaskOwner(workspaceId);
  }

  /** Stamp `workspaceId` as a task of `ownerWorkspaceId`. Synchronous and
   *  durable before it returns; throws when the write fails. A re-mark by the
   *  same owner never erases a recorded origin: it only adds one the stamp
   *  does not have yet. `task`: the task and launch generation it was created
   *  for; a re-mark records a newer generation, never an older one. */
  markTask(workspaceId: string, ownerWorkspaceId: string, origin?: FanoutOrigin, task?: StampTask): void {
    if (!workspaceId || !ownerWorkspaceId) throw new Error('markTask: workspace ids are required');
    holderInputsChanged();
    const map = this.loadLineage();
    const clean = sanitizeFanoutOrigin(origin);
    const named = isStampTask(task) ? { taskId: task.taskId, gen: task.gen } : null;
    const existing = map.get(workspaceId);
    if (existing?.owner === ownerWorkspaceId) {
      const addOrigin = !existing.origin && !!clean;
      const addTask = !!named && (existing.taskId !== named.taskId || (existing.gen ?? 0) < named.gen);
      if (!addOrigin && !addTask) return;
      const next = new Map(map);
      next.set(workspaceId, { ...existing, ...(addOrigin && clean ? { origin: clean } : {}), ...(addTask && named ? named : {}) });
      atomicWriteJSONSync(this.lineagePath(), { version: 1, tasks: Object.fromEntries(next) });
      this.lineage = next;
      return;
    }
    const next = new Map(map);
    next.delete(workspaceId);
    next.set(workspaceId, { owner: ownerWorkspaceId, at: this.now(), ...(clean ? { origin: clean } : {}), ...(named ?? {}) });
    while (next.size > LINEAGE_MAX_ENTRIES) {
      const oldest = next.keys().next();
      if (oldest.done) break;
      next.delete(oldest.value);
    }
    atomicWriteJSONSync(this.lineagePath(), { version: 1, tasks: Object.fromEntries(next) });
    this.lineage = next;
  }

  /** The task and launch generation `workspaceId`'s stamp names, or null
   *  (no stamp, one written before stamps named tasks, or the store cannot
   *  be read). Never throws. */
  taskOfWorkspace(workspaceId: string): StampTask | null {
    let stamp: LineageStamp | undefined;
    try {
      stamp = this.loadLineage().get(workspaceId);
    } catch {
      return null;
    }
    return stamp?.taskId && stamp.gen ? { taskId: stamp.taskId, gen: stamp.gen } : null;
  }

  /**
   * Live fan-out tasks: stamped task workspaces that are still OPEN. Not the
   * ledger status — a worker can mark its own row completed or failed while
   * its agent keeps running, and a task whose materialization failed never
   * gets a row at all. THROWS when the open set is unknown (renderer not up).
   */
  liveTaskCount(): number {
    if (this.countLiveOverride) return this.countLiveOverride();
    const holders = this.holders();
    if (holders) return holderCounts(holders.holders).live;
    return this.liveTaskWorkspaces().length;
  }

  /** The holder set every live-worker cap filters (factory/workerHolders.ts),
   *  read only by the hosted instance, whose bookings it holds; null while
   *  the worker lifecycle host has not installed it. THROWS when the open
   *  workspaces are unknown or the lineage store cannot be trusted, as the
   *  workspace count does: the live cap then refuses. */
  private holders(): LiveHolders | null {
    if (hosted !== this) return null;
    const live = liveHolders();
    if (!live) return null;
    if (!live.workspacesKnown) throw new Error('the open workspace list is not available yet');
    this.loadLineage();
    return live;
  }

  /** The workspaces liveTaskCount counts while no holder set is installed
   *  (it throws the same way): every open stamped task workspace. */
  liveTaskWorkspaces(): string[] {
    const open = this.openWorkspaceIds();
    if (!open) throw new Error('the open workspace list is not available yet');
    const stamps = this.loadLineage();
    return open.filter((ws) => stamps.has(ws));
  }

  /** What holds the live slots, or null when it cannot be told (the count
   *  is overridden, or a read fails). */
  private liveSlotHolders(starting: number): LiveSlotHolders | null {
    if (this.countLiveOverride) return null;
    try {
      const set = this.holders();
      if (set) {
        const out: LiveSlotHolders = { open: [], ended: [], untracked: 0, starting: 0 };
        for (const h of set.holders) {
          if (h.state === 'free') continue;
          if (h.why === 'starting' && !h.status) out.starting++;
          else if (h.status === 'completed' || h.status === 'cancelled' || h.status === 'failed') out.ended.push(h.title ?? h.taskId);
          else if (h.status || h.why === 'resumed') out.open.push(h.title ?? h.taskId);
          else out.untracked++;
        }
        return out;
      }
      const holders: LiveSlotHolders = { open: [], ended: [], untracked: 0, starting };
      for (const ws of this.liveTaskWorkspaces()) {
        const task = this.ledgerTaskOf(ws);
        if (!task) holders.untracked++;
        else if (task.status === 'completed' || task.status === 'cancelled' || task.status === 'failed') holders.ended.push(task.title);
        else holders.open.push(task.title);
      }
      return holders;
    } catch {
      return null;
    }
  }

  // ── caps ─────────────────────────────────────────────────────────────────

  private capsPath(): string {
    return path.join(this.dir, FANOUT_CAPS_FILENAME);
  }

  private loadHourly(): HourlyStamp[] {
    if (this.hourly) return this.hourly;
    const p = this.capsPath();
    let list: HourlyStamp[] = [];
    if (fs.existsSync(p)) {
      try {
        const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as { starts?: unknown };
        if (!Array.isArray(raw.starts)) throw new Error('no starts list');
        list = raw.starts.filter(
          (s): s is HourlyStamp =>
            !!s &&
            typeof (s as HourlyStamp).id === 'string' &&
            typeof (s as HourlyStamp).at === 'number' &&
            typeof (s as HourlyStamp).count === 'number',
        );
      } catch {
        // A torn caps file must not hand a loop a fresh hour: treat the hour
        // it was last written in as FULL, and keep the file for inspection.
        let mtime = this.now();
        try {
          mtime = fs.statSync(p).mtimeMs;
        } catch {
          // keep now
        }
        this.quarantine(p);
        list = [{ id: 'unreadable-caps-file', at: mtime, count: FANOUT_HOURLY_TASK_CAP }];
        try {
          atomicWriteJSONSync(p, { version: 1, starts: list });
        } catch {
          // in memory is enough for this process
        }
      }
    }
    this.hourly = list;
    return list;
  }

  private saveHourly(list: HourlyStamp[]): void {
    atomicWriteJSONSync(this.capsPath(), { version: 1, starts: list });
    this.hourly = list;
  }

  /**
   * Check both caps for `count` more tasks and, if they fit, reserve them
   * under `key`. Synchronous, so the claim that follows it happens in the same
   * tick and two concurrent calls cannot both squeeze under a cap.
   */
  reserve(key: string, count: number, who?: { ownerWorkspaceId: string; botId?: string }): CapReservation {
    const now = this.now();
    const windowStart = now - FANOUT_CAP_WINDOW_MS;
    const hourly = this.loadHourly().filter((s) => s.at > windowStart);

    const pendingCount = this.booked('pending');
    const spawningCount = this.booked('spawning');
    let live: number;
    try {
      // The holder set counts the bookings itself, one per task; the
      // workspace count adds them.
      const holders = this.countLiveOverride ? null : this.holders();
      live = holders ? holderCounts(holders.holders).live : this.liveTaskCount() + pendingCount + spawningCount;
    } catch (err) {
      return {
        ok: false,
        message: `fan-out refused: the live-task count is unavailable (${(err as Error).message}); retry shortly`,
      };
    }
    if (live + count > FANOUT_LIVE_TASK_CAP) {
      return { ok: false, message: liveCapMessage(live, count, this.liveSlotHolders(pendingCount + spawningCount)) };
    }

    const recorded = hourly.reduce((sum, s) => sum + s.count, 0);
    const started = recorded + pendingCount;
    if (started + count > FANOUT_HOURLY_TASK_CAP) {
      // Walk the recorded window oldest-first to the stamp whose expiry makes
      // room. Pending reservations do not expire on a clock — if the excess is
      // theirs, room frees when those fan-outs start or are dropped.
      const sorted = [...hourly].sort((a, b) => a.at - b.at);
      let freed = 0;
      let freesAt: number | null = null;
      for (const s of sorted) {
        freed += s.count;
        if (started - freed + count <= FANOUT_HOURLY_TASK_CAP) {
          freesAt = s.at + FANOUT_CAP_WINDOW_MS;
          break;
        }
      }
      const when =
        freesAt !== null
          ? `Room frees at ${formatClock(freesAt)}.`
          : 'Room frees as the fan-outs still waiting to start begin or are dropped.';
      return {
        ok: false,
        message:
          `fan-out refused: at most ${FANOUT_HOURLY_TASK_CAP} fan-out tasks may start per rolling hour across wmux ` +
          `(${started} started or starting in the last hour, ${count} requested). ${when}`,
      };
    }

    holderInputsChanged();
    this.reserved = this.reserved.filter((u) => !(u.key === key && u.phase === 'pending'));
    for (let i = 0; i < count; i++) {
      this.reserved.push({ key, ownerWorkspaceId: who?.ownerWorkspaceId ?? '', ...(who?.botId ? { botId: who.botId } : {}), phase: 'pending' });
    }
    return { ok: true };
  }

  /** The fan-out never started (preflight failure, denial, repo moved, a
   *  throw): its reservation stops counting against either cap. */
  release(key: string): void {
    holderInputsChanged();
    this.reserved = this.reserved.filter((u) => !(u.key === key && u.phase === 'pending'));
  }

  /** How many tasks are booked in `phase` (of `key`, or of every fan-out). */
  private booked(phase: ReservedTask['phase'], key?: string): number {
    let n = 0;
    for (const u of this.reserved) if (u.phase === phase && (key === undefined || u.key === key)) n++;
    return n;
  }

  /** The tasks booked now, one per task (copies). */
  reservedTasks(): ReservedTask[] {
    return this.reserved.map((u) => ({ ...u }));
  }

  /** A started fan-out minted `taskId`: one of its bookings is that task's
   *  from now on. */
  bindTask(key: string, taskId: string): void {
    const unit = this.reserved.find((u) => u.taskId === taskId)
      ?? this.reserved.find((u) => u.key === key && u.phase === 'spawning' && !u.taskId);
    if (unit) unit.taskId = taskId;
    holderInputsChanged();
  }

  /**
   * The fan-out is about to spawn: its hourly stamp goes to disk, so a restart
   * does not hand a loop a fresh hour, and its tasks keep counting against the
   * live cap until each one settles. Only STARTED fan-outs are persisted — a
   * reservation that was denied never touched the file. Stamps are only ever
   * appended, never replaced: a key reused after a restart adds to the hour.
   */
  commitStart(key: string, deferred = 0): void {
    const count = this.booked('pending', key);
    if (count === 0) return;
    holderInputsChanged();
    for (const u of this.reserved) if (u.key === key) u.phase = 'spawning';
    // Tasks that wait on dependencies are booked live now but stamped on the
    // hour only when they actually start (stampDeferredStart): stamped now,
    // one that waited past the window would start uncounted.
    const stamped = count - Math.max(0, Math.min(deferred, count));
    if (stamped === 0) return;
    this.appendStamp(key, stamped);
  }

  /**
   * A task that waited on its dependencies is about to start: check the hourly
   * cap for it NOW and stamp it. Its live slot was booked by commitStart and
   * is still held, so only the hour is checked.
   */
  stampDeferredStart(key: string): CapReservation {
    const now = this.now();
    const recorded = this.loadHourly()
      .filter((s) => s.at > now - FANOUT_CAP_WINDOW_MS)
      .reduce((sum, s) => sum + s.count, 0);
    if (recorded + this.booked('pending') + 1 > FANOUT_HOURLY_TASK_CAP) {
      return {
        ok: false,
        message: `at most ${FANOUT_HOURLY_TASK_CAP} fan-out tasks may start per rolling hour across wmux, and the hour is full`,
      };
    }
    this.appendStamp(key, 1);
    return { ok: true };
  }

  private appendStamp(key: string, count: number): void {
    const now = this.now();
    const hourly = this.loadHourly().filter((s) => s.at > now - FANOUT_CAP_WINDOW_MS);
    const next = [...hourly, { id: key, at: now, count }];
    try {
      this.saveHourly(next);
    } catch (err) {
      // Still counted for this process; only a restart would forget it.
      this.hourly = next;
      console.warn(`[fanout] could not persist the hourly cap stamp: ${String(err)}`);
    }
  }

  /**
   * Give back `count` tasks of a started fan-out's hourly stamp: they never got
   * a workspace, so nothing was launched for them. The stamp is shrunk (or
   * dropped at zero) on disk too, so a restart does not bring the charge back.
   */
  refundStart(key: string, count: number): void {
    if (!(count > 0)) return;
    const hourly = this.loadHourly();
    let left = count;
    const next: HourlyStamp[] = [];
    // Newest first: the stamp commitStart just appended for this key.
    for (const s of [...hourly].reverse()) {
      if (left > 0 && s.id === key) {
        const take = Math.min(left, s.count);
        left -= take;
        if (s.count - take > 0) next.unshift({ ...s, count: s.count - take });
        continue;
      }
      next.unshift(s);
    }
    if (left === count) return;
    try {
      this.saveHourly(next);
    } catch (err) {
      this.hourly = next;
      console.warn(`[fanout] could not persist the hourly cap refund: ${String(err)}`);
    }
  }

  /** One task of a started fan-out finished its spawn (either way). From here
   *  its stamped workspace, if it got one, is what counts it. `taskId`: the
   *  task, when it was minted. */
  taskSettled(key: string, taskId?: string): void {
    holderInputsChanged();
    const of = this.reserved.filter((u) => u.key === key && u.phase === 'spawning');
    const unit = (taskId ? of.find((u) => u.taskId === taskId) : undefined) ?? of.find((u) => !u.taskId) ?? of[0];
    if (unit) this.reserved = this.reserved.filter((u) => u !== unit);
  }

  /** The fan-out's run returned: whatever is still booked for it is dropped. */
  settleStarted(key: string): void {
    holderInputsChanged();
    this.reserved = this.reserved.filter((u) => !(u.key === key && u.phase === 'spawning'));
  }

  // ── audit ────────────────────────────────────────────────────────────────

  private auditPath(): string {
    return path.join(this.dir, FANOUT_AUDIT_FILENAME);
  }

  /** Append one record. Throws when the write fails. */
  appendAudit(record: FanOutAuditRecord): void {
    const p = this.auditPath();
    fs.mkdirSync(this.dir, { recursive: true });
    try {
      if (fs.statSync(p).size > AUDIT_MAX_BYTES) fs.renameSync(p, `${p}.1`);
    } catch {
      // absent — first record
    }
    fs.appendFileSync(p, JSON.stringify(record) + '\n', 'utf8');
  }

  /**
   * #1481 — the newest `limit` records, newest first, reading only the file's
   * tail (at most AUDIT_TAIL_BYTES) and off the main thread. The sidebar calls
   * this on workspace-set changes; a 1 MB synchronous read there would stall
   * the main process for nothing.
   */
  async recentAuditTail(limit = 20): Promise<FanOutAuditRecord[]> {
    let handle: fs.promises.FileHandle | undefined;
    let text = '';
    try {
      handle = await fs.promises.open(this.auditPath(), 'r');
      const { size } = await handle.stat();
      const length = Math.min(size, AUDIT_TAIL_BYTES);
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, size - length);
      text = buf.toString('utf8');
      // A tail that starts mid-record: drop the partial first line.
      if (length < size) text = text.slice(text.indexOf('\n') + 1);
    } catch {
      return [];
    } finally {
      await handle?.close().catch(() => undefined);
    }
    const out: FanOutAuditRecord[] = [];
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as FanOutAuditRecord);
      } catch {
        // skip a torn line
      }
    }
    return out;
  }

  /**
   * #1481 — the durable owner stamps for `workspaceIds`, for the sidebar's
   * fan-out nesting. Read-only and non-throwing: an unreadable store yields
   * no stamps (the sidebar then falls back to the task ledger), unlike
   * fanoutOwnerOf, whose depth-1 check must refuse on doubt.
   *
   * A bot's worker is told apart even when its stamp is missing or carries
   * no origin (an unreadable store set aside, a stamp written without one):
   * the task ledger's dispatch record names the bot, and the answer then
   * carries `origin: {kind:'bot', botId}` from it. `botId` is set on every
   * entry whose origin is a bot.
   */
  lineageFor(workspaceIds: readonly string[]): Record<string, FanoutLineageEntry> {
    const out: Record<string, FanoutLineageEntry> = {};
    let map: Map<string, LineageStamp>;
    try {
      map = this.loadLineage();
    } catch {
      map = new Map();
    }
    for (const id of workspaceIds) {
      const stamp = map.get(id);
      let entry: FanoutLineageEntry | null = stamp
        ? { owner: stamp.owner, at: stamp.at, ...(stamp.origin ? { origin: { ...stamp.origin } } : {}) }
        : null;
      if (!entry?.origin) {
        let bot: { owner: string; botId: string; at: number } | null = null;
        try {
          bot = this.ledgerBotTask(id);
        } catch {
          bot = null;
        }
        if (bot && (!entry || entry.owner === bot.owner)) {
          entry = { owner: bot.owner, at: entry?.at ?? bot.at, origin: { kind: 'bot', botId: bot.botId } };
        }
      }
      if (!entry) continue;
      if (entry.origin?.kind === 'bot' && entry.origin.botId) entry.botId = entry.origin.botId;
      out[id] = entry;
    }
    return out;
  }

  /** The newest `limit` records, newest first. Unparseable lines are skipped. */
  recentAudit(limit = 20): FanOutAuditRecord[] {
    let raw = '';
    try {
      raw = fs.readFileSync(this.auditPath(), 'utf8');
    } catch {
      return [];
    }
    const out: FanOutAuditRecord[] = [];
    const lines = raw.split('\n');
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as FanOutAuditRecord);
      } catch {
        // skip a torn line
      }
    }
    return out;
  }
}

/**
 * The pty.create half of the lineage stamp. A fan-out task pane's create carries
 * `fanoutTaskOf`; the stamp is written right there, before the PTY (and the
 * agent its initialCommand launches) exists. Doing it inside the create rather
 * than as a separate renderer round-trip keeps the renderer's spawn free of an
 * extra await — during which the empty-leaf funnel would race it with a plain
 * shell. Throws (failing the create) when the stamp cannot be written.
 *
 * `fanoutOrigin` — who asked, as the renderer resolved it from its layout — is
 * stamped with the owner. It is sanitized here; a malformed one is dropped.
 */
export function stampFanoutTaskPane(
  options: { fanoutTaskOf?: unknown; workspaceId?: unknown; fanoutOrigin?: unknown; fanoutLaunch?: unknown } | undefined,
  guards: Pick<FanOutGuards, 'markTask'> = getFanOutGuards(),
  launches: () => Pick<WorkerSlots, 'claimLaunch'> = getWorkerSlots,
): void {
  const owner = typeof options?.fanoutTaskOf === 'string' ? options.fanoutTaskOf : '';
  if (!owner) return;
  const ws = typeof options?.workspaceId === 'string' ? options.workspaceId : '';
  if (!ws) throw new Error('PTY_CREATE: a fan-out task pane needs its workspaceId for the lineage stamp');
  const origin = sanitizeFanoutOrigin(options?.fanoutOrigin);
  // The launch its spawn carried (main recorded it before the spawn,
  // factory/workerSlots.ts): the stamp names it from the start, and one that
  // was abandoned or replaced fails the create (claimLaunch throws).
  const token = parseLaunchToken(options?.fanoutLaunch);
  const task: StampTask | null = token ? launches().claimLaunch(token) : null;
  if (task) guards.markTask(ws, owner, origin ?? undefined, task);
  else if (origin) guards.markTask(ws, owner, origin);
  else guards.markTask(ws, owner);
}

/** A task pane's create, once its session id is known and before the
 *  session exists: the pane and its workspace are recorded as the launch's
 *  its spawn carried (factory/workerSlots.ts). Throws (failing the create)
 *  when that launch was abandoned or the record cannot be written. A pane
 *  whose spawn carried no launch is not recorded. */
export function recordFanoutTaskPane(
  options: { fanoutTaskOf?: unknown; workspaceId?: unknown; fanoutLaunch?: unknown } | undefined,
  sessionId: string,
  launches: () => Pick<WorkerSlots, 'recordCreate'> = getWorkerSlots,
): void {
  const owner = typeof options?.fanoutTaskOf === 'string' ? options.fanoutTaskOf : '';
  const ws = typeof options?.workspaceId === 'string' ? options.workspaceId : '';
  const token = parseLaunchToken(options?.fanoutLaunch);
  if (!owner || !ws || !token || !sessionId) return;
  launches().recordCreate(token, ws, sessionId);
}

/** The task and generation a workspace was created (or relaunched) for:
 *  its record (factory/workerSlots.ts), else its lineage stamp. Never throws. */
export function taskOfWorkspace(workspaceId: string): StampTask | null {
  try {
    return getWorkerSlots().workspaceOf(workspaceId) ?? getFanOutGuards().taskOfWorkspace(workspaceId);
  } catch {
    return null;
  }
}

/** How long a live-cap check waits for a fresh dormant read (#2387). A
 *  second layer: the root fix is the durable "agent seen gone" fact
 *  (factory/agentGoneFacts.ts, #2393), which answers without any read; this
 *  wait only lets a task that ended since the last read count on a fresh one. */
export const DORMANT_REFRESH_WAIT_MS = 2_000;

let dormantRefresh: (() => Promise<void>) | null = null;

/** Install (or clear, with null) how to bring the dormant source up to date. */
export function setDormantRefresh(refresh: (() => Promise<void>) | null): void {
  dormantRefresh = refresh;
}

/** Brings the dormant set up to date before a live-cap check: resolves once
 *  the fresh read settles or after `timeoutMs`, whichever is first (the
 *  check then decides on what is known). Never rejects. */
export async function refreshDormantTaskWorkspaces(timeoutMs = DORMANT_REFRESH_WAIT_MS): Promise<void> {
  let work: Promise<void> | undefined;
  try {
    work = dormantRefresh?.();
  } catch {
    return;
  }
  if (!work) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work.catch(() => undefined), new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

let hosted: FanOutGuards | null = null;

export function getFanOutGuards(): FanOutGuards {
  if (!hosted) hosted = new FanOutGuards();
  return hosted;
}

/** Tests only: swap the hosted instance (null = re-create lazily). */
export function setFanOutGuardsForTests(instance: FanOutGuards | null): void {
  hosted = instance;
}
