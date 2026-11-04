/**
 * Which replay the renderer is about to receive for a session: the first, or
 * one that follows a flush the renderer already got (daemon mode).
 *
 * A pane reattached twice (a split remounts it while the first mount's
 * reconnect is in flight, a late retry, a reconnect after a daemon restart)
 * gets the daemon's ring flush again, the whole history in it. The renderer
 * appends what it receives, so that second replay repeated everything the
 * pane already showed, live output included. Led by a terminal reset (RIS),
 * it repaints the pane instead, as the daemon's live re-flush already does
 * (SessionPipe.reflushInSlot).
 *
 * main sees both ends of it: every flush marker it forwards to the renderer
 * and every replay chunk it hands to the data batcher. The daemon's stream
 * scanner emits a replay together with its marker, so the first replay chunk
 * after a marker opens a new replay. A session that ended or restarted under
 * the same id starts over: its next flush is appended (after the exit or the
 * restart line), never reset.
 *
 * Kept per main process, not per handler registration, so the first flush of
 * a new daemon generation onto a screen the old one filled is a repaint too.
 */

/** RIS: a full terminal reset. */
export const REPLAY_RESET = '\x1bc';

export interface ReplayResetGate {
  /** A flush marker for the session went to the renderer. */
  flushed(sessionId: string): void;
  /** The text of a replay chunk going to the renderer, RIS-led when it opens a second replay. */
  replayText(sessionId: string, text: string): string;
  /** The session ended or restarted: its next flush is a first one. */
  forget(sessionId: string): void;
}

export function createReplayResetGate(
  log: (line: string) => void = (line) => console.log(line),
): ReplayResetGate {
  // Sessions whose last flush the renderer received, and no replay since.
  const flushedToRenderer = new Set<string>();
  return {
    flushed(sessionId) {
      flushedToRenderer.add(sessionId);
    },
    replayText(sessionId, text) {
      if (!flushedToRenderer.delete(sessionId)) return text;
      log(`[lifecycle] pty.replay id=${sessionId} reset=1`);
      return REPLAY_RESET + text;
    },
    forget(sessionId) {
      flushedToRenderer.delete(sessionId);
    },
  };
}
