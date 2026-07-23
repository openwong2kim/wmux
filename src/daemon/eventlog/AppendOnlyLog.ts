/**
 * AppendOnlyLog — segmented NDJSON append-only writer (envelope-design §2·§3).
 *
 * Contract summary (spec surface):
 *   - append(): Promise<boolean> — resolve(true) = durable via fsync barrier (commit).
 *     resolve(false) = batch rolled back (uncommitted). Does not throw (§2.4-5 D16).
 *   - lamport/origin.seq issued only inside append critical section (pre-increment, §3).
 *     When boot resume value is max, first new value is exactly max+1 (no off-by-one).
 *   - fsync coalescing (group commit, §2.5): arrivals during in-flight barrier batch to next barrier.
 *     Success·failure unit is always the batch.
 *   - batch single rollback (§2.4-4): on write/fsync failure truncate(committedOffset) **once** (path-based)
 *     physically removes all uncommitted + batch Promises all false. Order-dependent null tombstones impossible.
 *   - boot forward scan·first bad cut (§2.6): validate active segment front-to-back, cut at first
 *     bad line. Committed prefix fully·continuously guaranteed. Remaining valid tail may promote
 *     at-least-once (contract, not defect — §2.6 D17).
 *
 * PR1 scope: pure library. manifest·snapshot·migration are PR2 — not referenced here.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';

import type { EventEnvelope, EventEnvelopeDraft } from '../../shared/eventlog';

/** §2.8: 4MB segment roll. */
const DEFAULT_MAX_SEGMENT_BYTES = 4 * 1024 * 1024;
const SEGMENT_RE = /^(\d{8})\.ndjson$/;
const NEWLINE = 0x0a; // '\n'

export interface AppendOnlyLogOptions {
  /** events directory path. */
  dir: string;
  /**
   * Batch barrier fsync. Default async fs.fsync (coalescing window). Tests inject
   * throw to pin §2.4-4 batch rollback contract (dependency injection).
   */
  fsync?: (fd: number) => void | Promise<void>;
  /** Roll threshold (default 4MB). Tests force roll with small value. */
  maxSegmentBytes?: number;
  /**
   * Boot hwm floor (§3-4 clamp). When compaction truncates snapshot-reflected segments leaving only empty
   * (or no) segments, scan restores hwm lower than actual and lamport/seq **reuse**
   * (§6.L trap violation) — this floor closes that window: open() clamps scan hwm to max(scan, floor).
   * **PR3 wiring contract: always pass manifest.snapshotLamport as lamport floor**
   * (seq floor may equal same value until persistent coordinates exist — conservative given seq ≥ lamport issuance).
   */
  hwmFloor?: { lamport: number; seq: number };
}

interface PendingRecord {
  resolve: (ok: boolean) => void;
}

interface ScanResult {
  /** Valid byte length up to before first bad (truncate offset). */
  validEnd: number;
  maxLamport: number;
  maxSeq: number;
  records: EventEnvelope[];
}

/**
 * prototype-pollution guard reviver. Applies atomicWrite core.ts:99-104 guard to log line
 * parsing (§2.2). Required at trust boundary because payload is opaque.
 */
function stripProtoReviver(key: string, value: unknown): unknown {
  if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
    return undefined;
  }
  return value;
}

export class AppendOnlyLog {
  private readonly dir: string;
  private readonly fsyncFd: (fd: number) => void | Promise<void>;
  private readonly maxSegmentBytes: number;
  private readonly hwmFloor?: { lamport: number; seq: number };

  private fd = -1;
  private activeSegNum = 0;
  private activeSegPath = '';

  // §3: hwm = last used value (max). Issue pre-increment (hwm+1), confirm on write success.
  private hwmLamport = 0;
  private hwmSeq = 0;

  // §2.4: committedOffset = last successful fsync barrier offset (= single ftruncate point on rollback).
  private committedOffset = 0;
  private currentOffset = 0;
  private readonly unsynced: PendingRecord[] = [];
  private fsyncInFlight = false;
  // Rollback generation counter: if rollback interleaves during in-flight fsync, completion callback must not
  // double resolve/commit an already-false barrier.
  private rollbackEpoch = 0;
  private opened = false;
  // fail-stop marker (3-model panel): rollback ftruncate failure = "committedOffset == physical
  // EOF" coordinate invariant collapse. Continuing to write appends later true commits after bad tail and
  // next recovery·rollback pierces committed records (silent acked data loss).
  // → all later append immediately false. Resume only via reopen (new instance open).
  private broken = false;

  constructor(options: AppendOnlyLogOptions) {
    this.dir = options.dir;
    this.maxSegmentBytes = options.maxSegmentBytes ?? DEFAULT_MAX_SEGMENT_BYTES;
    this.hwmFloor = options.hwmFloor;
    this.fsyncFd =
      options.fsync ??
      ((fd) =>
        new Promise<void>((resolve, reject) => {
          fs.fsync(fd, (err) => (err ? reject(err) : resolve()));
        }));
  }

