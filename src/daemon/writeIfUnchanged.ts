/**
 * F26 — `daemon.writeIfUnchanged`: type into a session only if it has not
 * moved since the caller looked at it.
 *
 * Main decides to send a fan-out task pane's launch line a second time from a
 * snapshot of the pane (its output size and prompt markers). Re-reading the
 * pane and then writing through the session pipe leaves a window between the
 * two in which the shell can take the first line (an echo, a command-start)
 * and get a duplicate. Here the compare and the write are one synchronous
 * step on the daemon's live state, so nothing can arrive in between.
 */

import type { PromptEvent } from './PromptEventLog';

/** The pane as the caller saw it. */
export interface WriteExpectation {
  outputBytes: number;
  markerCount: number;
  /** The last prompt marker, or null when there was none. */
  lastPromptMarker: { type: string; byteOffset: number } | null;
}

export interface WritableSession {
  ringBuffer: { readonly totalBytesWritten: number };
  promptLog: { readonly size: number; recent(n: number): PromptEvent[] };
  /** Writes to the PTY (and does the session's input accounting). */
  write(data: string): void;
}

/** Parse `expect` from RPC params; null when it is malformed. */
export function parseWriteExpectation(raw: unknown): WriteExpectation | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  if (!Number.isSafeInteger(e.outputBytes) || !Number.isSafeInteger(e.markerCount)) return null;
  const last = e.lastPromptMarker;
  if (last === null) return { outputBytes: e.outputBytes as number, markerCount: e.markerCount as number, lastPromptMarker: null };
  if (!last || typeof last !== 'object') return null;
  const m = last as Record<string, unknown>;
  if (typeof m.type !== 'string' || !Number.isSafeInteger(m.byteOffset)) return null;
  return {
    outputBytes: e.outputBytes as number,
    markerCount: e.markerCount as number,
    lastPromptMarker: { type: m.type, byteOffset: m.byteOffset as number },
  };
}

/** Write `data` only when the session still matches `expect`. Synchronous. */
export function writeIfUnchanged(session: WritableSession, data: string, expect: WriteExpectation): boolean {
  if (session.ringBuffer.totalBytesWritten !== expect.outputBytes) return false;
  if (session.promptLog.size !== expect.markerCount) return false;
  const last = session.promptLog.recent(1)[0] ?? null;
  const want = expect.lastPromptMarker;
  if ((last === null) !== (want === null)) return false;
  if (last && want && (last.type !== want.type || last.byteOffset !== want.byteOffset)) return false;
  session.write(data);
  return true;
}
