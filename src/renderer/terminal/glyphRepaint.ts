// Defensive repaint scheduling for the "garbled glyphs until resize" class of
// rendering corruption (issue #166).
//
// Symptom: a pane's text renders as corrupted/mojibake glyphs after fast
// output bursts (CJK + box-drawing heavy, several panes updating at once),
// and stays corrupted until a pane-border drag forces a resize — which is the
// only code path today that triggers a full xterm repaint. This module repairs
// the dirty-region desync — xterm's incremental renderer treats rows as clean
// when their on-screen pixels are stale — with a full-range `refresh()`. It
// does NOT clear the WebGL texture atlas: xterm shares one glyph atlas across
// same-config terminals (CharAtlasCache), so clearing it from one pane corrupts
// the others; atlas-level staleness is left to xterm's own page management.
//
// The corruption is non-deterministic (driver/timing dependent), so instead of
// chasing a single trigger we schedule cheap repaints at the moments a user
// would notice staleness:
//
//   - `focus`   — the pane became the focused pane: mouse click, keyboard
//                 pane-nav, or the MCP pane.focus bridge (useActivePaneFocus
//                 calls term.focus() for all of these). Throttled because
//                 keyboard nav can cycle panes several times per second.
//   - `visible` — the pane's workspace/tab became visible again. Matters for
//                 fast view switches where the WebGL context pool kept the
//                 (possibly stale) context alive instead of rebuilding it.
//   - `burst`   — a contiguous run of PTY writes totalling >= burstBytes ended
//                 (quiet for burstQuietMs). This is the "watching agent output
//                 garble live" case where neither focus nor visibility changes.
//
// All three reasons run the same full-range refresh; the caller does not vary
// repaint cost per reason. The refresh never mutates the shared glyph atlas
// (#191), so it cannot corrupt sibling panes — the burst-visibility gate aside,
// the only per-reason difference is the throttle on `focus`.
//
// This module is pure scheduling logic (timers + counters) so it can be unit
// tested without xterm; all rendering side effects live in the caller's
// `repaint` callback.

export type RepaintReason = 'focus' | 'visible' | 'burst';

export interface GlyphRepaintScheduler {
  /** Feed PTY write sizes; fires repaint('burst') when a large burst settles. */
  onData(byteLength: number): void;
  /** The terminal's textarea gained focus; throttled repaint('focus'). */
  onFocus(): void;
  /** The terminal became visible again; immediate repaint('visible'). */
  onVisible(): void;
  /** Cancel pending timers; all further calls become no-ops. */
  dispose(): void;
}

export interface GlyphRepaintOptions {
  repaint: (reason: RepaintReason) => void;
  /** A burst must total at least this many UTF-16 code units to earn a
   *  repaint when it settles. Small interactive echoes never qualify. */
  burstBytes?: number;
  /** Quiet gap that ends a burst. Writes closer together than this are the
   *  same burst (one pending timer is re-armed per write). */
  burstQuietMs?: number;
  /** Minimum interval between focus-triggered repaints. Focus fires on every
   *  click into the pane; the atlas clear behind it should not. */
  focusThrottleMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export const BURST_BYTES_DEFAULT = 32 * 1024;
export const BURST_QUIET_MS_DEFAULT = 300;
export const FOCUS_THROTTLE_MS_DEFAULT = 1000;

export function createGlyphRepaintScheduler(
  options: GlyphRepaintOptions,
): GlyphRepaintScheduler {
  const {
    repaint,
    burstBytes = BURST_BYTES_DEFAULT,
    burstQuietMs = BURST_QUIET_MS_DEFAULT,
    focusThrottleMs = FOCUS_THROTTLE_MS_DEFAULT,
    now = Date.now,
  } = options;

  let disposed = false;
  let burstAccum = 0;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let lastFocusRepaintAt = -Infinity;

  return {
    onData(byteLength: number): void {
      if (disposed || byteLength <= 0) return;
      burstAccum += byteLength;
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        quietTimer = null;
        const qualified = burstAccum >= burstBytes;
        // Always reset at burst end — a slow trickle must not accumulate
        // across unrelated bursts into a spurious repaint.
        burstAccum = 0;
        if (qualified) repaint('burst');
      }, burstQuietMs);
    },

    onFocus(): void {
      if (disposed) return;
      const t = now();
      if (t - lastFocusRepaintAt < focusThrottleMs) return;
      lastFocusRepaintAt = t;
      repaint('focus');
    },

    onVisible(): void {
      if (disposed) return;
      repaint('visible');
    },

    dispose(): void {
      disposed = true;
      if (quietTimer) {
        clearTimeout(quietTimer);
        quietTimer = null;
      }
      burstAccum = 0;
    },
  };
}
