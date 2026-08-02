/**
 * Debounces terminal resize fits and retries a fit that was blocked by an
 * active selection once that selection clears.
 *
 * xterm clears selections when a fit changes the row count. ResizeObserver
 * does not fire merely because a selection was released, so the scheduler
 * keeps an explicit deferred bit instead of waiting for another resize.
 */

export type DeferredTerminalFitOutcome = 'fitted' | 'deferred' | 'skipped';

export interface DeferredTerminalFitDeps {
  /** Attempt the fit and report whether it ran, was deferred, or was skipped. */
  attemptFit: () => DeferredTerminalFitOutcome;
  /** Whether the terminal currently has an active selection. */
  hasSelection: () => boolean;
  /** Debounce window in milliseconds. Defaults to 100. */
  debounceMs?: number;
  /** Test seams for the timer and animation-frame queues. */
  setTimeoutFn?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
  requestAnimationFrameFn?: (fn: () => void) => number;
  cancelAnimationFrameFn?: (handle: number) => void;
}

export interface DeferredTerminalFitHandle {
  /** Debounce and queue a fit attempt. */
  requestFit: () => void;
  /** Record a fit skipped by a caller outside the normal resize path. */
  deferUntilSelectionClears: () => void;
  /** Retry a deferred fit when the terminal reports that selection changed. */
  onSelectionChange: () => void;
  /** Cancel queued work during terminal teardown. */
  dispose: () => void;
}

const DEFAULT_DEBOUNCE_MS = 100;

export function createDeferredTerminalFit(
  deps: DeferredTerminalFitDeps,
): DeferredTerminalFitHandle {
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const setT = deps.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
  const clearT = deps.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
  const requestFrame = deps.requestAnimationFrameFn
    ?? ((fn) => requestAnimationFrame(fn));
  const cancelFrame = deps.cancelAnimationFrameFn
    ?? ((handle) => cancelAnimationFrame(handle));

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let animationFrame: number | null = null;
  let waitingForSelectionRelease = false;

  const requestFit = (): void => {
    if (animationFrame !== null) {
      cancelFrame(animationFrame);
      animationFrame = null;
    }
    if (debounceTimer !== null) clearT(debounceTimer);
    debounceTimer = setT(() => {
      debounceTimer = null;
      animationFrame = requestFrame(() => {
        animationFrame = null;
        waitingForSelectionRelease = deps.attemptFit() === 'deferred';
      });
    }, debounceMs);
  };

  const deferUntilSelectionClears = (): void => {
    waitingForSelectionRelease = true;
  };

  const onSelectionChange = (): void => {
    if (!waitingForSelectionRelease || deps.hasSelection()) return;
    waitingForSelectionRelease = false;
    requestFit();
  };

  const dispose = (): void => {
    waitingForSelectionRelease = false;
    if (debounceTimer !== null) {
      clearT(debounceTimer);
      debounceTimer = null;
    }
    if (animationFrame !== null) {
      cancelFrame(animationFrame);
      animationFrame = null;
    }
  };

  return {
    requestFit,
    deferUntilSelectionClears,
    onSelectionChange,
    dispose,
  };
}
