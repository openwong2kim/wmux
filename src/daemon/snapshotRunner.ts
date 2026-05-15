import type { DaemonSessionManager } from './DaemonSessionManager';
import type { StateWriter } from './StateWriter';
import type { DaemonState, DaemonSession } from './types';

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
        for (const m of live) {
          const dumpPath = stateWriter.getBufferDumpPath(m.meta.id);
          try {
            await m.ringBuffer.dumpToFile(dumpPath);
          } catch (err) {
            snapshotLog('warn', `Snapshot dump failed for ${m.meta.id}:`, err);
          }
        }
        try {
          const liveSessions = sessionManager.listSessions();
          const liveIds = new Set(liveSessions.map((s) => s.id));
          let preserved: DaemonSession[] = [];
          try {
            const existing = stateWriter.load();
            preserved = existing.sessions.filter((s) => !liveIds.has(s.id));
          } catch {
            // No prior sessions.json (first save) — nothing to preserve.
          }
          const merged: DaemonState = {
            version: 1,
            sessions: [...liveSessions, ...preserved],
            bootId: options.getBootId(),
          };
          stateWriter.saveImmediate(merged);
        } catch (err) {
          snapshotLog('warn', 'Snapshot state save failed:', err);
        }
      } while (pendingRerun);
    } finally {
      running = false;
    }
  };
}
