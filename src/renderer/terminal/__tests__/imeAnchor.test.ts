// @vitest-environment jsdom
/**
 * #874 — IME candidate-window anchoring; #942 — the composition pin is split
 * per child (textarea pinned, inline preedit live) so Korean inline
 * composition is never dragged onto committed cells.
 *
 * Three layers, because each catches a class the others cannot:
 *   1. Pure math, including a regression lock on the live-measured drift.
 *   2. attachImeAnchor against a hand-built DOM — listener wiring, composition
 *      freeze, write elision, dispose.
 *   3. A real xterm Terminal, which is the only thing that can prove our
 *      listeners run AFTER xterm's and that the `.xterm-screen > .xterm-helpers`
 *      DOM contract still holds, plus a source-level tripwire that fires when
 *      upstream fixes the bug we are compensating for.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  attachImeAnchor,
  computeImeAnchorCorrection,
  createRestingTracker,
  isUsableGeometry,
  noteCursorMove,
  paintedCursorPosition,
  parsePxOrNull,
  pointFromCell,
  resetRestingTracker,
  RESTING_MS,
  selectFreezeCell,
  type ImeAnchorBufferState,
  type ImeAnchorGeometry,
  type ImeAnchorTerminal,
} from '../imeAnchor';

const GEOM: ImeAnchorGeometry = { cellWidth: 10, cellHeight: 17.6, rows: 39, cols: 142 };

const buf = (over: Partial<ImeAnchorBufferState> = {}): ImeAnchorBufferState => ({
  cursorX: 0, cursorY: 0, baseY: 0, viewportY: 0, ...over,
});

describe('#874 anchor math', () => {
  it('pinned to the bottom (ydisp === ybase) needs no vertical correction', () => {
    const b = buf({ baseY: 22, viewportY: 22, cursorY: 38 });
    const desired = paintedCursorPosition(b, GEOM);
    // xterm's (buggy) anchor for the same state.
    const xtermTop = b.cursorY * GEOM.cellHeight;
    expect(desired.top).toBe(xtermTop);
    expect(computeImeAnchorCorrection(desired, { left: 0, top: xtermTop }).dy).toBe(0);
  });

  it('regression lock: the live-measured 8-row drift resolves to 140.8px', () => {
    // Measured over CDP against a running wmux build (2026-08-13):
    // ybase=22, ydisp=14, cursorY=38, cellHeight=17.6 -> xterm anchored row 38
    // while the WebGL renderer painted the cursor on row 46. driftRows = -8.
    const b = buf({ baseY: 22, viewportY: 14, cursorY: 38, cursorX: 12 });
    const geom = { ...GEOM, rows: 47 }; // tall enough that row 46 is in view
    const desired = paintedCursorPosition(b, geom);
    expect(desired.top).toBeCloseTo(46 * 17.6, 6);
    const xtermAnchor = { left: b.cursorX * geom.cellWidth, top: b.cursorY * geom.cellHeight };
    const { dx, dy } = computeImeAnchorCorrection(desired, xtermAnchor);
    expect(dx).toBe(0);
    expect(dy).toBeCloseTo(8 * 17.6, 6); // 140.8
  });

  it('clamps a cursor below the viewport to the last visible row', () => {
    // rows=39 but the painted row would be 46 — xterm stops syncing entirely
    // here, so an unclamped anchor would push the candidate window out of the
    // pane instead of parking it at the nearest edge.
    const b = buf({ baseY: 22, viewportY: 14, cursorY: 38 });
    expect(paintedCursorPosition(b, GEOM).top).toBe(38 * GEOM.cellHeight);
  });

  it('clamps a cursor above the viewport to row 0', () => {
    const b = buf({ baseY: 0, viewportY: 30, cursorY: 2 });
    expect(paintedCursorPosition(b, GEOM).top).toBe(0);
  });

  it('clamps a wrap-pending cursorX to cols - 1, matching xterm', () => {
    // CompositionHelper.ts:221 does Math.min(buffer.x, cols - 1); without the
    // same clamp the freeze would sit one cell too far right after a wrap.
    const b = buf({ cursorX: GEOM.cols });
    expect(paintedCursorPosition(b, GEOM).left).toBe((GEOM.cols - 1) * GEOM.cellWidth);
  });

  it('alt-screen (no scrollback) never needs a correction', () => {
    const b = buf({ baseY: 0, viewportY: 0, cursorY: 12, cursorX: 3 });
    const desired = paintedCursorPosition(b, GEOM);
    const xtermAnchor = { left: b.cursorX * GEOM.cellWidth, top: b.cursorY * GEOM.cellHeight };
    expect(computeImeAnchorCorrection(desired, xtermAnchor)).toEqual({ dx: 0, dy: 0 });
  });

  it('a correct upstream anchor collapses to zero (no double-correction after an xterm fix)', () => {
    const b = buf({ baseY: 22, viewportY: 14, cursorY: 20, cursorX: 4 });
    const desired = paintedCursorPosition(b, GEOM);
    // Pretend a future xterm places it right: actual === desired.
    expect(computeImeAnchorCorrection(desired, desired)).toEqual({ dx: 0, dy: 0 });
  });

  it('rejects unusable geometry', () => {
    expect(isUsableGeometry(GEOM)).toBe(true);
    expect(isUsableGeometry({ ...GEOM, cellHeight: 0 })).toBe(false);   // hidden pane
    expect(isUsableGeometry({ ...GEOM, rows: 0 })).toBe(false);         // divide-by-zero
    expect(isUsableGeometry({ ...GEOM, cellWidth: NaN })).toBe(false);
  });

  it('parses only px values, never xterm\'s -9999em parking spot', () => {
    expect(parsePxOrNull('140.8px')).toBeCloseTo(140.8, 6);
    expect(parsePxOrNull('-12px')).toBe(-12);
    // Legal CSS forms Chromium does not currently emit, accepted anyway so a
    // change upstream cannot silently switch the correction off.
    expect(parsePxOrNull('.5px')).toBe(0.5);
    expect(parsePxOrNull('+1px')).toBe(1);
    expect(parsePxOrNull('1e2px')).toBe(100);
    expect(parsePxOrNull('-1.5E-1px')).toBeCloseTo(-0.15, 6);
    expect(parsePxOrNull('-9999em')).toBeNull();
    expect(parsePxOrNull('0')).toBeNull();
    expect(parsePxOrNull('auto')).toBeNull();
    expect(parsePxOrNull('')).toBeNull();
    expect(parsePxOrNull(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

interface FakeSub { dispose(): void }
class FakeEmitter<T> {
  private listeners = new Set<(arg: T) => void>();
  readonly event = (listener: (arg: T) => void): FakeSub => {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  };
  fire(arg: T): void { for (const l of [...this.listeners]) l(arg); }
  get size(): number { return this.listeners.size; }
}

/** Parse the applied `translate(...)` back to numbers — comparing the CSS
 *  string would pin float formatting rather than behaviour. */