  /** §3: resumed lamport hwm (last used value). First new append = this value + 1. */
  get lamportHwm(): number {
    return this.hwmLamport;
  }

  /** §3: resumed origin.seq hwm (last used value). */
  get seqHwm(): number {
    return this.hwmSeq;
  }

  /** Current active segment path (for test observation). */
  get activeSegment(): string {
    return this.activeSegPath;
  }

  /**
   * Boot recovery (§2.6·§3·§2.8). Segment scan → active segment forward validate·truncate →
   * restore hwm. Post-roll crash (empty active segment) must not be mistaken for first-boot;
   * restore hwm from previous non-empty segment.
   */
  open(): void {
    if (this.opened) return;
    fs.mkdirSync(this.dir, { recursive: true });

    const segments = this.listSegments();

    // §3-2: first-boot = zero segments only. Create first segment, hwm=0.
    if (segments.length === 0) {
      this.activeSegNum = 1;
      this.activeSegPath = this.segPath(1);
      this.fd = this.createSegment(this.activeSegPath);
      this.committedOffset = 0;
      this.currentOffset = 0;
      this.applyHwmFloor(); // §3-4: floor blocks reuse even after compaction pre-loss
      this.opened = true;
      return;
    }

    // Active = highest-number segment. §2.6 forward scan + first bad cut.
    const activeNum = segments[segments.length - 1];
    this.activeSegNum = activeNum;
    this.activeSegPath = this.segPath(activeNum);

    const scan = this.forwardScanFile(this.activeSegPath);
    // §2.6 truncate is not best-effort (3-model panel): opening file with bad tail remaining in 'a' mode
    // appends later commits after tail; next boot scan stops at tail and discards those commits (acked loss).
    // Failure = open failure.
    this.truncateFileStrict(this.activeSegPath, scan.validEnd);

    if (scan.records.length > 0) {
      this.hwmLamport = scan.maxLamport;
      this.hwmSeq = scan.maxSeq;
    } else {
      // §3-3: active segment empty (post-roll crash) → descend to previous non-empty segment for
      // hwm restore. Lamport monotonic so latest non-empty segment has highest values.
      for (let i = segments.length - 2; i >= 0; i--) {
        const prev = this.forwardScanFile(this.segPath(segments[i]));
        if (prev.records.length > 0) {
          this.hwmLamport = prev.maxLamport;
          this.hwmSeq = prev.maxSeq;
          break;
        }
      }
    }

    // Open active segment in append('a') mode. 'a' writes at EOF each time so after
    // ftruncate append always lands at valid tail (no offset management needed).
    this.fd = fs.openSync(this.activeSegPath, 'a');
    this.committedOffset = scan.validEnd;
    this.currentOffset = scan.validEnd;
    this.applyHwmFloor(); // §3-4 floor clamp
    this.opened = true;
  }

  /**
   * §3-4 floor clamp: hwm = max(scan restore, hwmFloor). When compaction truncates segments scan cannot
   * reach, floor (snapshot coordinates) stands in for past issuance — no reuse invariant.
   */
  private applyHwmFloor(): void {
    if (!this.hwmFloor) return;
    if (this.hwmFloor.lamport > this.hwmLamport) {
      this.hwmLamport = this.hwmFloor.lamport;
    }
    if (this.hwmFloor.seq > this.hwmSeq) {
      this.hwmSeq = this.hwmFloor.seq;
    }
  }

  /**
   * Append one record (§2.4). Synchronous write critical section (no await → Node single-thread
   * mutex) issues lamport/seq + write; resolve when covering fsync barrier completes.
   */
  append(draft: EventEnvelopeDraft): Promise<boolean> {
    if (!this.opened) {
      return Promise.reject(
        new Error('AppendOnlyLog.append: open() must be called first'),
      );
    }
    return new Promise<boolean>((resolve) => {
      // In fail-stop state (coordinate invariant collapse) no write is safe — immediate false.
      if (this.broken) {
        resolve(false);
        return;
      }
      try {
        this.rollIfNeeded();

        // §3: pre-increment issue. Confirm hwm only after write success to avoid
        // unnecessary gap from write failure (no-reuse invariant holds on all paths).
        const lamport = this.hwmLamport + 1;
        const seq = this.hwmSeq + 1;
        // §1 "@ append": eventId·wallClock also issued here — reusing draft on retry still
        // gives fresh eventId per committed record for global uniqueness.
        const full: EventEnvelope = {
          ...draft,
          eventId: randomUUID(),
          wallClock: Date.now(),
          lamport,
          origin: { ...draft.origin, seq },
        };
        const buf = Buffer.from(`${JSON.stringify(full)}\n`, 'utf8');

        this.writeFully(buf); // §2.4-2 short-write loop

        this.hwmLamport = lamport;
        this.hwmSeq = seq;
        this.currentOffset += buf.length;
        this.unsynced.push({ resolve });
      } catch {
        // §2.4: write errors (ENOSPC/EIO) also go through batch single rollback path.
        this.rollbackBatch();
        resolve(false);
        return;
      }
      this.maybeStartFsync();
    });
  }

