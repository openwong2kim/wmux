import { terminalCoreSelection } from '../shared/terminalCoreSettings';
import { writeFile, rename, unlink } from 'node:fs/promises';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  ftruncateSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadNativeTerminalCore, reportNativeFallback, type NativeRingStorage, type NativeOutputChunk } from '../shared/nativeTerminalCore';

// Pattern that identifies temporary buffer files produced by
// dumpToFile / dumpToFileSyncAtomic. Recovery / dump-readers must skip
// these; they may exist briefly between the tmp write and the rename.
const TMP_SUFFIX_RE = /\.tmp\.[0-9a-f]+$/;

// Windows-only: an antivirus real-time scan or a concurrent reader can hold a
// transient handle on the destination `.buf`, making the final rename fail
// EPERM / EACCES / EBUSY. The lock releases within tens of ms, so a bounded
// backoff retry clears it instead of leaving the session dirty (which would
// re-dump the full multi-MB ring every 30 s tick — pure churn). POSIX rename is
// atomic and never hits this, so the retry is gated on win32.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_RETRY_BACKOFFS_MS = [20, 50, 100, 200]; // ≤ +370 ms, trivial vs the 30 s tick

// Per-DESTINATION serialization for the ASYNC dumps (codex #4). The rename
// retry widens a pre-existing race: the async call sites — the 30 s snapshot
// tick, the interrupted-session dump, and the async shutdown dump — can each
// dump the SAME session path, and a retry-delayed older dump could otherwise
// rename AFTER a newer one and restore stale scrollback. Atomic rename
// guarantees integrity, not freshness. Chaining dumps to the same path (keyed
// by the destination, the actual shared resource) makes the newest-enqueued
// dump land last. The map entry is deleted once the chain tail resolves, so it
// never grows unbounded.
//
// The SYNC exit path (dumpToFileSyncAtomic) is deliberately NOT chained: it is
// the terminal last-word write in the Windows process.on('exit') handler, where
// no event loop is left to await a chain, and it runs after the async shutdown
// body has settled — so it is already the freshest, final write by construction
// (GLM P3: this is a doc clarification, not a gap).
const dumpChains = new Map<string, Promise<void>>();

/**
 * Fixed-size circular byte buffer for storing ConPTY output per session.
 * Preserves raw bytes including ANSI escape sequences without any filtering.
 * When the buffer is full, the oldest data is overwritten.
 */
/**
 * Initial physical allocation for a new buffer. The ring grows from here by
 * doubling, up to its configured ceiling, so an idle session that prints
 * little holds only ~64 KB instead of the full multi-MB ceiling (the default
 * is 8 MB/session). Buffers whose ceiling is already ≤ this value allocate
 * their ceiling outright and behave as a classic fixed ring.
 */
const INITIAL_PHYSICAL_BYTES = 64 * 1024;

/** A PTY size change at a point in the byte stream. `at` is a lifetime
 *  offset (totalBytesWritten when the change took effect). */
interface GeometryMark {
  at: number;
  cols: number;
  rows: number;
}

/**
 * The sizes the stored bytes were written at, relative to a readAll() copy:
 * `start` applies from byte 0, and each change applies from its `offset` on.
 * A replay that parses the whole ring at one width re-wraps history written
 * at another — cursor-up redraws (Claude Code's inline TUI) then land on the
 * wrong rows and stack into garbled frames. Replaying each stretch at its own
 * width and resizing after (which reflows like the live terminal did) avoids it.
 */
export interface ReplayGeometry {
  start: { cols: number; rows: number };
  changes: Array<{ offset: number; cols: number; rows: number }>;
}

/** Bound on remembered size changes inside the ring window. A divider drag
 *  sends a burst of them; past this the oldest in-window ones are merged into
 *  the start size (a replay of that stretch is no worse than before this log). */
const MAX_GEOMETRY_MARKS = 256;

