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
//   - `burst`   — output is actively flowing to a visible pane. Fired on a
//                 time cadence (see below) so live streaming self-repairs, plus
//                 once more when the stream finally settles.
//
// --- Why the `burst` gate is an activity-based TIME cadence (issue #318) ---
//
// The original #319 gate qualified a "burst" by SIZE: a contiguous run of PTY
// writes had to accumulate >= 32KB (with no gap >= burstQuietMs) before ANY
// repaint fired, mid-stream or trailing. That gate assumed agent output arrives
// in fat contiguous slabs. It does not. A captured Claude Code TUI stream
// (141s, 1907 chunks) is a DRIP: mean chunk ~48 UTF-16 units, with a 300ms+
// pause every few seconds (34 such gaps → 35 separate "bursts"). Replayed
// through the real module, only 1 of 35 bursts ever crossed 32KB, and that one
// took 39s of blind ramp to get there — total measured coverage was ~18% of
// active streaming time. 82% of the reporter's scenario was structurally blind,
// mid-stream AND trailing (sub-32KB bursts got no repaint at all, ever). The
// reporter confirmed "no measurable improvement" — exactly consistent.
//
// The fix: SIZE never gates a repaint; TIME does. `activityBytes` (default 256)
// is only a noise floor — it suppresses refreshes for idle chatter (keystroke
// echoes, cursor-blink sequences) so we don't churn the GPU when nothing is
// really streaming. Any real flow of output clears it in a few chunks. Once
// cleared, we repaint on a fixed `burstStreamFlushMs` cadence for as long as
// output keeps flowing, and once more at the trailing quiet settle.
//
// windowAccum = units written since the last flush of ANY kind (mid or
// trailing). It is the "has enough NEW output arrived to be worth a refresh?"
// counter, reset to 0 at every flush — NOT a running burst total.
//
// Resulting invariant: on a VISIBLE pane, render staleness cannot outlive
// roughly `burstStreamFlushMs + burstQuietMs` while output flows, and is
// repaired once more when the stream settles. (Old gate: staleness could
// persist for the entire multi-second stream — the #318 report.)
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
  /** Feed PTY write sizes; fires repaint('burst') on the streaming cadence. */
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
  /** Noise floor, in UTF-16 code units: the minimum output accumulated SINCE
   *  THE LAST FLUSH for a flush to be worth firing. Its only job is to suppress
   *  refreshes for tiny idle noise (keystroke echoes, cursor-blink sequences) —
   *  it does NOT qualify a "big burst". Real streaming clears it in a handful of
   *  chunks. */
  activityBytes?: number;
  /** Quiet gap that ends a stream. Writes closer together than this belong to
   *  the same active stream (one pending timer is re-armed per write). The
   *  trailing settle flush fires when this timer elapses. */
  burstQuietMs?: number;
  /** Minimum interval between focus-triggered repaints. Focus fires on every
   *  click into the pane; the atlas clear behind it should not. */
  focusThrottleMs?: number;
  /** Mid-stream flush cadence: while output keeps flowing, repaint at most this
   *  often. Bounds the streaming repaint rate so a busy stream stays fresh
   *  without churning a full refresh on every write. Pass Infinity to disable
   *  the mid-stream cadence entirely (the trailing settle flush still runs). */
  burstStreamFlushMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

// Noise floor. ~256 UTF-16 units is a few lines of output — small enough that
// any genuine stream clears it almost immediately, large enough that a lone
// keystroke echo or a cursor-blink escape never triggers a refresh.
export const ACTIVITY_BYTES_DEFAULT = 256;
export const BURST_QUIET_MS_DEFAULT = 300;
export const FOCUS_THROTTLE_MS_DEFAULT = 1000;
// Mid-stream flush cadence (issue #318). ~2 repaints/sec during heavy streaming
// — frequent enough that corruption never lingers visibly, infrequent enough
// that the extra full-range refreshes are not measurable GPU churn.
export const BURST_STREAM_FLUSH_MS_DEFAULT = 500;

export function createGlyphRepaintScheduler(
  options: GlyphRepaintOptions,
): GlyphRepaintScheduler {
  const {
    repaint,
    activityBytes = ACTIVITY_BYTES_DEFAULT,
    burstQuietMs = BURST_QUIET_MS_DEFAULT,
    focusThrottleMs = FOCUS_THROTTLE_MS_DEFAULT,
    burstStreamFlushMs: burstStreamFlushMsRaw = BURST_STREAM_FLUSH_MS_DEFAULT,
    now = Date.now,
  } = options;
  // Floor the mid-stream cadence at 1ms so a 0/negative value can't turn the
  // flush into a full-range refresh on every single write (the GPU churn the
  // cadence exists to avoid). Infinity is preserved (Math.max(1, Infinity) =
  // Infinity); a non-finite cadence disables the mid-stream flush below.
  const burstStreamFlushMs = Math.max(1, burstStreamFlushMsRaw);
  const midStreamEnabled = Number.isFinite(burstStreamFlushMs);

  let disposed = false;
  // Units written since the last flush of any kind. Reset to 0 at every flush.
  let windowAccum = 0;
  let quietTimer: ReturnType<typeof setTimeout> | null = null;
  let lastFocusRepaintAt = -Infinity;
  // Timestamp of the last real flush (mid or trailing). Seeded to -Infinity so
  // the first qualifying write flushes immediately — intentional and harmless.
  // Only ever advanced when a flush actually fires (never on a dropped tail).
  let lastFlushAt = -Infinity;

  return {
    onData(byteLength: number): void {
      if (disposed || byteLength <= 0) return;
      const t = now();
      windowAccum += byteLength;
      // Mid-stream flush (issue #318): once enough NEW output has arrived since
      // the last flush (windowAccum >= activityBytes), repaint on the cadence
      // so a live stream self-repairs instead of waiting for a quiet gap that,
      // for a continuous TUI, never comes. windowAccum resets here because it
      // measures output SINCE the last flush; the trailing settle then only
      // fires if further output accrues past the floor before the stream quiets.
      if (
        midStreamEnabled &&
        windowAccum >= activityBytes &&
        t - lastFlushAt >= burstStreamFlushMs
      ) {
        lastFlushAt = t;
        windowAccum = 0;
        repaint('burst');
      }
      // Re-arm the quiet timer on every write. When it finally elapses the
      // stream has settled; the trailing flush is this stream's last repair
      // opportunity, so it ignores the cadence rate limit.
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        quietTimer = null;
        if (windowAccum >= activityBytes) {
          lastFlushAt = now();
          windowAccum = 0;
          repaint('burst');
        } else {
          // Sub-threshold tail: drop it so a stale trickle can't leak into a
          // later unrelated stream's first-flush timing. No flush happened, so
          // lastFlushAt is left untouched.
          windowAccum = 0;
        }
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
      windowAccum = 0;
    },
  };
}
