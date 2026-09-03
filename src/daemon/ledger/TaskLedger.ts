// ─── Task Ledger — the status log behind src/shared/ledger.ts ───────────────
//
// A STATUS LOG keyed by WorkTask id. WorkTask (daemon WorkTaskService) stays
// the source of identity and ownership: an entry is only ever created by
// `register`, which mirrors an existing task; the ledger never invents one.
//
// Storage: one JSONL file under the wmux data dir (WMUX_DATA_SUFFIX-scoped
// through the caller-supplied dir, exactly like the deck-* stores). Every
// accepted write appends one line through a single writer queue, so two
// concurrent updates cannot interleave half-lines. Boot replays the file in
// order; a truncated last line (crash mid-append) is ignored, never fatal.
// Past LEDGER_ROTATE_BYTES the file is rotated: the old log moves to `.1` and
// the new one opens with a `snapshot` line carrying every live entry, so a
// replay of the fresh file alone reconstructs the full state.
//
// Rules enforced here (the contract lists them; this is the writer):
//   - transitions: `canTransition`; a same-status resubmit is a no-op.
//   - authz: `canActorSet` — the ONE predicate, never re-implemented.
//   - `completed`: only by a `brain`, only from `review_requested` (table),
//     only with a recorded gate whose exitCode is exactly 0 — unless
//     `force: true` with a non-empty `reason`, which is logged on the entry.
//   - CAS: every update names the `expectedRev` it read; a stale one is
//     refused so two writers cannot both pass the table against one snapshot.
//   - WorkTask closed/detached → `closeTask` forces `cancelled` unless the
//     entry is already `completed`.
//   - terminal entries older than LEDGER_TERMINAL_RETENTION_MS are pruned
//     from the live map on load and on list.
//
// Orphaned events (lane F step 1): a worker lifecycle event whose owner
// workspace has no brain is parked here under `orphaned_event` and handed back
// as a backlog (`takeOrphanedEvents`) when a brain boots for that workspace.

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  LEDGER_GATE_TAIL_MAX_BYTES,
  LEDGER_SCHEMA_VERSION,
  LEDGER_TERMINAL_RETENTION_MS,
  canActorSet,
  canTransition,
  isLedgerStatus,
  type LedgerActor,
  type LedgerEntry,
  type LedgerGateResult,
  type LedgerStatus,
} from '../../shared/ledger';

export const LEDGER_FILENAME = 'task-ledger.jsonl';
/** Rotate past this many bytes (spec: 5 MB). */
export const LEDGER_ROTATE_BYTES = 5 * 1024 * 1024;

export function getTaskLedgerPath(dir: string): string {
  return path.join(dir, LEDGER_FILENAME);
}

/** A worker lifecycle event parked for an owner workspace that had no brain
 *  when it fired. `payload` is opaque to the ledger (the coalescer input the
 *  deck handler built); `seq` is the EventBus seq used to drain in order. */
export interface OrphanedEvent {
  ownerWorkspaceId: string;
  seq: number;
  payload: unknown;
}

/** One accepted transition, as seen by listeners (mission-channel emitter). */
export interface LedgerTransition {
  entry: LedgerEntry;
  /** null on first registration. */
  from: LedgerStatus | null;
  to: LedgerStatus;
  by: LedgerActor;
  summary?: string;
  /** Present when `completed` was forced past a missing/failing gate. */
  forcedReason?: string;
}

export interface LedgerRegisterInput {
  id: string;
  taskWorkspaceId: string;
  ownerWorkspaceId: string;
  title: string;
  actor?: LedgerActor;
}

export interface LedgerUpdateInput {
  id: string;
  status: string;
  actor: LedgerActor;
  expectedRev: number;
  summary?: string;
  gate?: LedgerGateResult;
  force?: boolean;
  reason?: string;
}

export type LedgerUpdateError =
  | 'not_found'
  | 'invalid_status'
  | 'stale_rev'
  | 'not_authorized'
  | 'illegal_transition'
  | 'gate_required'
  | 'force_reason_required';

export type LedgerUpdateResult =
  | { ok: true; entry: LedgerEntry; noop?: true }
  | { ok: false; error: LedgerUpdateError; message: string; entry?: LedgerEntry };

export interface LedgerListFilter {
  ownerWorkspaceId?: string;
  taskWorkspaceId?: string;
  id?: string;
  /** Only working / input_required / review_requested. */
  openOnly?: boolean;
}

export const OPEN_LEDGER_STATUSES: readonly LedgerStatus[] = [
  'working',
  'input_required',
  'review_requested',
];

export function isOpenLedgerStatus(status: LedgerStatus): boolean {
  return OPEN_LEDGER_STATUSES.includes(status);
}

