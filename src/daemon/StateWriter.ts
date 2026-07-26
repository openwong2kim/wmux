import fs from 'node:fs';
import path from 'node:path';
import type { DaemonState } from './types';
import {
  atomicReadJSONSync,
  atomicWriteJSON,
  atomicWriteJSONSync,
  createMigrator,
  DAEMON_STATE_REGISTRY,
  BACKUP_SUFFIXES,
} from './util/atomicWrite';
import { AsyncQueue } from './util/AsyncQueue';
import { stripCredentialValues } from '../shared/envFilter';

/**
 * Fresh copy of DaemonState with credential *values* stripped before persistence. Every
 * sessions.json write path (saveImmediate, saveDebounced, flushSync, race-recovery)
 * goes through this, so credentials exist only in in-memory meta.env and never reach
 * disk. Other session fields and non-credential env (PATH, identity, etc.) are
 * preserved. **Fresh copy** — does not mutate live in-memory meta (spawn/supervised-restart
 * uses in-memory env as-is).
 */
function toPersistable(state: DaemonState): DaemonState {
  return {
    ...state,
    sessions: state.sessions.map((s) => ({ ...s, env: stripCredentialValues(s.env) })),
  };
}

/**
 * One-time boot legacy scrub: remove credential values from existing sessions.json
 * primary + all .bak slots. Cleans legacy files where post-PR1 user shell (passthrough)
 * credentials remained in plaintext — call before recovery(load) so subsequent load reads
 * scrubbed copies. total, non-throwing: skip read/parse failures; never drop session list.
 * Scrub slots in place via tmp→fsync→rename (no rotation, no backup-of-backup).
 *
 * Scope: primary + rotation backups (.bak~.bak.3) only. `*.premigrate.bak` (migrate) and
 * `corrupted/` (quarantine) copies are out of scope — today's DAEMON_STATE_REGISTRY is
 * identity so no premigrate snapshot is created, and quarantine isolates only unparseable
 * files so harmless for now. When a real daemon-state migration step lands, include both
 * paths in scrub targets.
 */
export function scrubPersistedCredentials(baseDir: string): void {
  const primary = path.join(baseDir, 'sessions.json');
  const targets = [primary, ...BACKUP_SUFFIXES.map((suffix) => `${primary}${suffix}`)];
  for (const file of targets) {
    try {
      if (!fs.existsSync(file)) continue;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
        sessions?: Array<{ env?: unknown }>;
      } | null;
      if (!parsed || !Array.isArray(parsed.sessions)) continue;
      let changed = false;
      for (const session of parsed.sessions) {
        if (!session || !('env' in session)) continue; // preserve sessions without env
        const env = session.env;
        if (env === null || typeof env !== 'object') {
          // Non-object env (e.g. corrupted/hand-edited string "GITHUB_TOKEN=ghp...") cannot
          // hide credentials, so replace with {} — skip would leave the string intact (Codex
          // review). Matches stripCredentialValues non-object→{} contract.
          session.env = {};
          changed = true;
          continue;
        }
        const before = Object.keys(env as Record<string, string>).length;
        const stripped = stripCredentialValues(env as Record<string, string>);
        if (Object.keys(stripped).length !== before) {
          session.env = stripped;
          changed = true;
        }
      }
      if (!changed) continue;
      // fsync then rename — boot batch scrub rewrites many slots (primary+.bak.N) in sequence;
      // rename-only without flush can tear all slots on power loss so load finds no valid slot
      // (3-model review F2). One fsync per slot at boot is negligible overhead.
      const tmp = `${file}.scrub.tmp`;
      const fd = fs.openSync(tmp, 'w', 0o600);
      try {
        fs.writeSync(fd, JSON.stringify(parsed));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, file);
    } catch (err) {
      // total, non-throwing — one slot failure must not block others or boot.
      console.warn(`[StateWriter] credential scrub skipped ${file}:`, (err as Error)?.message ?? err);
    }
  }
}

const DEBOUNCE_MS = 30_000;
const QUEUE_KEY = 'state';
let nextExactWriteId = 0;

export type ExactStateWriteOutcome = 'written' | 'failed' | 'superseded';

/**
 * A state transition whose candidate must not become observable until its
 * exact persisted representation has been accepted.
 */
export interface ExactStateTransaction {
  /** Build the candidate from the latest accepted in-memory state. */
  prepare: () => DaemonState | undefined;
  /**
   * Commit the already-written candidate and return the newest authoritative
   * state, including unrelated changes that arrived while the write ran.
   * Returning undefined rejects a stale candidate (for example after ID reuse).
   */
  commit: () => DaemonState | undefined;
  /** Build the accepted state used to repair a candidate that became stale. */
  current: () => DaemonState;
}

