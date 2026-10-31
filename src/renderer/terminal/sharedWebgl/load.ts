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
 * chunk failed to load; a failed load is retried on the next call (useTerminal
 * calls again only when the flag is switched on again).
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

/** Whether `addon` is the fork in shared-context mode. */
export function isSharedContextAddon(addon: unknown): boolean {
  return (addon as { usesSharedContext?: unknown } | null | undefined)?.usesSharedContext === true;
}

/**
 * The class to build a pane's WebGL addon with, or null for the stock addon.
 * A first build follows the flag, once the chunk has loaded. A rebuild that
 * `replaces` an addon keeps that addon's kind whatever the flag says now: the
 * pool decided the pane's budget when it granted it, and a pane's renderer is
 * never swapped for the other kind.
 */
export function sharedWebglAddonClassFor(flagOn: boolean, replaces?: unknown): SharedContextWebglAddonClass | null {
  const shared = replaces === undefined ? flagOn : isSharedContextAddon(replaces);
  return shared ? addonClass : null;
}
