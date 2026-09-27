/**
 * The geometry a remote mirror needs to fit a grid it does not own.
 *
 * A mirror renders the REMOTE daemon's grid — `RemoteMirrorTerminal` only ever
 * calls `term.resize()` with cols/rows the remote sent, because geometry has a
 * single owner and a viewer must not resize someone else's pane. The pixels,
 * though, are local: the mirror draws with this app's font settings. So the
 * rendered element is `remoteCols × localCellW` wide and nothing relates that
 * to the box it sits in. When the remote pane is the bigger of the two, the
 * surplus columns and rows are cropped by the enclosing `overflow-hidden` — and
 * a TUI keeps its input box on the LAST rows, so the crop takes exactly the
 * part the user is looking at.
 *
 * The fix is to shrink the mirror's own font until the remote's grid fits.
 * Deliberately NOT a CSS transform: xterm derives every mouse coordinate from
 * `getBoundingClientRect()` divided by an unscaled cell width, so a scaled
 * mirror maps clicks to the wrong cell — and those clicks are not local
 * decoration, they leave as SGR mouse reports through `onData` → `paneWrite`
 * into a live remote shell. Changing the font size keeps xterm's own metrics
 * and the rendered size in agreement, so coordinates stay exact.
 *
 * This module is the arithmetic only, with no DOM in it, because that is the
 * part worth testing: jsdom reports every layout as zero, so a component test
 * cannot check the numbers.
 */

/** Below this the glyphs stop being glyphs; we crop instead of shrinking on.
 *  A grid that still overflows here keeps being clipped — the same outcome as
 *  before the fit existed, and the user's remedy is a wider window. */
export const MIN_MIRROR_FONT_SIZE = 6;

/** Font sizes are quantised to this, so a 1px box jitter cannot restyle the
 *  terminal (each restyle re-measures the char and clears xterm's width cache). */
export const FONT_STEP = 0.5;

/** How many measure→apply passes one box size is allowed. Pass 1 is the linear
 *  prediction; the rest only ever shrink (see {@link computeMirrorFontSize}),
 *  so this is a belt-and-braces bound, not the termination argument. */
export const MAX_FIT_PASSES = 3;

export interface MirrorFitInput {
  /** Content box of the cell the mirror sits in, CSS px. 0 while hidden. */
  boxWidth: number;
  boxHeight: number;
  /** The remote's grid. */
  cols: number;
  rows: number;
  /** Rendered size of that grid RIGHT NOW, CSS px — `.xterm-screen`'s layout
   *  box. 0 while the mirror is inside a `display:none` subtree. */
  renderedWidth: number;
  renderedHeight: number;
  /** The font size `renderedWidth`/`renderedHeight` were produced at. */
  currentFontSize: number;
  /** The user's terminal font size. The fit never grows past it — a mirror is
   *  not allowed to be bigger than a local pane, only smaller. */
  maxFontSize: number;
  /** The size this box already settled on, if a previous pass ran for the SAME
   *  box. Present means "only accept a strictly smaller answer" (see below). */
  settledFontSize?: number;
}

export interface MirrorFitResult {
  /** The font size to apply, or null for "nothing to do": hidden, unmeasured,
   *  a degenerate grid, or a later pass that did not want to shrink further.
   *  The caller leaves the terminal alone and waits for the next measurement. */
  fontSize: number | null;
}

/**
 * Everything the answer depends on, as one comparable string.
 *
 * The caller restarts its fit whenever this changes and forbids growing while
 * it does not, so anything left out here is an input whose change the fit will
 * ignore. `fontFamily` is in it because a different face has different cell
 * metrics: leave it out and switching to a wider font re-overflows the box
 * with the shrink guard still holding the old, now-wrong, answer.
 */
export function mirrorFitKey(parts: {
  boxWidth: number;
  boxHeight: number;
  cols: number;
  rows: number;
  maxFontSize: number;
  fontFamily: string;
}): string {
  const { boxWidth, boxHeight, cols, rows, maxFontSize, fontFamily } = parts;
  return `${boxWidth}x${boxHeight}x${cols}x${rows}x${maxFontSize}x${fontFamily}`;
}

