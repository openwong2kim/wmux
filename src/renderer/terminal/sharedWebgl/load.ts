// Lazy loader for the shared-context WebGL fork (terminal/sharedWebgl/addon).
//
// The fork is only used while the experimental terminalSharedWebgl flag is on,
// so it lives in its own chunk and is fetched when the flag is first seen on
// (useTerminal starts it). Until the chunk has loaded, a pane builds the stock
// addon exactly as with the flag off, and keeps it: nothing swaps a pane's
// renderer once the fork arrives.

import type { WebglAddon as SharedContextWebglAddon } from './addon/WebglAddon';

export type SharedContextWebglAddonClass = typeof SharedContextWebglAddon;

let addonClass: SharedContextWebglAddonClass | null = null;
let pending: Promise<SharedContextWebglAddonClass | null> | null = null;

/**
 * Start loading the fork, once. Resolves to its addon class, or null when the
 * chunk failed to load; a failed load is retried on the next call.
 */
export function preloadSharedWebgl(): Promise<SharedContextWebglAddonClass | null> {
  pending ??= import('./addon/WebglAddon').then(
    (m) => (addonClass = m.WebglAddon),
    (err: unknown) => {
      console.warn('[wmux:shared-webgl] could not load the shared-context renderer', err);
      pending = null;
      return null;
    },
  );
  return pending;
}

/** The fork's addon class once loaded; null before, and the caller uses the
 *  stock addon. */
export function loadedSharedWebglAddon(): SharedContextWebglAddonClass | null {
  return addonClass;
}
