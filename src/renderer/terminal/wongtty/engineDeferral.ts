// When a pane takes a new terminal engine (Labs wongtty switch): not in the
// middle of an IME composition (rebuilding the terminal would drop the
// composed text) or a mouse drag on a terminal (a drag over a disposed
// terminal is the #582 race, see useTerminal's disposeWhenDragEnds). Waiting
// is capped, so a stuck composition or a release nobody saw cannot keep a
// pane on the old engine for good.

/** Longest a pane waits for a composition or a drag to end. */
export const ENGINE_DEFER_CAP_MS = 3000;

export interface EngineDeferralDeps {
  isComposing(): boolean;
  isDragging(): boolean;
  /** Calls `retry` when a blocker may have cleared (compositionend, mouseup);
   *  returns the unsubscribe. */
  subscribeUnblock(retry: () => void): () => void;
  apply(): void;
  capMs?: number;
}

export interface EngineDeferral {
  /** Apply now, or once nothing blocks it (or the cap runs out). */
  request(): void;
  cancel(): void;
}

export function createEngineDeferral(deps: EngineDeferralDeps): EngineDeferral {
  let waiting: { unsubscribe: () => void; cap: ReturnType<typeof setTimeout> } | null = null;
  const stop = () => {
    if (!waiting) return;
    waiting.unsubscribe();
    clearTimeout(waiting.cap);
    waiting = null;
  };
  const tryApply = (force: boolean) => {
    if (!force && (deps.isComposing() || deps.isDragging())) return false;
    stop();
    deps.apply();
    return true;
  };
  return {
    request() {
      if (waiting) return;
      if (tryApply(false)) return;
      waiting = {
        unsubscribe: deps.subscribeUnblock(() => { tryApply(false); }),
        cap: setTimeout(() => {
          console.warn('[wmux:engine-swap] composition or drag still active after the wait cap; swapping anyway');
          tryApply(true);
        }, deps.capMs ?? ENGINE_DEFER_CAP_MS),
      };
    },
    cancel: stop,
  };
}