export class RingBuffer {
  private native?: NativeRingStorage;
  private disposed = false;
  readonly backend: 'node' | 'rust';
  private buffer: Buffer;
  private readonly capacity: number;  // logical ceiling — the max this ring will ever hold
  private physical: number;           // bytes currently allocated (<= capacity), grown on demand
  private writePos: number;   // next write position (0..physical-1)
  private length: number;     // bytes currently stored (<= physical)
  private totalWritten: number; // monotonic lifetime count (used as byte offset for PromptEventLog)
  private geometry: GeometryMark[] = []; // size changes, oldest first (see ReplayGeometry)
  // Idle hibernation (node backend only, see BufferHibernation.ts): while
  // `hibernatedPath` is set, `buffer` is released and the stored bytes live
  // only in that `.buf`. `length`, `totalWritten` and `geometry` stay in
  // memory, so every offset consumer is unaffected; the bytes come back
  // synchronously on the first read or write (wake()).
  private hibernatedPath: string | null = null;
  private hibernatedFileBytes = 0; // what that `.buf` held when it was released
  private releasedBytes = 0;
  // Output that arrived while the `.buf` could not be read back: it follows
  // the file's bytes and joins them on the next successful wake. Always fewer
  // than `capacity` bytes (it replaces the file once it fills the ring), and
  // kept even after a dump writes it to the file (`appendedBytes` of it).
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private appendedBytes = 0;
  private wakeFailing = false; // the current failure episode is counted
  private nextWriteWakeAt = 0; // output retries a failing wake at most this often
  private wokeAt = 0;
  private mutations = 0; // bumps on every content change, including clear()
  private lastDump: { path: string; mutations: number } | null = null;

  constructor(capacityBytes: number, backend: 'node' | 'rust' = terminalCoreSelection() === 'rust' ? 'rust' : 'node') {
    if (capacityBytes <= 0 || !Number.isInteger(capacityBytes)) {
      throw new Error('capacityBytes must be a positive integer');
    }
    this.capacity = capacityBytes;
    if (backend === 'rust') {
      try { this.native = new (loadNativeTerminalCore('ring-v1').NativeRing)(capacityBytes); }
      catch { reportNativeFallback('ring'); }
    }
    this.backend = this.native ? 'rust' : 'node';
    this.physical = Math.min(INITIAL_PHYSICAL_BYTES, capacityBytes);
    this.buffer = Buffer.alloc(this.native ? 0 : this.physical);
    this.writePos = 0;
    this.length = 0;
    this.totalWritten = 0;
  }

  /**
   * Grow the physical allocation so it can hold at least `needed` bytes
   * linearly, doubling each step and clamping at the ceiling. No-op once the
   * allocation already covers `needed` or has reached the ceiling. Existing
   * contents are copied in logical order (oldest→newest) into the new buffer,
   * which also un-wraps the ring (writePos = length) — safe because after a
   * grow the stored length is strictly below the new physical size.
   */
  private ensureCapacity(needed: number): void {
    if (this.physical >= this.capacity || needed <= this.physical) return;
    let next = this.physical;
    while (next < needed && next < this.capacity) next *= 2;
    next = Math.min(next, this.capacity);
    if (next === this.physical) return;

    const grown = Buffer.alloc(next);
    // Copy directly into the new allocation: readAll() would allocate and
    // copy the entire history once more during every growth step.
    const start = this.length < this.physical ? 0 : this.writePos;
    const tailLength = Math.min(this.length, this.physical - start);
    this.buffer.copy(grown, 0, start, start + tailLength);
    if (tailLength < this.length) {
      this.buffer.copy(grown, tailLength, 0, this.length - tailLength);
    }
    this.buffer = grown;
    this.physical = next;
    this.writePos = this.length; // length < next, so no wrap
  }

