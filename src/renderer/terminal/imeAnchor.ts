/**
 * IME candidate-window anchoring (#874).
 *
 * Windows CJK IMEs draw their candidate window at the caret rect Chromium
 * reports for the focused editable element. In a terminal that element is
 * xterm's hidden helper textarea, so wherever xterm parks the textarea is
 * where the candidate list appears. xterm parks it in the wrong place, twice
 * over:
 *
 *   1. Wrong row while the viewport is scrolled up. `_syncTextArea` anchors at
 *      `buffer.y * cellHeight`, which is ybase-relative, but the renderer
 *      paints the cursor at `(ybase + y) - ydisp` (WebglRenderer.ts:402), which
 *      is ydisp-relative. The two disagree by exactly the number of rows the
 *      viewport is scrolled up. xterm's own guard `isCursorInViewport`
 *      (Buffer.ts:97) applies the ydisp term correctly, and InputHandler.ts:502
 *      converts with `+ (ybase - ydisp)` and a comment explaining why, so the
 *      anchor code is simply missing it. Measured live: ybase=22, ydisp=14,
 *      cursorY=38, cellHeight=17.6 -> anchor row 38, painted row 46, drift -8.
 *      wmux runs with `scrollOnUserInput: false`, so unlike stock xterm the
 *      drift does not self-heal when the user types — one stray wheel scroll
 *      leaves the candidate window misaligned until the user scrolls back.
 *
 *   2. Moving target while composing. `CompositionHelper.updateCompositionElements`
 *      re-anchors on every `compositionupdate` (plus a recursive setTimeout),
 *      so while an agent streams output the candidate window chases wherever
 *      the TUI last parked the cursor mid-redraw. Latin input shows no
 *      candidate window, which is why only CJK users see it.
 *
 * Both live in upstream xterm and this repo does not patch node_modules, so the
 * correction is applied downstream: one `transform` on the `.xterm-helpers`
 * container, which holds the textarea and the visible preedit box. xterm keeps
 * writing `style.top` / `style.left` on those children; a transform on their
 * parent composes with that instead of fighting it.
 *
 *   .xterm-screen  (position: relative, origin for everything below)
 *     +-- .xterm-helpers                 <- transform: translate(dx, dy)  [ours]
 *     |     +-- textarea                 <- style.top / left              [xterm]
 *     |     +-- .composition-view        <- style.top / left              [xterm]
 *     +-- canvas                         <- painted cursor                [webgl]
 *
 * The correction is computed as `desired - actual`, where `actual` is read back
 * from the styles xterm wrote rather than re-derived from the buffer. That
 * matters for three reasons: `_syncTextArea` early-returns while composing (so
 * a buffer-derived estimate would be wrong exactly when it counts), xterm stops
 * syncing entirely once the cursor leaves the viewport (leaving stale
 * coordinates a model cannot predict), and if a future xterm release fixes the
 * anchor upstream then `desired - actual` collapses to zero on its own instead
 * of double-correcting.
 */

/** Minimal view of `terminal.buffer.active` that the anchor math needs. */
export interface ImeAnchorBufferState {
  /** Cursor column, ybase-relative buffer coordinates. */
  cursorX: number;
  /** Cursor row, ybase-relative (this is xterm's `buffer.y`). */
  cursorY: number;
  /** Rows scrolled off the top of the buffer (xterm's `ybase`). */
  baseY: number;
  /** Row currently at the top of the viewport (xterm's `ydisp`). */
  viewportY: number;
}

/** Cell metrics plus the grid size, in CSS pixels / cells. */
export interface ImeAnchorGeometry {
  cellWidth: number;
  cellHeight: number;
  rows: number;
  cols: number;
}

/** A position in `.xterm-screen`-local CSS pixels. */
export interface ImeAnchorPoint {
  left: number;
  top: number;
}

export interface ImeAnchorCorrection {
  dx: number;
  dy: number;
}

/** True when the geometry is usable — a hidden pane reports zero-sized cells. */
export function isUsableGeometry(geometry: ImeAnchorGeometry): boolean {
  const { cellWidth, cellHeight, rows, cols } = geometry;
  return (
    Number.isFinite(cellWidth) && cellWidth > 0 &&
    Number.isFinite(cellHeight) && cellHeight > 0 &&
    Number.isFinite(rows) && rows > 0 &&
    Number.isFinite(cols) && cols > 0
  );
}

/**
 * Where the renderer actually paints the cursor, in screen-local CSS pixels.
 *
 * The row is clamped into the viewport: once the cursor scrolls out of view
 * xterm stops moving the textarea at all, and an unclamped anchor would send
 * the candidate window outside the pane. Pinning it to the nearest visible edge
 * keeps it attached to the terminal, which is the least surprising thing an IME
 * can do when the caret itself is off-screen. The column is clamped to
 * `cols - 1` to match what xterm does (CompositionHelper.ts:221) so a
 * wrap-pending cursor at `cursorX === cols` does not land a cell too far right.
 */