  /** Return committed records in order for current disk state (recovery truncate applied). For replay/tests. */
  readAllRecords(): EventEnvelope[] {
    const out: EventEnvelope[] = [];
    for (const n of this.listSegments()) {
      const scan = this.forwardScanFile(this.segPath(n));
      for (const rec of scan.records) out.push(rec);
    }
    return out;
  }

  /**
   * Close fd. Unconfirmed (unsynced) appends are **all finalized false** — only resolve(true) is
   * durability guarantee at shutdown boundary; pending promises must not hang forever
   * (panel C2). Un-fsynced lines on disk may absorb via next open valid-tail promotion (§2.6
   * at-least-once). flush-then-close (graceful shutdown) is service wiring (PR3, §6.4b).
   * In-flight barrier invalidated by epoch guard.
   */
  close(): void {
    this.rollbackEpoch++;
    const pending = this.unsynced.splice(0, this.unsynced.length);
    for (const rec of pending) rec.resolve(false);
    if (this.fd >= 0) {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* noop */
      }
      this.fd = -1;
    }
    this.opened = false;
  }

  // ── internal: fsync coalescing ────────────────────────────────────────────

  private maybeStartFsync(): void {
    if (this.broken || this.fsyncInFlight || this.unsynced.length === 0) return;
    this.fsyncInFlight = true;
    // Defer via microtask to coalesce synchronous burst (many appends same tick) into one barrier (§2.5).
    // Later tick arrivals batch to next in-flight barrier.
    queueMicrotask(() => {
      void this.runFsync();
    });
  }

  private async runFsync(): Promise<void> {
    const epoch = this.rollbackEpoch;
    const barrierCount = this.unsynced.length; // records this barrier covers
    const barrierEnd = this.currentOffset;

    let ok = true;
    try {
      await this.fsyncFd(this.fd);
    } catch {
      ok = false;
    }

    if (this.rollbackEpoch !== epoch) {
      // Rollback interleaved — barrier records already false. Resume only.
      this.fsyncInFlight = false;
      this.maybeStartFsync();
      return;
    }

    if (!ok) {
      this.rollbackBatch(); // §2.4-4 single truncate + all false
      this.fsyncInFlight = false;
      this.maybeStartFsync();
      return;
    }

    // Success: only barrier-covered portion durable. Arrivals in between go to next barrier.
    this.committedOffset = barrierEnd;
    const done = this.unsynced.splice(0, barrierCount);
    for (const rec of done) rec.resolve(true);
    this.fsyncInFlight = false;
    // §2.8 roll starvation prevention (panel X3): barrier success boundary too — under sustained load where
    // unsynced never empties at append time, roll succeeds here.
    if (this.unsynced.length === 0) this.rollIfNeeded();
    this.maybeStartFsync();
  }

  /**
   * §2.4-4 batch single rollback. truncate(committedOffset) **once** physically removes all uncommitted
   * (barrier + waiting after) and all false. Does not rewind hwm
   * (§3 trap: gap allowed, no reuse).
   *
   * Truncate is **path-based close→truncate→reopen**: on Windows 'a' (append)
   * mode fd ftruncate fails with EPERM (no SetEndOfFile on append-only handle — CI windows lane proven).
   * Sequence completes inside append critical section (sync) so atomicity holds.
   */
  private rollbackBatch(): void {
    this.rollbackEpoch++;
    try {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* noop — proceed path truncate even if already closed */
      }
      this.fd = -1;
      fs.truncateSync(this.activeSegPath, this.committedOffset);
      this.fd = fs.openSync(this.activeSegPath, 'a');
      this.currentOffset = this.committedOffset;
    } catch {
      // Swallowing truncate failure and continuing write diverges committedOffset from physical EOF; later
      // true commits append after bad tail and next rollback/boot pierces those commits
      // (3-model panel consensus — §2.6-c reboot promotion contract does not cover this in-process desync).
      // → fail-stop. Written tail handled by next open scan.
      this.broken = true;
    }
    const failed = this.unsynced.splice(0, this.unsynced.length);
    for (const rec of failed) rec.resolve(false);
  }

  // ── internal: segment·recovery ─────────────────────────────────────────────

  private rollIfNeeded(): void {
    // §2.8: roll only at batch boundary (unsynced empty) — batchStartOffset always
    // single file coordinate. Unresolved batch keeps writing current segment; roll at next boundary
    // (attempted at append time + after barrier success — prevents sustained-load starvation).
    if (this.broken) return;
    if (this.unsynced.length > 0) return;
    if (this.currentOffset <= this.maxSegmentBytes) return;
    // open-then-swap (panel C6): switch state only after new segment open succeeds.
    // On failure keep using current segment (state unchanged, retry next boundary) —
    // closing old fd first leaves fd-less half state on open failure.
    const nextNum = this.activeSegNum + 1;
    const nextPath = this.segPath(nextNum);
    let nextFd: number;
    try {
      nextFd = this.createSegment(nextPath);
    } catch {
      return;
    }
    try {
      fs.closeSync(this.fd);
    } catch {
      /* noop */
    }
    this.fd = nextFd;
    this.activeSegNum = nextNum;
    this.activeSegPath = nextPath;
    this.committedOffset = 0;
    this.currentOffset = 0;
  }

  private createSegment(segPath: string): number {
    const fd = fs.openSync(segPath, 'a'); // create + append open
    this.fsyncDir(); // §2.5: directory entry durability on first segment create
    return fd;
  }

  private writeFully(buf: Buffer): void {
    // §2.4-2: single fs.writeSync does not guarantee full write → loop.
    let written = 0;
    while (written < buf.length) {
      written += fs.writeSync(this.fd, buf, written, buf.length - written);
    }
  }

  private fsyncDir(): void {
    if (process.platform === 'win32') return; // §2.3 win32 residue
    let dirFd = -1;
    try {
      dirFd = fs.openSync(this.dir, 'r');
      fs.fsyncSync(dirFd);
    } catch {
      // best-effort — filesystems without directory fsync are §2.3 accepted residue
    } finally {
      if (dirFd >= 0) {
        try {
          fs.closeSync(dirFd);
        } catch {
          /* noop */
        }
      }
    }
  }

  private listSegments(): number[] {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.dir);
    } catch {
      return [];
    }
    const nums: number[] = [];
    for (const name of entries) {
      const m = SEGMENT_RE.exec(name);
      if (m) nums.push(Number(m[1]));
    }
    nums.sort((a, b) => a - b);
    return nums;
  }

  private segPath(n: number): string {
    return path.join(this.dir, `${String(n).padStart(8, '0')}.ndjson`);
  }

  /**
   * §2.6 forward scan. Parse line-by-line front-to-back with validation; stop at first bad line
   * (parse failure or non-\n-terminated tail). validEnd = valid length before that.
   * Everything after first bad is discarded even if valid lines remain (no partial promotion).
   */
  private forwardScanFile(filePath: string): ScanResult {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(filePath);
    } catch {
      return { validEnd: 0, maxLamport: 0, maxSeq: 0, records: [] };
    }

    let offset = 0;
    let validEnd = 0;
    let maxLamport = 0;
    let maxSeq = 0;
    const records: EventEnvelope[] = [];

    while (offset < buf.length) {
      const nl = buf.indexOf(NEWLINE, offset);
      if (nl === -1) {
        // non-\n-terminated tail (incomplete torn) → first bad, cut.
        break;
      }
      const line = buf.toString('utf8', offset, nl);
      let parsed: unknown;
      try {
        parsed = JSON.parse(line, stripProtoReviver);
      } catch {
        // parse failure (torn middle etc.) → first bad, discard rest.
        break;
      }
      if (parsed === null || typeof parsed !== 'object') {
        break;
      }
      const rec = parsed as EventEnvelope;
      // Minimum schema guard (panel C5): lines without issued fields ({} etc. non-envelope JSON) are
      // first bad — prevent unknown records promoting into hwm·replay.
      if (
        typeof rec.lamport !== 'number' ||
        typeof rec.eventId !== 'string' ||
        typeof rec.origin?.seq !== 'number'
      ) {
        break;
      }
      if (rec.lamport > maxLamport) maxLamport = rec.lamport;
      if (rec.origin.seq > maxSeq) maxSeq = rec.origin.seq;
      records.push(rec);
      validEnd = nl + 1;
      offset = nl + 1;
    }

    return { validEnd, maxLamport, maxSeq, records };
  }

  /**
   * §2.6 boot recovery truncate — **validating** (no best-effort, 3-model panel). If truncate
   * fails cannot establish "committed prefix = entire file" invariant so open fails
   * (better than opening on bad tail and losing later commits).
   */
  private truncateFileStrict(filePath: string, size: number): void {
    if (fs.statSync(filePath).size > size) {
      fs.truncateSync(filePath, size);
    }
    const after = fs.statSync(filePath).size;
    if (after !== size) {
      throw new Error(
        `AppendOnlyLog.open: recovery truncate failed — ${filePath} size ${after} != validEnd ${size}`,
      );
    }
  }
}
