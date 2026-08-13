// What the desk tells the daemon about who can see a pane (#766, fixed #882).
//
// The daemon hands PTY geometry ownership to the phone exactly when the desk
// says nobody is looking (`WebTerminalServer` → `409 desk-owns-size` otherwise).
// Getting that bit wrong is invisible until someone picks the session up on
// their phone and it will not resize, so the decision lives here as a pure
// function rather than inline in a hook nothing can test.
//
// Three inputs, two of them about the window:
//
//   paneVisible      this pane's workspace is shown and its tab is active
//   docVisible       document.visibilityState — real on macOS/Linux, a
//                    constant `true` on Windows (measured, #882)
//   windowDisplayed  main's answer: not minimized, not hidden to tray, screen
//                    not locked. The term that makes this work on Windows.
//
// Both window terms are ANDed, not swapped: `docVisible` still catches occlusion
// on the platforms that report it, and `windowDisplayed` catches the states no
// platform reports through the DOM.
//
// The refit half is the other half of the bug. When the desk stops claiming the
// size, a phone may reshape the PTY; when the desk comes back it has to take the
// geometry back, and a restored window fires no ResizeObserver tick because the
// container never changed size. So a WINDOW-level reveal has to refit
// explicitly. It is keyed on the window terms only — a workspace/tab reveal
// already refits through useTerminal's visibility effect, and keying it on the
// combined value would fit twice on every workspace switch.

export interface ViewerVisibilityInput {
  /** This pane's workspace is shown and its tab is active. */
  paneVisible: boolean;
  /** `document.visibilityState === 'visible'`. */
  docVisible: boolean;
  /** Main's window-displayed bit (#882). */
  windowDisplayed: boolean;
  /** The `windowVisible` of the previous evaluation, for reveal detection. */
  prevWindowVisible: boolean;
}

export interface ViewerVisibilityDecision {
  /** Both window terms — "the window itself can be seen". */
  windowVisible: boolean;
  /** What to report to the daemon for this pane. */
  viewerVisible: boolean;
  /** The window came back and this pane is on screen: retake the geometry. */
  refit: boolean;
}

export function decideViewerVisibility(input: ViewerVisibilityInput): ViewerVisibilityDecision {
  const windowVisible = input.docVisible && input.windowDisplayed;
  return {
    windowVisible,
    viewerVisible: input.paneVisible && windowVisible,
    refit: windowVisible && !input.prevWindowVisible && input.paneVisible,
  };
}