export function paintedCursorPosition(
  buffer: ImeAnchorBufferState,
  geometry: ImeAnchorGeometry,
): ImeAnchorPoint {
  const viewportRow = (buffer.baseY + buffer.cursorY) - buffer.viewportY;
  const row = Math.min(Math.max(viewportRow, 0), geometry.rows - 1);
  const col = Math.min(Math.max(buffer.cursorX, 0), geometry.cols - 1);
  return { left: col * geometry.cellWidth, top: row * geometry.cellHeight };
}

/**
 * The translate that moves the helper container's children from where xterm
 * put them to where they belong.
 */
export function computeImeAnchorCorrection(
  desired: ImeAnchorPoint,
  actual: ImeAnchorPoint,
): ImeAnchorCorrection {
  return { dx: desired.left - actual.left, dy: desired.top - actual.top };
}

/**
 * Parse a `<n>px` inline style value. Returns null for anything else, notably
 * xterm's stylesheet default of `left: -9999em`, which means "xterm has not
 * positioned this yet" and must not be read as a pixel offset. The number
 * accepts every CSS form (`.5px`, `1e2px`) rather than only what Chromium
 * happens to serialize today, so a change in how the offset is computed
 * upstream degrades into a wrong-but-parsed value we can see rather than
 * silently switching the correction off.
 */
export function parsePxOrNull(value: string | undefined | null): number | null {
  if (!value) return null;
  const match = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)px$/.exec(value.trim());
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Runtime wiring
// ---------------------------------------------------------------------------

interface Disposable {
  dispose(): void;
}

interface EventEmitterLike<T> {
  (listener: (arg: T) => void): Disposable;
}

/** The slice of xterm's public Terminal API this needs. */
export interface ImeAnchorTerminal {
  readonly rows: number;
  readonly cols: number;
  readonly textarea: HTMLTextAreaElement | undefined;
  readonly element: HTMLElement | undefined;
  readonly buffer: { active: ImeAnchorBufferState };
  onRender: EventEmitterLike<unknown>;
  onScroll: EventEmitterLike<unknown>;
  onResize: EventEmitterLike<unknown>;
}

export interface ImeAnchorOptions {
  /**
   * Called once per composition start with the coordinates that produced the
   * correction. #874 could not be reproduced locally (no CJK IME here), so this
   * is how a reporter's log tells us whether any offset survives the fix.
   */
  onCompositionDiagnostic?: (info: {
    baseY: number;
    viewportY: number;
    cursorY: number;
    cursorX: number;
    cellHeight: number;
    dx: number;
    dy: number;
  }) => void;
}

const NO_OP: Disposable = { dispose: () => undefined };

