import { useCallback, useRef } from 'react';

/** How long after an approval appears its buttons ignore activation. */
export const APPROVAL_ACTIVATION_DELAY_MS = 500;

/**
 * Wraps an approval's button handlers so an activation landing within
 * `delayMs` of the prompt appearing is ignored: a click (or key press) that
 * was already on its way when the prompt arrived must not answer it. The
 * clock restarts whenever `requestId` changes, so each queued prompt gets its
 * own window.
 */
export function useActivationGuard(requestId: string, delayMs = APPROVAL_ACTIVATION_DELAY_MS) {
  const shown = useRef<{ id: string; at: number } | null>(null);
  if (shown.current?.id !== requestId) shown.current = { id: requestId, at: Date.now() };
  return useCallback(
    (fn: () => void) => () => {
      if (!shown.current || Date.now() - shown.current.at < delayMs) return;
      fn();
    },
    [delayMs],
  );
}
