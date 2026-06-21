import fs from 'node:fs';
import path from 'node:path';
import type { DaemonState } from './types';
import {
  atomicReadJSONSync,
  atomicWriteJSON,
  atomicWriteJSONSync,
  createMigrator,
  DAEMON_STATE_REGISTRY,
} from './util/atomicWrite';
import { AsyncQueue } from './util/AsyncQueue';

const DEBOUNCE_MS = 30_000;
const QUEUE_KEY = 'state';

// Default suspended-session retention (hours). Suspended sessions persist
// across daemon restarts so an interrupted shell can be resumed. Without a
// TTL they accumulate indefinitely: every X-button shutdown re-suspends
// every live session, the next launch recovers them, and any panes the
// user adds before the next shutdown ride along forever. v2.8.0 shipped
// without this bound and users reached the session hard cap after a few
// launches, at which point recovery throws and new pane creation throws —
// wmux silently becomes unusable. 7 days mirrors the dead-session pattern
// (24h × 7) so a session you stopped touching a week ago is unlikely to be
// the one you actually wanted to resume.
//
// Substrate 3.0: now configurable via config.session.suspendedTtlHours,
// threaded through the constructor. This constant is only the fallback for
// callers that don't pass config (see constructor).
const SUSPENDED_TTL_HOURS_DEFAULT = 7 * 24;

/**
 * Persists DaemonState (sessions.json) to disk using the shared
 * atomic-write helpers in `./util/atomicWrite`. The public API
 * (saveImmediate / saveDebounced / load / flush / dispose) is frozen
 * so later waves can layer behaviour without changing call sites.
 *
 * Concurrency model (T2):
 *   - `saveImmediate` is synchronous and remains so — the daemon's
 *     emergency-exit paths (SIGINT/SIGTERM/session-end/etc.) rely on
 *     it running inline. Before writing it clears any queued async
 *     write so a stale debounced snapshot cannot overwrite the newer
 *     immediate one.
 *   - `saveDebounced` funnels through an `AsyncQueue` keyed `'state'`
 *     so only one async write is ever in flight. Repeated debounced
 *     calls coalesce to the latest snapshot.
 *   - `flushSync` drains the queue by invoking the registered sync
 *     fallback (used by process-exit handlers where the event loop
 *     has stopped).
 */
export class StateWriter {
  private filePath: string;
  private readonly suspendedTtlHours: number;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pendingState: DaemonState | null = null;
  private readonly queue = new AsyncQueue();
  // Epoch bumped by every saveImmediate() call. A debounced async write
  // captures this on entry and re-checks it after its final rename so a
  // saveImmediate that fired mid-flight can restore its payload. Fixes
  // the race where AsyncQueue.clear() cannot interrupt a running task
  // (see AsyncQueue.ts:188) and the async task's tail rename silently
  // overwrites the emergency save.
  private immediateEpoch = 0;
  private lastImmediateState: DaemonState | null = null;

  constructor(baseDir: string, suspendedTtlHours: number = SUSPENDED_TTL_HOURS_DEFAULT) {
    this.filePath = path.join(baseDir, 'sessions.json');
    // Substrate 3.0: suspended-tombstone GC retention. The daemon main
    // threads config.session.suspendedTtlHours here (codex #2). The
    // acquireLock() one-shot StateWriter omits it — it only reads bootId
    // and discards the pruned sessions, so the default is harmless there;
    // the authoritative prune runs on the main instance during recovery
    // (codex #3 — both startup paths handled).
    this.suspendedTtlHours = suspendedTtlHours;

    // Sync fallback used by `flushSync()` on emergency exit paths.
    // It writes whatever the latest pending snapshot is using the
    // synchronous atomic-write helper.
    this.queue.setSyncFallback(QUEUE_KEY, () => {
      if (this.pendingState !== null) {
        atomicWriteJSONSync(this.filePath, this.pendingState, {
          validate: StateWriter.isDaemonState,
          rotationEnabled: true,
        });
        this.pendingState = null;
      }
    });
  }

