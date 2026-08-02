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
