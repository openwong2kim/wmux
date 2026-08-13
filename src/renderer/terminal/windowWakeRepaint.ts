// Repaint every visible pane when the wmux window is re-activated (#879).
//
// --- Why this exists (measured, Electron 41 on Windows) --------------------
//
// Every other visibility-driven recovery in the renderer keys off
// `document.visibilityState`. On Windows that value is a constant:
//
//   | window state                        | visibilityState | rAF   |
//   |-------------------------------------|-----------------|-------|
//   | foreground                          | visible         | 60/s  |
//   | fully covered by another app        | visible         | 60/s  |
//   | MINIMIZED                           | visible         | 60/s  |
//
// Measured with a bare Electron 41.0.3 probe, and identical with Chromium's
// `CalculateNativeWinOcclusion` feature explicitly disabled, so it is not a
// tunable. `visibilitychange` fires exactly once per window: at teardown.
//
// Consequences: `atlasWakeRecovery`'s `visibility` trigger can never fire on
// Windows (only `system-resumed` can), and neither can useTerminal's
// `docRevealed` reclaim. The one repaint that DOES fire on alt-tab is the
// focused pane's textarea `focus` handler — element-level focus/blur do
// re-fire on every window focus transition — and that covers exactly one pane.
//
// #879: a pane comes back from alt-tab with its canvas unpainted. The xterm
// buffer is intact (the reporter's own forced redraw brings the text back
// correct), so this is lost pixels with nothing to repaint them. Measured:
// with the drawing buffer wiped behind xterm's back, an idle pane NEVER
// self-heals — xterm only redraws rows it believes are dirty — and a single
// `terminal.refresh(0, rows - 1)` fully restores it.
//
// Honest scope: the wmux-side gap (no trigger) is proven. The GPU-side reason
// the pixels go missing is NOT — it does not reproduce on every machine, and
// the reporter has other rendering complaints on the same box. This module
// closes the gap; it does not claim to explain the driver.
//
// --- Shape -----------------------------------------------------------------
//
// ONE listener pair for the whole app (the `atlasGuard` + `AppLayout` pattern),
// not one per pane: window focus is a global event, and N panes each owning a
// listener, a frame request and a timer is N times the bookkeeping for one
// event.
//
//   window blur ──► cancel pending passes, arm "we were away"
//   window focus ─► (only if we were away)
//                     ├─ pass 1: next animation frame
//                     └─ pass 2: +WAKE_SECOND_PASS_MS
//                          each pass: for every registered pane that is
//                          still visible → its full-range refresh
//
// Two passes because the loss can land on either side of re-activation. Pass 1
// covers pixels lost while the window was away. Pass 2 is an explicit hedge
// against a surface that Chromium re-establishes just AFTER activation, which
// is the part that is not proven — if the reporter confirms pass 1 alone is
// enough, delete pass 2. Cost of being wrong: one extra full-range refresh per
// visible pane per alt-tab.
//
// This never clears the shared glyph atlas. Wiping it on plain refocus re-arms
// xterm's page-merge race (#191) — the same reason atlasWakeRecovery excludes
// focus from its own triggers.

/** Delay of the second repaint pass after the window regains focus. */
export const WAKE_SECOND_PASS_MS = 250;

/** `setTimeout` is typed as returning a number in the DOM lib and a `Timeout`
 *  under @types/node; the renderer sees both. Keep the handle opaque so tests
 *  can hand back their own. */
export type TimerHandle = ReturnType<typeof setTimeout> | number;

/** One registered pane. */
export interface WakeRepaintEntry {
  /** False for a pane in a hidden workspace/tab — it repaints via
   *  glyphRepaint's `visible` reason when it is shown again, so waking it here
   *  would be a full-range refresh nobody can see. */
  isVisible(): boolean;
  /** Full-range repaint for this pane. */
  repaint(): void;
}

