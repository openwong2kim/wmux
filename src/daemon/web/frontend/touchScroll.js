/* Touch scrolling for the wmux web terminal (#890).
 *
 * xterm exposes no touch API at all — `xterm.d.ts` has zero `touch` matches,
 * and the VS Code `Gesture` helper xterm 6 vendors is behind an internal
 * `Gesture.addTarget()`. Upstream agrees the gap is real (xterm.js#5377,
 * xterm.js#1007), so a downstream handler is the supported path here, not us
 * re-implementing a built-in. Without it a phone cannot reach scrollback at
 * all: the swipe does nothing, the 14px overlay scrollbar cannot be dragged by
 * touch, and there is no wheel or Shift+PageUp on a soft keyboard.
 *
 * Kept out of app.js — and out of app.js's IIFE — for the same reason as
 * attentionFormat.js and pairQuery.js: the build script inlines this file into
 * terminal.html (there is no bundler), and the unit tests evaluate the shipped
 * bytes directly, so the two pure functions that hold all of the arithmetic are
 * testable without a DOM and `attachTouchScroll` is testable without booting
 * the whole app.
 *
 * What deliberately is NOT here: momentum. xterm cannot do it structurally
 * (xterm.js#594 — "the viewport is actually underneath the row divs"), so it
 * would mean hand-rolling velocity tracking and a deceleration loop, which is
 * the most bug-prone part of any touch handler. `smoothScrollDuration` on the
 * Terminal covers the perceptual half.
 */
