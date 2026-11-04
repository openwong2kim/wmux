/**
 * Which replay the renderer is about to receive for a session: the first, or
 * one that follows a flush the renderer already got (daemon mode).
 *
 * A pane reattached twice (a split remounts it while the first mount's
 * reconnect is in flight, a late retry, a reconnect after a daemon restart)
 * gets the daemon's ring flush again, the whole history in it. The renderer
 * appends what it receives, so that second replay repeated everything the
 * pane already showed, live output included. Led by a clear of the screen and
 * the scrollback, it repaints the pane instead.
 *
 * main sees both ends of it: every flush marker it forwards to the renderer
 * and every replay chunk it hands to the data batcher. The daemon's stream
 * scanner emits a replay together with its marker, so the first replay chunk
 * after a marker opens a new replay. A session that ended or restarted under
 * the same id starts over: its next flush is appended (after the exit or the
 * restart line), never cleared.
 *
 * Kept per main process, not per handler registration, so the first flush of
 * a new daemon generation onto a screen the old one filled is a repaint too.
 */

/**
 * Clears what the replay draws again and nothing the terminal negotiated
 * with the app. Not RIS: RIS also drops the kitty keyboard flags (a snapshot
 * replay does not carry them), and it ends a DEC 2026 hold the renderer opened
 * in front of the replay (a cold-frame swap). What RIS resets that would
 * change how the replay's own text lands is reset here: the scroll region,
 * SGR, the G0 charset and shift state, insert mode, origin mode, autowrap and
 * reverse wrap. Then home, erase the screen and the scrollback (ED2, ED3).
 */
export const REPLAY_CLEAR = '\x1b[r\x1b[0m\x1b(B\x0f\x1b[4l\x1b[?6l\x1b[?7h\x1b[?45l\x1b[H\x1b[2J\x1b[3J';

/**
 * Back to the main screen first when the session is on the alternate one: the
 * clear must reach the main screen's scrollback, and the replay (a snapshot
 * writes the main screen, then `?1049h` and the alternate one) must enter the
 * alternate screen from the main one. Sent only then: xterm swaps the kitty
 * keyboard flags of the two screens on every 1049 switch, wherever it is.
 */
export const LEAVE_ALT_SCREEN = '\x1b[?1049l';

// RIS, or a DECSET/DECRST whose parameters may switch the screen.
// eslint-disable-next-line no-control-regex
const SCREEN_SWITCH = /\x1bc|\x1b\[\?([\d;]*)([hl])/g;

/**
 * Whether `text` leaves the terminal on the alternate screen. A second replay
 * ends where the session is now, which is where the pane's terminal is.
 */
export function endsOnAltScreen(text: string): boolean {
  let alt = false;
  for (const m of text.matchAll(SCREEN_SWITCH)) {
    if (m[0] === '\x1bc') alt = false;
    else if (m[1].split(';').some((p) => p === '1049' || p === '1047' || p === '47')) alt = m[2] === 'h';
  }
  return alt;
}

export interface ReplayResetGate {
  /** A flush marker for the session went to the renderer. */
  flushed(sessionId: string): void;
  /** The text of a replay chunk going to the renderer, clear-led when it opens a second replay. */
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
      // A live re-flush opens with its own RIS (SessionPipe.reflushInSlot).
      if (text.startsWith('\x1bc')) return text;
      const alt = endsOnAltScreen(text);
      log(`[lifecycle] pty.replay id=${sessionId} reset=1${alt ? ' alt=1' : ''}`);
      return (alt ? LEAVE_ALT_SCREEN : '') + REPLAY_CLEAR + text;
    },
    forget(sessionId) {
      flushedToRenderer.delete(sessionId);
    },
  };
}