/**
 * When the mirror may ask the remote to resize again: once per box size, font
 * ceiling and face — the inputs that decide what grid the box holds.
 *
 * Deliberately NOT {@link mirrorFitKey}: that one carries the remote grid, and
 * the remote grid is exactly what a granted request changes. Keyed on it, every
 * grant re-armed the request, and because the ideal grid was re-derived from a
 * font the fit had just changed, the next answer could be a cell or two off the
 * last — so the mirror and the remote traded two grids forever, delivering a
 * SIGWINCH to the remote app on every swap. A remote-side change (a grant, or
 * someone re-gridding the pane on the host) is never a reason to ask again.
 */
export function mirrorResizeRequestKey(parts: {
  boxWidth: number;
  boxHeight: number;
  maxFontSize: number;
  fontFamily: string;
}): string {
  const { boxWidth, boxHeight, maxFontSize, fontFamily } = parts;
  return `${boxWidth}x${boxHeight}x${maxFontSize}x${fontFamily}`;
}

/** A remote grid within this many cells of the ideal in both axes is left
 *  alone: the font fit absorbs a one-cell residue, while a resize costs the
 *  remote app a SIGWINCH and a full repaint. */
export const REMOTE_RESIZE_HYSTERESIS_CELLS = 1;

/** Whether `ideal` is far enough from the remote's current grid to be worth a
 *  resize request (see {@link REMOTE_RESIZE_HYSTERESIS_CELLS}). */
export function shouldRequestRemoteResize(
  ideal: { cols: number; rows: number },
  cols: number,
  rows: number,
): boolean {
  return Math.abs(ideal.cols - cols) > REMOTE_RESIZE_HYSTERESIS_CELLS
    || Math.abs(ideal.rows - rows) > REMOTE_RESIZE_HYSTERESIS_CELLS;
}

/**
 * Pick the font size at which `cols × rows` fits inside the box.
 *
 * Pass 1 is a linear prediction: cell width is very nearly proportional to font
 * size, so `boxWidth / (cols × pxPerFontUnit)` lands within a rounding step of
 * the answer. It is only *nearly* proportional — xterm rounds cell metrics
 * through `ceil`/`floor` and the device pixel ratio, so the true relationship is
 * a staircase — which is why the caller re-measures and calls again.
 *
 * Later passes for the same box pass `settledFontSize`, and this function then
 * refuses to grow. Without that rule the staircase oscillates: shrink until it
 * fits, and the next prediction (made from the now-smaller cells) says a larger
 * font would fit too, forever. Monotone shrinking per box size is what makes the
 * loop terminate; the box changing is what lets it grow again.
 *
 * A residue smaller than one cell is left to the enclosing `overflow-hidden` —
 * losing two pixels off the last column is not a symptom anyone can see, and
 * chasing it would restyle the terminal on every frame.
 */
export function computeMirrorFontSize(input: MirrorFitInput): MirrorFitResult {
  const {
    boxWidth, boxHeight, cols, rows,
    renderedWidth, renderedHeight,
    currentFontSize, maxFontSize, settledFontSize,
  } = input;

  // Hidden, not yet laid out, or a grid that cannot be divided by. All of these
  // are "ask again later", NOT "shrink to nothing" — a `display:none` mirror
  // measures 0×0, and 0/0 would otherwise come back as NaN and be assigned.
  // Non-finite inputs land here too: NaN fails every comparison.
  const measurable =
    boxWidth > 0 && boxHeight > 0 &&
    renderedWidth > 0 && renderedHeight > 0 &&
    cols > 0 && rows > 0 && currentFontSize > 0 &&
    Number.isFinite(boxWidth) && Number.isFinite(boxHeight) &&
    Number.isFinite(renderedWidth) && Number.isFinite(renderedHeight);
  if (!measurable) return { fontSize: null };

  // A settings value restored from disk is not validated on its way into the
  // store, so a corrupt session can hand us a zero or negative ceiling. Taking
  // it literally would put the fit permanently below its own floor and silently
  // disable it; the floor wins instead.
  const ceiling = Math.max(MIN_MIRROR_FONT_SIZE, Number.isFinite(maxFontSize) ? maxFontSize : 0);

  // px of rendered grid per unit of font size, measured rather than assumed.
  const widthPerFontUnit = renderedWidth / currentFontSize;
  const heightPerFontUnit = renderedHeight / currentFontSize;

  const wanted = quantise(Math.min(
    boxWidth / widthPerFontUnit,
    boxHeight / heightPerFontUnit,
    ceiling,
  ));
  const fontSize = Math.max(MIN_MIRROR_FONT_SIZE, wanted);

  // Later pass on an unchanged box: shrink or stay put, never grow.
  if (settledFontSize !== undefined && fontSize >= settledFontSize) {
    return { fontSize: null };
  }
  return { fontSize };
}

