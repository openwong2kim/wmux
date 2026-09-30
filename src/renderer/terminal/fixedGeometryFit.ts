/**
 * A FitAddon for a terminal whose grid someone else owns.
 *
 * The browser build of the renderer (wmux web) shows panes whose cols/rows are
 * set by the desktop: while the desk is showing a pane, the daemon refuses any
 * other viewer's resize (`409 desk-owns-size`). A normal fit would size the
 * grid to the browser's container and then disagree with every
 * absolute-positioned frame the pane's app draws. So this addon inverts the
 * fit: the grid is fixed to the owner's cols/rows, and the FONT SIZE is chosen
 * so that grid fits the container. No CSS transform — scaling the element
 * would leave xterm's mouse coordinates pointing at the wrong cells.
 *
 * It replaces FitAddon in place, so every fit site in useTerminal (mount,
 * ResizeObserver, fonts.ready, visibility, font/theme) applies the fixed grid
 * without a per-site branch. `proposeDimensions()` answers with the fixed
 * geometry, which is also what the sites' floor gates read.
 *
 * With no geometry (the getter returns null) it behaves exactly like FitAddon.
 */
import type { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

export interface FixedGeometry {
  cols: number;
  rows: number;
}

export const FIXED_FIT_MIN_FONT = 4;
export const FIXED_FIT_MAX_FONT = 24;
const FONT_STEP = 0.5;
/** xterm's own default scrollbar width (ViewportConstants.DEFAULT_SCROLL_BAR_WIDTH). */
const DEFAULT_SCROLL_BAR_WIDTH = 14;

interface CellSize { width: number; height: number }

/**
 * The rendered cell size. Read from xterm's PRIVATE render service — the same
 * field FitAddon itself reads; xterm has no public API for it. If an xterm
 * upgrade moves it, this returns null, the grid is still pinned and only the
 * font fit is skipped (with one warning); useTerminal.fixedGeometry.test pins
 * the path against the installed xterm so the move is caught in CI.
 */
export function cellSize(term: Terminal): CellSize | null {
  const dims = (term as unknown as {
    _core?: { _renderService?: { dimensions?: { css?: { cell?: CellSize } } } };
  })._core?._renderService?.dimensions?.css?.cell;
  if (!dims || !(dims.width > 0) || !(dims.height > 0)) return null;
  return { width: dims.width, height: dims.height };
}

/** The box FitAddon fits into — same arithmetic, so a pane the same size as
 *  the desktop's lands on the desktop's font size. */
function availableBox(term: Terminal): { width: number; height: number } | null {
  const el = term.element;
  const parent = el?.parentElement;
  if (!el || !parent) return null;
  const ps = window.getComputedStyle(parent);
  const es = window.getComputedStyle(el);
  const px = (v: string) => parseInt(v, 10) || 0;
  const scrollbar = term.options.scrollback === 0
    ? 0
    : (term.options.overviewRuler?.width || DEFAULT_SCROLL_BAR_WIDTH);
  const width = Math.max(0, px(ps.getPropertyValue('width')))
    - px(es.getPropertyValue('padding-left')) - px(es.getPropertyValue('padding-right')) - scrollbar;
  const height = px(ps.getPropertyValue('height'))
    - px(es.getPropertyValue('padding-top')) - px(es.getPropertyValue('padding-bottom'));
  return width > 0 && height > 0 ? { width, height } : null;
}

function isValid(g: FixedGeometry | null | undefined): g is FixedGeometry {
  return !!g && Number.isInteger(g.cols) && Number.isInteger(g.rows) && g.cols > 0 && g.rows > 0;
}

export class FixedGeometryFitAddon extends FitAddon {
  private term: Terminal | undefined;
  /** State the last font search settled on; an unchanged state skips the
   *  search, so the char-size refit a font change triggers cannot loop. */
  private settledKey = '';
  /** Fits in a row that found a laid-out box but no readable cell size. */
  private unreadable = 0;
  private warned = false;

  constructor(private readonly geometry: () => FixedGeometry | null | undefined) {
    super();
  }

  override activate(terminal: Terminal): void {
    super.activate(terminal);
    this.term = terminal;
  }

  override proposeDimensions(): { cols: number; rows: number } | undefined {
    const g = this.geometry();
    if (!isValid(g)) return super.proposeDimensions();
    if (!this.term?.element?.parentElement) return undefined;
    return { cols: g.cols, rows: g.rows };
  }

  override fit(): void {
    const g = this.geometry();
    if (!isValid(g)) {
      super.fit();
      return;
    }
    const term = this.term;
    if (!term?.element?.parentElement) return;
    if (term.cols !== g.cols || term.rows !== g.rows) term.resize(g.cols, g.rows);
    this.fitFont(term, g);
  }

  private stateKey(term: Terminal, g: FixedGeometry, box: { width: number; height: number }, cell: CellSize): string {
    return `${box.width}x${box.height}|${g.cols}x${g.rows}|${term.options.fontSize}|${cell.width}x${cell.height}`;
  }

  private fitFont(term: Terminal, g: FixedGeometry): void {
    const box = availableBox(term);
    const cell0 = box ? cellSize(term) : null;
    if (box && !cell0) {
      // Before the first render the size is legitimately missing; persisting
      // past a few fits means xterm's internals moved (see cellSize).
      this.unreadable += 1;
      if (this.unreadable >= 3 && !this.warned) {
        this.warned = true;
        console.warn('[wmux] xterm cell size unreadable; the grid stays pinned, the font size is not fitted');
      }
      return;
    }
    if (!box || !cell0) return;
    this.unreadable = 0;
    if (this.stateKey(term, g, box, cell0) === this.settledKey) return;

    const fits = (c: CellSize) => c.width * g.cols <= box.width && c.height * g.rows <= box.height;
    const setFont = (size: number): CellSize | null => {
      if (term.options.fontSize !== size) term.options.fontSize = size;
      return cellSize(term);
    };
    const clamp = (n: number) => Math.min(FIXED_FIT_MAX_FONT, Math.max(FIXED_FIT_MIN_FONT, n));
    const current = term.options.fontSize ?? 13;
    // Cell size scales close to linearly with the font size; start at that
    // estimate, then walk in half-point steps to the largest size that fits
    // (glyph metrics round, so the estimate alone can overshoot by a pixel).
    const ratio = Math.min(box.width / (cell0.width * g.cols), box.height / (cell0.height * g.rows));
    let size = clamp(Math.floor((current * ratio) / FONT_STEP) * FONT_STEP);
    let cell = setFont(size);
    for (let i = 0; i < 16 && cell && !fits(cell) && size > FIXED_FIT_MIN_FONT; i++) {
      size = clamp(size - FONT_STEP);
      cell = setFont(size);
    }
    for (let i = 0; i < 16 && cell && fits(cell) && size < FIXED_FIT_MAX_FONT; i++) {
      const next = setFont(clamp(size + FONT_STEP));
      if (!next || !fits(next)) {
        cell = setFont(size);
        break;
      }
      size = clamp(size + FONT_STEP);
      cell = next;
    }
    const settled = cellSize(term);
    this.settledKey = settled ? this.stateKey(term, g, box, settled) : '';
  }
}