  /**
   * Write data into the ring buffer.
   * If data exceeds capacity, only the last `capacity` bytes are preserved.
   */
  write(data: Buffer): void {
    if (this.disposed) throw new Error('Ring disposed');
    if (this.native) { this.native.write(data); return; }
    const dataLen = data.length;
    if (dataLen === 0) return;
    if (!this.wake(false)) { this.writeWhileAsleep(data); return; }
    this.mutations++;

    this.totalWritten += dataLen;

    // Grow toward the ceiling so this write lands without prematurely
    // overwriting still-young data. Once at the ceiling the ring wraps.
    this.ensureCapacity(this.length + dataLen);

    // If incoming data is larger than the current allocation, only keep the tail
    if (dataLen >= this.physical) {
      const offset = dataLen - this.physical;
      data.copy(this.buffer, 0, offset, dataLen);
      this.writePos = 0;
      this.length = this.physical;
      return;
    }

    // How much space from writePos to end of buffer
    const spaceToEnd = this.physical - this.writePos;

    if (dataLen <= spaceToEnd) {
      // Fits without wrapping
      data.copy(this.buffer, this.writePos);
    } else {
      // Wraps around
      data.copy(this.buffer, this.writePos, 0, spaceToEnd);
      data.copy(this.buffer, 0, spaceToEnd, dataLen);
    }

    this.writePos = (this.writePos + dataLen) % this.physical;
    this.length = Math.min(this.length + dataLen, this.physical);
  }

  /** Retain a transport-owned chunk without sending its bytes back through JS. */
  writeNativeChunk(chunk: NativeOutputChunk): void {
    if (this.disposed) throw new Error('Ring disposed');
    if (this.native?.writeChunk) this.native.writeChunk(chunk);
    else this.write(chunk.readBytes());
  }

  /**
   * Total bytes ever written to this buffer over its lifetime (monotonic).
   * Used by PromptEventLog as a stable offset even after the ring wraps.
   */
  get totalBytesWritten(): number {
    if (this.native) return this.native.totalBytesWritten;
    return this.totalWritten;
  }

  /** Capture inside the shared snapshot slot; callers own the frozen copy. */
  freezeNative() { return this.native?.freeze(); }

  /** Release native storage on explicit session removal, independently of GC. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.native?.dispose();
    this.buffer = Buffer.alloc(0); this.length = 0; this.physical = 0; this.writePos = 0;
    this.geometry = [];
    this.hibernatedPath = null;
    this.pending = []; this.pendingBytes = 0; this.appendedBytes = 0;
  }

  /**
   * Record that the PTY now writes at `cols`×`rows`. Bytes written from here
   * on were produced at this size. Repeats of the current size are ignored.
   */
  noteGeometry(cols: number, rows: number): void {
    if (this.disposed) throw new Error('Ring disposed');
    if (this.native) {
      if (cols > 0 && rows > 0) this.native.noteGeometry(cols, rows);
      return;
    }
    if (!(cols > 0 && rows > 0)) return;
    const last = this.geometry[this.geometry.length - 1];
    if (last && last.cols === cols && last.rows === rows) return;
    if (last && last.at === this.totalWritten) {
      // No bytes at the previous size — it never applied to anything.
      this.geometry[this.geometry.length - 1] = { at: this.totalWritten, cols, rows };
    } else {
      this.geometry.push({ at: this.totalWritten, cols, rows });
    }
    this.pruneGeometry();
  }

  /**
   * readAll() plus the sizes its bytes were written at, and the lifetime
   * byte count at the read (`writtenAt`) so a later read can locate exactly
   * the bytes that arrived since. `geometry` is undefined when no size was
   * ever recorded.
   */
  readAllWithGeometry(): { data: Buffer; geometry: ReplayGeometry | undefined; writtenAt: number } {
    if (this.native) {
      const snapshot = this.native.readAllWithGeometry();
      return { ...snapshot, geometry: snapshot.geometry ?? undefined };
    }
    const data = this.readAll();
    const writtenAt = this.totalWritten;
    this.pruneGeometry();
    // Still hibernated: `data` is only the newest bytes, which the marks
    // (kept for the full window) do not line up with.
    if (this.geometry.length === 0 || this.hibernatedPath !== null) return { data, geometry: undefined, writtenAt };
    const windowStart = this.totalWritten - data.length;
    const [first, ...rest] = this.geometry;
    return {
      data,
      writtenAt,
      geometry: {
        start: { cols: first.cols, rows: first.rows },
        changes: rest.map((m) => ({ offset: m.at - windowStart, cols: m.cols, rows: m.rows })),
      },
    };
  }

