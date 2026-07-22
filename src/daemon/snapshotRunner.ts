import { promises as fsp } from 'node:fs';
import type { DaemonSessionManager } from './DaemonSessionManager';
import type { StateWriter } from './StateWriter';
import type { DaemonState, DaemonSession } from './types';
import { BACKUP_SUFFIXES } from './util/atomicWrite';

// Side-effect-free module so unit tests can drive runSnapshotOnce without
// importing src/daemon/index.ts (which would execute its main() bootstrap on
// import and start a real daemon during the test run).

function snapshotLog(level: string, msg: string, ...args: unknown[]): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [daemon/${level}] ${msg}`, ...args);
}

// Returns an async function that dumps every live session's RingBuffer to
// disk AND persists a merged sessions.json. Owns a per-runner re-entrancy
// flag so concurrent invocations (e.g., a scheduled tick fires while a
// previous one is still flushing) collapse to a single run.
//
// Extracted from the inline 30 s setInterval body so the same runner can also
// be invoked at session-create time and once at spawn, closing the window
// where no .buf yet exists on disk. A crash within the first 30 s after
// daemon start would otherwise leave the recovery loop with no buffer file
// to restore from.
//
// sessions.json handling — codex review P2 (2026-05-15) flagged two
// failure modes that bracket the design:
//   1. If the runner saves only listSessions(), it clobbers any suspended
//      entries that recovery preserved past MAX_RECOVER_SESSIONS (those
//      sessions live only in sessions.json, not in sessionManager).
//   2. If the runner doesn't save at all, in-memory metadata updates
//      (lastActivity / cwd / cols / rows / state changes that happen on
//      data/resize without an RPC roundtrip) never reach disk, and crash
//      recovery picks stale entries under its own cap.
// Resolution: load existing sessions.json, take every managed session as
// authoritative for its id, and append non-managed entries verbatim.
export function createSnapshotRunner(
  sessionManager: DaemonSessionManager,
  stateWriter: StateWriter,
  options: { getBootId: () => string },
): () => Promise<void> {
  let running = false;
  let pendingRerun = false;
  // ── app-weight P1-5: dirty-only dumps ────────────────────────────────────
  // `.buf` dumps used to rewrite EVERY live session's ring (up to 8 MB each)
  // every tick even when nothing changed — pure SSD churn at idle. Track the
  // ring's monotonic byte counter per session and skip clean ones, with two
  // conservative guards because this loop is the crash-recovery substrate:
  //   • TOCTOU rule (codex #9 / eng F8): the counter is captured BEFORE
  //     dumpToFile() snapshots the ring (its readAll() runs synchronously at
  //     call entry), and recorded only AFTER the dump resolves (atomic
  //     rename). Bytes that arrive mid-dump keep the session dirty next tick.
  //     A failed dump records nothing, so the session stays dirty.
  //   • Forced cadence: every FORCE_DUMP_EVERY_N_TICKS ticks a session dumps
  //     regardless of dirty state — a bounded backstop against any counter
  //     bookkeeping bug silently starving recovery freshness.
  //   • Bookkeeping is keyed by RING IDENTITY (WeakMap), not session id: a
  //     destroyed-and-recreated session id gets a FRESH ring whose byte count
  //     can collide with the old ring's recorded value (same-length output),
  //     which an id-keyed map would misread as "clean" and skip the first
  //     dump of the new life. A WeakMap can't confuse two ring objects, and
  //     dead rings garbage-collect their entries — no pruning pass needed.
  // The Windows process-exit sync dump (daemon/index.ts) is a separate path
  // and remains unconditional. sessions.json below also stays unconditional —
  // metadata (lastActivity/cwd/state) changes without ring bytes.
  const FORCE_DUMP_EVERY_N_TICKS = 10;
  const lastDumpedBytes = new WeakMap<object, number>();
  const ticksSinceDump = new WeakMap<object, number>();
  return async function runSnapshotOnce(): Promise<void> {
    // Pending-rerun pattern (codex review P2, session 019e2af8): if a
    // concurrent trigger arrives while the previous run is mid-dump, mark a
    // rerun so the freshly-created/attached session that arrived between
    // listManagedSessions() and finally still gets its .buf produced
    // immediately rather than waiting for the 30 s interval.
    if (running) {
      pendingRerun = true;
      return;
    }
    running = true;
    try {
      do {
        pendingRerun = false;
        const managed = sessionManager.listManagedSessions();
        const live = managed.filter((m) => m.meta.state !== 'dead');
        if (live.length === 0) break;

        stateWriter.ensureBufferDir();
        let dumped = 0; let skipped = 0; let forced = 0;
        for (const m of live) {
          const dumpPath = stateWriter.getBufferDumpPath(m.meta.id);
          const ring = m.ringBuffer as unknown as object & { totalBytesWritten: number; dumpToFile: (p: string) => Promise<void> };
          // Capture BEFORE dumpToFile — see the TOCTOU note above.
          const writtenAtStart = ring.totalBytesWritten;
          const ticks = (ticksSinceDump.get(ring) ?? 0) + 1;
          const clean = lastDumpedBytes.get(ring) === writtenAtStart;
          const forceDue = ticks >= FORCE_DUMP_EVERY_N_TICKS;
          if (clean && !forceDue) {
            ticksSinceDump.set(ring, ticks);
            skipped++;
            continue;
          }
          try {
            await m.ringBuffer.dumpToFile(dumpPath);
            lastDumpedBytes.set(ring, writtenAtStart);
            ticksSinceDump.set(ring, 0);
            if (clean && forceDue) forced++; else dumped++;
          } catch (err) {
            // Nothing recorded — the session stays dirty and retries next tick.
            ticksSinceDump.set(ring, ticks);
            snapshotLog('warn', `Snapshot dump failed for ${m.meta.id}:`, err);
          }
        }
        if (dumped > 0 || forced > 0) {
          snapshotLog('info', `Snapshot: dumped=${dumped} forced=${forced} skipped-clean=${skipped} of ${live.length} live`);
        }
        try {
          // Async read (30-session scaling): this used to be a sync
          // stateWriter.load() + saveImmediate pair on EVERY 30s tick —
          // re-parsing and re-writing a sessions.json that grows with the
          // fleet, on the same event loop that answers daemon.ping.
          //
          // Backup fallback (review consensus): the primary can be corrupt,
          // or this read can land inside atomicWriteJSON's rename window.
          // Treating that as "nothing to preserve" and then SAVING would
          // permanently drop recovery-cap-skipped suspended sessions that
          // exist only in this file — so on primary failure we walk the same
          // .bak rotation load() uses before giving up.
          let onDisk: DaemonSession[] = [];
          const primary = stateWriter.getFilePath();
          for (const file of [primary, ...BACKUP_SUFFIXES.map((s) => `${primary}${s}`)]) {
            try {
              const parsed = JSON.parse(await fsp.readFile(file, 'utf-8')) as
                | { sessions?: DaemonSession[] }
                | null;
              if (parsed && Array.isArray(parsed.sessions)) {
                onDisk = parsed.sessions;
                break;
              }
            } catch {
              // Absent/unreadable/corrupt slot — try the next backup. All
              // slots failing means a true first save: nothing to preserve.
            }
          }

          // Capture the live sessions AFTER the await above (codex review):
          // a cwd/lifecycle event that persisted DURING the read would
          // otherwise be overwritten by this merge's pre-event copies,
          // re-opening the reboot-loss window until the next tick.
          const liveSessions = sessionManager.listSessions();
          const liveIds = new Set(liveSessions.map((s) => s.id));
          const preserved = onDisk.filter(
            (s) => s && typeof s.id === 'string' && !liveIds.has(s.id),
          );
          const merged: DaemonState = {
            version: 1,
            sessions: [...liveSessions, ...preserved],
            bootId: options.getBootId(),
          };
          // saveAsap, not saveImmediate: the periodic snapshot must not block
          // the loop; the coalescing queue serialises it against other writers
          // and a racing saveImmediate supersedes it (next tick re-merges).
          // Awaited so "snapshot ran" still means "state persisted" for
          // callers (session-create backstop, tests) — awaiting yields the
          // loop, it does not block it.
          await stateWriter.saveAsap(merged);
        } catch (err) {
          snapshotLog('warn', 'Snapshot state save failed:', err);
        }
      } while (pendingRerun);
    } finally {
      running = false;
    }
  };
}
