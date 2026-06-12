import { writeFile, rename, unlink } from 'node:fs/promises';
import {
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Pattern that identifies temporary buffer files produced by
// dumpToFile / dumpToFileSyncAtomic. Recovery / dump-readers must skip
// these; they may exist briefly between the tmp write and the rename.
const TMP_SUFFIX_RE = /\.tmp\.[0-9a-f]+$/;

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

export class RingBuffer {
  private buffer: Buffer;
  private readonly capacity: number;  // logical ceiling — the max this ring will ever hold
  private physical: number;           // bytes currently allocated (<= capacity), grown on demand
  private writePos: number;   // next write position (0..physical-1)
  private length: number;     // bytes currently stored (<= physical)
  private totalWritten: number; // monotonic lifetime count (used as byte offset for PromptEventLog)

  constructor(capacityBytes: number) {
    if (capacityBytes <= 0 || !Number.isInteger(capacityBytes)) {
      throw new Error('capacityBytes must be a positive integer');
    }
    this.capacity = capacityBytes;
    this.physical = Math.min(INITIAL_PHYSICAL_BYTES, capacityBytes);
    this.buffer = Buffer.alloc(this.physical);
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

    const existing = this.readAll(); // oldest→newest, exactly `length` bytes
    const grown = Buffer.alloc(next);
    existing.copy(grown, 0);
    this.buffer = grown;
    this.physical = next;
    this.writePos = existing.length; // length < next, so no wrap
    this.length = existing.length;
  }

  /**
   * Write data into the ring buffer.
   * If data exceeds capacity, only the last `capacity` bytes are preserved.
   */
  write(data: Buffer): void {
    const dataLen = data.length;
    if (dataLen === 0) return;

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

  /**
   * Total bytes ever written to this buffer over its lifetime (monotonic).
   * Used by PromptEventLog as a stable offset even after the ring wraps.
   */
  get totalBytesWritten(): number {
    return this.totalWritten;
  }

  /**
   * Read all stored data in order (oldest first, newest last).
   * Returns a new Buffer copy; the internal buffer is not modified.
   */
  readAll(): Buffer {
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
    this.buffer.fill(0);
    this.writePos = 0;
    this.length = 0;
    // totalWritten is intentionally NOT reset — it represents the stream's
    // lifetime byte count, which PromptEventLog consumers may still hold
    // references to.
  }

  /** Number of bytes currently stored. */
  get size(): number {
    return this.length;
  }

  /** Logical ceiling in bytes — the most this ring will ever store. */
  get totalCapacity(): number {
    return this.capacity;
  }

  /** Bytes currently committed for backing storage (grows on demand toward the ceiling). */
  get allocatedBytes(): number {
    return this.physical;
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
    const data = this.readAll();
    const tmpPath = `${filePath}.tmp.${crypto.randomBytes(6).toString('hex')}`;
    try {
      // mode is a no-op on Windows; use icacls for NTFS ACLs.
      await writeFile(tmpPath, data, { mode: 0o600 });
      await rename(tmpPath, filePath);
    } catch (err) {
      try { await unlink(tmpPath); } catch { /* tmp may already be gone */ }
      throw err;
    }
  }

  /**
   * Synchronous atomic dump. Used by the Windows process.on('exit')
   * handler as a last-resort save when the daemon has no time to await
   * the async path. Same tmp + rename invariants as {@link dumpToFile}.
   */
  dumpToFileSyncAtomic(filePath: string): void {
    const data = this.readAll();
    const tmpPath = `${filePath}.tmp.${crypto.randomBytes(6).toString('hex')}`;
    try {
      writeFileSync(tmpPath, data, { mode: 0o600 });
      renameSync(tmpPath, filePath);
    } catch (err) {
      try { unlinkSync(tmpPath); } catch { /* tmp may already be gone */ }
      throw err;
    }
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
