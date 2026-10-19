/**
 * Quiets two jsdom gaps every renderer test file hits. TEST-ONLY.
 *
 * Runs before each test file; a no-op in the default 'node' environment, where
 * there is no `window`. Neither stub changes what the code under test sees in
 * a way it could act on: both answer exactly what an absent feature already
 * answered, minus the stderr noise that buried real failures in CI logs.
 */
if (typeof window !== 'undefined' && typeof HTMLCanvasElement !== 'undefined') {
  // jsdom has no canvas. xterm and its addons probe a 2D context at import
  // time (inside try/catch); jsdom answers null but first prints a
  // "Not implemented: HTMLCanvasElement.prototype.getContext" error with a
  // stack, once per probe. Answer the same null, silently. Do NOT install the
  // `canvas` npm package (native, breaks Windows CI). Tests that open a real
  // Terminal still install canvas2dStub over this.
  HTMLCanvasElement.prototype.getContext = function getContext() {
    return null;
  } as typeof HTMLCanvasElement.prototype.getContext;

  // jsdom has no matchMedia, and xterm's Terminal.open() calls it on its
  // window to track devicePixelRatio. Nothing ever matches; listeners never
  // fire. Defined only when absent and left writable/configurable, so a test's
  // own stub (assignment, vi.stubGlobal or delete) still wins.
  if (typeof window.matchMedia !== 'function') {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: (media: string): MediaQueryList => ({
        matches: false,
        media,
        onchange: null,
        addEventListener() { /* never fires */ },
        removeEventListener() { /* never fires */ },
        addListener() { /* never fires */ },
        removeListener() { /* never fires */ },
        dispatchEvent() { return false; },
      }),
    });
  }
}