/* global globalThis */
(function (root) {
  'use strict';

  /**
   * How far a finger must travel before the gesture commits to an axis.
   *
   * Small enough that a deliberate swipe locks almost immediately, large enough
   * that the wobble in a tap does not count as movement — the tap has to keep
   * reaching the `click` listener that raises the soft keyboard.
   */
  var AXIS_THRESHOLD = 8;

  /**
   * Ceiling on arrow keys emitted for ONE touchmove on the alt screen.
   *
   * A normal move carries a handful of lines. A pathological one (a finger
   * re-entering the element after leaving it, a synthetic event) can carry
   * hundreds, and each line is a keystroke POSTed at a live TUI. Cap it at
   * roughly a screenful rather than let a stray delta hammer the pane.
   */
  var MAX_KEYS_PER_MOVE = 24;

  /**
   * Arrow keys in both encodings, because the alt screen needs the right one.
   *
   * A TUI that turns on keypad-transmit (terminfo `smkx`, which sets DECCKM)
   * expects the SS3 form and treats the CSI form as noise. Git for Windows
   * `less` does exactly that: during the #890 dogfood the handler claimed all
   * 14 touchmoves of a swipe and `less` still did not move, because every
   * keystroke went out as CSI. vim, less and htop are precisely the panes this
   * branch exists for, so guessing one encoding is guessing wrong.
   */
  var CSI_UP = '\x1b[A';
  var CSI_DOWN = '\x1b[B';
  var SS3_UP = '\x1bOA';
  var SS3_DOWN = '\x1bOB';

  /**
   * Property stamped on a host that already carries the listeners.
   *
   * Holds the rebind function, so attaching twice to the same element swaps the
   * terminal rather than stacking a second handler on top of the first.
   */
  var ATTACH_KEY = '__wmuxTouchScroll';

  /**
   * Convert a vertical finger delta into whole terminal lines.
   *
   * Returns `{ lines, remainder }`. The remainder is the sub-cell leftover in
   * PIXELS and MUST be fed back in as the next call's `accum` — dropping it is
   * what makes a slow drag scroll nothing at all forever, since every
   * individual touchmove on a high-DPR phone is well under one cell tall.
   *
   * `lines` is positive when the finger moved DOWN. Callers negate for
   * `scrollLines` (content follows the finger) — the sign convention lives at
   * the call site so this function is just arithmetic.
   */
  function touchDeltaToLines(accum, dy, cellHeight) {
    var a = typeof accum === 'number' && isFinite(accum) ? accum : 0;
    var d = typeof dy === 'number' && isFinite(dy) ? dy : 0;
    // A hidden or not-yet-measured pane reports a zero cell height. Dividing
    // would yield Infinity; carrying the delta forward instead would fire the
    // whole accumulated swipe in one jump the moment the pane is measured
    // again. Drop it — a pane the user cannot see is not one they meant to
    // scroll.
    if (!(cellHeight > 0) || !isFinite(cellHeight)) return { lines: 0, remainder: 0 };
    var total = a + d;
    // trunc, not floor: floor would round -0.5 cells down to a whole line up,
    // making the two directions behave differently at the same finger speed.
    // `|| 0` normalises -0, which Math.trunc returns for any small negative
    // delta. A caller branching on `lines > 0` would read -0 as "upward" and
    // pick the wrong arrow key for a step that is not a step at all.
    var lines = Math.trunc(total / cellHeight) || 0;
    return { lines: lines, remainder: total - lines * cellHeight };
  }

  /**
   * Decide which axis a gesture belongs to, and keep that decision.
   *
   * Returns 'vertical', 'horizontal', or '' while still undecided. Pass the
   * previous answer back in as `current` and it is returned unchanged: the lock
   * is sticky by construction, so a swipe that starts vertical cannot flip
   * halfway and start stealing the `#stage` horizontal pan that zoom mode
   * depends on.
   */
  function decideGestureAxis(dx, dy, threshold, current) {
    if (current === 'vertical' || current === 'horizontal') return current;
    var limit = typeof threshold === 'number' && threshold > 0 ? threshold : AXIS_THRESHOLD;
    var ax = Math.abs(dx);
    var ay = Math.abs(dy);
    if (!(ax >= limit || ay >= limit)) return '';
    // Ties go horizontal on purpose. Stealing the stage pan breaks an
    // affordance that works today; losing one ambiguous swipe costs a repeat.
    return ay > ax ? 'vertical' : 'horizontal';
  }

  /** True when the pane is showing a full-screen app, which has no scrollback. */
  function isAltScreen(term) {
    try {
      return !!(term && term.buffer && term.buffer.active && term.buffer.active.type === 'alternate');
    } catch (e) {
      // Misreading the buffer type falls back to the normal-buffer branch,
      // whose worst case is a scrollLines that moves nothing.
      return false;
    }
  }

  /**
   * The arrow-key byte sequence this terminal's app is currently listening for.
   *
   * `term.modes.applicationCursorKeysMode` is public xterm API (DECCKM,
   * `CSI ? 1 h`) and is what xterm consults for its own keyboard encoding —
   * reading it here is how a swipe agrees with the arrow key on the key bar.
   *
   * Read live rather than cached: an app can flip DECCKM at any moment, and a
   * pane changes what it is running without the handler being re-attached.
   * Falls back to CSI, which is the unmodified default and what a terminal
   * without the `modes` accessor would have wanted anyway.
   */
  function arrowKeyFor(term, up) {
    var application = false;
    try {
      application = !!(term && term.modes && term.modes.applicationCursorKeysMode);
    } catch (e) {
      application = false;
    }
    if (application) return up ? SS3_UP : SS3_DOWN;
    return up ? CSI_UP : CSI_DOWN;
  }

  /** True when the normal buffer actually has history above the viewport. */
  function hasScrollback(term) {
    try {
      return !!(term && term.buffer && term.buffer.active && term.buffer.active.baseY > 0);
    } catch (e) {
      return false;
    }
  }

  /**
   * Visual height of one cell, in the same coordinate space as `clientY`.
   *
   * getBoundingClientRect, NOT offsetHeight: `#scaler` carries a CSS transform
   * in fit mode, and the finger's delta arrives already scaled. offsetHeight
   * reports the untransformed layout height, so a fitted pane would scroll by
   * the wrong number of lines — visibly wrong at the 0.4 scale a 100-column
   * pane takes on a 390px screen.
   */
  function cellHeightOf(term) {
    var el = term && term.element;
    if (!el) return 0;
    var rows = term && typeof term.rows === 'number' && term.rows > 0 ? term.rows : 0;
    if (!rows) return 0;
    var h = 0;
    if (typeof el.getBoundingClientRect === 'function') {
      var r = el.getBoundingClientRect();
      if (r && typeof r.height === 'number') h = r.height;
    }
    if (!(h > 0)) h = el.offsetHeight || 0;
    return h > 0 ? h / rows : 0;
  }

  /**
   * Wire touch scrolling onto ONE terminal.
   *
   * Called from both terminal-creation sites in app.js (the 1-up terminal and
   * every split tile). A second copy of this wiring is exactly the drift a
   * source-invariant test exists to catch, so there is one function and the
   * test asserts both call sites name it.
   *
   * `opts`:
   *   allowInput()   → boolean, read live (the server can revoke input mid-session)
   *   sendKeys(seq)  → deliver raw bytes to THIS terminal's pane
   *   notify(t, sub) → show a transient notice
   *
   * Scrolling is a READ affordance, so it works with or without input
   * everywhere except one corner: the alt screen with input off, where there is
   * no scrollback to move and no permission to send the keys the app scrolls
   * with. That corner gets a one-shot notice instead of a silent no-op — a
   * silent no-op is indistinguishable from a hang, and is what produced #890 in
   * the first place. It does NOT offer to enable input: read-only is a posture
   * the operator chose on the server, and the UI must not nudge past it.
   */
  function attachTouchScroll(term, host, opts) {
    if (!term || !host || typeof host.addEventListener !== 'function') return;

    // A host outlives its terminal. The 1-up view disposes `term` on the way
    // into split view and calls this again with a fresh one on the way back,
    // reusing the same `#term` element — so a plain addEventListener here would
    // stack a second set of handlers after one round trip: two accumulators,
    // two scrollLines per swipe, and the older closure still poking a disposed
    // terminal. Rebind the existing wiring instead of adding more.
    if (typeof host[ATTACH_KEY] === 'function') { host[ATTACH_KEY](term, opts); return; }

    var current = term;
    var o = opts || {};

    var active = false;   // a single-finger gesture we might own is in progress
    var axis = '';
    var startX = 0;
    var startY = 0;
    var lastY = 0;
    var accum = 0;        // sub-cell pixels carried between touchmove events
    var noticed = false;  // the read-only alt-screen notice is one-shot

    function reset() {
      active = false;
      axis = '';
      accum = 0;
    }

    // A resize re-measures every cell, so pixels accumulated against the old
    // cell height no longer mean the same number of lines. Carrying them over
    // makes the next move jump by whatever the ratio changed. The disposable is
    // not held: a disposed terminal takes its own listeners with it.
    function watchResize() {
      if (current && typeof current.onResize === 'function') {
        current.onResize(function () { accum = 0; });
      }
    }
    watchResize();

    host[ATTACH_KEY] = function (nextTerm, nextOpts) {
      current = nextTerm;
      o = nextOpts || {};
      noticed = false;   // a new pane earns a fresh explanation
      reset();
      watchResize();
    };

    host.addEventListener('touchstart', function (e) {
      var touches = e.touches || [];
      // Two fingers are a pinch or a two-finger pan. Both belong to the browser
      // and to #stage; taking either would break zoom mode.
      if (touches.length !== 1) { reset(); return; }
      active = true;
      axis = '';
      accum = 0;
      startX = touches[0].clientX;
      startY = touches[0].clientY;
      lastY = startY;
      // Deliberately no preventDefault. A tap starts exactly like a swipe, and
      // the tap has to reach the `click` listener that focuses the terminal —
      // on iOS that is the only way the soft keyboard comes up.
    }, { passive: true });

    host.addEventListener('touchmove', function (e) {
      if (!active) return;
      // Someone closer to the target already claimed this gesture. Today
      // nothing does; the day xterm grows its own touch handling it will, and
      // this is what keeps that from scrolling the pane twice per swipe. We sit
      // on the host, so any handler xterm adds inside runs first.
      if (e.defaultPrevented) return;
      var touches = e.touches || [];
      if (touches.length !== 1) { reset(); return; }   // a second finger landed mid-gesture
      var t = touches[0];
      axis = decideGestureAxis(t.clientX - startX, t.clientY - startY, AXIS_THRESHOLD, axis);
      var dy = t.clientY - lastY;
      lastY = t.clientY;
      // Undecided or horizontal: never preventDefault, or the #stage pan that
      // zoom mode depends on dies. Pre-lock travel is discarded rather than
      // accumulated — it is the threshold distance, well under one cell.
      if (axis !== 'vertical') return;

      var alt = isAltScreen(current);
      if (alt && !(typeof o.allowInput === 'function' && o.allowInput())) {
        if (!noticed) {
          noticed = true;
          if (typeof o.notify === 'function') {
            o.notify(
              'Nothing to scroll here',
              'This pane is running a full-screen app, so it keeps no scrollback, and this device is read-only.'
            );
          }
        }
        return;   // nothing was handled — leave the page's own scrolling alone
      }
      // No history above the viewport: let #stage keep the gesture so a pane
      // taller than the screen can still be panned into view in zoom mode.
      if (!alt && !hasScrollback(current)) return;

      var step = touchDeltaToLines(accum, dy, cellHeightOf(current));
      accum = step.remainder;
      if (step.lines !== 0) {
        if (alt) {
          // The alt screen has no scrollback to move, so translate the swipe
          // into the arrow keys the TUI scrolls itself with — the same thing
          // xterm does with a wheel there, and what xterm.js#1007 asks for.
          // The encoding follows the pane's DECCKM state; see arrowKeyFor.
          var n = Math.min(Math.abs(step.lines), MAX_KEYS_PER_MOVE);
          var seq = arrowKeyFor(current, step.lines > 0);
          var out = '';
          for (var i = 0; i < n; i++) out += seq;
          if (typeof o.sendKeys === 'function') o.sendKeys(out);
        } else {
          // content follows the finger. Guarded because the 1-up terminal can
          // be disposed mid-gesture (a switch into split view), and a torn-down
          // xterm is not something a swipe can do anything about.
          try { current.scrollLines(-step.lines); } catch (e) { /* torn down mid-gesture */ }
        }
      }
      // Claim the gesture for the whole vertical lock, not only for the moves
      // that crossed a cell boundary: otherwise the sub-cell moves in between
      // leak to #stage and the pane slides under the finger. This is also the
      // guard against double-scrolling if a future xterm grows its own touch
      // handling.
      if (e.cancelable !== false && typeof e.preventDefault === 'function') e.preventDefault();
    }, { passive: false });

    host.addEventListener('touchend', reset, { passive: true });
    host.addEventListener('touchcancel', reset, { passive: true });
  }

  root.wmuxTouchScroll = {
    touchDeltaToLines: touchDeltaToLines,
    decideGestureAxis: decideGestureAxis,
    attachTouchScroll: attachTouchScroll,
    AXIS_THRESHOLD: AXIS_THRESHOLD,
    MAX_KEYS_PER_MOVE: MAX_KEYS_PER_MOVE
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