type LedgerLine =
  | { op: 'entry'; entry: LedgerEntry }
  | { op: 'snapshot'; entries: LedgerEntry[]; orphans: OrphanedEvent[] }
  | { op: 'orphaned_event'; event: OrphanedEvent }
  | { op: 'orphans_drained'; ownerWorkspaceId: string; upToSeq: number };

export interface TaskLedgerOptions {
  /** The wmux data dir (already WMUX_DATA_SUFFIX-scoped by the caller). */
  dir: string;
  now?: () => number;
  rotateBytes?: number;
  retentionMs?: number;
  log?: (line: string) => void;
}

const SYSTEM_ACTOR = (workspaceId = 'daemon'): LedgerActor => ({ kind: 'system', workspaceId });

function truncateTail(tail: string): string {
  const bytes = Buffer.byteLength(tail, 'utf8');
  if (bytes <= LEDGER_GATE_TAIL_MAX_BYTES) return tail;
  const buf = Buffer.from(tail, 'utf8');
  return buf.subarray(buf.length - LEDGER_GATE_TAIL_MAX_BYTES).toString('utf8');
}

function boundGate(gate: LedgerGateResult): LedgerGateResult {
  return { ...gate, tail: truncateTail(typeof gate.tail === 'string' ? gate.tail : '') };
}

function isEntryShape(v: unknown): v is LedgerEntry {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.id === 'string' &&
    typeof e.taskWorkspaceId === 'string' &&
    typeof e.ownerWorkspaceId === 'string' &&
    isLedgerStatus(e.status) &&
    typeof e.rev === 'number' &&
    typeof e.updatedAt === 'number'
  );
}

export class TaskLedger {
  private readonly filePath: string;
  private readonly dir: string;
  private readonly now: () => number;
  private readonly rotateBytes: number;
  private readonly retentionMs: number;
  private readonly log: (line: string) => void;
  private readonly entries = new Map<string, LedgerEntry>();
  private orphans: OrphanedEvent[] = [];
  private readonly listeners = new Set<(t: LedgerTransition) => void>();
  private queue: Promise<void> = Promise.resolve();
  /** Lines the last load skipped (torn tail / malformed) — observability. */
  readonly skippedLines: number;

  constructor(opts: TaskLedgerOptions) {
    this.dir = opts.dir;
    this.filePath = getTaskLedgerPath(opts.dir);
    this.now = opts.now ?? Date.now;
    this.rotateBytes = opts.rotateBytes ?? LEDGER_ROTATE_BYTES;
    this.retentionMs = opts.retentionMs ?? LEDGER_TERMINAL_RETENTION_MS;
    this.log = opts.log ?? (() => {});
    this.skippedLines = this.replay();
    this.pruneTerminal();
  }

  get path(): string {
    return this.filePath;
  }

  // ── reads ────────────────────────────────────────────────────────────────

  get(id: string): LedgerEntry | null {
    return this.entries.get(id) ?? null;
  }

  /** The entry whose task workspace is `taskWorkspaceId` (a task has exactly
   *  one dedicated workspace; a re-used workspace id resolves to the newest). */
  findByTaskWorkspace(taskWorkspaceId: string): LedgerEntry | null {
    let best: LedgerEntry | null = null;
    for (const e of this.entries.values()) {
      if (e.taskWorkspaceId !== taskWorkspaceId) continue;
      if (!best || e.updatedAt > best.updatedAt) best = e;
    }
    return best;
  }

  list(filter: LedgerListFilter = {}): LedgerEntry[] {
    this.pruneTerminal();
    const out: LedgerEntry[] = [];
    for (const e of this.entries.values()) {
      if (filter.id !== undefined && e.id !== filter.id) continue;
      if (filter.ownerWorkspaceId !== undefined && e.ownerWorkspaceId !== filter.ownerWorkspaceId) continue;
      if (filter.taskWorkspaceId !== undefined && e.taskWorkspaceId !== filter.taskWorkspaceId) continue;
      if (filter.openOnly && !isOpenLedgerStatus(e.status)) continue;
      out.push(e);
    }
    out.sort((a, b) => a.updatedAt - b.updatedAt);
    return out;
  }

