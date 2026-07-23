/**
 * frameCoalescer — per-key frame coalescing gate (standalone util, zero dependencies).
 *
 * Self-contained implementation of the standard frame-batching pattern: merges consecutive
 * updates arriving under the same key to "once per frame", reducing renderer store write fan-out.
 * Last-write-wins — even if N updates land between frames, only the latest value at flush time
 * is committed.
 *
 * Behavioral invariants (NB2 wave 0 A3):
 *   - This gate delays renderer store reflection by at most one frame (~16ms).
 *   - No impact on daemon source of truth or session.json persistence — meta/title/cwd are
 *     already owned by main; what is deferred here is only "when values land in the renderer store".
 *   - Visual/functional/persistence semantics unchanged. Only rerender count decreases.
 *
 * in-flight/pending gate: when new values arrive during a flush callback (store set), do not
 * re-flush immediately — queue in pending only. After flush ends, if pending remains, schedule
 * one more frame. Updates during flush are neither lost nor recursively amplified.
 */

/** Frame budget (ms). Used as setTimeout fallback when RAF is unavailable (node tests). */
const FRAME_MS = 16;

/** RAF first; otherwise 16ms setTimeout. Returns scheduler with cancel handle. */
type CancelHandle = () => void;
function scheduleFrame(cb: () => void): CancelHandle {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(() => cb());
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(cb, FRAME_MS);
  return () => clearTimeout(id);
}

/**
 * Coalescer that merges values per key per frame and forwards to `commit`.
 *
 * @param commit Callback that applies the latest value for a key (store set, etc.). Called at
 *               most once per key per frame.
 */
export class FrameCoalescer<K, V> {
  private readonly commit: (key: K, value: V) => void;
  /** Latest value waiting for flush (key → value). Last-write-wins. */
  private readonly pending = new Map<K, V>();
  /** Whether a frame is already scheduled — prevents duplicate scheduling. */
  private cancelFrame: CancelHandle | null = null;
  /** In-flight flag during commit execution. Values arriving then stay in pending only. */
  private flushing = false;

  constructor(commit: (key: K, value: V) => void) {
    this.commit = commit;
  }

  /**
   * Schedule a value update for a key. Multiple calls for the same key still yield one commit
   * per frame with only the last value applied.
   */
  push(key: K, value: V): void {
    this.pending.set(key, value);
    this.ensureScheduled();
  }

  private ensureScheduled(): void {
    // Do not schedule again if a frame is already booked or flush is in progress. Values
    // arriving during flush are re-scheduled at flush end based on pending remainder.
    if (this.cancelFrame !== null || this.flushing) return;
    this.cancelFrame = scheduleFrame(() => this.flush());
  }

  private flush(): void {
    this.cancelFrame = null;
    // Snapshot this frame's batch and clear pending. Values pushed during commit land as new
    // pending entries and are not mixed into this batch.
    const batch = Array.from(this.pending.entries());
    this.pending.clear();
    this.flushing = true;
    try {
      for (const [key, value] of batch) {
        this.commit(key, value);
      }
    } finally {
      this.flushing = false;
    }
    // If new values arrived during flush (pending non-empty), flush once more next frame —
    // no loss, no recursive runaway.
    if (this.pending.size > 0) {
      this.ensureScheduled();
    }
  }

  /**
   * Cancel the scheduled frame and synchronously apply remaining pending values. Prevents
   * "last value never reaching the store" on unmount.
   */
  flushNow(): void {
    if (this.cancelFrame !== null) {
      this.cancelFrame();
      this.cancelFrame = null;
    }
    if (this.pending.size === 0) return;
    this.flush();
  }

  /** Cancel scheduled frame + discard pending (no apply). For hard teardown. */
  dispose(): void {
    if (this.cancelFrame !== null) {
      this.cancelFrame();
      this.cancelFrame = null;
    }
    this.pending.clear();
  }

  /** Test/debug: count of keys not yet flushed. */
  get pendingSize(): number {
    return this.pending.size;
  }
}
