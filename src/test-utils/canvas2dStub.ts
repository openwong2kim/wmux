/**
 * A do-nothing 2D canvas context for jsdom.
 *
 * TEST-ONLY. jsdom has no canvas, and xterm 6.1's DOM renderer builds a
 * canvas-backed WidthCache on `open()` and throws when `getContext('2d')`
 * returns nothing. Tests that open a real Terminal under jsdom install this
 * first. Every call is a no-op; `measureText` reports a zero width, which the
 * DOM renderer treats as "no adjustment". xterm's cell measurement does not
 * use it: that path needs OffscreenCanvas, which jsdom lacks, so it keeps
 * falling back to DOM measurement exactly as before.
 */
export function installCanvas2dStub(): void {
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get: (target, prop) => {
      if (prop in target) return target[prop];
      if (prop === 'measureText') return () => ({ width: 0 });
      return () => undefined;
    },
    set: (target, prop, value) => {
      target[prop] = value;
      return true;
    },
  });
  (HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }).getContext = () => ctx;
}
