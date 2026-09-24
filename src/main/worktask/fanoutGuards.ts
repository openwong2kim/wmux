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
}

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
  /** kind 'launched': the line each task's pane was actually started with. */
  launched?: { title: string; workspaceId?: string; command?: string; error?: string }[];
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

  /** null until first read. */
  private lineage: Map<string, LineageStamp> | null = null;
  private hourly: HourlyStamp[] | null = null;
  /** Claim-time reservations: key → task count, counted against BOTH caps
   *  until the fan-out starts or is dropped. Process memory only — a
   *  reservation stands for tasks that have not started, and after a restart
   *  they never will. */
  private readonly pending = new Map<string, number>();
  /** Started fan-outs: key → tasks not yet through their spawn. Each task
   *  leaves this count as it settles (see taskSettled), by which time its
   *  stamped workspace is what counts it. */
  private readonly spawning = new Map<string, number>();

  constructor(opts: FanOutGuardsOptions = {}) {
    this.dir = opts.dir ?? getWmuxDir();
    this.now = opts.now ?? Date.now;
    this.openWorkspaceIds =
      opts.openWorkspaceIds ?? (() => getWorkspaceMirror().getEntries()?.map((e) => e.id) ?? null);
    this.countLiveOverride = opts.countLiveTasks;
    this.ledgerTaskOwner =
      opts.ledgerTaskOwner ??
      ((ws) => getTaskLedger().findByTaskWorkspace(ws)?.ownerWorkspaceId ?? null);
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
            map.set(ws, { owner: s.owner, at: typeof s.at === 'number' ? s.at : 0 });
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
   *  durable before it returns; throws when the write fails. */
  markTask(workspaceId: string, ownerWorkspaceId: string): void {
    if (!workspaceId || !ownerWorkspaceId) throw new Error('markTask: workspace ids are required');
    const map = this.loadLineage();
    if (map.get(workspaceId)?.owner === ownerWorkspaceId) return;
    const next = new Map(map);
    next.delete(workspaceId);
    next.set(workspaceId, { owner: ownerWorkspaceId, at: this.now() });
    while (next.size > LINEAGE_MAX_ENTRIES) {
      const oldest = next.keys().next();
      if (oldest.done) break;
      next.delete(oldest.value);
    }
    atomicWriteJSONSync(this.lineagePath(), { version: 1, tasks: Object.fromEntries(next) });
    this.lineage = next;
  }

  /**
   * Live fan-out tasks: stamped task workspaces that are still OPEN. Not the
   * ledger status — a worker can mark its own row completed or failed while
   * its agent keeps running, and a task whose materialization failed never
   * gets a row at all. THROWS when the open set is unknown (renderer not up).
   */
  liveTaskCount(): number {
    if (this.countLiveOverride) return this.countLiveOverride();
    const open = this.openWorkspaceIds();
    if (!open) throw new Error('the open workspace list is not available yet');
    const stamps = this.loadLineage();
    let n = 0;
    for (const ws of open) if (stamps.has(ws)) n++;
    return n;
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
  reserve(key: string, count: number): CapReservation {
    const now = this.now();
    const windowStart = now - FANOUT_CAP_WINDOW_MS;
    const hourly = this.loadHourly().filter((s) => s.at > windowStart);

    let pendingCount = 0;
    for (const n of this.pending.values()) pendingCount += n;
    let spawningCount = 0;
    for (const n of this.spawning.values()) spawningCount += n;
    let liveNow: number;
    try {
      liveNow = this.liveTaskCount();
    } catch (err) {
      return {
        ok: false,
        message: `fan-out refused: the live-task count is unavailable (${(err as Error).message}); retry shortly`,
      };
    }
    const live = liveNow + pendingCount + spawningCount;
    if (live + count > FANOUT_LIVE_TASK_CAP) {
      return {
        ok: false,
        message:
          `fan-out refused: at most ${FANOUT_LIVE_TASK_CAP} fan-out tasks may be live at once across wmux ` +
          `(${live} live now, ${count} requested). It frees as task workspaces are closed — close one first.`,
      };
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

    this.pending.set(key, count);
    return { ok: true };
  }

  /** The fan-out never started (preflight failure, denial, repo moved, a
   *  throw): its reservation stops counting against either cap. */
  release(key: string): void {
    this.pending.delete(key);
  }

  /**
   * The fan-out is about to spawn: its hourly stamp goes to disk, so a restart
   * does not hand a loop a fresh hour, and its tasks keep counting against the
   * live cap until each one settles. Only STARTED fan-outs are persisted — a
   * reservation that was denied never touched the file. Stamps are only ever
   * appended, never replaced: a key reused after a restart adds to the hour.
   */
  commitStart(key: string): void {
    const count = this.pending.get(key);
    if (count === undefined) return;
    this.pending.delete(key);
    this.spawning.set(key, (this.spawning.get(key) ?? 0) + count);
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

  /** One task of a started fan-out finished its spawn (either way). From here
   *  its stamped workspace, if it got one, is what counts it. */
  taskSettled(key: string): void {
    const left = (this.spawning.get(key) ?? 0) - 1;
    if (left > 0) this.spawning.set(key, left);
    else this.spawning.delete(key);
  }

  /** The fan-out's run returned: whatever is still booked for it is dropped. */
  settleStarted(key: string): void {
    this.spawning.delete(key);
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
   */
  lineageFor(workspaceIds: readonly string[]): Record<string, { owner: string; at: number }> {
    const out: Record<string, { owner: string; at: number }> = {};
    let map: Map<string, LineageStamp>;
    try {
      map = this.loadLineage();
    } catch {
      return out;
    }
    for (const id of workspaceIds) {
      const stamp = map.get(id);
      if (stamp) out[id] = { owner: stamp.owner, at: stamp.at };
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
 */
export function stampFanoutTaskPane(
  options: { fanoutTaskOf?: unknown; workspaceId?: unknown } | undefined,
  guards: Pick<FanOutGuards, 'markTask'> = getFanOutGuards(),
): void {
  const owner = typeof options?.fanoutTaskOf === 'string' ? options.fanoutTaskOf : '';
  if (!owner) return;
  const ws = typeof options?.workspaceId === 'string' ? options.workspaceId : '';
  if (!ws) throw new Error('PTY_CREATE: a fan-out task pane needs its workspaceId for the lineage stamp');
  guards.markTask(ws, owner);
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
