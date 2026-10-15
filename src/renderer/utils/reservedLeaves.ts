// ─── Empty leaves another spawn is about to fill ───────────────────────────
//
// fanout.spawnWorkspace adds a workspace (its one leaf empty, and active)
// and only then awaits its worker's pty.create. Meanwhile EmptyLeafFunnel
// sees that empty leaf and starts a plain shell in it. Its orphan guard
// usually disposes that shell, but with WSL as the default shell both
// creates take the slow WSL probe and the shell could land first, leaving a
// stray home-folder pane beside the worker (#2231 Windows run 4). A leaf the
// spawn reserves is skipped by the funnel until the spawn releases it.

import { useSyncExternalStore } from 'react';

const reserved = new Set<string>();
let version = 0;
const listeners = new Set<() => void>();

/** Reserve an empty leaf for a spawn already on its way; returns the release.
 *  A release is observable (useReservedLeavesVersion): a leaf a failed spawn
 *  could not roll back (the last workspace) gets its shell then. */
export function reserveLeaf(paneId: string): () => void {
  reserved.add(paneId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    reserved.delete(paneId);
    version += 1;
    for (const fn of listeners) fn();
  };
}

/** Changes on every release, for the funnel's effect to run again. */
export function useReservedLeavesVersion(): number {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => version,
  );
}

/** Whether a spawn has reserved this leaf. */
export function isLeafReserved(paneId: string): boolean {
  return reserved.has(paneId);
}