  /**
   * Immediately write state to disk (session create/destroy/state change).
   *
   * @returns `true` when the synchronous write succeeded, `false` when
   *   the write threw. StateWriter.saveImmediate is changed for parity
   *   with ChannelStateWriter.saveImmediate (U2). The boolean is
   *   opt-in for callers that need the failure signal; existing
   *   call sites that ignore the return value continue to work. The
   *   synchronous, non-throwing contract is preserved — emergency
   *   exit handlers (SIGINT/SIGTERM/session-end) still rely on it
   *   running inline and not throwing.
   */
  saveImmediate(state: DaemonState): boolean {
    // Bump the epoch BEFORE the sync write so any debounced async task
    // already past its first await observes a newer epoch and can
    // restore this payload if its tail rename races us.
    this.immediateEpoch++;
    this.lastImmediateState = state;
    // Drop any queued async write — we are about to persist a newer
    // snapshot synchronously, and we don't want the older in-flight
    // payload to overwrite it after we return. (queue.clear() cannot
    // interrupt a running task; the epoch check in saveDebounced
    // handles that case.)
    this.queue.clear();
    try {
      atomicWriteJSONSync(this.filePath, state, {
        validate: StateWriter.isDaemonState,
        rotationEnabled: true,
      });

      // Clear pending since we just saved
      this.pendingState = null;
      return true;
    } catch (err) {
      console.error('[StateWriter] Failed to save state:', err);
      return false;
    }
  }

