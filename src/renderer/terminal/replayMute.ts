// === OSC 52 replay mute (#998/#1014) — pure state machine, DOM-free ===
//
// A copy is an act, and an act cannot be replayed. Stored output written back
// into xterm may contain an OSC 52 clipboard write; re-executing it must not
// replace the live clipboard. Replay provenance now comes from the daemon's
// session-pipe scanner, so every stored write can use xterm's completion
// callback as its mute lifetime. No receive-time window or timer is needed.
// The counter deliberately fails closed: if xterm strands a callback, later
// replay remains muted instead of silently regaining side-effect authority.

export interface ReplayMute {
  /** Replay writes handed to xterm but not yet confirmed parsed. */
  depth: number;
  /**
   * Terminal generation. This hook outlives the terminal it hosts, so a write
   * callback from a disposed terminal must not release the mute of the one
   * that replaced it.
   */
  gen: number;
}

export function createReplayMute(): ReplayMute {
  return { depth: 0, gen: 0 };
}

/** True while stored bytes are being parsed — the OSC 52 handler reads this. */
export function isReplayMuted(m: ReplayMute): boolean {
  return m.depth > 0;
}

/**
 * Mute for one replay write. Returns the release that the caller hands to
 * xterm's write callback: releasing synchronously would unmute while escape
 * sequences are still queued. Idempotent and generation-scoped.
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

/** Teardown: invalidate late callbacks and drop this generation's writes. */
export function resetReplayMute(m: ReplayMute): void {
  m.gen += 1;
  m.depth = 0;
}