  onTransition(listener: (t: LedgerTransition) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // ── writes ───────────────────────────────────────────────────────────────

  /** Mirror an existing WorkTask into the ledger as `working`. Idempotent:
   *  an already-registered id returns its live entry and writes nothing. */
  async register(input: LedgerRegisterInput): Promise<LedgerEntry> {
    const existing = this.entries.get(input.id);
    if (existing) return existing;
    const by = input.actor ?? SYSTEM_ACTOR();
    const entry: LedgerEntry = {
      schemaVersion: LEDGER_SCHEMA_VERSION,
      id: input.id,
      taskWorkspaceId: input.taskWorkspaceId,
      ownerWorkspaceId: input.ownerWorkspaceId,
      title: input.title,
      status: 'working',
      rev: 1,
      updatedAt: this.now(),
      updatedBy: by,
    };
    this.entries.set(entry.id, entry);
    await this.append({ op: 'entry', entry });
    this.emit({ entry, from: null, to: 'working', by });
    return entry;
  }

  async update(input: LedgerUpdateInput): Promise<LedgerUpdateResult> {
    const entry = this.entries.get(input.id);
    if (!entry) return { ok: false, error: 'not_found', message: `no ledger entry for task ${input.id}` };
    if (!isLedgerStatus(input.status)) {
      return { ok: false, error: 'invalid_status', message: `unknown status "${input.status}"`, entry };
    }
    const next = input.status;
    if (input.expectedRev !== entry.rev) {
      return {
        ok: false,
        error: 'stale_rev',
        message: `expectedRev ${input.expectedRev} but the entry is at rev ${entry.rev} — re-read and retry`,
        entry,
      };
    }
    if (!canActorSet(input.actor, entry, next)) {
      return {
        ok: false,
        error: 'not_authorized',
        message: `${input.actor.kind} ${input.actor.workspaceId} may not set ${next} on task ${entry.id}`,
        entry,
      };
    }
    if (!canTransition(entry.status, next)) {
      return {
        ok: false,
        error: 'illegal_transition',
        message: `${entry.status} → ${next} is not an allowed transition`,
        entry,
      };
    }
    if (entry.status === next) return { ok: true, entry, noop: true };
    let forcedReason: string | undefined;
    if (next === 'completed') {
      if (input.actor.kind !== 'brain') {
        return {
          ok: false,
          error: 'not_authorized',
          message: 'only the owning brain may mark a task completed',
          entry,
        };
      }
      const gate = input.gate ?? entry.gate;
      const gatePassed = gate !== undefined && gate.exitCode === 0;
      if (!gatePassed) {
        if (input.force !== true) {
          return {
            ok: false,
            error: 'gate_required',
            message: gate
              ? `the recorded gate did not pass (exitCode ${String(gate.exitCode)}); run the gate again or force with a reason`
              : 'no gate result recorded for this task; run the gate first or force with a reason',
            entry,
          };
        }
        const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
        if (!reason) {
          return {
            ok: false,
            error: 'force_reason_required',
            message: 'force: true requires a non-empty reason',
            entry,
          };
        }
        forcedReason = reason;
      }
    }
    const summary =
      typeof input.summary === 'string' && input.summary.trim().length > 0
        ? input.summary.trim()
        : entry.summary;
    const updated: LedgerEntry = {
      ...entry,
      status: next,
      rev: entry.rev + 1,
      updatedAt: this.now(),
      updatedBy: input.actor,
      ...(summary !== undefined ? { summary } : {}),
      ...(input.gate ? { gate: boundGate(input.gate) } : {}),
      ...(forcedReason !== undefined
        ? { summary: `${summary ? `${summary} ` : ''}[forced: ${forcedReason}]` }
        : {}),
    };
    this.entries.set(updated.id, updated);
    await this.append({ op: 'entry', entry: updated });
    this.emit({
      entry: updated,
      from: entry.status,
      to: next,
      by: input.actor,
      ...(updated.summary !== undefined ? { summary: updated.summary } : {}),
      ...(forcedReason !== undefined ? { forcedReason } : {}),
    });
    return { ok: true, entry: updated };
  }

  /** WorkTask closed or detached: force-terminate the entry (`cancelled`)
   *  unless it already reached `completed`. Returns the resulting entry, or
   *  null for an unknown id. */
  async closeTask(id: string, actor: LedgerActor = SYSTEM_ACTOR(), summary = 'WorkTask closed'): Promise<LedgerEntry | null> {
    const entry = this.entries.get(id);
    if (!entry) return null;
    if (entry.status === 'completed' || entry.status === 'cancelled') return entry;
    const updated: LedgerEntry = {
      ...entry,
      status: 'cancelled',
      rev: entry.rev + 1,
      updatedAt: this.now(),
      updatedBy: actor,
      summary,
    };
    this.entries.set(id, updated);
    await this.append({ op: 'entry', entry: updated });
    this.emit({ entry: updated, from: entry.status, to: 'cancelled', by: actor, summary });
    return updated;
  }

  // ── orphaned events (worker events with no brain to receive them) ────────

  async recordOrphanedEvent(event: OrphanedEvent): Promise<void> {
    this.orphans.push(event);
    await this.append({ op: 'orphaned_event', event });
  }

  peekOrphanedEvents(ownerWorkspaceId: string): OrphanedEvent[] {
    return this.orphans
      .filter((o) => o.ownerWorkspaceId === ownerWorkspaceId)
      .sort((a, b) => a.seq - b.seq);
  }

  /** Drain the backlog for one owner workspace, in seq order. */
  takeOrphanedEvents(ownerWorkspaceId: string): OrphanedEvent[] {
    const taken = this.peekOrphanedEvents(ownerWorkspaceId);
    if (taken.length === 0) return taken;
    const upToSeq = taken[taken.length - 1].seq;
    this.orphans = this.orphans.filter(
      (o) => !(o.ownerWorkspaceId === ownerWorkspaceId && o.seq <= upToSeq),
    );
    void this.append({ op: 'orphans_drained', ownerWorkspaceId, upToSeq });
    return taken;
  }

  /** Resolves once every queued append (and any rotation) has hit disk. */
  flush(): Promise<void> {
    return this.queue;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private emit(t: LedgerTransition): void {
    for (const l of this.listeners) {
      try {
        l(t);
      } catch (err) {
        this.log(`[ledger] transition listener threw: ${String(err)}`);
      }
    }
  }

  private pruneTerminal(): void {
    const cutoff = this.now() - this.retentionMs;
    for (const [id, e] of this.entries) {
      if ((e.status === 'completed' || e.status === 'cancelled') && e.updatedAt < cutoff) {
        this.entries.delete(id);
      }
    }
  }

  private append(line: LedgerLine): Promise<void> {
    const text = `${JSON.stringify(line)}\n`;
    this.queue = this.queue
      .then(async () => {
        await fs.promises.mkdir(this.dir, { recursive: true });
        await fs.promises.appendFile(this.filePath, text, 'utf8');
        const stat = await fs.promises.stat(this.filePath);
        if (stat.size > this.rotateBytes) await this.rotate();
      })
      .catch((err) => {
        this.log(`[ledger] append failed: ${String(err)}`);
      });
    return this.queue;
  }

  /** Move the full log aside and open a fresh one with a snapshot line, so
   *  the new file alone replays to the current state. */
  private async rotate(): Promise<void> {
    const snapshot: LedgerLine = {
      op: 'snapshot',
      entries: [...this.entries.values()],
      orphans: [...this.orphans],
    };
    const rotated = `${this.filePath}.1`;
    await fs.promises.rm(rotated, { force: true });
    await fs.promises.rename(this.filePath, rotated);
    await fs.promises.writeFile(this.filePath, `${JSON.stringify(snapshot)}\n`, 'utf8');
  }

  /** Replay the log into memory. Returns the number of skipped lines. */
  private replay(): number {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      this.log(`[ledger] read failed, starting empty: ${String(err)}`);
      return 0;
    }
    const lines = raw.split('\n');
    let skipped = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A torn last line is the crash-mid-append case; anything else
        // malformed is skipped the same way rather than poisoning the boot.
        skipped += 1;
        continue;
      }
      this.apply(parsed);
    }
    if (skipped > 0) this.log(`[ledger] replay skipped ${skipped} unreadable line(s)`);
    return skipped;
  }

  private apply(parsed: unknown): void {
    if (!parsed || typeof parsed !== 'object') return;
    const line = parsed as Partial<LedgerLine> & { op?: string };
    switch (line.op) {
      case 'entry': {
        const e = (line as { entry?: unknown }).entry;
        if (isEntryShape(e)) this.entries.set(e.id, e);
        return;
      }
      case 'snapshot': {
        const s = line as { entries?: unknown; orphans?: unknown };
        this.entries.clear();
        if (Array.isArray(s.entries)) {
          for (const e of s.entries) if (isEntryShape(e)) this.entries.set(e.id, e);
        }
        this.orphans = Array.isArray(s.orphans) ? (s.orphans as OrphanedEvent[]) : [];
        return;
      }
      case 'orphaned_event': {
        const ev = (line as { event?: unknown }).event as OrphanedEvent | undefined;
        if (ev && typeof ev.ownerWorkspaceId === 'string' && typeof ev.seq === 'number') {
          this.orphans.push(ev);
        }
        return;
      }
      case 'orphans_drained': {
        const d = line as { ownerWorkspaceId?: unknown; upToSeq?: unknown };
        if (typeof d.ownerWorkspaceId === 'string' && typeof d.upToSeq === 'number') {
          this.orphans = this.orphans.filter(
            (o) => !(o.ownerWorkspaceId === d.ownerWorkspaceId && o.seq <= (d.upToSeq as number)),
          );
        }
        return;
      }
      default:
        return;
    }
  }
}
