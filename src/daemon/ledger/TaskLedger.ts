// ─── Task Ledger — the status log behind src/shared/ledger.ts ───────────────
//
// A STATUS LOG keyed by WorkTask id. WorkTask (daemon WorkTaskService) stays
// the source of identity and ownership: an entry is only ever created by
// `register`, which mirrors an existing task; the ledger never invents one.
//
// Storage: one JSONL file under the wmux data dir (WMUX_DATA_SUFFIX-scoped
// through the caller-supplied dir, exactly like the deck-* stores). Every
// write — the checks, the append and the in-memory commit — runs inside ONE
// serialized section, so two concurrent updates cannot both pass the
// compare-and-swap against the same snapshot, and memory only changes after
// the line is on disk: a failed append returns `persist_failed`, commits
// nothing and fires no listener. Boot replays the file in order; a truncated
// last line (crash mid-append) is ignored, never fatal. Past LEDGER_ROTATE_BYTES
// the file is rotated: the old log is hard-linked to `.1` and a snapshot line
// (every live entry + parked orphan) is renamed over the live path, so at no
// instant is there no ledger; a replay that finds no live file but a `.1`
// recovers from `.1`.
//
// Rules enforced here (the contract lists them; this is the writer):
//   - transitions: `canTransition`; a same-status resubmit is a no-op.
//   - authz: `canActorSet` — the ONE predicate, never re-implemented.
//   - gate results are written by the `system` actor only (`recordGate`,
//     the gate runner); `update` ignores a caller-supplied gate.
//   - `completed`: only by a `brain`, only from `review_requested` (table),
//     only with a SYSTEM-recorded gate whose exitCode is exactly 0 — unless
//     `force: true` with a non-empty `reason`, which is logged on the entry.
//   - CAS: every update names the `expectedRev` it read; a stale one is
//     refused.
//   - WorkTask closed/detached → `closeTask` forces `cancelled` unless the
//     entry is already `completed`.
//   - terminal entries older than LEDGER_TERMINAL_RETENTION_MS are pruned
//     from the live map on load and on list (`onPrune` tells the host).
//
// Orphaned events (lane F step 1): a worker lifecycle event whose owner
// workspace has no brain is parked here under `orphaned_event`, bounded by
// count and bytes (oldest dropped, logged), peeked as a backlog when a brain
// boots and acknowledged only once a wake actually delivered it.

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
/** Caps on free text the writer stores (a worker/brain summary, the gate
 *  command line). Bytes, truncated from the end — the head carries the
 *  meaning. */
export const LEDGER_SUMMARY_MAX_BYTES = 2 * 1024;
export const LEDGER_GATE_COMMAND_MAX_BYTES = 512;
/** Orphan backlog bounds (all owners together): oldest dropped past either. */
export const LEDGER_ORPHAN_MAX_COUNT = 200;
export const LEDGER_ORPHAN_MAX_BYTES = 256 * 1024;

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
  | 'force_reason_required'
  | 'persist_failed';

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
  orphanMaxCount?: number;
  orphanMaxBytes?: number;
  log?: (line: string) => void;
  /** Called with every entry id the retention prune drops, so a host can
   *  release what it keyed on the id. */
  onPrune?: (id: string) => void;
}

const SYSTEM_ACTOR = (workspaceId = 'daemon'): LedgerActor => ({ kind: 'system', workspaceId });

/** Keep the LAST `maxBytes` of `text` without splitting a UTF-8 sequence:
 *  after cutting, advance past any continuation bytes (10xxxxxx). */
export function truncateTail(text: string, maxBytes: number = LEDGER_GATE_TAIL_MAX_BYTES): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) start += 1;
  return buf.subarray(start).toString('utf8');
}

/** Keep the FIRST `maxBytes` of `text` without splitting a UTF-8 sequence:
 *  back the cut up to the start of the sequence it landed inside. */
export function truncateHead(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end).toString('utf8');
}

