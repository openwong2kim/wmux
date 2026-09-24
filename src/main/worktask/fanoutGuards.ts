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
//   audit   — one jsonl line per wire fan-out that is about to run: who, where,
//             what (prompt hashes, not bodies), and whether a person approved.
//
// Threat model: these are brakes against loops and accidental amplification on
// the HONEST paths, not a defence against hostile local code — anything
// running as the user can edit these files or call `claude` directly. They are
// built to be correct and fail closed where the answer is uncertain (an
// unreadable lineage store refuses the fan-out), not to be spoof-proof.
//
// Storage sits beside the task ledger in the WMUX_DATA_SUFFIX-scoped wmux dir.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getWmuxDir } from '../../daemon/config';
import { atomicWriteJSONSync } from '../../daemon/util/atomicWrite';
import { getTaskLedger } from '../deck/taskLedgerHost';

export const FANOUT_LIVE_TASK_CAP = 8;
export const FANOUT_HOURLY_TASK_CAP = 24;
export const FANOUT_CAP_WINDOW_MS = 60 * 60 * 1000;

/** Oldest lineage stamps are dropped past this many. Task workspaces are
 *  closed long before a store this size could fill; the bound only keeps a
 *  pathological loop from growing the file without limit. */
const LINEAGE_MAX_ENTRIES = 10_000;
/** The audit log rolls to `<name>.1` past this size. */
const AUDIT_MAX_BYTES = 1024 * 1024;

export const FANOUT_LINEAGE_FILENAME = 'fanout-lineage.json';
export const FANOUT_CAPS_FILENAME = 'fanout-caps.json';
export const FANOUT_AUDIT_FILENAME = 'fanout-audit.jsonl';

interface LineageStamp {
  owner: string;
  at: number;
}

interface HourlyStamp {
  /** Reservation id (the fan-out's scoped idempotency key). */
  id: string;
  at: number;
  count: number;
}

export interface FanOutAuditRecord {
  at: number;
  /** The caller's own idempotency key (not the workspace-scoped one). */
  idempotencyKey: string;
  ownerWorkspaceId: string;
  /** How the caller proved who it is. */
  callerIdentity: 'pty' | 'commander';
  repoPath: string;
  titles: string[];
  roles: string[];
  /** What each role resolves to under the operator's bindings, as the
   *  renderer expanded it. Empty when no task carries a role. */
  roleCommands: string[];
  /** sha256 of each task's effective prompt, index-aligned with `titles`. */
  promptSha256: string[];
  approvedBy: 'auto' | 'human';
}

export type CapReservation = { ok: true } | { ok: false; message: string };

export interface FanOutGuardsOptions {
  /** Data dir. Defaults to the wmux dir. */
  dir?: string;
  now?: () => number;
  /** Open tasks app-wide. Defaults to the task ledger's open rows. */
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
  private readonly countLiveTasks: () => number;
  private readonly ledgerTaskOwner: (workspaceId: string) => string | null;

  /** null until first read. */
  private lineage: Map<string, LineageStamp> | null = null;
  private hourly: HourlyStamp[] | null = null;
  /** In-flight reservations against the live cap: key → task count. Process
   *  memory only — after a restart the tasks that did spawn are ledger rows,
   *  and the ones that did not never will. */
  private readonly liveReservations = new Map<string, number>();

  constructor(opts: FanOutGuardsOptions = {}) {
    this.dir = opts.dir ?? getWmuxDir();
    this.now = opts.now ?? Date.now;
    this.countLiveTasks =
      opts.countLiveTasks ?? (() => getTaskLedger().list({ openOnly: true }).length);
    this.ledgerTaskOwner =
      opts.ledgerTaskOwner ??
      ((ws) => getTaskLedger().findByTaskWorkspace(ws)?.ownerWorkspaceId ?? null);
  }

  // ── lineage ──────────────────────────────────────────────────────────────

  private lineagePath(): string {
    return path.join(this.dir, FANOUT_LINEAGE_FILENAME);
  }

