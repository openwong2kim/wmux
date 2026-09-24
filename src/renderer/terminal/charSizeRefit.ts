import type { IDisposable, Terminal } from '@xterm/xterm';

/**
 * Char-size re-measure hooks for the bundled webfont race (#1497).
 *
 * xterm measures its cell once, at `open()`. A pane restored right after boot
 * opens before the bundled Cascadia Code webfont has loaded, so the cell is
 * measured with the fallback font (Consolas on Windows: 7.2x17.6 instead of
 * 8x16 CSS px). xterm treats that as a valid size and never re-measures on its
 * own — except inside `_afterResize`, i.e. AFTER FitAddon has already computed
 * cols/rows from the stale cell. The first resize then leaves the screen
 * overflowing its container until the next one.
 *
 * Neither the re-measure nor the change event is public API, so both go
 * through xterm's private CharSizeService, following the webglTeardown.ts
 * precedent: one named shape, optional-chained, a no-op if the internals ever
 * change, and a shape-lock test (charSizeRefit.test.ts) against a real
 * Terminal so a package bump fails loudly instead.
 */

/** Private xterm internals used here. Kept in one named shape so the test can
 *  lock the exact paths against @xterm package bumps. */
interface XtermCharSizeInternals {
  _core?: {
    _charSizeService?: {
      measure?: () => void;
      onCharSizeChange?: (listener: () => void) => IDisposable;
    };
  };
}

function charSizeService(terminal: Terminal) {
  return (terminal as unknown as XtermCharSizeInternals)._core?._charSizeService;
}

/** Re-measure the cell with the current fonts. Fires the char-size change
 *  event only when the measurement actually differs, so calling it with an
 *  up-to-date cell is a no-op. Safe before `open()` and on a hidden pane. */
export function forceCharSizeMeasure(terminal: Terminal): void {
  try {
    charSizeService(terminal)?.measure?.();
  } catch {
    /* best-effort; a disposed terminal has nothing to re-measure */
  }
}

/** Subscribe to xterm's char-size change. Returns undefined when the terminal
 *  is not open yet or the internals changed shape. */
export function onCharSizeChange(terminal: Terminal, listener: () => void): IDisposable | undefined {
  return charSizeService(terminal)?.onCharSizeChange?.(listener);
}
