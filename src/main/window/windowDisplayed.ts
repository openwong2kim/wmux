// Is anyone actually looking at the desktop window? (#882)
//
// #766 made PTY geometry ownership visibility-based: while a desk renderer
// reports a pane on screen, a phone resize gets `409 desk-owns-size`; while it
// reports the pane hidden, the phone's numbers are applied. The renderer built
// the window half of that report out of `document.visibilityState`.
//
// On Windows that value is a constant. Measured on Electron 41: it stays
// 'visible' while the window is fully covered by another app AND while the
// window is minimized; `visibilitychange` fires once per window, at teardown;
// disabling Chromium's `CalculateNativeWinOcclusion` changes nothing. So the
// window term contributed nothing there, and minimising wmux never handed the
// size to the phone — the handoff #766 exists for simply did not happen.
//
// Main is the only side that can see the window, so main owns the signal:
//
//   'minimize' / 'restore' / 'hide' / 'show'   window state
//   'lock-screen' / 'suspend'                  user is gone, window or not
//   'unlock-screen' / 'resume'                 re-read, never assume
//                     │
//                     ▼   dedup, then push
//        IPC.WINDOW_DISPLAYED_CHANGED ──► renderer (+ IPC.WINDOW_IS_DISPLAYED
//                                          pull at mount, so a renderer that
//                                          loads while hidden — start-to-tray,
//                                          or a reload after a crash — starts
//                                          from the truth rather than from the
//                                          optimistic default)
//
// BLUR IS DELIBERATELY NOT PART OF THIS. A blurred window is still on screen:
// someone typing in another app with wmux open beside it is looking at that
// layout, and letting the phone reshape the PTY there is exactly the geometry
// fight #766's own comment set out to prevent. Worse on Windows, where there is
// no reveal event either, so the desk would not re-fit and the pane would sit
// at the phone's geometry until some unrelated layout pass. Minimize, hide to
// tray and lock screen are different in kind: nobody can see the layout at all.
//
// Occlusion — covered by another window but not minimized — stays unhandled,
// because Chromium on Windows will not tell us. Known hole, not an oversight.
//
// The lock-screen half mirrors desktopPresence.ts, which learned the same
// lesson for notification presence: locking the screen does NOT blur or hide
// the window, so a window-events-only reporter would keep claiming the desk is
// in use while the user is away from the machine — the moment the phone is the
// only channel left.

import { IPC } from '../../shared/constants';

/** The slice of `BrowserWindow` this touches, so a test can pass a stub. */
export interface DisplayableWindow {
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  on(event: 'minimize' | 'restore' | 'hide' | 'show', listener: () => void): unknown;
  webContents: {
    isDestroyed(): boolean;
    send(channel: string, payload: unknown): void;
  };
}

/** The slice of `powerMonitor` this touches. */
export interface DisplayedPowerMonitor {
  on(
    event: 'lock-screen' | 'unlock-screen' | 'suspend' | 'resume',
    listener: () => void,
  ): unknown;
}

/**
 * Is the window itself on screen right now?
 *
 * Destruction is checked FIRST: `isVisible()`/`isMinimized()` on a destroyed
 * window throw, and every caller wants "no" rather than an exception.
 *
 * This is the predicate `shouldPollMetadata` was already using inline; it now
 * calls this so the two definitions of "displayed" cannot drift apart. Note
 * `shouldPollMetadata` adds its own `webContents.isLoading()` term — a loading
 * renderer is a reason not to poll it for cosmetics, but not a reason to tell
 * the daemon nobody can see the window.
 */
export function isWindowDisplayed(win: DisplayableWindow): boolean {
  if (win.isDestroyed()) return false;
  return win.isVisible() && !win.isMinimized();
}

export interface WindowDisplayedReporter {
  /** Wire the window and power events; returns the teardown. */
  attach(win: DisplayableWindow, opts?: { powerMonitor?: DisplayedPowerMonitor }): () => void;
  /**
   * The value the pull handler answers with. True when nothing is attached:
   * the same optimistic default the daemon holds (`viewerVisible: true`), so a
   * build without this wiring behaves exactly as it did before.
   */
  current(): boolean;
}

export function createWindowDisplayedReporter(channel: string): WindowDisplayedReporter {
  let attached: DisplayableWindow | null = null;
  // Screen locked / machine suspended. Tracked separately from window state
  // because it does not change window state at all — that is the whole reason
  // this term exists.
  let userAway = false;
  // Last value actually pushed, so an event that does not change the answer
  // (a `show` on an already-shown window, `resume` right after `unlock-screen`)
  // does not wake every pane's report effect for nothing.
  let lastSent: boolean | null = null;

  const current = (): boolean => {
    if (!attached) return true;
    if (userAway) return false;
    return isWindowDisplayed(attached);
  };

  const push = (): void => {
    const win = attached;
    if (!win) return;
    const value = current();
    if (value === lastSent) return;
    lastSent = value;
    // Both guards: a BrowserWindow can outlive its webContents (mid-navigation,
    // renderer crash), and send() on a dead webContents throws.
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send(channel, { displayed: value });
  };

  return {
    current,
    attach(win, opts = {}) {
      attached = win;
      userAway = false;
      // Seed from the window's own state rather than from "nothing sent yet".
      // The renderer PULLS its initial value, so a push that merely restates
      // what the window already was is not information — it is a wake-up for
      // every pane's report effect. Any real change still pushes.
      lastSent = current();
      for (const event of ['minimize', 'restore', 'hide', 'show'] as const) {
        win.on(event, push);
      }
      const power = opts.powerMonitor;
      if (power) {
        for (const event of ['lock-screen', 'suspend'] as const) {
          power.on(event, () => { userAway = true; push(); });
        }
        // Back at the machine: re-read the window rather than assuming it came
        // back to the foreground. It may still be minimized.
        for (const event of ['unlock-screen', 'resume'] as const) {
          power.on(event, () => { userAway = false; push(); });
        }
      }
      return () => {
        // Electron has no removeListener slice worth stubbing here, and the
        // window's listeners die with the window. Dropping the reference is
        // what matters: `current()` must go back to the safe default so a pull
        // arriving during teardown does not read a dead window.
        attached = null;
        lastSent = null;
        userAway = false;
      };
    },
  };
}

/** App-wide singleton: `createWindow` attaches the window, the
 *  `WINDOW_IS_DISPLAYED` handler answers pulls from it. */
export const windowDisplayedReporter = createWindowDisplayedReporter(
  IPC.WINDOW_DISPLAYED_CHANGED,
);