export function attachImeAnchor(
  terminal: ImeAnchorTerminal,
  options: ImeAnchorOptions = {},
): Disposable {
  const textarea = terminal.textarea;
  const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen') ?? null;
  const helpers = screen?.querySelector<HTMLElement>('.xterm-helpers') ?? null;
  if (!textarea || !screen || !helpers) {
    return NO_OP;
  }

  // xterm's own cell height, learned from the `style.height` it writes onto the
  // textarea in _syncTextArea. Deriving it from clientHeight instead leaves a
  // sub-pixel disagreement (xterm rounds the cell to whole device pixels, the
  // client box does not), which would make every correction a fraction off and
  // put a transform on the element even when nothing needs moving.
  let xtermCellHeight: number | null = null;

  const readGeometry = (): ImeAnchorGeometry => {
    const rows = terminal.rows;
    const cols = terminal.cols;
    const fromLayout = rows > 0 ? screen.clientHeight / rows : 0;
    // Trust xterm's number when it is in the same ballpark as the measured box;
    // anything wilder means we read something that is not a cell height.
    const cellHeight = xtermCellHeight !== null
      && xtermCellHeight > 0
      && fromLayout > 0
      && xtermCellHeight > fromLayout / 2
      && xtermCellHeight < fromLayout * 2
      ? xtermCellHeight
      : fromLayout;
    return {
      cellWidth: cols > 0 ? screen.clientWidth / cols : 0,
      cellHeight,
      rows,
      cols,
    };
  };

  const readHelpersOrigin = (): ImeAnchorPoint => ({
    left: helpers.offsetLeft,
    top: helpers.offsetTop,
  });

  // Cell metrics need a layout read, so they are cached and refreshed only on
  // resize. Recomputing them inside onRender would put a forced synchronous
  // layout in the streaming-output hot path, which is the one place this must
  // stay free.
  let geometry: ImeAnchorGeometry = readGeometry();
  // `.xterm-helpers` is `position: absolute; top: 0` inside `.xterm-screen`, so
  // this is normally {0,0}; read it anyway rather than assume, and refresh it
  // with the rest of the geometry.
  let helpersOrigin: ImeAnchorPoint = readHelpersOrigin();

  let frozen: ImeAnchorPoint | null = null;
  let lastDx = 0;
  let lastDy = 0;
  let pendingCompositionSync: ReturnType<typeof setTimeout> | null = null;

  /**
   * Where xterm currently has the children, in screen-local pixels, with our
   * own transform excluded. Read from the inline styles xterm wrote rather than
   * from `offsetTop`, so the hot path stays layout-read-free.
   */
  const readActual = (): ImeAnchorPoint | null => {
    const top = parsePxOrNull(textarea.style.top);
    const left = parsePxOrNull(textarea.style.left);
    if (top === null || left === null) return null;
    return { left: helpersOrigin.left + left, top: helpersOrigin.top + top };
  };

  const apply = (dx: number, dy: number): void => {
    if (dx === lastDx && dy === lastDy) return;
    lastDx = dx;
    lastDy = dy;
    helpers.style.transform = dx === 0 && dy === 0 ? '' : `translate(${dx}px, ${dy}px)`;
  };

  const sync = (): ImeAnchorCorrection | null => {
    if (frozen === null) {
      // Not composing, so `style.height` is still the cell height xterm wrote
      // in _syncTextArea (during a composition it holds the preedit box size
      // instead, which is why this only samples outside one).
      const h = parsePxOrNull(textarea.style.height);
      if (h !== null && h > 0 && h !== xtermCellHeight) {
        xtermCellHeight = h;
        geometry = readGeometry();
      }
    }
    if (!isUsableGeometry(geometry)) return null;
    const actual = readActual();
    // xterm has not positioned the textarea yet (stylesheet default
    // `left: -9999em`). Nothing to correct against, and forcing a transform
    // now would only move the off-screen parking spot around.
    if (!actual) return null;
    const desired = frozen ?? paintedCursorPosition(terminal.buffer.active, geometry);
    const correction = computeImeAnchorCorrection(desired, actual);
    apply(correction.dx, correction.dy);
    return correction;
  };

  const onRefreshGeometry = (): void => {
    geometry = readGeometry();
    helpersOrigin = readHelpersOrigin();
    sync();
  };

  const onCompositionStart = (): void => {
    // Pin the anchor for the whole composition. The buffer cursor keeps moving
    // while the agent streams, but the candidate window belongs where the user
    // started typing, not wherever the TUI's redraw last left the cursor.
    frozen = isUsableGeometry(geometry)
      ? paintedCursorPosition(terminal.buffer.active, geometry)
      : null;
    const correction = sync();
    if (options.onCompositionDiagnostic) {
      const b = terminal.buffer.active;
      options.onCompositionDiagnostic({
        baseY: b.baseY,
        viewportY: b.viewportY,
        cursorY: b.cursorY,
        cursorX: b.cursorX,
        cellHeight: geometry.cellHeight,
        dx: correction?.dx ?? 0,
        dy: correction?.dy ?? 0,
      });
    }
  };

  const onCompositionUpdate = (): void => {
    // xterm's own compositionupdate handler already ran (it registered first)
    // and re-anchored the children; correct on top of that. It also queues a
    // setTimeout(0) re-run of the same repositioning, so queue one behind it.
    sync();
    if (pendingCompositionSync !== null) clearTimeout(pendingCompositionSync);
    pendingCompositionSync = setTimeout(() => {
      pendingCompositionSync = null;
      sync();
    }, 0);
  };

  const onCompositionEnd = (): void => {
    frozen = null;
    sync();
  };

  // onRender fires after xterm has written the child styles for the frame, so
  // reading them here never sees a half-updated position.
  const renderSub = terminal.onRender(() => sync());
  // xterm does NOT re-sync the textarea on scroll — that omission is half of
  // #874 — so this is where the scrolled-viewport correction actually lands.
  const scrollSub = terminal.onScroll(() => sync());
  const resizeSub = terminal.onResize(onRefreshGeometry);

  textarea.addEventListener('compositionstart', onCompositionStart);
  textarea.addEventListener('compositionupdate', onCompositionUpdate);
  textarea.addEventListener('compositionend', onCompositionEnd);

  sync();

  return {
    dispose: (): void => {
      renderSub.dispose();
      scrollSub.dispose();
      resizeSub.dispose();
      textarea.removeEventListener('compositionstart', onCompositionStart);
      textarea.removeEventListener('compositionupdate', onCompositionUpdate);
      textarea.removeEventListener('compositionend', onCompositionEnd);
      if (pendingCompositionSync !== null) clearTimeout(pendingCompositionSync);
      helpers.style.transform = '';
    },
  };
}