function translateOf(el: HTMLElement): { dx: number; dy: number } | null {
  const m = /^translate\((-?[\d.e-]+)px,\s*(-?[\d.e-]+)px\)$/.exec(el.style.transform);
  return m ? { dx: Number(m[1]), dy: Number(m[2]) } : null;
}

function buildTerminalDom(cellWidth = 10, cellHeight = 17.6, rows = 39, cols = 142): {
  root: HTMLElement; screen: HTMLElement; helpers: HTMLElement; textarea: HTMLTextAreaElement;
  compView: HTMLElement;
} {
  const root = document.createElement('div');
  root.className = 'xterm';
  const screen = document.createElement('div');
  screen.className = 'xterm-screen';
  const helpers = document.createElement('div');
  helpers.className = 'xterm-helpers';
  const textarea = document.createElement('textarea');
  textarea.className = 'xterm-helper-textarea';
  const compView = document.createElement('div');
  compView.className = 'composition-view';
  helpers.appendChild(textarea);
  helpers.appendChild(compView);
  screen.appendChild(helpers);
  root.appendChild(screen);
  document.body.appendChild(root);
  // jsdom has no layout; stand in for the measured cell grid.
  Object.defineProperty(screen, 'clientWidth', { value: cellWidth * cols, configurable: true });
  Object.defineProperty(screen, 'clientHeight', { value: cellHeight * rows, configurable: true });
  return { root, screen, helpers, textarea, compView };
}

function makeTerminal(dom: ReturnType<typeof buildTerminalDom>, rows = 39, cols = 142): {
  terminal: ImeAnchorTerminal;
  onRender: FakeEmitter<unknown>;
  onScroll: FakeEmitter<unknown>;
  onResize: FakeEmitter<unknown>;
  onCursorMove: FakeEmitter<unknown>;
  onBufferChange: FakeEmitter<unknown>;
  state: ImeAnchorBufferState;
} {
  const onRender = new FakeEmitter<unknown>();
  const onScroll = new FakeEmitter<unknown>();
  const onResize = new FakeEmitter<unknown>();
  const onCursorMove = new FakeEmitter<unknown>();
  const onBufferChange = new FakeEmitter<unknown>();
  const state = buf();
  const terminal: ImeAnchorTerminal = {
    rows, cols,
    textarea: dom.textarea,
    element: dom.root,
    buffer: { active: state, onBufferChange: onBufferChange.event },
    onRender: onRender.event,
    onScroll: onScroll.event,
    onResize: onResize.event,
    onCursorMove: onCursorMove.event,
  };
  return { terminal, onRender, onScroll, onResize, onCursorMove, onBufferChange, state };
}

