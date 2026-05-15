import type { DaemonSessionManager } from './DaemonSessionManager';
import type { StateWriter } from './StateWriter';
import type { DaemonState } from './types';

// Side-effect-free module so unit tests can drive runSnapshotOnce without
// importing src/daemon/index.ts (which would execute its main() bootstrap on
// import and start a real daemon during the test run).

function snapshotLog(level: string, msg: string, ...args: unknown[]): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [daemon/${level}] ${msg}`, ...args);
}

// Returns an async function that dumps every live session's RingBuffer to disk
// and persists sessions.json. Owns a per-runner re-entrancy flag so concurrent
// invocations (e.g., a scheduled tick fires while a previous one is still
// flushing) collapse to a single run.
//
// Extracted from the inline 30 s setInterval body so the same runner can also
// be invoked once at spawn time, closing the window where no .buf yet exists
// on disk. A crash within the first 30 s after daemon start would otherwise
// leave the recovery loop with no buffer file to restore from.
export function createSnapshotRunner(
  sessionManager: DaemonSessionManager,
  stateWriter: StateWriter,
  options: { getBootId: () => string },
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
      try {
        const state: DaemonState = {
          version: 1,
          sessions: sessionManager.listSessions(),
          bootId: options.getBootId(),
        };
        stateWriter.saveImmediate(state);
      } catch (err) {
        snapshotLog('warn', 'Snapshot state save failed:', err);
      }
    } finally {
      running = false;
    }
  };
}
