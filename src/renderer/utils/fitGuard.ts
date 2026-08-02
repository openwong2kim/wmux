/**
 * Guard helpers for xterm `FitAddon.fit()` calls.
 *
 * Background:
 * xterm's `SelectionService` clears the active selection on every
 * `rowsChanged` event emitted by `Terminal.resize()`. ResizeObserver and the
 * font/theme effect both call `fitAddon.fit()` which can change rows, so
 * mid-drag the selection vanishes — manifesting as "only the last paragraph
 * is copied" because mousemove restarts the selection from the cursor's
 * current position.
 *
 * Skipping `fit()` while the user has an active selection prevents the clear.
 *
 * A skipped fit is a DEFERRED fit, and the caller owns settling it. This
 * docstring used to promise that "the next ResizeObserver tick (after the user
 * releases)" would, but releasing a selection is not a size change and fires no
 * tick — so a resize that landed mid-selection was simply lost, leaving xterm
 * and the daemon PTY pinned to the old cols/rows (#747). useTerminal records the
 * debt in `pendingFitRef` and re-runs the fit from its onSelectionChange
 * handler; any new caller of this guard must do the same.
 */

/**
 * @returns true if `fit()` should run, false if it should be skipped because
 * the terminal currently has an active selection that we want to preserve.
 */
export function shouldFitWhilePreservingSelection(
  term: { hasSelection(): boolean } | null | undefined,
): boolean {
  if (!term) return true; // nothing to preserve, defer to caller's other guards
  return !term.hasSelection();
}

/**
 * Ask for permission to fit, recording the debt if the answer is no.
 *
 * Prefer this over calling the guard directly. Deferring and remembering are one
 * decision — a site that checks the guard but forgets to set the flag silently
 * drops the resize, which is exactly the shape of #747. Bundling them means a
 * new call site cannot get it half-right.
 *
 * @returns true when the caller should fit now; false when it must skip, in
 * which case `pending.current` is set and the retry path owns settling it.
 */
export function claimFit(
  term: { hasSelection(): boolean } | null | undefined,
  pending: { current: boolean },
): boolean {
  if (shouldFitWhilePreservingSelection(term)) return true;
  pending.current = true;
  return false;
}
