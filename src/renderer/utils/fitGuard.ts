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
 * Skipping `fit()` while the user has an active selection prevents the
 * clear. Callers must explicitly retry the fit when the selection clears;
 * selection release by itself does not trigger ResizeObserver.
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