/** Round DOWN to a FONT_STEP multiple — rounding up would re-overflow the box. */
function quantise(size: number): number {
  return Math.floor(size / FONT_STEP) * FONT_STEP;
}

/**
 * The grid (cols × rows) that would fill the box AT THE USER'S OWN FONT SIZE
 * — i.e. without the font-shrink `computeMirrorFontSize` performs.
 *
 * The two functions answer different halves of the same problem. Font-shrink
 * is the fallback: it never touches the remote and always works, but a
 * grid smaller than the box stays small (letterboxed) and a grid bigger than
 * the box renders unreadably tiny. This function is the input to the
 * PREFERRED fix (#1322): ask the remote daemon to resize its PTY to a grid
 * that actually fills the box (`RemoteMirrorTerminal`'s `requestRemoteResize`),
 * so the remote reflows its own output at the new width instead of this
 * mirror silently misrepresenting a still-differently-sized session through a
 * shrunk or oversized font.
 *
 * Prefers `ceilingCell`, the cell size MEASURED while the mirror was drawn at
 * `maxFontSize`. Without it, the cell size is extrapolated from the CURRENT
 * render (px per font unit) — the same approximation `computeMirrorFontSize`
 * uses for its pass-1 prediction. That approximation is not good enough to ask
 * a remote for a grid with: xterm's cell size is a staircase in the font size
 * (`ceil`/`floor` through the device pixel ratio), so extrapolating from a
 * shrunk font lands a cell or two away from the real answer, and a different
 * shrunk font lands somewhere else. The caller must therefore not re-ask on
 * every remote grid change — see {@link mirrorResizeRequestKey}.
 */
export function computeMirrorGeometry(input: {
  boxWidth: number;
  boxHeight: number;
  cols: number;
  rows: number;
  renderedWidth: number;
  renderedHeight: number;
  currentFontSize: number;
  maxFontSize: number;
  /** Cell size (CSS px) measured at `maxFontSize` for the current face. */
  ceilingCell?: { width: number; height: number };
}): { cols: number; rows: number } | null {
  const {
    boxWidth, boxHeight, cols, rows,
    renderedWidth, renderedHeight, currentFontSize, maxFontSize, ceilingCell,
  } = input;

  const measurable =
    boxWidth > 0 && boxHeight > 0 &&
    renderedWidth > 0 && renderedHeight > 0 &&
    cols > 0 && rows > 0 && currentFontSize > 0 &&
    Number.isFinite(boxWidth) && Number.isFinite(boxHeight) &&
    Number.isFinite(renderedWidth) && Number.isFinite(renderedHeight);
  if (!measurable) return null;

  const ceiling = Math.max(MIN_MIRROR_FONT_SIZE, Number.isFinite(maxFontSize) ? maxFontSize : 0);

  // The measured ceiling cell when there is one; otherwise the cell size at the
  // CURRENT font, extrapolated to the ceiling (only "very nearly" right).
  const measured = ceilingCell
    && Number.isFinite(ceilingCell.width) && Number.isFinite(ceilingCell.height)
    && ceilingCell.width > 0 && ceilingCell.height > 0;
  const cellWidthAtCeiling = measured
    ? ceilingCell.width
    : (renderedWidth / currentFontSize) * (ceiling / cols);
  const cellHeightAtCeiling = measured
    ? ceilingCell.height
    : (renderedHeight / currentFontSize) * (ceiling / rows);
  if (!(cellWidthAtCeiling > 0) || !(cellHeightAtCeiling > 0)) return null;

  const idealCols = Math.floor(boxWidth / cellWidthAtCeiling);
  const idealRows = Math.floor(boxHeight / cellHeightAtCeiling);
  if (idealCols <= 0 || idealRows <= 0) return null;
  return { cols: idealCols, rows: idealRows };
}