  /** Debounced save — coalesces frequent updates (e.g. lastActivity) over 30s. */
  saveDebounced(state: DaemonState): void {
    this.pendingState = state;

    if (this.debounceTimer !== null) {
      return; // Timer already running; state will be picked up when it fires
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const snapshot = this.pendingState;
      if (snapshot === null) return;

      // Hand the actual I/O off to the coalescing queue so concurrent
      // debounced writes (or an overlapping immediate save) cannot
      // race each other over the shared `.bak`/`.tmp` rotation.
      void this.queue.enqueue(QUEUE_KEY, async () => {
        // Re-read pendingState at task execution time — another
        // saveDebounced() call between the timer firing and this
        // microtask running will have updated it.
        const payload = this.pendingState;
        if (payload === null) return;
        // Snapshot the immediate epoch so we can detect a saveImmediate
        // that fires while atomicWriteJSON is mid-flight.
        const epochAtStart = this.immediateEpoch;
        try {
          await atomicWriteJSON(this.filePath, payload, {
            validate: StateWriter.isDaemonState,
            rotationEnabled: true,
          });
          // Race recovery: if saveImmediate() bumped the epoch while
          // we were between awaits, our final rename just clobbered
          // the emergency payload. Restore it synchronously so the
          // on-disk primary matches the latest immediate save.
          if (
            this.immediateEpoch !== epochAtStart &&
            this.lastImmediateState !== null
          ) {
            try {
              atomicWriteJSONSync(this.filePath, this.lastImmediateState, {
                validate: StateWriter.isDaemonState,
                rotationEnabled: true,
              });
            } catch (err) {
              console.error(
                '[StateWriter] Failed to restore superseded immediate save:',
                err,
              );
            }
          }
          // Only clear pending if no newer snapshot arrived while we
          // were writing — otherwise we'd discard the newer data.
          if (this.pendingState === payload) {
            this.pendingState = null;
          }
        } catch (err) {
          console.error('[StateWriter] Failed to save state (async):', err);
        }
      });
    }, DEBOUNCE_MS);
  }

  /** Load state from disk. Falls back to .bak on failure. Prunes expired DEAD sessions. */
  load(): DaemonState {
    const empty: DaemonState = { version: 1, sessions: [] };

    let state: DaemonState | null = null;
    try {
      // T7: wire the lazy-migration hook. Production registry ships as
      // identity (v1, no steps) so this is behaviour-neutral today —
      // the point is that future schema changes land without touching
      // this call site. `createMigrator` also short-circuits legacy
      // payloads missing a `version` marker so no spurious
      // premigrate snapshot is written for routine v1 loads.
      const migrator = createMigrator<DaemonState>(
        DAEMON_STATE_REGISTRY,
        this.filePath,
      );
      state = atomicReadJSONSync<DaemonState>(this.filePath, {
        validate: StateWriter.isDaemonState,
        migrator,
      });
    } catch (err) {
      console.error('[StateWriter] Failed to load state:', err);
    }

    if (!state) {
      return empty;
    }

    // Prune expired sessions. Two paths:
    //   - dead: per-session TTL (s.deadTtlHours)
    //   - suspended: this.suspendedTtlHours (configurable, default 7d —
    //     v2.8.1 hotfix; see top of this file for the accumulation incident
    //     this prevents).
    //
    // detached/attached states are runtime-only and never reach disk —
    // shutdown demotes every live session to suspended before saving.
    const now = Date.now();
    state.sessions = state.sessions.filter((s) => {
      const sinceMs = now - new Date(s.lastActivity).getTime();
      if (s.state === 'dead') {
        return sinceMs < s.deadTtlHours * 60 * 60 * 1000;
      }
      if (s.state === 'suspended') {
        return sinceMs < this.suspendedTtlHours * 60 * 60 * 1000;
      }
      return true;
    });

    return state;
  }

  /** Flush pending debounce — if there is pending state, write it immediately. */
  flush(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.pendingState !== null) {
      this.saveImmediate(this.pendingState);
    }
  }

  /**
   * Process-exit friendly drain. Cancels the debounce timer and runs
   * any registered sync fallbacks for queued async writes. Safe to
   * call multiple times.
   *
   * Order (T14 fix):
   *   1. Cancel the debounce timer so no new async task can be
   *      enqueued behind our back.
   *   2. Drive the queue's sync fallback first — this persists any
   *      `pendingState` seen by previously enqueued (now-draining)
   *      tasks, and is the authoritative path when a debounced
   *      write was already in the queue.
   *   3. If we still observe a `pendingState` after the drain (the
   *      debounce timer fired but the queue never saw it, or the
   *      caller staged a snapshot without ever enqueuing — e.g.
   *      dispose on a freshly-debounced state), persist it inline.
   *
   * The previous order (idle-check → direct write → queue drain)
   * raced against a running queue task: if we observed `running`
   * (so `isIdle === false`) we skipped the inline write on the
   * assumption that the queue would flush pendingState; but the
   * in-flight task had already snapshotted `pendingState === null`
   * before our caller mutated it, so the snapshot was lost.
   */
  flushSync(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    // 2. Drain the queue first — registered sync fallbacks get to
    //    act on `pendingState` exactly once, and any pending
    //    coalesced promise resolves cleanly.
    this.queue.flushSync();

    // 3. Anything still staged must be written inline. Typical case:
    //    the debounce timer had not yet fired so nothing was enqueued
    //    for the queue to drain.
    if (this.pendingState !== null) {
      const state = this.pendingState;
      this.pendingState = null;
      try {
        atomicWriteJSONSync(this.filePath, state, {
          validate: StateWriter.isDaemonState,
          rotationEnabled: true,
        });
      } catch (err) {
        console.error('[StateWriter] flushSync immediate write failed:', err);
      }
    }
  }

  /** Clean up timers (daemon shutdown). Flushes pending state first. */
  dispose(): void {
    this.flush();
  }

  /** Get the path where a session's scrollback buffer should be dumped. */
  getBufferDumpPath(sessionId: string): string {
    return path.join(path.dirname(this.filePath), 'buffers', `${sessionId}.buf`);
  }

  /** Get the buffers/ directory path. */
  getBufferDir(): string {
    return path.join(path.dirname(this.filePath), 'buffers');
  }

  /** Ensure the buffers/ directory exists. */
  ensureBufferDir(): void {
    const dir = this.getBufferDir();
    if (!fs.existsSync(dir)) {
      // Note: mode is no-op on Windows; use icacls for NTFS ACLs
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  /** Remove orphaned .buf files not referenced by any session. */
  cleanOrphanedBuffers(activeIds: Set<string>): void {
    const dir = path.join(path.dirname(this.filePath), 'buffers');
    if (!fs.existsSync(dir)) return;
    try {
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.buf')) continue;
        const id = file.replace(/\.buf$/, '');
        if (!activeIds.has(id)) {
          try { fs.unlinkSync(path.join(dir, file)); } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }

  // ── Internal helpers ──────────────────────────────────────────────

  /**
   * Type guard used by the shared atomic-read helper. Validates the
   * minimum required shape; full schema validation lives in Wave 3.
   */
  private static isDaemonState(parsed: unknown): parsed is DaemonState {
    if (typeof parsed !== 'object' || parsed === null) return false;
    const obj = parsed as Record<string, unknown>;

    if (typeof obj['version'] !== 'number') return false;
    if (!Array.isArray(obj['sessions'])) return false;

    // Validate each session has minimum required fields
    for (const s of obj['sessions'] as unknown[]) {
      if (typeof s !== 'object' || s === null) return false;
      const sess = s as Record<string, unknown>;
      if (typeof sess['id'] !== 'string') return false;
      if (typeof sess['state'] !== 'string') return false;
    }

    return true;
  }
}
