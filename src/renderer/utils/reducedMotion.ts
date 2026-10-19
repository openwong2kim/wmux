// ─── Reduced motion: the media query, or Windows' setting from main ─────────
//
// On Windows the renderer's `prefers-reduced-motion` misses the system's
// "Animation effects" off (main/reducedMotion.ts). Main reads that setting;
// this module asks for it at start and whenever the window regains focus
// (Windows sends no event when it changes) and mirrors it as
// `data-reduced-motion` on the root element. Each CSS reduced-motion rule has
// a `:root[data-reduced-motion]` twin next to its media query, and script
// reads prefersReducedMotion(), which honours both.

export const REDUCED_MOTION_ATTR = 'data-reduced-motion';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

const listeners = new Set<() => void>();

/** Whether motion should be reduced: the media query or the root attribute. */
export function prefersReducedMotion(): boolean {
  try {
    if (typeof document !== 'undefined' && document.documentElement.hasAttribute(REDUCED_MOTION_ATTR)) return true;
    return typeof window !== 'undefined' && !!window.matchMedia?.(REDUCED_MOTION_QUERY).matches;
  } catch {
    return false;
  }
}

/** Set or clear the root attribute from the system's answer; subscribers hear
 *  a change. */
export function setSystemReducedMotion(on: boolean): void {
  const root = document.documentElement;
  if (root.hasAttribute(REDUCED_MOTION_ATTR) === on) return;
  if (on) root.setAttribute(REDUCED_MOTION_ATTR, 'true');
  else root.removeAttribute(REDUCED_MOTION_ATTR);
  for (const fn of [...listeners]) fn();
}

/** Calls `fn` when either source changes. Returns the unsubscribe. */
export function subscribeReducedMotion(fn: () => void): () => void {
  listeners.add(fn);
  let mql: MediaQueryList | undefined;
  try {
    mql = typeof window !== 'undefined' ? window.matchMedia?.(REDUCED_MOTION_QUERY) : undefined;
  } catch {
    mql = undefined;
  }
  mql?.addEventListener?.('change', fn);
  return () => {
    listeners.delete(fn);
    mql?.removeEventListener?.('change', fn);
  };
}

/** Windows only: ask main now and on every focus. Returns the uninstall. */
export function installSystemReducedMotion(
  platform: string | undefined = window.electronAPI?.platform,
  read: () => Promise<boolean> | undefined = () => window.electronAPI?.system?.getReducedMotion?.(),
): () => void {
  if (platform !== 'win32') return () => undefined;
  let disposed = false;
  const sync = () => {
    void Promise.resolve(read())
      .then((on) => { if (!disposed) setSystemReducedMotion(on === true); })
      .catch(() => undefined);
  };
  sync();
  window.addEventListener('focus', sync);
  return () => {
    disposed = true;
    window.removeEventListener('focus', sync);
  };
}

// ─── A hidden window: no motion at all ──────────────────────────────────────
//
// A hidden document (minimized, fully covered, or the display asleep) draws
// no frames. Blink drops a removed element's CSS animations from the document
// timeline only when it services a frame, so while the window is hidden every
// animated element React removes stays in memory with its whole detached
// tree: each Bots page left behind kept ~600 nodes until the window was shown
// again. Pausing is not enough (a paused animation stays on the timeline), so
// CSS stops the looping avatar motion outright under this attribute and no
// animation is created for a page drawn while hidden.

export const DOCUMENT_HIDDEN_ATTR = 'data-document-hidden';

/** Mirror `document.visibilityState` as the root attribute. Returns the uninstall. */
export function installDocumentHiddenMotion(): () => void {
  const sync = () => {
    document.documentElement.toggleAttribute(DOCUMENT_HIDDEN_ATTR, document.visibilityState === 'hidden');
  };
  sync();
  document.addEventListener('visibilitychange', sync);
  return () => {
    document.removeEventListener('visibilitychange', sync);
    document.documentElement.removeAttribute(DOCUMENT_HIDDEN_ATTR);
  };
}