interface ExactWriteRecord {
  outcome: ExactStateWriteOutcome;
  finalized: boolean;
  runSync: () => ExactStateWriteOutcome;
}

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

// #557: idle DETACHED sessions (no client attached, shell still alive) are
// reaped after this many hours of inactivity. `lastActivity` is bumped on PTY
// output, so only shells that have gone silent while detached age out — an
// active detached session (running build, tail -f) stays alive. 8 h survives a
// workday gap and kills overnight orphans; the per-instance config
// (config.session.detachedTtlHours) overrides this at the daemon.
const DETACHED_TTL_HOURS_DEFAULT = 8;

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
  private readonly detachedTtlHours: number;
  // When true, load() persists the healed state to disk if it had to restamp
  // any corrupt lastActivity (see load()). Enabled ONLY on the main recovery
  // StateWriter — the acquireLock() one-shot writer leaves it false so it can
  // never race the main instance over sessions.json.
  private readonly persistHealedOnLoad: boolean;
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
  private readonly exactWrites = new Map<string, ExactWriteRecord>();

  constructor(baseDir: string, suspendedTtlHours: number = SUSPENDED_TTL_HOURS_DEFAULT, detachedTtlHours: number = DETACHED_TTL_HOURS_DEFAULT, persistHealedOnLoad = false) {
    this.filePath = path.join(baseDir, 'sessions.json');
    // Substrate 3.0: suspended-tombstone GC retention. The daemon main
    // threads config.session.suspendedTtlHours here (codex #2). The
    // acquireLock() one-shot StateWriter omits it — it only reads bootId
    // and discards the pruned sessions, so the default is harmless there;
    // the authoritative prune runs on the main instance during recovery
    // (codex #3 — both startup paths handled).
    this.suspendedTtlHours = suspendedTtlHours;
    // #557: detached-shell GC retention. Same threading pattern; the daemon
    // main passes config.session.detachedTtlHours. Idle detached sessions
    // that reach this TTL on load are dropped BEFORE recovery iterates, so a
    // crash/forced-kill no longer resurrects a fleet of orphan shells.
    this.detachedTtlHours = detachedTtlHours;
    this.persistHealedOnLoad = persistHealedOnLoad;

    // Sync fallback used by `flushSync()` on emergency exit paths.
    // It writes whatever the latest pending snapshot is using the
    // synchronous atomic-write helper.
    this.queue.setSyncFallback(QUEUE_KEY, () => {
      if (this.pendingState !== null) {
        atomicWriteJSONSync(this.filePath, toPersistable(this.pendingState), {
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
      atomicWriteJSONSync(this.filePath, toPersistable(state), {
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

  /**
   * Persist and commit one exact state transition synchronously.
   *
   * Failed attempts never install the candidate in pending/recovery state.
   * On success, older queued work is superseded and an already-running async
   * write observes the bumped epoch and restores the committed state.
   */
  writeExactImmediate(
    transaction: ExactStateTransaction,
    attempts = 1,
  ): ExactStateWriteOutcome {
    const candidate = transaction.prepare();
    if (!candidate) return 'superseded';

    let written = false;
    for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
      try {
        atomicWriteJSONSync(this.filePath, toPersistable(candidate), {
          validate: StateWriter.isDaemonState,
          rotationEnabled: true,
        });
        written = true;
        break;
      } catch (err) {
        console.error('[StateWriter] Failed to save exact state:', err);
      }
    }
    if (!written) return 'failed';

    // Synchronous I/O cannot interleave with an async completion on this
    // thread, so publish the epoch only after a successful write. Failed
    // candidates must not make an older accepted write restore a stale
    // lastImmediateState.
    this.immediateEpoch++;
    let committed: DaemonState | undefined;
    try {
      committed = transaction.commit();
    } catch (err) {
      console.error('[StateWriter] Failed to commit exact state:', err);
      return this.restoreExactState(transaction.current(), 'failed');
    }
    if (!committed) {
      return this.restoreExactState(transaction.current(), 'superseded');
    }

    this.lastImmediateState = committed;
    this.pendingState = null;
    this.queue.clear();
    return 'written';
  }

  /**
   * Persist and commit one exact state transition through the existing file
   * queue without same-key coalescing. The returned outcome describes this
   * candidate, not merely completion of a newer coalesced write.
   */
  async writeExactAsap(
    transaction: ExactStateTransaction,
  ): Promise<ExactStateWriteOutcome> {
    const key = `state:exact:${++nextExactWriteId}`;
    const record: ExactWriteRecord = {
      outcome: 'superseded',
      finalized: false,
      runSync: () => {
        if (!record.finalized) {
          record.outcome = this.writeExactImmediate(transaction);
          record.finalized = true;
        }
        return record.outcome;
      },
    };
    this.exactWrites.set(key, record);
    this.queue.setSyncFallback(key, () => { record.runSync(); });

    try {
      await this.queue.enqueue(key, async () => {
        if (record.finalized) return;
        const candidate = transaction.prepare();
        if (!candidate) {
          record.outcome = 'superseded';
          record.finalized = true;
          return;
        }

        const epochAtStart = this.immediateEpoch;
        try {
          await atomicWriteJSON(this.filePath, toPersistable(candidate), {
            validate: StateWriter.isDaemonState,
            rotationEnabled: true,
          });
        } catch (err) {
          console.error('[StateWriter] Failed to save exact state (async):', err);
          record.outcome = 'failed';
          record.finalized = true;
          return;
        }

        if (this.immediateEpoch !== epochAtStart) {
          if (this.lastImmediateState !== null) {
            const restored = this.restoreExactState(this.lastImmediateState, 'superseded');
            if (!record.finalized) {
              record.outcome = restored;
              record.finalized = true;
            }
          } else {
            record.outcome = 'superseded';
            record.finalized = true;
          }
          return;
        }

        let committed: DaemonState | undefined;
        try {
          committed = transaction.commit();
        } catch (err) {
          console.error('[StateWriter] Failed to commit exact state:', err);
          record.outcome = this.restoreExactState(transaction.current(), 'failed');
          record.finalized = true;
          return;
        }
        if (!committed) {
          record.outcome = this.restoreExactState(transaction.current(), 'superseded');
          record.finalized = true;
          return;
        }

        // Preserve unrelated changes staged while the exact write was in
        // flight, but ensure their pending representation includes the newly
        // committed transition.
        if (this.pendingState !== null) this.pendingState = committed;
        record.outcome = 'written';
        record.finalized = true;
      });
      return record.outcome;
    } finally {
      this.queue.deleteSyncFallback(key);
      this.exactWrites.delete(key);
    }
  }

  /**
   * Synchronously finish every exact write currently pending or in flight.
   * A running async write observes the epoch bump and restores the newest
   * committed state if its older I/O completes later.
   */
  flushExactWritesSync(): ExactStateWriteOutcome[] {
    return Array.from(this.exactWrites.values(), (record) => record.runSync());
  }

  private restoreExactState(
    state: DaemonState,
    restoredOutcome: ExactStateWriteOutcome,
  ): ExactStateWriteOutcome {
    try {
      atomicWriteJSONSync(this.filePath, toPersistable(state), {
        validate: StateWriter.isDaemonState,
        rotationEnabled: true,
      });
      this.lastImmediateState = state;
      if (this.pendingState !== null) this.pendingState = state;
      return restoredOutcome;
    } catch (err) {
      console.error('[StateWriter] Failed to restore rejected exact state:', err);
      return 'failed';
    }
  }

  /**
   * Compatibility for the existing daemon wiring. Removed when that wiring
   * moves to SessionLocationTransaction in the next milestone.
   */
  recoverRejectedImmediateState(state: DaemonState): void {
    this.lastImmediateState = state;
    this.pendingState = state;
    void this.enqueueAsyncWrite();
  }

  /** Debounced save — coalesces frequent updates (e.g. lastActivity) over 30s. */
  saveDebounced(state: DaemonState): void {
    this.pendingState = state;

    if (this.debounceTimer !== null) {
      return; // Timer already running; state will be picked up when it fires
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      if (this.pendingState === null) return;
      void this.enqueueAsyncWrite();
    }, DEBOUNCE_MS);
  }

  /**
   * Immediate-but-async save (30-session scaling). For state changes that
   * should persist NOW but must not block the daemon's event loop with a
   * synchronous multi-file write (`atomicWriteJSONSync` + `.bak` rotation
   * grows with session count and stacks up under load — the exact stall
   * pattern that starves `daemon.ping` and gets a busy-but-alive daemon
   * force-respawned).
   *
   * Durability vs `saveImmediate`: the SIGKILL-loss window shrinks from the
   * debounce's 30s to the queue-dispatch + write duration (typically ms).
   * Graceful-exit paths are fully covered — `flushSync()`/`flush()` persist
   * any still-pending snapshot via the sync fallback. Callers whose write
   * must survive an IMMEDIATE hard kill (emergency shutdown/suspend) keep
   * using `saveImmediate`.
   *
   * Returns the queue promise: resolved when this snapshot (or a newer one
   * that coalesced over it) has been written. Callers that need
   * "persisted" semantics (snapshotRunner) await it; fire-and-forget
   * callers ignore it.
   */
  saveAsap(state: DaemonState): Promise<void> {
    this.pendingState = state;
    return this.enqueueAsyncWrite();
  }

  /**
   * Hand the actual I/O off to the coalescing queue so concurrent async
   * writes (or an overlapping immediate save) cannot race each other over
   * the shared `.bak`/`.tmp` rotation. The task re-reads `pendingState` at
   * execution time, so calls that land while a write is queued coalesce to
   * the newest snapshot, and a `saveImmediate` in between (which nulls
   * `pendingState` and clears the queue) turns a stale task into a no-op.
   */
  private enqueueAsyncWrite(): Promise<void> {
    return this.queue.enqueue(QUEUE_KEY, async () => {
      const payload = this.pendingState;
      if (payload === null) return;
      // Snapshot the immediate epoch so we can detect a saveImmediate
      // that fires while atomicWriteJSON is mid-flight.
      const epochAtStart = this.immediateEpoch;
      try {
        await atomicWriteJSON(this.filePath, toPersistable(payload), {
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
            atomicWriteJSONSync(this.filePath, toPersistable(this.lastImmediateState), {
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

    // Prune expired sessions. Three paths:
    //   - dead: per-session TTL (s.deadTtlHours)
    //   - suspended: this.suspendedTtlHours (configurable, default 7d —
    //     v2.8.1 hotfix; see top of this file for the accumulation incident
    //     this prevents).
    //   - detached: this.detachedTtlHours (configurable, default 8h — #557).
    //
    // attached is the only live state with no TTL: a client is connected, so
    // the session is in active use. detached/attached DO reach disk via the
    // 30 s snapshot runner (snapshotRunner.ts merges listSessions() verbatim),
    // so the detached clause below is the bound that prevents a crash/forced-
    // kill from resurrecting a fleet of orphan shells on the next boot — the
    // stale records are pruned here BEFORE recovery iterates and re-spawns.
    // Graceful shutdown still demotes every live session to suspended, so on a
    // clean exit these become suspended-tombstones governed by the 7 d TTL.
    const now = Date.now();
    let restamped = false;
    state.sessions = state.sessions.filter((s) => {
      // Heal any lastActivity that is not a valid, parseable ISO timestamp.
      // isDaemonState() only validates minimal fields, so disk corruption or a
      // legacy record can leave lastActivity as a non-string (null, number,
      // boolean) or an unparseable string. `new Date(null/false/0).getTime()`
      // coerces to a VALID epoch 0, which a NaN-only guard would miss — the
      // record would then look ancient and be silently reaped, contradicting
      // this reaper's own fail-open design. So we detect corruption directly:
      // non-string OR Date.parse() → NaN. Restamp to now rather than pruning:
      // pruning would fail-closed and could kill a possibly-live session on a
      // single bad timestamp, while restamping restarts the TTL clock so the
      // record can age out on a later load. The restamp is persisted below
      // (persistHealedOnLoad) so the fix survives a daemon restart — otherwise
      // the corrupt value would be re-read and re-restamped every boot and
      // never actually age out.
      if (typeof s.lastActivity !== 'string' || Number.isNaN(Date.parse(s.lastActivity))) {
        s.lastActivity = new Date(now).toISOString();
        restamped = true;
        return true;
      }
      const sinceMs = now - new Date(s.lastActivity).getTime();
      if (s.state === 'dead') {
        return sinceMs < s.deadTtlHours * 60 * 60 * 1000;
      }
      if (s.state === 'suspended') {
        return sinceMs < this.suspendedTtlHours * 60 * 60 * 1000;
      }
      if (s.state === 'detached') {
        // #557: exec/supervised units (X8 reboot-survival) are intentionally
        // long-lived unattached sessions that may sit silent for >8 h. The
        // detached TTL would defeat supervision, so never age them out here.
        // exec and supervision are independent optional fields (a supervised
        // plain shell has supervision without exec), so both must exempt —
        // matches the supervised-unit predicate in agentResume.ts.
        if (s.exec || s.supervision) return true;
        return sinceMs < this.detachedTtlHours * 60 * 60 * 1000;
      }
      return true; // attached: in active use, never TTL-reaped
    });

    // If we healed any corrupt timestamp, persist the repaired state so the fix
    // is durable across restarts. Gated on persistHealedOnLoad: only the main
    // recovery StateWriter writes here. The acquireLock() one-shot writer (which
    // only reads bootId and discards the pruned list) leaves the flag off, so it
    // can never race the main instance over sessions.json. saveImmediate is sync
    // and durable, matching the recovery path's write expectations.
    if (restamped && this.persistHealedOnLoad) {
      this.saveImmediate(state);
    }

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
        atomicWriteJSONSync(this.filePath, toPersistable(state), {
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

  /** Absolute path of sessions.json (for async readers like snapshotRunner). */
  getFilePath(): string {
    return this.filePath;
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
