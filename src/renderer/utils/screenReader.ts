// ─── Whether a screen reader is on, mirrored from main ──────────────────────
//
// Main decides (main/screenReader.ts: Chromium's accessibility support and a
// running screen-reader process). This module asks once at start and then
// follows main's change events. What behaves differently for screen-reader
// users reads it here: xterm's screen-reader mode, the agents' launch flags
// and the agent-state announcer. Off until main says otherwise.

import { useSyncExternalStore } from 'react';

let on = false;
const listeners = new Set<() => void>();

/** Whether a screen reader is on now. */
export function screenReaderOn(): boolean {
  return on;
}

/** Sets the state; subscribers hear a change. */
export function setScreenReaderOn(next: boolean): void {
  if (next === on) return;
  on = next;
  for (const fn of [...listeners]) fn();
}

/** Calls `fn` on every change. Returns the unsubscribe. */
export function subscribeScreenReader(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** The state, re-rendering on a change. */
export function useScreenReaderOn(): boolean {
  return useSyncExternalStore(subscribeScreenReader, screenReaderOn, () => false);
}

interface ScreenReaderApi {
  getScreenReader?: () => Promise<boolean>;
  onScreenReaderChanged?: (callback: (on: boolean) => void) => () => void;
}

/** Asks main now and follows its changes. A change that arrives before the
 *  answer wins over it. Returns the uninstall. */
export function installScreenReader(api: ScreenReaderApi | undefined = window.electronAPI?.system): () => void {
  let disposed = false;
  let changed = false;
  const off = api?.onScreenReaderChanged?.((next) => {
    if (disposed) return;
    changed = true;
    setScreenReaderOn(next);
  });
  void Promise.resolve(api?.getScreenReader?.())
    .then((next) => { if (!disposed && !changed && typeof next === 'boolean') setScreenReaderOn(next); })
    .catch(() => undefined);
  return () => {
    disposed = true;
    off?.();
  };
}
