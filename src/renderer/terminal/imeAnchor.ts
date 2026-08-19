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
 * And a third cause lives in the anchor's input rather than its math
 * (field-verified on v3.42.0 after the first two were fixed): the buffer
 * cursor sampled at `compositionstart` is not always the input caret. A TUI
 * like Claude Code repaints its lower region every frame, and while a frame's
 * escape stream is being parsed the cursor rides along with the writes — it is
 * only parked back on the caret by the cursor-positioning sequence at the end
 * of the frame. Frames arrive from the PTY split across chunks, so there are
 * real JS turns where the cursor sits mid-frame, and a composition starting in
 * one of them freezes a wrong-but-stable anchor:
 *
 *   PTY frame (one TUI repaint, split across N chunks):
 *
 *    chunk1        chunk2        chunk3(final: CUP to caret)
 *    ├─parse─┤gap├─parse─┤gap├─parse─┤───────── rest ─────────┤ next frame
 *    cursor:  mid-frame    mid-frame  caret     caret (holds)
 *             (transient)  (transient)
 *    gap  = inter-chunk, sub-ms to a few ms
 *    rest = inter-frame, >= ~50 ms streaming, seconds when idle
 *
 *    compositionstart in a "gap"  -> samples a transient   <- the bug
 *    compositionstart in "rest"   -> samples the caret
 *
 * The countermeasure is a resting-cell tracker: the anchor freezes to the last
 * cell the cursor held for at least RESTING_MS when the instantaneous cursor
 * is inside a move burst. Known limit, accepted deliberately: dwell time
 * cannot distinguish the caret from any cell the cursor parks on for
 * >= RESTING_MS, so the compositionstart diagnostic reports which source was
 * selected and why — the field log is the discriminator before any further
 * complexity is added.
 *
 * All of this lives in upstream xterm and this repo does not patch
 * node_modules, so the correction is applied downstream as a `transform` that
 * composes with the `style.top` / `style.left` xterm keeps writing, instead of
 * fighting it. #875 put that transform on the `.xterm-helpers` container;
 * #942 showed the container is the wrong unit, because its two children have
 * opposite requirements while a composition is live:
 *
 *   .xterm-screen  (position: relative, origin for everything below)
 *     +-- .xterm-helpers
 *     |     +-- textarea            <- style.top/left [xterm] + transform [ours: pinned]
 *     |     +-- .composition-view   <- style.top/left [xterm] + transform [ours: live]
 *     +-- canvas                    <- painted cursor                     [webgl]
 *
 * The textarea is what Chromium reports the caret rect from, so it is what a
 * floating candidate window (Chinese/Japanese) follows — pinning it for the
 * whole composition is the point of the freeze. The `.composition-view` is
 * the visible inline preedit, and `CompositionHelper.updateCompositionElements`
 * deliberately re-anchors it to the live cursor on every `compositionupdate`.
 * Korean Microsoft IME draws no candidate window at all: the preedit rendered
 * inline at the caret IS the text the user is watching. Freezing the shared
 * parent turned every committed syllable's echo into a backwards drag — the
 * caret advances past the pinned point, `frozen - actual` goes negative, and
 * the composing syllable is painted on top of the one that just committed
 * (typing 대한민국 reads 대한국, #942). The composition ending cleared the
 * transform and the WebGL repaint restored the real cells, which is why the
 * buffer was never wrong, only the paint. So the pin applies to the textarea
 * alone, and the preedit gets the same anchor math against the live cursor,
 * never frozen — it still lands on the painted caret when the viewport is
 * scrolled (cause 1 applies to it too), and it follows the caret as commits
 * echo back mid-composition.
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
 * Where the renderer would paint a given buffer cell, in screen-local CSS
 * pixels.
 *
 * The row is clamped into the viewport: once the cursor scrolls out of view
 * xterm stops moving the textarea at all, and an unclamped anchor would send
 * the candidate window outside the pane. Pinning it to the nearest visible edge
 * keeps it attached to the terminal, which is the least surprising thing an IME
 * can do when the caret itself is off-screen. The column is clamped to
 * `cols - 1` to match what xterm does (CompositionHelper.ts:221) so a
 * wrap-pending cursor at `col === cols` does not land a cell too far right.
 */
export function pointFromCell(
  absRow: number,
  col: number,
  buffer: ImeAnchorBufferState,
  geometry: ImeAnchorGeometry,
): ImeAnchorPoint {
  const viewportRow = absRow - buffer.viewportY;
  const row = Math.min(Math.max(viewportRow, 0), geometry.rows - 1);
  const clampedCol = Math.min(Math.max(col, 0), geometry.cols - 1);
  return { left: clampedCol * geometry.cellWidth, top: row * geometry.cellHeight };
}

/** Where the renderer actually paints the live cursor. */
export function paintedCursorPosition(
  buffer: ImeAnchorBufferState,
  geometry: ImeAnchorGeometry,
): ImeAnchorPoint {
  return pointFromCell(buffer.baseY + buffer.cursorY, buffer.cursorX, buffer, geometry);
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
// Resting-cell tracker (cause 3)
// ---------------------------------------------------------------------------

/**
 * A cell counts as "at rest" once the cursor has held it this long. Inter-chunk
 * gaps inside one TUI repaint are sub-ms to a few ms; the inter-frame rest is
 * >= ~50 ms while streaming and seconds when idle — 32 ms sits between the two
 * populations with roughly 10x margin on both sides.
 */
export const RESTING_MS = 32;

/**
 * Mutable tracker record. The transition functions below mutate it in place —
 * that is how "pure-function testability" and an allocation-free hot path
 * coexist: each function is deterministic in (state, args), returns scalars,
 * and tests simply construct a fresh record per case.
 */
export interface RestingTrackerState {
  /** Cell the cursor is in right now (absolute row = ybase + buffer.y). */
  currentAbsRow: number;
  currentCol: number;
  /** Clock reading when the current cell was entered. */
  currentSince: number;
  /** Last cell that was held for >= RESTING_MS before the cursor left it. */
  lastRestingAbsRow: number;
  lastRestingCol: number;
  /** Clock reading when the resting cell was promoted. */
  lastRestingAt: number;
  hasResting: boolean;
}

/**
 * Seed the tracker from the live cursor. Seeding (rather than starting empty)
 * means an idle caret that never moves still reads as "at rest", so the
 * pre-first-move window has no hole where the selection could do nothing.
 */
export function createRestingTracker(absRow: number, col: number, now: number): RestingTrackerState {
  return {
    currentAbsRow: absRow,
    currentCol: col,
    currentSince: now,
    lastRestingAbsRow: 0,
    lastRestingCol: 0,
    lastRestingAt: 0,
    hasResting: false,
  };
}

/** Record a cursor movement. Promotes the cell being left if it had rested. */
export function noteCursorMove(state: RestingTrackerState, absRow: number, col: number, now: number): void {
  if (absRow === state.currentAbsRow && col === state.currentCol) return;
  if (now - state.currentSince >= RESTING_MS) {
    state.lastRestingAbsRow = state.currentAbsRow;
    state.lastRestingCol = state.currentCol;
    state.lastRestingAt = now;
    state.hasResting = true;
  }
  state.currentAbsRow = absRow;
  state.currentCol = col;
  state.currentSince = now;
}

/**
 * Invalidate everything and re-seed. Resize reflow and buffer switches
 * (alt-screen) change what an absolute row means, so a resting cell recorded
 * before either event must never be selected after it.
 */
export function resetRestingTracker(state: RestingTrackerState, absRow: number, col: number, now: number): void {
  state.currentAbsRow = absRow;
  state.currentCol = col;
  state.currentSince = now;
  state.hasResting = false;
}

/** Where the freeze cell came from. `scrolled_out` is `instant` chosen because
 *  the resting cell had left the viewport — kept distinct so a field log can
 *  tell that rejection apart from a cursor that was simply at rest. */
export type FreezeCellSource = 'instant' | 'resting' | 'scrolled_out';

export interface FreezeCellSelection {
  absRow: number;
  col: number;
  src: FreezeCellSource;
  /** How long the instantaneous cell had been held when selection ran. */
  held: number;
  /** Age of the resting cell at selection time; -1 when none exists. */
  restAge: number;
}

/**
 * Pick the cell the composition should anchor to. A cursor that has held its
 * cell for RESTING_MS is at rest — trust it. A cursor that moved more recently
 * is mid-repaint, so fall back to the last cell that did rest. With no resting
 * cell recorded (fresh tracker), the instantaneous cursor is all there is.
 *
 * `viewport` guards the one case where the resting cell is the WORSE of the
 * two. A resting cell is by definition a past cell, so output that scrolls the
 * buffer (a build log, not an in-place TUI repaint) pushes it off the top of
 * the screen within a frame or two. `pointFromCell` then clamps that row into
 * view and parks the candidate window at the very top of the terminal — a
 * bigger miss than the live cursor, and one #875 could not produce because it
 * only ever read the live cursor, which is always on screen. Verified on the
 * dev build: 20k lines of scrolling output selected resting cells 1000+ rows
 * above `ydisp`, every one correcting to the top edge. Off-screen resting
 * cells are therefore rejected rather than trusted.
 */
export function selectFreezeCell(
  state: RestingTrackerState,
  instAbsRow: number,
  instCol: number,
  now: number,
  viewport?: { top: number; rows: number },
): FreezeCellSelection {
  const held = now - state.currentSince;
  const restAge = state.hasResting ? now - state.lastRestingAt : -1;
  if (held >= RESTING_MS || !state.hasResting) {
    return { absRow: instAbsRow, col: instCol, src: 'instant', held, restAge };
  }
  if (viewport && (state.lastRestingAbsRow < viewport.top
    || state.lastRestingAbsRow >= viewport.top + viewport.rows)) {
    return { absRow: instAbsRow, col: instCol, src: 'scrolled_out', held, restAge };
  }
  return { absRow: state.lastRestingAbsRow, col: state.lastRestingCol, src: 'resting', held, restAge };
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
  readonly buffer: {
    active: ImeAnchorBufferState;
    /** Fires on normal <-> alt buffer switches. */
    onBufferChange: EventEmitterLike<unknown>;
  };
  onRender: EventEmitterLike<unknown>;
  onScroll: EventEmitterLike<unknown>;
  onResize: EventEmitterLike<unknown>;
  onCursorMove: EventEmitterLike<unknown>;
}

export interface ImeAnchorOptions {
  /**
   * Called with the coordinates that produced the correction. #874/#942 could
   * not be reproduced locally (no CJK IME here), so this is how a reporter's
   * log tells us whether any offset survives the fix. Fires on every
   * `compositionstart`, and again mid-composition (`update`) or at
   * `compositionend` ONLY when a correction changed since the last report —
   * #942's log was all `correction=(0,0)` precisely because the drag developed
   * after the start-only diagnostic had already fired.
   */
  onCompositionDiagnostic?: (info: {
    phase: 'start' | 'update' | 'end';
    baseY: number;
    viewportY: number;
    cursorY: number;
    cursorX: number;
    cellHeight: number;
    /** Correction applied to the textarea (the pinned candidate-window anchor). */
    dx: number;
    dy: number;
    /** Live correction applied to the inline preedit box; 0,0 when none. */
    preeditDx: number;
    preeditDy: number;
    /** Which cell the anchor froze to (cause 3 discriminator). */
    src: FreezeCellSource;
    held: number;
    restAge: number;
    /** Selected cell, ybase-relative like cursorY/cursorX. */
    selY: number;
    selX: number;
  }) => void;
  /** Clock override for tests. Defaults to performance.now. */
  now?: () => number;
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
  // The inline preedit box (#942). Optional on purpose: if an xterm upgrade
  // renames it, the preedit stays on xterm's own live positioning — the
  // pre-#875 behavior Korean reporters describe as clean — instead of breaking.
  const compositionView = helpers.querySelector<HTMLElement>('.composition-view');

  const now = options.now ?? ((): number => performance.now());

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

  const bufferState = (): ImeAnchorBufferState => terminal.buffer.active;
  const tracker = createRestingTracker(
    bufferState().baseY + bufferState().cursorY,
    bufferState().cursorX,
    now(),
  );

  let frozen: ImeAnchorPoint | null = null;
  // Tracked separately from `frozen`: unusable geometry at compositionstart
  // leaves `frozen` null while a composition IS live, and both the cell-height
  // sampling gate and the preedit correction key off the composition itself.
  let composing = false;
  let pendingCompositionSync: ReturnType<typeof setTimeout> | null = null;

  /**
   * Where xterm currently has a child, in screen-local pixels, with our own
   * transform excluded. Read from the inline styles xterm wrote rather than
   * from `offsetTop`, so the hot path stays layout-read-free.
   */
  const readStyledPoint = (el: HTMLElement): ImeAnchorPoint | null => {
    const top = parsePxOrNull(el.style.top);
    const left = parsePxOrNull(el.style.left);
    if (top === null || left === null) return null;
    return { left: helpersOrigin.left + left, top: helpersOrigin.top + top };
  };

  /** Write-elided transform setter. #942 split the correction per child, so
   *  each child carries its own last-applied pair. */
  const makeTransformApplier = (el: HTMLElement): { set(dx: number, dy: number): void } => {
    let lastDx = 0;
    let lastDy = 0;
    return {
      set(dx: number, dy: number): void {
        if (dx === lastDx && dy === lastDy) return;
        lastDx = dx;
        lastDy = dy;
        el.style.transform = dx === 0 && dy === 0 ? '' : `translate(${dx}px, ${dy}px)`;
      },
    };
  };
  const textareaTransform = makeTransformApplier(textarea);
  const preeditTransform = compositionView ? makeTransformApplier(compositionView) : null;
  // Last preedit correction actually applied, for the diagnostic.
  let preeditDx = 0;
  let preeditDy = 0;

  const sync = (): ImeAnchorCorrection | null => {
    if (!composing) {
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
    const live = paintedCursorPosition(bufferState(), geometry);
    // The preedit is NEVER pinned (#942): while composing it gets the same
    // anchor math against the live cursor — the ydisp term xterm forgot plus
    // whatever the caret did since xterm last wrote its styles — and outside a
    // composition it carries no transform at all (xterm hides it anyway).
    if (preeditTransform && compositionView) {
      if (composing) {
        const actualPreedit = readStyledPoint(compositionView);
        if (actualPreedit) {
          const c = computeImeAnchorCorrection(live, actualPreedit);
          preeditDx = c.dx;
          preeditDy = c.dy;
          preeditTransform.set(c.dx, c.dy);
        }
      } else {
        preeditDx = 0;
        preeditDy = 0;
        preeditTransform.set(0, 0);
      }
    }
    const actual = readStyledPoint(textarea);
    // xterm has not positioned the textarea yet (stylesheet default
    // `left: -9999em`). Nothing to correct against, and forcing a transform
    // now would only move the off-screen parking spot around.
    if (!actual) return null;
    const correction = computeImeAnchorCorrection(frozen ?? live, actual);
    textareaTransform.set(correction.dx, correction.dy);
    return correction;
  };

  const resetTracker = (): void => {
    const b = bufferState();
    resetRestingTracker(tracker, b.baseY + b.cursorY, b.cursorX, now());
  };

  const onRefreshGeometry = (): void => {
    geometry = readGeometry();
    helpersOrigin = readHelpersOrigin();
    // Resize reflow re-wraps the buffer — absolute rows recorded before it no
    // longer name the same content, so the resting cell must not survive.
    resetTracker();
    sync();
  };

  // Freeze-cell selection of the current composition, for the diagnostic.
  let lastSel: FreezeCellSelection | null = null;
  // Last corrections the diagnostic reported: update/end records fire only on
  // change, so a healthy composition costs one record and a developing offset
  // is captured the moment it develops (#942's field log was all
  // `correction=(0,0)` because the start-only diagnostic fired before the
  // committed syllable's echo moved anything).
  let reportedDx = 0;
  let reportedDy = 0;
  let reportedPreeditDx = 0;
  let reportedPreeditDy = 0;

  const emitDiagnostic = (phase: 'start' | 'update' | 'end', correction: ImeAnchorCorrection | null): void => {
    if (!options.onCompositionDiagnostic || lastSel === null) return;
    const dx = correction?.dx ?? 0;
    const dy = correction?.dy ?? 0;
    if (phase !== 'start'
      && dx === reportedDx && dy === reportedDy
      && preeditDx === reportedPreeditDx && preeditDy === reportedPreeditDy) {
      return;
    }
    reportedDx = dx;
    reportedDy = dy;
    reportedPreeditDx = preeditDx;
    reportedPreeditDy = preeditDy;
    const b = bufferState();
    options.onCompositionDiagnostic({
      phase,
      baseY: b.baseY,
      viewportY: b.viewportY,
      cursorY: b.cursorY,
      cursorX: b.cursorX,
      cellHeight: geometry.cellHeight,
      dx,
      dy,
      preeditDx,
      preeditDy,
      src: lastSel.src,
      held: lastSel.held,
      restAge: lastSel.restAge,
      selY: lastSel.absRow - b.baseY,
      selX: lastSel.col,
    });
  };

  const onCompositionStart = (): void => {
    // Pin the textarea anchor for the whole composition. The buffer cursor
    // keeps moving while the agent streams, but the candidate window belongs
    // where the user started typing, not wherever the TUI's redraw last left
    // the cursor. The cell it pins to is the resting-tracker selection: the
    // instantaneous cursor when it is at rest, the last resting cell when the
    // composition starts inside a repaint burst (cause 3).
    composing = true;
    const b = bufferState();
    const sel = selectFreezeCell(tracker, b.baseY + b.cursorY, b.cursorX, now(), {
      top: b.viewportY,
      rows: geometry.rows,
    });
    lastSel = sel;
    frozen = isUsableGeometry(geometry)
      ? pointFromCell(sel.absRow, sel.col, b, geometry)
      : null;
    emitDiagnostic('start', sync());
  };

  const onCompositionUpdate = (): void => {
    // xterm's own compositionupdate handler already ran (it registered first)
    // and re-anchored the children; correct on top of that. It also queues a
    // setTimeout(0) re-run of the same repositioning, so queue one behind it.
    emitDiagnostic('update', sync());
    if (pendingCompositionSync !== null) clearTimeout(pendingCompositionSync);
    pendingCompositionSync = setTimeout(() => {
      pendingCompositionSync = null;
      emitDiagnostic('update', sync());
    }, 0);
  };

  const onCompositionEnd = (): void => {
    composing = false;
    frozen = null;
    emitDiagnostic('end', sync());
    lastSel = null;
  };

  // onRender fires after xterm has written the child styles for the frame, so
  // reading them here never sees a half-updated position. Mid-composition this
  // is also where a committed syllable's PTY echo lands (cursor advances, cells
  // repaint), so the diagnostic samples here too — change-gated, so a quiet
  // frame costs a few compares and no record.
  const renderSub = terminal.onRender(() => {
    const correction = sync();
    if (composing) emitDiagnostic('update', correction);
  });
  // xterm does NOT re-sync the textarea on scroll — that omission is half of
  // #874 — so this is where the scrolled-viewport correction actually lands.
  const scrollSub = terminal.onScroll(() => {
    const correction = sync();
    if (composing) emitDiagnostic('update', correction);
  });
  const resizeSub = terminal.onResize(onRefreshGeometry);
  // Coalesced per parse batch by xterm; the handler is a compare plus a few
  // number writes, so the streaming hot path stays cold.
  const cursorSub = terminal.onCursorMove(() => {
    const b = bufferState();
    noteCursorMove(tracker, b.baseY + b.cursorY, b.cursorX, now());
  });
  // Normal <-> alt buffer switches change what an absolute row means.
  const bufferSub = terminal.buffer.onBufferChange(resetTracker);

  textarea.addEventListener('compositionstart', onCompositionStart);
  textarea.addEventListener('compositionupdate', onCompositionUpdate);
  textarea.addEventListener('compositionend', onCompositionEnd);

  sync();

  return {
    dispose: (): void => {
      renderSub.dispose();
      scrollSub.dispose();
      resizeSub.dispose();
      cursorSub.dispose();
      bufferSub.dispose();
      textarea.removeEventListener('compositionstart', onCompositionStart);
      textarea.removeEventListener('compositionupdate', onCompositionUpdate);
      textarea.removeEventListener('compositionend', onCompositionEnd);
      if (pendingCompositionSync !== null) clearTimeout(pendingCompositionSync);
      textarea.style.transform = '';
      if (compositionView) compositionView.style.transform = '';
    },
  };
}
