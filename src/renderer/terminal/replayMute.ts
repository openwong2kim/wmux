// === OSC 52 replay mute (#998) — pure state machine, DOM-free ===
//
// A copy is an act, and an act cannot be replayed. Stored output written back
// into xterm — a dead-pane snapshot, a resync payload, restored scrollback, or
// the daemon RingBuffer flush after a reattach — may contain an OSC 52
// clipboard write. Re-executing it silently replaces the live clipboard with
// whatever was copied when those bytes were first produced, and since the ring
// buffer outlives the session that produced it, that value can be days old.
//
// This module owns WHEN the bridge is closed. Two shapes, because the two kinds
// of replay arrive differently:
//
//   • writes we make ourselves        -> beginWrite(), released in xterm's
//     (snapshot / resync / scrollback)   write callback, so the mute lasts
//                                        exactly as long as the parse
//   • the reattach replay             -> openReattachWindow(), released when the
//     (arrives as ordinary pty:data)     burst goes quiet, or at a hard cap
//
// The reattach window is the one that needs a heuristic: nothing in the data
// event says "this is a replay", so the window opens when we ask the daemon to
// reconnect and closes when the output it sends back stops arriving. A live copy
// made inside that window is swallowed — deliberate, and the lesser evil: a lost
// copy is a retry the user notices immediately, a resurrected one is corruption
// they discover after pasting the wrong thing somewhere.
//
// The quiet timer tracks silence in the REPLAY, not silence since the window
// opened: it only starts once the first chunk arrives (noteReplayData). A
// daemon that takes longer than REATTACH_QUIET_MS to answer the reconnect
// request would otherwise let a quiet-from-open timer close the window before
// its own flush landed — the leak this module exists to prevent, just moved
// later. The cap timer alone covers "the replay never came at all".

/** No data for this long ends the reattach window (the flush arrives as a burst). */
export const REATTACH_QUIET_MS = 250;
/** Hard cap, so a pane that keeps printing can never hold the bridge shut. */
export const REATTACH_CAP_MS = 5_000;

type Timer = ReturnType<typeof setTimeout>;

export interface ReplayMute {
  /** In-flight replay writes plus (at most one) open reattach window. */
  depth: number;
  /**
   * Terminal generation. This hook outlives the terminal it hosts, so a write
   * callback or timer from a disposed terminal must not release the mute of the
   * one that replaced it.
   */
  gen: number;
  reattachOpen: boolean;
  quiet: Timer | null;
  /** Release for the open reattach window, so `noteReplayData` can re-arm it. */
  closeReattach?: () => void;
  cap: Timer | null;
}

export function createReplayMute(): ReplayMute {
  return { depth: 0, gen: 0, reattachOpen: false, quiet: null, cap: null };
}

/** True while stored bytes are being parsed — the OSC 52 handler reads this. */
export function isReplayMuted(m: ReplayMute): boolean {
  return m.depth > 0;
}

/**
 * Mute for one write we are about to make. Returns the release, which the caller
 * hands to xterm's write callback: releasing synchronously would unmute while
 * the escape sequences are still queued, which is the bug itself. Idempotent,
 * and inert once the generation has moved on.
 */
export function beginReplayWrite(m: ReplayMute): () => void {
  const gen = m.gen;
  m.depth += 1;
  let released = false;
  return () => {
    if (released || m.gen !== gen) return;
    released = true;
    m.depth = Math.max(0, m.depth - 1);
  };
}

/**
 * Mute the window around a reattach: the daemon replays its RingBuffer as
 * ordinary pty:data, so there is no write of ours to hang the mute on. Opens at
 * most one window; `noteData` extends it while the burst is arriving.
 */
export function openReattachWindow(m: ReplayMute): void {
  if (m.reattachOpen) return;
  const gen = m.gen;
  m.reattachOpen = true;
  m.depth += 1;
  const close = (): void => {
    if (!m.reattachOpen || m.gen !== gen) return;
    m.reattachOpen = false;
    clearTimers(m);
    m.depth = Math.max(0, m.depth - 1);
  };
  // Only `cap` is armed here — the backstop for "the replay never came"
  // (failed reconnect, empty ring), which would otherwise hold the bridge
  // shut indefinitely. `quiet` is NOT armed until the first chunk actually
  // arrives (see noteReplayData): arming it from open() measured silence
  // from the RECONNECT REQUEST, not from the replay, so a daemon slower than
  // REATTACH_QUIET_MS to answer closed the window before its own flush
  // landed — the exact leak this module exists to prevent, just moved later.
  m.cap = setTimeout(close, REATTACH_CAP_MS);
  m.closeReattach = close;
}

/** Extend an open reattach window: more bytes are still arriving. */
export function noteReplayData(m: ReplayMute): void {
  if (!m.reattachOpen) return;
  if (m.quiet) clearTimeout(m.quiet);
  m.quiet = setTimeout(() => m.closeReattach?.(), REATTACH_QUIET_MS);
}

/**
 * Teardown. Bumps the generation so late callbacks and timers cannot touch the
 * successor's state, and drops everything this generation was holding.
 */
export function resetReplayMute(m: ReplayMute): void {
  m.gen += 1;
  m.depth = 0;
  m.reattachOpen = false;
  clearTimers(m);
  m.closeReattach = undefined;
}

function clearTimers(m: ReplayMute): void {
  if (m.quiet) { clearTimeout(m.quiet); m.quiet = null; }
  if (m.cap) { clearTimeout(m.cap); m.cap = null; }
}
