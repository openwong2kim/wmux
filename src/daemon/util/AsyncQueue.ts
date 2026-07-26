/**
 * Single-slot coalescing queue. Each enqueue call uses a key; when the
 * same key is enqueued multiple times before the previous task runs,
 * only the most recent value is kept. Different keys run FIFO.
 *
 * Designed for debounced file writes where only the most recent
 * snapshot matters. Used by `StateWriter` and `SessionManager` to
 * serialise concurrent debounced writes so that two async writes can
 * never race against the shared `.bak` / `.tmp` rotation in
 * `atomicWriteJSON`.
 *
 * The queue never runs tasks concurrently — at most one task is
 * in-flight. When that task completes, the next FIFO entry is
 * dispatched. Coalescing happens at enqueue time only: re-enqueuing a
 * key that is already pending (but not yet running) replaces the task
 * while keeping its FIFO position; the superseded promise is resolved
 * as a no-op so callers awaiting it do not block forever.
 *
 * `flushSync()` exists for process-exit handlers (SIGKILL / Windows
 * session-end) where the event loop has stopped. Async tasks cannot
 * execute after that point, so callers register a synchronous
 * fallback via `setSyncFallback(key, fn)` which is invoked against
 * any still-pending entry.
 */

type Task = () => Promise<void> | void;

interface Entry {
  task: Task;
  resolve: () => void;
  reject: (err: unknown) => void;
}

export interface AsyncQueueOptions {
  clock?: () => number;
}

export class AsyncQueue {
  // Map preserves insertion order, which gives us FIFO across keys.
  private readonly pending = new Map<string, Entry>();
  private readonly syncFallbacks = new Map<string, () => void>();
  private readonly flushWaiters: Array<() => void> = [];
  private running = false;

  // `clock` is accepted for parity with the atomicWrite helpers so
  // tests can swap it out. T2 itself does not read wall-clock time,
  // but future diagnostics (latency sampling, stall detection) will.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_opts: AsyncQueueOptions = {}) {}

  /**
   * Enqueue a task under `key`. If a pending task already exists for
   * this key, it is replaced (coalesced) and the previous promise is
   * resolved as a no-op. Returns a promise that resolves when this
   * specific task completes — or when the task is superseded by a
   * later enqueue on the same key (coalescing is observable as
   * "resolved without having run").
   */
  enqueue(key: string, task: Task): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const existing = this.pending.get(key);
      if (existing !== undefined) {
        // Coalesce: replace task, resolve old promise as no-op.
        // Map.set on an existing key preserves insertion order, so the
        // coalesced entry keeps its FIFO slot.
        existing.resolve();
        this.pending.set(key, { task, resolve, reject });
        return;
      }
      this.pending.set(key, { task, resolve, reject });
      // Kick the pump asynchronously — avoids surprising
      // before-return side effects for callers.
      queueMicrotask(() => {
        void this.maybeStart();
      });
    });
  }

  private async maybeStart(): Promise<void> {
    if (this.running) return;
    const next = this.pending.entries().next();
    if (next.done) {
      this.notifyFlushWaiters();
      return;
    }
    this.running = true;
    const [key, entry] = next.value;
    this.pending.delete(key);

    try {
      await entry.task();
      entry.resolve();
    } catch (err) {
      entry.reject(err);
    } finally {
      this.running = false;
      if (this.pending.size > 0) {
        // Continue draining; use microtask to unwind the stack.
        queueMicrotask(() => {
          void this.maybeStart();
        });
      } else {
        this.notifyFlushWaiters();
      }
    }
  }

  private notifyFlushWaiters(): void {
    if (this.flushWaiters.length === 0) return;
    const waiters = this.flushWaiters.splice(0);
    for (const w of waiters) {
      try {
        w();
      } catch {
        // ignore — flush waiter callbacks are just resolve()s
      }
    }
  }

  /**
   * Drain all pending tasks asynchronously. Resolves when the queue
   * becomes idle (nothing pending, nothing running).
   */
  flush(): Promise<void> {
    if (this.isIdle) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.flushWaiters.push(resolve);
    });
  }

  /**
   * Synchronously drain. For each remaining pending entry (in FIFO
   * order) invoke its registered sync fallback, if any. Fallbacks
   * that throw are logged and swallowed so one bad entry cannot
   * block the others. Pending entries are cleared after the sweep;
   * their promises are resolved as no-ops (the real work has been
   * done synchronously via the fallback).
   *
   * Intended for process-exit paths where the event loop will not
   * run again.
   */
  flushSync(): void {
    if (this.pending.size === 0) {
      this.notifyFlushWaiters();
      return;
    }
    // Snapshot keys up-front — the fallback may, in theory, interact
    // with state that would otherwise modify iteration.
    const keys = Array.from(this.pending.keys());
    for (const key of keys) {
      const entry = this.pending.get(key);
      if (entry === undefined) continue;
      const fallback = this.syncFallbacks.get(key);
      if (fallback !== undefined) {
        try {
          fallback();
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`[AsyncQueue] sync fallback for "${key}" threw:`, err);
        }
      }
      // Resolve the queued promise as a no-op; the sync fallback has
      // taken over the task's responsibility.
      entry.resolve();
      this.pending.delete(key);
    }
    this.notifyFlushWaiters();
  }

  /**
   * Register a synchronous fallback executor for a given key. The
   * fallback is invoked by `flushSync()` when a task for this key is
   * still pending. A second call for the same key replaces the
   * earlier fallback.
   */
  setSyncFallback(key: string, fallback: () => void): void {
    this.syncFallbacks.set(key, fallback);
  }

  /** Remove a fallback registered for a one-shot queue entry. */
  deleteSyncFallback(key: string): void {
    this.syncFallbacks.delete(key);
  }

  /** True when no task is pending and none is running. */
  get isIdle(): boolean {
    return !this.running && this.pending.size === 0;
  }

  /**
   * Clear all pending tasks without executing them. Each discarded
   * promise is resolved as a no-op (matches coalescing semantics).
   * Does not interrupt an already-running task.
   */
  clear(): void {
    if (this.pending.size === 0) return;
    for (const entry of this.pending.values()) {
      entry.resolve();
    }
    this.pending.clear();
  }
}