  /** Load the lineage store. THROWS when the file exists but cannot be read
   *  or parsed — a caller must treat that as "maybe a task" and refuse. */
  private loadLineage(): Map<string, LineageStamp> {
    if (this.lineage) return this.lineage;
    const p = this.lineagePath();
    const map = new Map<string, LineageStamp>();
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as unknown;
      const tasks = (raw as { tasks?: unknown } | null)?.tasks;
      if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) {
        throw new Error(`${FANOUT_LINEAGE_FILENAME} has no tasks map`);
      }
      for (const [ws, v] of Object.entries(tasks as Record<string, unknown>)) {
        const s = v as Partial<LineageStamp> | null;
        if (s && typeof s.owner === 'string' && s.owner.length > 0) {
          map.set(ws, { owner: s.owner, at: typeof s.at === 'number' ? s.at : 0 });
        }
      }
    }
    this.lineage = map;
    return map;
  }

  /**
   * The workspace that fanned `workspaceId` out, or null when it is not a
   * fan-out task. Reads the stamp first, then the ledger (status-independent:
   * a worker that marked itself `failed` is still a task). THROWS when the
   * stamp store is unreadable — the depth-1 check refuses on a throw.
   */
  fanoutOwnerOf(workspaceId: string): string | null {
    const stamp = this.loadLineage().get(workspaceId);
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

  // ── caps ─────────────────────────────────────────────────────────────────

  private capsPath(): string {
    return path.join(this.dir, FANOUT_CAPS_FILENAME);
  }

  private loadHourly(): HourlyStamp[] {
    if (this.hourly) return this.hourly;
    let list: HourlyStamp[] = [];
    try {
      const p = this.capsPath();
      if (fs.existsSync(p)) {
        const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as { starts?: unknown };
        if (Array.isArray(raw.starts)) {
          list = raw.starts.filter(
            (s): s is HourlyStamp =>
              !!s &&
              typeof (s as HourlyStamp).id === 'string' &&
              typeof (s as HourlyStamp).at === 'number' &&
              typeof (s as HourlyStamp).count === 'number',
          );
        }
      }
    } catch {
      // A torn caps file must not refuse fan-out forever; an empty window is
      // the honest reading of "no record".
      list = [];
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

    let reservedLive = 0;
    for (const n of this.liveReservations.values()) reservedLive += n;
    const live = this.countLiveTasks() + reservedLive;
    if (live + count > FANOUT_LIVE_TASK_CAP) {
      return {
        ok: false,
        message:
          `fan-out refused: at most ${FANOUT_LIVE_TASK_CAP} fan-out tasks may be live at once across wmux ` +
          `(${live} live now, ${count} requested). It frees as live tasks finish — close or complete one first.`,
      };
    }

    const started = hourly.reduce((sum, s) => sum + s.count, 0);
    if (started + count > FANOUT_HOURLY_TASK_CAP) {
      // Walk the window oldest-first to the stamp whose expiry makes room.
      const sorted = [...hourly].sort((a, b) => a.at - b.at);
      let freed = 0;
      let freesAt = now + FANOUT_CAP_WINDOW_MS;
      for (const s of sorted) {
        freed += s.count;
        if (started - freed + count <= FANOUT_HOURLY_TASK_CAP) {
          freesAt = s.at + FANOUT_CAP_WINDOW_MS;
          break;
        }
      }
      return {
        ok: false,
        message:
          `fan-out refused: at most ${FANOUT_HOURLY_TASK_CAP} fan-out tasks may start per rolling hour across wmux ` +
          `(${started} started in the last hour, ${count} requested). Room frees at ${formatClock(freesAt)}.`,
      };
    }

    this.saveHourly([...hourly.filter((s) => s.id !== key), { id: key, at: now, count }]);
    this.liveReservations.set(key, count);
    return { ok: true };
  }

  /** The fan-out never started (preflight failure, denial, repo moved): give
   *  back both its live slots and its hourly stamp. */
  release(key: string): void {
    this.liveReservations.delete(key);
    const hourly = this.loadHourly();
    if (!hourly.some((s) => s.id === key)) return;
    try {
      this.saveHourly(hourly.filter((s) => s.id !== key));
    } catch {
      // Keeping the stamp only over-counts for an hour — the safe direction.
    }
  }

  /** The fan-out finished spawning: its tasks are ledger rows now, so its live
   *  reservation stops counting. The hourly stamp stays — it started. */
  settleStarted(key: string): void {
    this.liveReservations.delete(key);
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

let hosted: FanOutGuards | null = null;

export function getFanOutGuards(): FanOutGuards {
  if (!hosted) hosted = new FanOutGuards();
  return hosted;
}

/** Tests only: swap the hosted instance (null = re-create lazily). */
export function setFanOutGuardsForTests(instance: FanOutGuards | null): void {
  hosted = instance;
}
