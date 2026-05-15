import type { DaemonSessionManager } from './DaemonSessionManager';
import type { StateWriter } from './StateWriter';

// Side-effect-free module so unit tests can drive runSnapshotOnce without
// importing src/daemon/index.ts (which would execute its main() bootstrap on
// import and start a real daemon during the test run).

function snapshotLog(level: string, msg: string, ...args: unknown[]): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [daemon/${level}] ${msg}`, ...args);
}

// Returns an async function that dumps every live session's RingBuffer to
// disk. Owns a per-runner re-entrancy flag so concurrent invocations (e.g., a
// scheduled tick fires while a previous one is still flushing) collapse to a
// single run.
//
// Extracted from the inline 30 s setInterval body so the same runner can also
// be invoked at session-create time and once at spawn, closing the window
// where no .buf yet exists on disk. A crash within the first 30 s after
// daemon start would otherwise leave the recovery loop with no buffer file
// to restore from.
//
// Important: this runner intentionally does NOT persist sessions.json.
// sessions.json is maintained by every create/attach/detach/destroy RPC
// handler and by recovery itself. If the runner re-saved listSessions() it
// would erase any suspended session entries that recovery preserved past
// MAX_RECOVER_SESSIONS (which are present in sessions.json but absent from
// sessionManager).
export function createSnapshotRunner(
  sessionManager: DaemonSessionManager,
  stateWriter: StateWriter,
): () => Promise<void> {
  let running = false;
  return async function runSnapshotOnce(): Promise<void> {
    if (running) return;
    const managed = sessionManager.listManagedSessions();
    const live = managed.filter((m) => m.meta.state !== 'dead');
    if (live.length === 0) return;

    running = true;
    stateWriter.ensureBufferDir();
    try {
      for (const m of live) {
        const dumpPath = stateWriter.getBufferDumpPath(m.meta.id);
        try {
          await m.ringBuffer.dumpToFile(dumpPath);
        } catch (err) {
          snapshotLog('warn', `Snapshot dump failed for ${m.meta.id}:`, err);
        }
      }
    } finally {
      running = false;
    }
  };
}