  /** Drop marks wholly before the stored window, keeping the one that applies
   *  at the window's first byte, and merge past MAX_GEOMETRY_MARKS. */
  private pruneGeometry(): void {
    const windowStart = this.totalWritten - this.length;
    let firstApplying = 0;
    while (firstApplying + 1 < this.geometry.length && this.geometry[firstApplying + 1].at <= windowStart) {
      firstApplying++;
    }
    if (firstApplying > 0) this.geometry.splice(0, firstApplying);
    if (this.geometry.length > MAX_GEOMETRY_MARKS) {
      this.geometry.splice(0, this.geometry.length - MAX_GEOMETRY_MARKS);
    }
  }

  /**
   * Read all stored data in order (oldest first, newest last).
   * Returns a new Buffer copy; the internal buffer is not modified.
   */
  readAll(): Buffer {
    if (this.native) return this.native.readAll();
    // The `.buf` is unreadable right now: serve the newest bytes, keep the file.
    if (!this.wake()) return Buffer.concat(this.pending);
    if (this.length === 0) {
      return Buffer.alloc(0);
    }

    if (this.length < this.physical) {
      // Buffer has not wrapped yet; data is at [0..length)
      return Buffer.from(this.buffer.subarray(0, this.length));
    }

    // Buffer is full and has wrapped.
    // writePos points to the oldest byte (it's where the next write will go).
    // Order: [writePos..physical) + [0..writePos)
    const tail = this.buffer.subarray(this.writePos, this.physical);
    const head = this.buffer.subarray(0, this.writePos);
    return Buffer.concat([tail, head]);
  }

  /** Clear the buffer, resetting all pointers and zeroing sensitive data. */
  clear(): void {
    if (this.disposed) throw new Error('Ring disposed');
    if (this.native) { this.native.clear(); return; }
    if (this.hibernatedPath !== null) this.restore(Buffer.alloc(0)); // nothing to read back
    this.mutations++;
    this.buffer.fill(0);
    this.writePos = 0;
    this.length = 0;
    // totalWritten is intentionally NOT reset — it represents the stream's
    // lifetime byte count, which PromptEventLog consumers may still hold
    // references to.
  }

  /** Number of bytes currently stored. */
  get size(): number {
    if (this.native) return this.native.size;
    return this.length;
  }

  /** Logical ceiling in bytes — the most this ring will ever store. */
  get totalCapacity(): number {
    return this.capacity;
  }

  /** Bytes currently committed for backing storage (grows on demand toward the ceiling). */
  get allocatedBytes(): number {
    if (this.native) return this.native.allocatedBytes;
    return this.physical + this.pendingBytes;
  }

  /** Whether replay needs resize-aware parsing, without copying the byte buffer. */
  get hasGeometryChanges(): boolean {
    if (this.native) return this.native.hasGeometryChanges;
    this.pruneGeometry();
    return this.geometry.length > 1;
  }

  /**
   * Dump the buffer contents to a file atomically (write to tmp + rename).
   *
   * Phase A — A4. Writing the .buf directly is not safe across a crash:
   * a reader that races a half-written buffer would see a truncated file
   * and either fail to parse or restore a scrollback that abruptly cuts
   * off mid-frame. tmp + rename keeps readers from ever observing a
   * partial state — the rename either has happened or has not.
   *
   * The tmp file lives in the SAME parent directory as the destination
   * so rename is always intra-FS (cross-device renames fail with EXDEV).
   * On failure, the tmp file is best-effort cleaned up; recovery code
   * also sweeps stale tmps via {@link cleanupStaleTmpFiles}.
   */
  async dumpToFile(filePath: string): Promise<void> {
    // Serialize on the destination path so a retry-delayed older dump can never
    // rename after a newer one (codex #4). A prior dump's rejection must NOT
    // skip this dump, so we chain off a swallowed copy of the previous promise.
    const prev = dumpChains.get(filePath) ?? Promise.resolve();
    const run = prev
      .catch(() => { /* a prior dump's failure must not skip this one */ })
      .then(() => this.doDumpToFile(filePath));
    dumpChains.set(filePath, run);
    try {
      await run;
    } finally {
      // Only clear when we are still the chain tail — a dump enqueued after us
      // owns the entry now, and deleting it would break its serialization.
      if (dumpChains.get(filePath) === run) dumpChains.delete(filePath);
    }
  }