describe('#874 attachImeAnchor', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('does nothing until xterm has positioned the textarea', () => {
    const dom = buildTerminalDom();
    const { terminal, onRender } = makeTerminal(dom);
    const handle = attachImeAnchor(terminal);
    onRender.fire(undefined);
    // style.left is still xterm's -9999em stylesheet default.
    expect(dom.textarea.style.transform).toBe('');
    handle.dispose();
  });

  it('corrects the scrolled-viewport drift on render', () => {
    const dom = buildTerminalDom(10, 17.6, 47);
    const { terminal, onRender, state } = makeTerminal(dom, 47);
    const handle = attachImeAnchor(terminal);
    Object.assign(state, { baseY: 22, viewportY: 14, cursorY: 38, cursorX: 12 });
    dom.textarea.style.top = `${38 * 17.6}px`;
    dom.textarea.style.left = `${12 * 10}px`;
    onRender.fire(undefined);
    expect(translateOf(dom.textarea)?.dx).toBe(0);
    expect(translateOf(dom.textarea)?.dy).toBeCloseTo(8 * 17.6, 6);
    handle.dispose();
  });

  it('corrects on scroll, which xterm never re-syncs at all', () => {
    const dom = buildTerminalDom(10, 17.6, 47);
    const { terminal, onScroll, state } = makeTerminal(dom, 47);
    const handle = attachImeAnchor(terminal);
    Object.assign(state, { baseY: 22, viewportY: 22, cursorY: 38, cursorX: 0 });
    dom.textarea.style.top = `${38 * 17.6}px`;
    dom.textarea.style.left = '0px';
    onScroll.fire(undefined);
    expect(dom.textarea.style.transform).toBe('');
    // User wheels up 4 rows. xterm leaves style.top alone; we absorb it.
    state.viewportY = 18;
    onScroll.fire(undefined);
    expect(translateOf(dom.textarea)?.dy).toBeCloseTo(4 * 17.6, 6);
    handle.dispose();
  });

  it('does not touch the DOM when the correction is unchanged', () => {
    const dom = buildTerminalDom();
    const { terminal, onRender, state } = makeTerminal(dom);
    const handle = attachImeAnchor(terminal);
    Object.assign(state, { cursorY: 5, cursorX: 2 });
    dom.textarea.style.top = `${5 * 17.6}px`;
    dom.textarea.style.left = '20px';
    onRender.fire(undefined);
    const spy = vi.spyOn(dom.textarea.style, 'transform', 'set');
    for (let i = 0; i < 60; i++) onRender.fire(undefined);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    handle.dispose();
  });

  it('freezes the anchor for the duration of a composition', () => {
    const dom = buildTerminalDom();
    const { terminal, onRender, state } = makeTerminal(dom);
    const handle = attachImeAnchor(terminal);
    Object.assign(state, { baseY: 0, viewportY: 0, cursorY: 30, cursorX: 8 });
    dom.textarea.style.top = `${30 * 17.6}px`;
    dom.textarea.style.left = '80px';
    onRender.fire(undefined);
    expect(dom.textarea.style.transform).toBe('');

    dom.textarea.dispatchEvent(new Event('compositionstart'));

    // The agent streams: the TUI parks the cursor 12 rows up and 40 cells left,
    // and xterm re-anchors the preedit there on every compositionupdate.
    Object.assign(state, { cursorY: 18, cursorX: 4 });
    dom.textarea.style.top = `${18 * 17.6}px`;
    dom.textarea.style.left = '40px';
    onRender.fire(undefined);

    // Candidate window must stay on row 30 / col 8 where the user started.
    expect(translateOf(dom.textarea)?.dx).toBeCloseTo(40, 6);
    expect(translateOf(dom.textarea)?.dy).toBeCloseTo(12 * 17.6, 6);
    // The pin covers the textarea only — the inline preedit is never dragged
    // by it (#942; xterm has not positioned the preedit here, so no live
    // correction exists either).
    expect(dom.compView.style.transform).toBe('');

    dom.textarea.dispatchEvent(new Event('compositionend'));
    onRender.fire(undefined);
    expect(dom.textarea.style.transform).toBe('');
    handle.dispose();
  });

  it('re-syncs behind xterm\'s own setTimeout(0) re-anchor on compositionupdate', async () => {
    const dom = buildTerminalDom();
    const { terminal, state } = makeTerminal(dom);
    const handle = attachImeAnchor(terminal);
    Object.assign(state, { cursorY: 20, cursorX: 0 });
    dom.textarea.style.top = `${20 * 17.6}px`;
    dom.textarea.style.left = '0px';
    dom.textarea.dispatchEvent(new Event('compositionstart'));

    dom.textarea.dispatchEvent(new Event('compositionupdate'));
    // Simulate xterm's deferred updateCompositionElements(true) moving it.
    dom.textarea.style.top = `${6 * 17.6}px`;
    await new Promise((r) => setTimeout(r, 1));
    expect(translateOf(dom.textarea)?.dy).toBeCloseTo(14 * 17.6, 6);
    handle.dispose();
  });

  it('refreshes cell geometry on resize instead of reading layout per frame', () => {
    const dom = buildTerminalDom(10, 17.6, 39);
    const { terminal, onResize, onRender, state } = makeTerminal(dom);
    const handle = attachImeAnchor(terminal);
    Object.assign(state, { baseY: 10, viewportY: 8, cursorY: 4, cursorX: 0 });
    dom.textarea.style.top = `${4 * 17.6}px`;
    dom.textarea.style.left = '0px';
    onRender.fire(undefined);
    expect(translateOf(dom.textarea)?.dy).toBeCloseTo(2 * 17.6, 6);
    // Font size bumped: cells get taller, and xterm re-anchors at the new
    // metrics. Our correction must track the new cell height, which it only
    // learns about from onResize (never from a per-frame layout read).
    Object.defineProperty(dom.screen, 'clientHeight', { value: 20 * 39, configurable: true });
    dom.textarea.style.top = `${4 * 20}px`;
    onResize.fire(undefined);
    expect(translateOf(dom.textarea)?.dy).toBeCloseTo(2 * 20, 6);
    handle.dispose();
  });

  it('prefers xterm\'s own cell height over the measured client box', () => {
    // xterm rounds the cell to whole device pixels; clientHeight/rows does not.
    // Using the layout number would leave a fractional correction on every
    // frame and put a transform on the element when nothing needs moving.
    const dom = buildTerminalDom(10, 17.59, 39);
    const { terminal, onRender, state } = makeTerminal(dom);
    const handle = attachImeAnchor(terminal);
    Object.assign(state, { baseY: 6, viewportY: 4, cursorY: 10, cursorX: 0 });
    dom.textarea.style.top = `${10 * 16}px`;
    dom.textarea.style.left = '0px';
    dom.textarea.style.height = '16px'; // what _syncTextArea writes
    onRender.fire(undefined);
    // Exactly two cells of drift at xterm's 16px, not 2 * 17.59.
    expect(translateOf(dom.textarea)?.dy).toBe(32);
    handle.dispose();
  });

  it('does not sample the cell height from a composition-resized textarea', () => {
    const dom = buildTerminalDom(10, 16, 39);
    const { terminal, onRender, state } = makeTerminal(dom);
    const handle = attachImeAnchor(terminal);
    Object.assign(state, { baseY: 6, viewportY: 4, cursorY: 10, cursorX: 0 });
    dom.textarea.style.top = `${10 * 16}px`;
    dom.textarea.style.left = '0px';
    dom.textarea.style.height = '16px';
    onRender.fire(undefined);
    expect(translateOf(dom.textarea)?.dy).toBe(32);

    dom.textarea.dispatchEvent(new Event('compositionstart'));
    // xterm now writes the preedit box height here, not a cell height.
    dom.textarea.style.height = '48px';
    onRender.fire(undefined);
    // Frozen at the composition-start row, and still using the 16px cell.
    expect(translateOf(dom.textarea)?.dy).toBe(32);
    handle.dispose();
  });

  it('stays inert on a hidden pane (zero-sized cells)', () => {
    const dom = buildTerminalDom(0, 0, 39);
    const { terminal, onRender, state } = makeTerminal(dom);
    const handle = attachImeAnchor(terminal);
    Object.assign(state, { baseY: 22, viewportY: 14, cursorY: 38 });
    dom.textarea.style.top = '0px';
    dom.textarea.style.left = '0px';
    onRender.fire(undefined);
    expect(dom.textarea.style.transform).toBe('');
    handle.dispose();
  });

  it('reports a start diagnostic per composition and stays quiet while nothing changes', () => {
    const dom = buildTerminalDom(10, 17.6, 47);
    const { terminal, state } = makeTerminal(dom, 47);
    const diag = vi.fn();
    const handle = attachImeAnchor(terminal, { onCompositionDiagnostic: diag });
    Object.assign(state, { baseY: 22, viewportY: 14, cursorY: 38, cursorX: 12 });
    dom.textarea.style.top = `${38 * 17.6}px`;
    dom.textarea.style.left = '120px';
    dom.textarea.dispatchEvent(new Event('compositionstart'));
    expect(diag).toHaveBeenCalledTimes(1);
    expect(diag.mock.calls[0][0]).toMatchObject({ phase: 'start', baseY: 22, viewportY: 14, cursorY: 38, cursorX: 12 });
    expect(diag.mock.calls[0][0].dy).toBeCloseTo(140.8, 6);
    // An update with no correction change is change-gated out (#942 made the
    // diagnostic fire mid-composition, but only when there is news).
    dom.textarea.dispatchEvent(new Event('compositionupdate'));
    expect(diag).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it('dispose unsubscribes everything and clears the transform', () => {
    const dom = buildTerminalDom();
    const { terminal, onRender, onScroll, onResize, onCursorMove, onBufferChange, state } = makeTerminal(dom);
    const handle = attachImeAnchor(terminal);
    Object.assign(state, { baseY: 10, viewportY: 5, cursorY: 4, cursorX: 0 });
    dom.textarea.style.top = `${4 * 17.6}px`;
    dom.textarea.style.left = '0px';
    onRender.fire(undefined);
    expect(dom.textarea.style.transform).not.toBe('');

    handle.dispose();
    expect(dom.textarea.style.transform).toBe('');
    expect(dom.compView.style.transform).toBe('');
    expect(onRender.size).toBe(0);
    expect(onScroll.size).toBe(0);
    expect(onResize.size).toBe(0);
    expect(onCursorMove.size).toBe(0);
    expect(onBufferChange.size).toBe(0);
    // A composition after dispose must not resurrect the transform.
    dom.textarea.dispatchEvent(new Event('compositionstart'));
    onRender.fire(undefined);
    expect(dom.textarea.style.transform).toBe('');
  });

  it('is a no-op when the helper container is missing', () => {
    const root = document.createElement('div');
    const textarea = document.createElement('textarea');
    const terminal = {
      rows: 39, cols: 142, textarea, element: root,
      buffer: { active: buf(), onBufferChange: new FakeEmitter<unknown>().event },
      onRender: new FakeEmitter<unknown>().event,
      onScroll: new FakeEmitter<unknown>().event,
      onResize: new FakeEmitter<unknown>().event,
      onCursorMove: new FakeEmitter<unknown>().event,
    } as ImeAnchorTerminal;
    expect(() => attachImeAnchor(terminal).dispose()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe('#942 inline preedit (Korean IME) — the pin never drags the preedit', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  /** Typing at an idle prompt: caret at (row, col), both children positioned
   *  there by xterm, then a composition starts. */
  function composeAt(row: number, col: number): {
    dom: ReturnType<typeof buildTerminalDom>;
    t: ReturnType<typeof makeTerminal>;
    handle: { dispose(): void };
    diag: ReturnType<typeof vi.fn>;
    positionChildren: (r: number, c: number) => void;
  } {
    const dom = buildTerminalDom();
    const t = makeTerminal(dom);
    const diag = vi.fn();
    Object.assign(t.state, { baseY: 0, viewportY: 0, cursorY: row, cursorX: col });
    const positionChildren = (r: number, c: number): void => {
      dom.textarea.style.top = `${r * 17.6}px`;
      dom.textarea.style.left = `${c * 10}px`;
      dom.compView.style.top = `${r * 17.6}px`;
      dom.compView.style.left = `${c * 10}px`;
    };
    positionChildren(row, col);
    const handle = attachImeAnchor(t.terminal, { onCompositionDiagnostic: diag });
    dom.textarea.dispatchEvent(new Event('compositionstart'));
    return { dom, t, handle, diag, positionChildren };
  }

  it('a committed syllable\'s echo advances the caret: preedit follows, textarea stays pinned', () => {
    // 대한민국 on Korean Microsoft IME: 민 is composing at col 23 when the echo
    // of the committed 한 lands. The buffer cursor advances two cells and xterm
    // re-anchors BOTH children to the live caret on the next compositionupdate.
    // The candidate-window pin must hold the textarea at the start cell — and
    // must NOT haul the visible preedit back onto the syllable that just
    // committed (the #942 symptom: 대한민국 reads 대한국 while typing).
    const { dom, t, handle, positionChildren } = composeAt(30, 23);
    expect(dom.textarea.style.transform).toBe('');
    expect(dom.compView.style.transform).toBe('');

    // Echo arrives: cursor advances past the pinned cell, cells repaint.
    Object.assign(t.state, { cursorX: 25 });
    t.onRender.fire(undefined);
    // The preedit is corrected forward onto the live caret even before xterm's
    // next reposition; the pinned textarea has nothing to move yet.
    expect(translateOf(dom.compView)?.dx).toBeCloseTo(2 * 10, 6);
    expect(dom.textarea.style.transform).toBe('');

    // Next compositionupdate: xterm re-anchors both children to the live caret.
    positionChildren(30, 25);
    dom.textarea.dispatchEvent(new Event('compositionupdate'));
    // Textarea pinned back to the start cell (candidate-window anchor stays
    // where the user started typing)…
    expect(translateOf(dom.textarea)?.dx).toBeCloseTo(-2 * 10, 6);
    // …while the preedit stays on the live caret: zero correction. Under the
    // #875 container transform both children were dragged back to col 23,
    // painting the composing syllable over the committed one.
    expect(dom.compView.style.transform).toBe('');

    dom.textarea.dispatchEvent(new Event('compositionend'));
    // Composition over: xterm hides the preedit, the pin dissolves, the real
    // cells repaint — nothing left to correct on either child.
    expect(dom.textarea.style.transform).toBe('');
    expect(dom.compView.style.transform).toBe('');
    handle.dispose();
  });

  it('while composing scrolled up, the preedit gets the same ydisp correction as the textarea', () => {
    // Cause 1 applies to the preedit too: xterm anchors it ybase-relative while
    // the renderer paints ydisp-relative. The split must not lose that.
    const dom = buildTerminalDom(10, 17.6, 47);
    const t = makeTerminal(dom, 47);
    const handle = attachImeAnchor(t.terminal);
    Object.assign(t.state, { baseY: 22, viewportY: 14, cursorY: 38, cursorX: 12 });
    dom.textarea.style.top = `${38 * 17.6}px`;
    dom.textarea.style.left = '120px';
    dom.compView.style.top = `${38 * 17.6}px`;
    dom.compView.style.left = '120px';
    dom.textarea.dispatchEvent(new Event('compositionstart'));
    expect(translateOf(dom.textarea)?.dy).toBeCloseTo(8 * 17.6, 6);
    expect(translateOf(dom.compView)?.dy).toBeCloseTo(8 * 17.6, 6);
    handle.dispose();
  });

  it('diagnostic: change-gated update/end records capture a mid-composition offset', () => {
    // #942's field log was 40/41 correction=(0,0): the start-only diagnostic
    // fired before the committed syllable's echo moved anything. The update
    // and end phases exist so this class of report is self-diagnosing.
    const { dom, t, handle, diag, positionChildren } = composeAt(30, 23);
    expect(diag).toHaveBeenCalledTimes(1);
    expect(diag.mock.calls[0][0]).toMatchObject({ phase: 'start', dx: 0, dy: 0, preeditDx: 0, preeditDy: 0 });

    Object.assign(t.state, { cursorX: 25 });
    t.onRender.fire(undefined);
    expect(diag).toHaveBeenCalledTimes(2);
    expect(diag.mock.calls[1][0]).toMatchObject({ phase: 'update', dx: 0 });
    expect(diag.mock.calls[1][0].preeditDx).toBeCloseTo(2 * 10, 6);

    positionChildren(30, 25);
    dom.textarea.dispatchEvent(new Event('compositionupdate'));
    expect(diag).toHaveBeenCalledTimes(3);
    expect(diag.mock.calls[2][0]).toMatchObject({ phase: 'update', preeditDx: 0 });
    expect(diag.mock.calls[2][0].dx).toBeCloseTo(-2 * 10, 6);

    // A quiet frame adds no record.
    t.onRender.fire(undefined);
    expect(diag).toHaveBeenCalledTimes(3);

    dom.textarea.dispatchEvent(new Event('compositionend'));
    expect(diag).toHaveBeenCalledTimes(4);
    expect(diag.mock.calls[3][0]).toMatchObject({ phase: 'end', dx: 0, dy: 0, preeditDx: 0, preeditDy: 0 });

    // Post-composition renders never report.
    t.onRender.fire(undefined);
    expect(diag).toHaveBeenCalledTimes(4);
    handle.dispose();
  });

  it('a missing .composition-view degrades to stock preedit behavior, not a crash', () => {
    const dom = buildTerminalDom();
    dom.compView.remove();
    const t = makeTerminal(dom);
    const handle = attachImeAnchor(t.terminal);
    Object.assign(t.state, { cursorY: 30, cursorX: 23 });
    dom.textarea.style.top = `${30 * 17.6}px`;
    dom.textarea.style.left = '230px';
    dom.textarea.dispatchEvent(new Event('compositionstart'));
    Object.assign(t.state, { cursorX: 25 });
    expect(() => t.onRender.fire(undefined)).not.toThrow();
    expect(dom.textarea.style.transform).toBe('');
    handle.dispose();
  });
});

// ---------------------------------------------------------------------------

describe('#874 resting-cell tracker (cause 3, pure)', () => {
  it('pointFromCell and paintedCursorPosition agree (delegation)', () => {
    const b = buf({ baseY: 22, viewportY: 14, cursorY: 38, cursorX: 12 });
    const geom = { ...GEOM, rows: 47 };
    expect(paintedCursorPosition(b, geom)).toEqual(
      pointFromCell(b.baseY + b.cursorY, b.cursorX, b, geom),
    );
  });

  it('pointFromCell clamps rows into the viewport and a wrap-pending col', () => {
    const b = buf({ viewportY: 30 });
    // Above the viewport -> row 0; below -> last row; col === cols -> cols - 1.
    expect(pointFromCell(2, 0, b, GEOM).top).toBe(0);
    expect(pointFromCell(200, 0, b, GEOM).top).toBe((GEOM.rows - 1) * GEOM.cellHeight);
    expect(pointFromCell(30, GEOM.cols, b, GEOM).left).toBe((GEOM.cols - 1) * GEOM.cellWidth);
  });

  it('a bootstrap-seeded tracker reads as at-rest (no null hole before the first move)', () => {
    const t = createRestingTracker(30, 8, 1000);
    const sel = selectFreezeCell(t, 30, 8, 1005);
    // held < RESTING_MS but there is no resting cell yet — instantaneous wins.
    expect(sel).toMatchObject({ absRow: 30, col: 8, src: 'instant', restAge: -1 });
  });

  it('a burst of sub-threshold moves never promotes a resting cell', () => {
    const t = createRestingTracker(30, 8, 1000);
    noteCursorMove(t, 49, 113, 1000 + RESTING_MS); // 30,8 held exactly RESTING_MS -> promoted
    expect(t.hasResting).toBe(true);
    noteCursorMove(t, 49, 0, 1000 + RESTING_MS + 2);   // 49,113 held 2ms -> not promoted
    noteCursorMove(t, 50, 0, 1000 + RESTING_MS + 5);   // 49,0 held 3ms -> not promoted
    expect(t.lastRestingAbsRow).toBe(30);
    expect(t.lastRestingCol).toBe(8);
  });

  it('same-cell events are no-ops (the dwell clock keeps running)', () => {
    const t = createRestingTracker(30, 8, 1000);
    noteCursorMove(t, 30, 8, 1010);
    expect(t.currentSince).toBe(1000);
    // Leaving after a long same-cell run still promotes from the ORIGINAL entry time.
    noteCursorMove(t, 49, 113, 1100);
    expect(t.hasResting).toBe(true);
    expect(t.lastRestingAbsRow).toBe(30);
  });

  it('selectFreezeCell: at-rest cursor is trusted, mid-burst falls back to the resting cell', () => {
    const t = createRestingTracker(30, 8, 1000);
    noteCursorMove(t, 49, 113, 1100); // caret promoted, cursor parked at 49,113
    // 5ms after the park: mid-burst -> resting cell.
    const midBurst = selectFreezeCell(t, 49, 113, 1105);
    expect(midBurst).toEqual({ absRow: 30, col: 8, src: 'resting', held: 5, restAge: 5 });
    // 100ms after the park: the parked cell is now at rest -> trusted as-is
    // (the documented cause-3 residual: dwell cannot tell a caret from a parked
    // cell — the diagnostic fields are the field-log discriminator).
    const atRest = selectFreezeCell(t, 49, 113, 1200);
    expect(atRest).toMatchObject({ absRow: 49, col: 113, src: 'instant', held: 100 });
  });

  it('resetRestingTracker drops the resting cell across a reflow boundary', () => {
    const t = createRestingTracker(30, 8, 1000);
    noteCursorMove(t, 49, 113, 1100);
    expect(t.hasResting).toBe(true);
    resetRestingTracker(t, 12, 0, 1105);
    expect(t.hasResting).toBe(false);
    // Mid-burst right after the reset: no resting cell -> instantaneous.
    expect(selectFreezeCell(t, 12, 0, 1106).src).toBe('instant');
  });

  it('rejects a resting cell that has scrolled off the viewport', () => {
    // Scrolling output (a build log, not an in-place TUI repaint) leaves the
    // resting cell above ydisp within a frame or two. pointFromCell would clamp
    // it to row 0 and park the candidate window at the top of the terminal —
    // worse than the live cursor, which is always on screen.
    const t = createRestingTracker(1000, 8, 1000);
    noteCursorMove(t, 3000, 0, 1100); // 1000,8 promoted; buffer has scrolled on
    const viewport = { top: 2960, rows: 40 }; // rows 2960..2999 are visible
    const sel = selectFreezeCell(t, 3000, 0, 1105, viewport);
    expect(sel).toMatchObject({ absRow: 3000, col: 0, src: 'scrolled_out' });
  });

  it('keeps a resting cell that is still inside the viewport', () => {
    // The in-place repaint case (ybase unchanged): both cells are on screen, so
    // the resting cell is still the caret and must win.
    const t = createRestingTracker(2990, 18, 1000);
    noteCursorMove(t, 2984, 6, 1100);
    const sel = selectFreezeCell(t, 2984, 6, 1105, { top: 2960, rows: 40 });
    expect(sel).toMatchObject({ absRow: 2990, col: 18, src: 'resting' });
  });

  it('without a viewport the off-screen guard does not fire (arg stays optional)', () => {
    const t = createRestingTracker(1000, 8, 1000);
    noteCursorMove(t, 3000, 0, 1100);
    expect(selectFreezeCell(t, 3000, 0, 1105).src).toBe('resting');
  });
});

describe('#874 resting-cell wiring (cause 3)', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  /** Attach with a controllable clock; park the caret, then burst the cursor away. */
  function scenario(): {
    dom: ReturnType<typeof buildTerminalDom>;
    t: ReturnType<typeof makeTerminal>;
    handle: { dispose(): void };
    diag: ReturnType<typeof vi.fn>;
    setClock: (ms: number) => void;
    parkCursorAt: (absRow: number, col: number) => void;
  } {
    const dom = buildTerminalDom(10, 17.6, 60);
    const t = makeTerminal(dom, 60);
    let clock = 1000;
    const diag = vi.fn();
    // Caret rests at row 30, col 8 from attach time.
    Object.assign(t.state, { baseY: 0, viewportY: 0, cursorY: 30, cursorX: 8 });
    const handle = attachImeAnchor(t.terminal, {
      now: () => clock,
      onCompositionDiagnostic: diag,
    });
    return {
      dom, t, handle, diag,
      setClock: (ms) => { clock = ms; },
      parkCursorAt: (absRow, col) => {
        Object.assign(t.state, { cursorY: absRow, cursorX: col });
        t.onCursorMove.fire(undefined);
        // Stand in for xterm's own (instantaneous) anchoring of the textarea.
        dom.textarea.style.top = `${absRow * 17.6}px`;
        dom.textarea.style.left = `${col * 10}px`;
      },
    };
  }

  it('a composition starting mid-burst anchors to the resting caret, not the parked cursor', () => {
    const { dom, handle, diag, setClock, parkCursorAt } = scenario();
    setClock(1100);
    parkCursorAt(49, 113); // TUI repaint parks the cursor bottom-right
    setClock(1105);        // 5ms later — inside the burst window
    dom.textarea.dispatchEvent(new Event('compositionstart'));
    // Anchor must land on the caret cell (30, 8): correction = desired - actual.
    expect(translateOf(dom.textarea)?.dy).toBeCloseTo((30 - 49) * 17.6, 6);
    expect(translateOf(dom.textarea)?.dx).toBeCloseTo((8 - 113) * 10, 6);
    expect(diag.mock.calls[0][0]).toMatchObject({
      src: 'resting', held: 5, restAge: 5, selY: 30, selX: 8, cursorY: 49, cursorX: 113,
    });
    handle.dispose();
  });

  it('a composition starting at rest keeps the #875 instantaneous behavior (regression lock)', () => {
    const { dom, handle, diag, setClock, parkCursorAt } = scenario();
    setClock(1100);
    parkCursorAt(30, 8); // no-op move: cursor is already the caret
    dom.textarea.style.top = `${30 * 17.6}px`;
    dom.textarea.style.left = '80px';
    setClock(1200); // held 200ms >= RESTING_MS
    dom.textarea.dispatchEvent(new Event('compositionstart'));
    // Pinned at bottom, cursor at rest: nothing to correct, no transform.
    expect(dom.textarea.style.transform).toBe('');
    expect(diag.mock.calls[0][0]).toMatchObject({ src: 'instant', selY: 30, selX: 8 });
    handle.dispose();
  });

  it('resize resets the tracker — no stale resting cell crosses a reflow', () => {
    const { dom, t, handle, diag, setClock, parkCursorAt } = scenario();
    setClock(1100);
    parkCursorAt(49, 113);
    t.onResize.fire(undefined); // reflow boundary between park and composition
    setClock(1105);
    dom.textarea.dispatchEvent(new Event('compositionstart'));
    expect(diag.mock.calls[0][0].src).toBe('instant'); // resting cell was dropped
    handle.dispose();
  });

  it('an alt-screen switch resets the tracker', () => {
    const { dom, t, handle, diag, setClock, parkCursorAt } = scenario();
    setClock(1100);
    parkCursorAt(49, 113);
    t.onBufferChange.fire(undefined);
    setClock(1105);
    dom.textarea.dispatchEvent(new Event('compositionstart'));
    expect(diag.mock.calls[0][0].src).toBe('instant');
    handle.dispose();
  });

  it('scrolling output past the resting cell falls back to the live cursor', () => {
    // The wiring passes the live viewport to the selection, so a resting cell
    // the output has scrolled away from is rejected instead of being clamped to
    // the top edge (dogfooded on the dev build with 20k lines of output).
    const { dom, t, handle, diag, setClock, parkCursorAt } = scenario();
    setClock(1100);
    parkCursorAt(49, 113);          // caret cell (30,8) promoted to resting
    Object.assign(t.state, { viewportY: 45 }); // …and then scrolled out of view
    setClock(1105);
    dom.textarea.dispatchEvent(new Event('compositionstart'));
    expect(diag.mock.calls[0][0]).toMatchObject({ src: 'scrolled_out', selY: 49, selX: 113 });
    handle.dispose();
  });
});

// ---------------------------------------------------------------------------

describe('#874 upstream contracts', () => {
  it('xterm still nests .xterm-helpers inside .xterm-screen', async () => {
    // The correction transforms .xterm-helpers and computes offsets in
    // .xterm-screen space. If an upgrade reparents the helpers, every number
    // this module produces is measured against the wrong origin.
    (window as unknown as { matchMedia: unknown }).matchMedia = () => ({
      matches: false, media: '', onchange: null,
      addListener: () => undefined, removeListener: () => undefined,
      addEventListener: () => undefined, removeEventListener: () => undefined,
      dispatchEvent: () => false,
    });
    (HTMLCanvasElement.prototype as unknown as { getContext: unknown }).getContext = () => ({
      measureText: () => ({ width: 8 }),
      fillRect: () => undefined, clearRect: () => undefined, fillText: () => undefined,
      getImageData: () => ({ data: new Uint8ClampedArray(4) }),
      putImageData: () => undefined, createImageData: () => ({ data: new Uint8ClampedArray(4) }),
      setTransform: () => undefined, drawImage: () => undefined, save: () => undefined,
      restore: () => undefined, beginPath: () => undefined, moveTo: () => undefined,
      lineTo: () => undefined, closePath: () => undefined, stroke: () => undefined,
      translate: () => undefined, scale: () => undefined, rotate: () => undefined,
      arc: () => undefined, fill: () => undefined,
    });
    const { Terminal } = await import('@xterm/xterm');
    const host = document.createElement('div');
    document.body.appendChild(host);
    const term = new Terminal();
    try {
      term.open(host);
      const screen = host.querySelector('.xterm-screen');
      const helpers = host.querySelector('.xterm-helpers');
      expect(screen).not.toBeNull();
      expect(helpers).not.toBeNull();
      expect(helpers!.parentElement).toBe(screen);
      expect(helpers!.querySelector('.xterm-helper-textarea')).not.toBeNull();
      // #942 splits the correction across the two children, so the preedit box
      // must still live here under this class — if an upgrade renames it, the
      // preedit silently loses its ydisp correction (degrades, not breaks).
      expect(helpers!.querySelector('.composition-view')).not.toBeNull();
      // Not yet positioned — the -9999em parking spot parsePxOrNull rejects.
      expect(parsePxOrNull((term.textarea as HTMLTextAreaElement).style.top)).toBeNull();
    } finally {
      term.dispose();
      host.remove();
    }
  });

  it('our composition listeners are registered after xterm\'s', () => {
    // xterm's CompositionHelper writes style.top/left from its own handler.
    // Ours must read what xterm wrote, so it has to run second. Registration
    // order on the same element is the only thing guaranteeing that, and
    // attachImeAnchor runs long after terminal.open().
    const dom = buildTerminalDom();
    const { terminal, state } = makeTerminal(dom);
    const order: string[] = [];
    // Stand in for xterm's handler: registered first, moves the children.
    dom.textarea.addEventListener('compositionstart', () => {
      order.push('xterm');
      dom.textarea.style.top = `${9 * 17.6}px`;
      dom.textarea.style.left = '0px';
    });
    Object.assign(state, { baseY: 4, viewportY: 0, cursorY: 9, cursorX: 0 });
    const handle = attachImeAnchor(terminal, {
      onCompositionDiagnostic: () => order.push('ours'),
    });
    dom.textarea.dispatchEvent(new Event('compositionstart'));
    expect(order).toEqual(['xterm', 'ours']);
    // 4 rows of scrollback offset, read against the value xterm just wrote.
    expect(translateOf(dom.textarea)?.dy).toBeCloseTo(4 * 17.6, 6);
    handle.dispose();
  });

  it('TRIPWIRE: upstream still anchors the IME without the ydisp term', () => {
    // The whole module exists to add `(ybase - ydisp)` back. When an xterm
    // upgrade fixes this upstream, `desired - actual` goes to zero on its own
    // (no double-correction), but the module becomes dead weight — this test
    // fails so somebody deletes it instead of carrying it forever.
    const read = (p: string): string =>
      fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', 'node_modules', '@xterm', 'xterm', 'src', p), 'utf8');

    const core = read(path.join('browser', 'CoreBrowserTerminal.ts'));
    const syncTextArea = /private _syncTextArea\(\): void \{[\s\S]*?\n {2}\}/.exec(core);
    expect(syncTextArea, '_syncTextArea not found — xterm internals moved').not.toBeNull();
    expect(syncTextArea![0]).toContain('const cursorTop = this.buffer.y *');
    expect(syncTextArea![0]).not.toContain('ydisp');

    const comp = read(path.join('browser', 'input', 'CompositionHelper.ts'));
    const update = /public updateCompositionElements\(dontRecurse\?: boolean\): void \{[\s\S]*?\n {2}\}/.exec(comp);
    expect(update, 'updateCompositionElements not found — xterm internals moved').not.toBeNull();
    expect(update![0]).toContain('const cursorTop = this._bufferService.buffer.y *');
    expect(update![0]).not.toContain('ydisp');
  });
});