function boundGate(gate: LedgerGateResult): LedgerGateResult {
  return {
    exitCode: gate.exitCode === null ? null : typeof gate.exitCode === 'number' ? gate.exitCode : null,
    tail: truncateTail(typeof gate.tail === 'string' ? gate.tail : ''),
    at: typeof gate.at === 'number' ? gate.at : Date.now(),
    command: truncateHead(typeof gate.command === 'string' ? gate.command : '', LEDGER_GATE_COMMAND_MAX_BYTES),
    recordedBy: 'system',
  };
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

function isOrphanShape(v: unknown): v is OrphanedEvent {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.ownerWorkspaceId === 'string' && typeof o.seq === 'number' && 'payload' in o;
}

function orphanBytes(o: OrphanedEvent): number {
  return Buffer.byteLength(JSON.stringify(o), 'utf8');
}

export class TaskLedger {
  private readonly filePath: string;
  private readonly dir: string;
  private readonly now: () => number;
  private readonly rotateBytes: number;
  private readonly retentionMs: number;
  private readonly orphanMaxCount: number;
  private readonly orphanMaxBytes: number;
  private readonly log: (line: string) => void;
  private readonly onPrune: (id: string) => void;
  private readonly entries = new Map<string, LedgerEntry>();
  private orphans: OrphanedEvent[] = [];
  private readonly listeners = new Set<(t: LedgerTransition) => void>();
  /** Every write runs inside this chain — checks, append and commit together. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Lines the last load skipped (torn tail / malformed) — observability. */
  readonly skippedLines: number;
  /** True when the last load recovered from the rotated `.1` file. */
  readonly recoveredFromRotated: boolean;

  constructor(opts: TaskLedgerOptions) {
    this.dir = opts.dir;
    this.filePath = getTaskLedgerPath(opts.dir);
    this.now = opts.now ?? Date.now;
    this.rotateBytes = opts.rotateBytes ?? LEDGER_ROTATE_BYTES;
    this.retentionMs = opts.retentionMs ?? LEDGER_TERMINAL_RETENTION_MS;
    this.orphanMaxCount = opts.orphanMaxCount ?? LEDGER_ORPHAN_MAX_COUNT;
    this.orphanMaxBytes = opts.orphanMaxBytes ?? LEDGER_ORPHAN_MAX_BYTES;
    this.log = opts.log ?? (() => undefined);
    this.onPrune = opts.onPrune ?? (() => undefined);
    const loaded = this.replay();
    this.skippedLines = loaded.skipped;
    this.recoveredFromRotated = loaded.recovered;
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

  /** Same, but only an OPEN entry: a finished task's workspace must not keep
   *  routing events to the brain. */
  findOpenByTaskWorkspace(taskWorkspaceId: string): LedgerEntry | null {
    const e = this.findByTaskWorkspace(taskWorkspaceId);
    return e && isOpenLedgerStatus(e.status) ? e : null;
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
   *  an already-registered id returns its live entry and writes nothing.
   *  Rejects when the line could not be persisted (nothing is committed). */
  register(input: LedgerRegisterInput): Promise<LedgerEntry> {
    return this.serialize(async () => {
      const existing = this.entries.get(input.id);
      if (existing) return existing;
      const by = input.actor ?? SYSTEM_ACTOR();
      const entry: LedgerEntry = {
        schemaVersion: LEDGER_SCHEMA_VERSION,
        id: input.id,
        taskWorkspaceId: input.taskWorkspaceId,
        ownerWorkspaceId: input.ownerWorkspaceId,
        title: truncateHead(input.title, LEDGER_SUMMARY_MAX_BYTES),
        status: 'working',
        rev: 1,
        updatedAt: this.now(),
        updatedBy: by,
      };
      await this.append({ op: 'entry', entry });
      this.entries.set(entry.id, entry);
      this.emit({ entry, from: null, to: 'working', by });
      return entry;
    });
  }

  update(input: LedgerUpdateInput): Promise<LedgerUpdateResult> {
    return this.serialize(() => this.updateLocked(input));
  }

  private async updateLocked(input: LedgerUpdateInput): Promise<LedgerUpdateResult> {
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
      // Provenance, not just value: the gate must have been RECORDED by the
      // gate runner (system). A gate that arrived on the wire never counts.
      const gate = entry.gate;
      const gatePassed = gate !== undefined && gate.recordedBy === 'system' && gate.exitCode === 0;
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
        forcedReason = truncateHead(reason, LEDGER_SUMMARY_MAX_BYTES);
      }
    }
    const given =
      typeof input.summary === 'string' && input.summary.trim().length > 0
        ? truncateHead(input.summary.trim(), LEDGER_SUMMARY_MAX_BYTES)
        : undefined;
    const base = given ?? entry.summary;
    const summary =
      forcedReason !== undefined
        ? truncateHead(`${base ? `${base} ` : ''}[forced: ${forcedReason}]`, LEDGER_SUMMARY_MAX_BYTES)
        : base;
    const updated: LedgerEntry = {
      ...entry,
      status: next,
      rev: entry.rev + 1,
      updatedAt: this.now(),
      updatedBy: input.actor,
      ...(summary !== undefined ? { summary } : {}),
    };
    try {
      await this.append({ op: 'entry', entry: updated });
    } catch (err) {
      return { ok: false, error: 'persist_failed', message: `ledger write failed: ${String(err)}`, entry };
    }
    this.entries.set(updated.id, updated);
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

  /** The gate runner's write: attach a gate result to an entry. SYSTEM only —
   *  this is the one provenance `completed` trusts. Bumps the rev (a brain
   *  holding an older rev re-reads and sees the result). No status change,
   *  no transition event.
   *
   *  `expectedRev` is the same compare-and-swap `update()` enforces, and it
   *  belongs INSIDE this serialized section for the same reason: a caller that
   *  read the rev, compared it, and then awaited this call was comparing across
   *  an await, and any write that landed in between was silently overwritten. */
  recordGate(
    id: string,
    gate: LedgerGateResult,
    actor: LedgerActor = SYSTEM_ACTOR(),
    expectedRev?: number,
  ): Promise<LedgerUpdateResult> {
    return this.serialize(async () => {
      const entry = this.entries.get(id);
      if (!entry) return { ok: false, error: 'not_found', message: `no ledger entry for task ${id}` };
      if (actor.kind !== 'system') {
        return { ok: false, error: 'not_authorized', message: 'only the gate runner (system) may record a gate result', entry };
      }
      if (expectedRev !== undefined && expectedRev !== entry.rev) {
        return {
          ok: false,
          error: 'stale_rev',
          message: `expectedRev ${expectedRev} but the entry is at rev ${entry.rev} — re-read and retry`,
          entry,
        };
      }
      const updated: LedgerEntry = {
        ...entry,
        gate: boundGate(gate),
        rev: entry.rev + 1,
        updatedAt: this.now(),
        updatedBy: actor,
      };
      try {
        await this.append({ op: 'entry', entry: updated });
      } catch (err) {
        return { ok: false, error: 'persist_failed', message: `ledger write failed: ${String(err)}`, entry };
      }
      this.entries.set(id, updated);
      return { ok: true, entry: updated };
    });
  }

  /** WorkTask closed or detached: force-terminate the entry (`cancelled`)
   *  unless it already reached `completed`. Returns the resulting entry, or
   *  null for an unknown id; the previous entry when the write failed. */
  closeTask(id: string, actor: LedgerActor = SYSTEM_ACTOR(), summary = 'WorkTask closed'): Promise<LedgerEntry | null> {
    return this.serialize(async () => {
      const entry = this.entries.get(id);
      if (!entry) return null;
      if (entry.status === 'completed' || entry.status === 'cancelled') return entry;
      const updated: LedgerEntry = {
        ...entry,
        status: 'cancelled',
        rev: entry.rev + 1,
        updatedAt: this.now(),
        updatedBy: actor,
        summary: truncateHead(summary, LEDGER_SUMMARY_MAX_BYTES),
      };
      try {
        await this.append({ op: 'entry', entry: updated });
      } catch (err) {
        this.log(`[ledger] closeTask ${id} not persisted: ${String(err)}`);
        return entry;
      }
      this.entries.set(id, updated);
      this.emit({ entry: updated, from: entry.status, to: 'cancelled', by: actor, summary: updated.summary });
      return updated;
    });
  }

  // ── orphaned events (worker events with no brain to receive them) ────────

  /** Park an event. Bounded: past the count or byte cap the OLDEST parked
   *  events are dropped (and logged) before this one is appended. */
  recordOrphanedEvent(event: OrphanedEvent): Promise<void> {
    return this.serialize(async () => {
      const next = [...this.orphans, event];
      let bytes = next.reduce((n, o) => n + orphanBytes(o), 0);
      let dropped = 0;
      while (next.length > 1 && (next.length > this.orphanMaxCount || bytes > this.orphanMaxBytes)) {
        const gone = next.shift() as OrphanedEvent;
        bytes -= orphanBytes(gone);
        dropped += 1;
      }
      if (dropped > 0) {
        this.log(`[ledger] orphan backlog over cap — dropped ${dropped} oldest parked event(s)`);
      }
      await this.append({ op: 'orphaned_event', event });
      this.orphans = next;
    });
  }

  /** The backlog for one owner workspace, in seq order. Non-destructive: the
   *  caller acknowledges what a wake actually delivered (`ackOrphanedEvents`). */
  peekOrphanedEvents(ownerWorkspaceId: string): OrphanedEvent[] {
    return this.orphans
      .filter((o) => o.ownerWorkspaceId === ownerWorkspaceId)
      .sort((a, b) => a.seq - b.seq);
  }

  /** Drop the parked events of `ownerWorkspaceId` at or below `upToSeq` —
   *  they reached a brain. */
  ackOrphanedEvents(ownerWorkspaceId: string, upToSeq: number): Promise<void> {
    return this.serialize(async () => {
      const remaining = this.orphans.filter(
        (o) => !(o.ownerWorkspaceId === ownerWorkspaceId && o.seq <= upToSeq),
      );
      if (remaining.length === this.orphans.length) return;
      await this.append({ op: 'orphans_drained', ownerWorkspaceId, upToSeq });
      this.orphans = remaining;
    });
  }

  /** Resolves once every queued write (and any rotation) has settled. */
  flush(): Promise<void> {
    return this.queue.then(() => undefined, () => undefined);
  }

  // ── internals ────────────────────────────────────────────────────────────

  /** Run `fn` after every earlier write, and before every later one. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

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
        try {
          this.onPrune(id);
        } catch {
          // a host hook must not break the prune
        }
      }
    }
  }

  /** Append one line (caller holds the write section). Rejects on failure;
   *  the caller then commits nothing. */
  private async append(line: LedgerLine): Promise<void> {
    const text = `${JSON.stringify(line)}\n`;
    await fs.promises.mkdir(this.dir, { recursive: true });
    await fs.promises.appendFile(this.filePath, text, 'utf8');
    const stat = await fs.promises.stat(this.filePath);
    if (stat.size > this.rotateBytes) {
      try {
        await this.rotate(line);
      } catch (err) {
        // The append itself succeeded; a failed rotation only delays the
        // next one. Never fail the write for it.
        this.log(`[ledger] rotation failed: ${String(err)}`);
      }
    }
  }

  /** Keep the old log as `.1` (hard link, so it exists before anything moves)
   *  and rename a fresh snapshot over the live path — no instant without a
   *  ledger. Refuses when the snapshot itself would exceed the cap: rotating
   *  would immediately need rotating again, so the log is left to grow and a
   *  warning is logged instead. `justAppended` is the line the snapshot must
   *  already reflect — the caller commits it to memory only after append
   *  returns, so it is folded in here. */
  private async rotate(justAppended: LedgerLine): Promise<void> {
    const entries = new Map(this.entries);
    let orphans = [...this.orphans];
    if (justAppended.op === 'entry') entries.set(justAppended.entry.id, justAppended.entry);
    else if (justAppended.op === 'orphaned_event') orphans.push(justAppended.event);
    else if (justAppended.op === 'orphans_drained') {
      orphans = orphans.filter(
        (o) => !(o.ownerWorkspaceId === justAppended.ownerWorkspaceId && o.seq <= justAppended.upToSeq),
      );
    }
    const snapshot: LedgerLine = { op: 'snapshot', entries: [...entries.values()], orphans };
    const text = `${JSON.stringify(snapshot)}\n`;
    if (Buffer.byteLength(text, 'utf8') > this.rotateBytes) {
      this.log('[ledger] snapshot would exceed the rotation cap — not rotating');
      return;
    }
    const rotated = `${this.filePath}.1`;
    const tmp = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.promises.writeFile(tmp, text, 'utf8');
    await fs.promises.rm(rotated, { force: true });
    await fs.promises.link(this.filePath, rotated);
    await fs.promises.rename(tmp, this.filePath);
  }

  /** Replay the log into memory. Falls back to the rotated `.1` file when the
   *  live file is missing (a crash between the two rotation steps). */
  private replay(): { skipped: number; recovered: boolean } {
    let raw: string | null = this.readLog(this.filePath);
    let recovered = false;
    if (raw === null) {
      raw = this.readLog(`${this.filePath}.1`);
      if (raw === null) return { skipped: 0, recovered: false };
      recovered = true;
      this.log('[ledger] live log missing — recovering from the rotated .1 file');
    }
    const lines = raw.split('\n');
    let skipped = 0;
    for (const line of lines) {
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
    return { skipped, recovered };
  }

  private readLog(p: string): string | null {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.log(`[ledger] read of ${p} failed: ${String(err)}`);
      }
      return null;
    }
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
        this.orphans = Array.isArray(s.orphans) ? s.orphans.filter(isOrphanShape) : [];
        return;
      }
      case 'orphaned_event': {
        const ev = (line as { event?: unknown }).event;
        if (isOrphanShape(ev)) this.orphans.push(ev);
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