  /** The actual tmp-write + atomic-rename, run inside the per-path chain. */
  private async doDumpToFile(filePath: string): Promise<void> {
    // A queued dump can outlive explicit session removal. Never replace a
    // valid dump with the now-disposed ring's empty storage.
    if (this.disposed) return;
    // Hibernated to this very file: it already holds the bytes. Reading them
    // back would wake the ring on every forced snapshot tick.
    if (this.hibernatedPath === filePath && this.appendedBytes === this.pendingBytes) return;
    if (!this.wake()) { this.appendPendingTo(filePath); return; }
    // Captured here (inside the chain) rather than at enqueue time: a slightly
    // fresher snapshot is never wrong for recovery, and the snapshotRunner's
    // dirty-tracking captures totalBytesWritten BEFORE calling us, so a fresher
    // readAll at worst leaves the session marked dirty for one extra tick.
    const data = this.readAll();
    const mutations = this.mutations;
    const tmpPath = `${filePath}.tmp.${crypto.randomBytes(6).toString('hex')}`;
    try {
      // mode is a no-op on Windows; use icacls for NTFS ACLs.
      await writeFile(tmpPath, data, { mode: 0o600 });
      await RingBuffer.renameWithRetry(tmpPath, filePath);
      this.lastDump = { path: filePath, mutations };
    } catch (err) {
      try { await unlink(tmpPath); } catch { /* tmp may already be gone */ }
      throw err;
    }
  }