export interface WindowWakeRepaintDeps {
  /** Windows-only by default: macOS and Linux do flip `visibilityState`, so
   *  atlasWakeRecovery already covers their wake boundaries. When false, no
   *  listeners are attached and registered panes are never woken. */
  enabled: boolean;
  windowRef?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  /** Read at init: a pane can mount while the app is already in the
   *  background, and it never saw the blur that put it there. */
  hasFocus?: () => boolean;
  requestFrame?: (cb: () => void) => number;
  cancelFrame?: (handle: number) => void;
  setTimeoutFn?: (cb: () => void, ms: number) => TimerHandle;
  clearTimeoutFn?: (handle: TimerHandle) => void;
  log?: (message: string) => void;
}

export interface WindowWakeRepaint {
  /** Register a pane; returns its unregister function. */
  register(entry: WakeRepaintEntry): () => void;
  /** Wire the window listeners. Called once from App; returns the teardown. */
  init(deps: WindowWakeRepaintDeps): () => void;
}

export function createWindowWakeRepaint(): WindowWakeRepaint {
  const entries = new Set<WakeRepaintEntry>();

  let frameHandle: number | null = null;
  let timerHandle: TimerHandle | null = null;

  return {
    register(entry: WakeRepaintEntry): () => void {
      entries.add(entry);
      return () => { entries.delete(entry); };
    },

    init(deps: WindowWakeRepaintDeps): () => void {
      const {
        enabled,
        windowRef = window,
        hasFocus = () => document.hasFocus(),
        requestFrame = (cb) => requestAnimationFrame(cb),
        cancelFrame = (h) => cancelAnimationFrame(h),
        setTimeoutFn = (cb, ms) => setTimeout(cb, ms),
        clearTimeoutFn = (h) => clearTimeout(h as Parameters<typeof clearTimeout>[0]),
        log = (m) => console.warn(m),
      } = deps;

      if (!enabled) return () => { /* nothing attached */ };

      // Seed from the real focus state rather than from "we have seen a blur".
      // A terminal that mounts while the app sits in the background missed that
      // blur entirely, and would otherwise sit out its first wake — the exact
      // case a user hits when wmux restores a session and then they go do
      // something else before coming back.
      let wasAway = !hasFocus();

      const cancel = (): void => {
        if (frameHandle !== null) { cancelFrame(frameHandle); frameHandle = null; }
        if (timerHandle !== null) { clearTimeoutFn(timerHandle); timerHandle = null; }
      };
      const repaintVisible = (pass: number): void => {
        // Re-check focus at execution time, not only at scheduling time: a pass
        // armed by one focus can still be in flight when the user tabs away
        // again, and repainting a window nobody is looking at is the GPU work
        // this module is otherwise careful to avoid.
        if (!hasFocus()) return;
        let woken = 0;
        for (const entry of entries) {
          if (!entry.isVisible()) continue;
          woken++;
          try {
            entry.repaint();
          } catch {
            // pane may be disposing — the other panes still get their repaint
          }
        }
        if (woken > 0) {
          // warn, not debug: console.debug maps to Verbose, which Chromium
          // drops with DevTools closed, so a reporter could never tell "the
          // repaint fired and did not help" from "it never fired". warn is
          // mirrored into the main-side log they can attach to an issue.
          log(`[wmux:window-wake] repainted ${woken} visible pane(s) after window refocus (pass ${pass})`);
        }
      };

      const onBlur = (): void => {
        wasAway = true;
        // Drop any pass still queued from a previous focus so focus churn
        // cannot stack passes on top of each other.
        cancel();
      };

      const onFocus = (): void => {
        if (!wasAway) return; // in-app focus moves never reach here
        wasAway = false;
        cancel();
        frameHandle = requestFrame(() => {
          frameHandle = null;
          repaintVisible(1);
        });
        timerHandle = setTimeoutFn(() => {
          timerHandle = null;
          repaintVisible(2);
        }, WAKE_SECOND_PASS_MS);
      };

      windowRef.addEventListener('blur', onBlur);
      windowRef.addEventListener('focus', onFocus);

      return () => {
        windowRef.removeEventListener('blur', onBlur);
        windowRef.removeEventListener('focus', onFocus);
        cancel();
      };
    },
  };
}

/** App-wide singleton — panes register in useTerminal's main effect, and
 *  AppLayout calls `init` once. */
export const windowWakeRepaint = createWindowWakeRepaint();
