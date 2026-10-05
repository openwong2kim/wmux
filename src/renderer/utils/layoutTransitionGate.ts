/**
 * Layout-transition fit gate.
 *
 * An animated chrome change (the sidebar collapse/expand) resizes every pane
 * container on every frame. Fitting xterm and resizing the PTY per frame makes
 * terminals reflow mid-animation and floods the daemon with SIGWINCH. DESIGN.md:
 * "a sidebar collapse … refit the terminals once, never per frame."
 *
 * While a hold is active, container-resize ticks only record a debt. Releasing
 * the hold (transitionend, or the fallback timer when transitionend never
 * arrives — hidden window, zero duration, a cancelled transition) settles each
 * debt with exactly one fit.
 */

type Listener = () => void;

let held = false;
let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<Listener>();

/**
 * Start holding fits, or extend a hold already running (a re-toggle mid
 * animation resets the fallback rather than stacking a second hold).
 */
export function holdFits(fallbackMs: number): void {
  held = true;
  if (fallbackTimer !== null) clearTimeout(fallbackTimer);
  fallbackTimer = setTimeout(releaseFits, fallbackMs);
}

/** End the hold and notify every listener once. Idempotent. */
export function releaseFits(): void {
  if (fallbackTimer !== null) {
    clearTimeout(fallbackTimer);
    fallbackTimer = null;
  }
  if (!held) return;
  held = false;
  for (const cb of [...listeners]) {
    try {
      cb();
    } catch {
      // one listener must not starve the others of their fit
    }
  }
}

export function fitsHeld(): boolean {
  return held;
}

export function onFitsReleased(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export interface FitScheduler {
  /** Call from the container's ResizeObserver. */
  onResize(): void;
  dispose(): void;
}

/**
 * The container-resize scheduling of one terminal: debounce ResizeObserver
 * ticks, then hand off to `fitNextFrame` — unless a layout transition holds
 * fits, in which case the tick becomes a debt settled once on release.
 */
export function createFitScheduler(opts: {
  /** Queue the fit on the next frame (the caller owns the rAF handle). */
  fitNextFrame: () => void;
  debounceMs: number;
}): FitScheduler {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let debt = false;

  const unsubscribe = onFitsReleased(() => {
    if (!debt) return;
    debt = false;
    opts.fitNextFrame();
  });

  return {
    onResize() {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = null;
      if (fitsHeld()) {
        // A tick armed just before the hold must not fire mid-animation either.
        debt = true;
        return;
      }
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        // A hold that began inside the debounce window owns this fit now.
        if (fitsHeld()) {
          debt = true;
          return;
        }
        opts.fitNextFrame();
      }, opts.debounceMs);
    },
    dispose() {
      unsubscribe();
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = null;
    },
  };
}