  /**
   * rename with a bounded win32-only backoff retry for transient handle-lock
   * failures (AV scan / concurrent reader). Non-win32, non-transient codes, and
   * exhausted retries all throw exactly as a bare rename would — the caller's
   * catch still runs (tmp cleanup + rethrow), so the dirty-retry contract holds.
   */
  private static async renameWithRetry(from: string, to: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(from, to);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code ?? '';
        if (
          process.platform === 'win32' &&
          RENAME_RETRY_CODES.has(code) &&
          attempt < RENAME_RETRY_BACKOFFS_MS.length
        ) {
          await new Promise((r) => setTimeout(r, RENAME_RETRY_BACKOFFS_MS[attempt]));
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Synchronous atomic dump. Used by the Windows process.on('exit')
   * handler as a last-resort save when the daemon has no time to await
   * the async path. Same tmp + rename invariants as {@link dumpToFile}.
   */
  dumpToFileSyncAtomic(filePath: string): void {
    if (this.disposed) return;
    if (this.hibernatedPath === filePath && this.appendedBytes === this.pendingBytes) return; // see doDumpToFile
    if (!this.wake()) { this.appendPendingTo(filePath); return; }
    const data = this.readAll();
    const tmpPath = `${filePath}.tmp.${crypto.randomBytes(6).toString('hex')}`;
    try {
      writeFileSync(tmpPath, data, { mode: 0o600 });
      renameSync(tmpPath, filePath);
      this.lastDump = { path: filePath, mutations: this.mutations };
    } catch (err) {
      try { unlinkSync(tmpPath); } catch { /* tmp may already be gone */ }
      throw err;
    }
  }

  /** True while the stored bytes live only in the `.buf` (see hibernate). */
  get isHibernated(): boolean {
    return this.hibernatedPath !== null;
  }

  /** Bytes of backing storage the current hibernation released (0 when awake). */
  get hibernatedBytes(): number {
    return this.releasedBytes;
  }

  /**
   * Move the stored bytes to `filePath` (the session's recovery `.buf`, via
   * the same atomic dump) and release the backing storage. Returns the bytes
   * released, or 0 when nothing was released.
   *
   * Race-free by construction: the ring stays fully in memory until the dump
   * has landed, and the release happens synchronously right after, only if no
   * byte was written or cleared meanwhile and `stillIdle()` (re-checked at
   * that instant) holds. A reader during the write reads memory; a reader
   * after it wakes the ring from the file. A failed dump throws and releases
   * nothing. The rust backend is never hibernated.
   */
  async hibernate(filePath: string, stillIdle: () => boolean): Promise<number> {
    if (this.native || this.disposed || this.hibernatedPath !== null || this.length === 0) return 0;
    const mark = this.mutations;
    // Skip the write when this ring's last dump to the same file is still
    // current (a periodic snapshot, or the dump of an earlier hibernation that
    // a read woke from) and the file still holds every byte.
    if (!(this.lastDump?.path === filePath && this.lastDump.mutations === mark && RingBuffer.fileSize(filePath) === this.length)) {
      await this.dumpToFile(filePath);
    }
    if (this.disposed || this.hibernatedPath !== null || this.mutations !== mark || this.length === 0) return 0;
    if (this.lastDump?.path !== filePath || this.lastDump.mutations !== mark) return 0;
    if (!stillIdle()) return 0;
    const released = this.physical;
    this.hibernatedPath = filePath;
    this.hibernatedFileBytes = this.length;
    this.releasedBytes = released;
    this.buffer = Buffer.alloc(0);
    this.physical = 0;
    this.writePos = 0;
    return released;
  }

  /**
   * Bring hibernated bytes back from the `.buf`. Every read and write calls
   * this first; call it directly before deleting that `.buf`. Synchronous, so
   * no caller can observe a half-woken ring. Returns false, and stays
   * hibernated with the file untouched, when the file exists but cannot be
   * read right now (EMFILE, a sharing violation): the next access retries,
   * and PTY output (`retryNow` false) at most once a second.
   * A file that is gone cannot come back, so the ring wakes without it.
   */
  wake(retryNow = true): boolean {
    const file = this.hibernatedPath;
    if (file === null) return true;
    if (!retryNow && this.wakeFailing && Date.now() < this.nextWriteWakeAt) return false;
    // Only the bytes the ring can still hold are read: the newest part of the
    // released history, up to `capacity` with the output held since.
    const base = this.hibernatedFileBytes;
    const want = Math.min(base, this.capacity - this.pendingBytes);
    let stored: Buffer;
    let fileBytes: number;
    try {
      const fd = openSync(file, 'r');
      try {
        fileBytes = fstatSync(fd).size;
        const end = Math.min(base, fileBytes);
        stored = Buffer.alloc(Math.min(want, end));
        let got = 0;
        while (got < stored.length) {
          const n = readSync(fd, stored, got, stored.length - got, end - stored.length + got);
          if (n === 0) break;
          got += n;
        }
        stored = stored.subarray(0, got);
      } finally {
        closeSync(fd);
      }
    } catch (err) {
      if (!this.wakeFailing) RingBuffer.wakeFailures++;
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        this.wakeFailing = true;
        this.nextWriteWakeAt = Date.now() + 1000;
        return false;
      }
      stored = Buffer.alloc(0);
      fileBytes = 0;
    }
    if (fileBytes < base + this.appendedBytes) {
      if (fileBytes > 0) RingBuffer.wakeFailures++;
      this.lastDump = null;
    }
    this.restore(this.pendingBytes > 0 ? Buffer.concat([stored, ...this.pending]) : stored);
    this.wakeFailing = false;
    this.wokeAt = Date.now();
    return true;
  }

  /** When the ring last came back from its `.buf` (epoch ms; 0 = never). */
  get lastWakeAt(): number {
    return this.wokeAt;
  }

  /** Leave hibernation holding exactly `data` (its newest `capacity` bytes). */
  private restore(data: Buffer): void {
    if (data.length > this.capacity) data = data.subarray(data.length - this.capacity);
    let physical = Math.min(INITIAL_PHYSICAL_BYTES, this.capacity);
    while (physical < data.length && physical < this.capacity) physical *= 2;
    physical = Math.min(physical, this.capacity);
    this.hibernatedPath = null;
    this.releasedBytes = 0;
    this.pending = [];
    this.pendingBytes = 0;
    this.appendedBytes = 0;
    this.buffer = Buffer.alloc(physical);
    data.copy(this.buffer, 0);
    this.physical = physical;
    this.length = data.length;
    this.writePos = data.length % physical;
  }

  /**
   * A dump while the `.buf` cannot be read back: that file is the only full
   * copy, so it is never replaced with the partial bytes readAll() serves.
   * The output held since is written after the released history instead, so
   * the file (and a recovery from it) still holds every byte. The write is
   * positional at the committed length: a retry after a partial write
   * overwrites it rather than repeating it. The file stays under
   * 2 × capacity, since `pending` replaces it once it fills the ring.
   * Throws when the write fails, like any failed dump.
   */
  private appendPendingTo(filePath: string): void {
    if (this.hibernatedPath !== filePath) throw new Error('hibernated ring buffer could not be read back');
    const unwritten = Buffer.concat(this.pending).subarray(this.appendedBytes);
    const offset = this.hibernatedFileBytes + this.appendedBytes;
    const fd = openSync(filePath, fsConstants.O_WRONLY); // no read access needed, no truncate, no append mode
    try {
      let done = 0;
      while (done < unwritten.length) {
        done += writeSync(fd, unwritten, done, unwritten.length - done, offset + done);
      }
      // Drop anything a failed attempt left past the end.
      ftruncateSync(fd, offset + unwritten.length);
    } finally {
      closeSync(fd);
    }
    this.appendedBytes = this.pendingBytes;
  }

  /** Output for a ring whose `.buf` cannot be read back right now. */
  private writeWhileAsleep(data: Buffer): void {
    this.mutations++;
    this.totalWritten += data.length;
    this.length = Math.min(this.length + data.length, this.capacity);
    this.pending.push(Buffer.from(data));
    this.pendingBytes += data.length;
    // Once the new bytes alone fill the ring, the file holds nothing that
    // would survive a wake: stop depending on it. The next dump replaces it.
    if (this.pendingBytes >= this.capacity) this.restore(Buffer.concat(this.pending));
  }

  /** Wakes whose `.buf` was missing or did not hold the expected bytes. */
  static wakeFailures = 0;

  private static fileSize(filePath: string): number {
    try { return statSync(filePath).size; } catch { return -1; }
  }

  /** Create a RingBuffer pre-filled with data loaded from a file. */
  static loadFromFile(filePath: string, capacityBytes: number): RingBuffer {
    const data = readFileSync(filePath);
    const rb = new RingBuffer(capacityBytes);
    if (data.length > 0) {
      rb.write(data);
    }
    return rb;
  }

  /**
   * Best-effort cleanup of stale `.tmp.<hex>` files in the buffer directory.
   *
   * tmp files only exist between the write and rename steps of an atomic
   * dump. Under normal operation rename either succeeds (no tmp left) or
   * the catch handler unlinks the tmp. A power loss or SIGKILL between
   * the two steps can leave a tmp behind. Recovery + dump-readers must
   * ignore them (test the filename against {@link TMP_SUFFIX_RE}); this
   * helper unlinks them so the buffer directory does not accumulate
   * orphans. Errors are swallowed — cleanup is best-effort.
   */
  static cleanupStaleTmpFiles(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // dir does not exist yet — nothing to clean.
    }
    for (const name of entries) {
      if (TMP_SUFFIX_RE.test(name)) {
        try {
          unlinkSync(path.join(dir, name));
        } catch {
          // file may have been removed by another process; ignore.
        }
      }
    }
  }

  /** True if the filename is a tmp companion of an atomic dump. */
  static isTmpFile(name: string): boolean {
    return TMP_SUFFIX_RE.test(name);
  }
}
