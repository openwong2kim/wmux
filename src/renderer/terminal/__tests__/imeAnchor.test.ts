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
  noteOutputParsed,
  OUTPUT_QUIET_MS,
  paintedCursorPosition,
  parsePxOrNull,
  pointFromCell,
  preeditFollowsLiveCursor,
  resetRestingTracker,
  RESTING_MS,
  scanClaudeInputLine,
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
  onWriteParsed: FakeEmitter<unknown>;
  onBufferChange: FakeEmitter<unknown>;
  state: ImeAnchorBufferState;
} {
  const onRender = new FakeEmitter<unknown>();
  const onScroll = new FakeEmitter<unknown>();
  const onResize = new FakeEmitter<unknown>();
  const onCursorMove = new FakeEmitter<unknown>();
  const onWriteParsed = new FakeEmitter<unknown>();
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
    onWriteParsed: onWriteParsed.event,
  };
  return { terminal, onRender, onScroll, onResize, onCursorMove, onWriteParsed, onBufferChange, state };
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
    const { terminal, onRender, onScroll, onResize, onCursorMove, onWriteParsed, onBufferChange, state } = makeTerminal(dom);
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
    expect(onWriteParsed.size).toBe(0);
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
      onWriteParsed: new FakeEmitter<unknown>().event,
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

    // Echo arrives: cursor advances past the pinned cell, cells repaint. The
    // render-path correction touches only the textarea; the preedit stays
    // where xterm put it until the next composition event, exactly like stock
    // xterm (following the per-frame cursor would chase mid-repaint
    // transients — see syncPreedit).
    Object.assign(t.state, { cursorX: 25 });
    t.onRender.fire(undefined);
    expect(dom.compView.style.transform).toBe('');
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

    // The echo alone changes nothing observable (the pin holds, the preedit
    // waits for the next composition event) — no record burned.
    Object.assign(t.state, { cursorX: 25 });
    t.onRender.fire(undefined);
    expect(diag).toHaveBeenCalledTimes(1);

    // The compositionupdate that follows develops the pin offset — recorded.
    positionChildren(30, 25);
    dom.textarea.dispatchEvent(new Event('compositionupdate'));
    expect(diag).toHaveBeenCalledTimes(2);
    expect(diag.mock.calls[1][0]).toMatchObject({ phase: 'update', preeditDx: 0 });
    expect(diag.mock.calls[1][0].dx).toBeCloseTo(-2 * 10, 6);

    // A quiet frame adds no record.
    t.onRender.fire(undefined);
    expect(diag).toHaveBeenCalledTimes(2);

    dom.textarea.dispatchEvent(new Event('compositionend'));
    expect(diag).toHaveBeenCalledTimes(3);
    expect(diag.mock.calls[2][0]).toMatchObject({ phase: 'end', dx: 0, dy: 0, preeditDx: 0, preeditDy: 0 });

    // Post-composition renders never report.
    t.onRender.fire(undefined);
    expect(diag).toHaveBeenCalledTimes(3);
    handle.dispose();
  });

  it('an agent streaming mid-composition never drags the preedit to transient cursors', () => {
    // The 2-model panel finding on the first cut of this fix: a per-frame
    // preedit follow re-opens cause 3 for the preedit. While a TUI repaints,
    // the buffer cursor parks mid-frame on real JS turns; renders during a
    // composition must leave the preedit where xterm put it.
    const { dom, t, handle, positionChildren } = composeAt(30, 23);
    positionChildren(30, 23);
    dom.textarea.dispatchEvent(new Event('compositionupdate'));
    expect(dom.compView.style.transform).toBe('');
    // TUI repaint parks the cursor far away for a frame, then puts it back.
    Object.assign(t.state, { cursorY: 5, cursorX: 100 });
    t.onRender.fire(undefined);
    expect(dom.compView.style.transform).toBe('');
    Object.assign(t.state, { cursorY: 30, cursorX: 23 });
    t.onRender.fire(undefined);
    expect(dom.compView.style.transform).toBe('');
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
    expect(midBurst).toEqual({ absRow: 30, col: 8, src: 'resting', held: 5, restAge: 5, outputGap: 105, caretAge: -1, edge: false });
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

describe('#951 quiet-caret tracker (pure)', () => {
  it('an output-free span promotes the spanning cell to the caret (no move yet this chunk)', () => {
    const t = createRestingTracker(640, 5, 1000, 40);
    // First chunk after 600ms of silence, onWriteParsed before any cursor
    // move was reported: the current cell spanned the quiet period.
    noteOutputParsed(t, 1000 + OUTPUT_QUIET_MS + 100);
    expect(t).toMatchObject({ hasCaret: true, caretRelRow: 40, caretCol: 5 });
  });

  it('covers the real xterm order too: cursor moves during the parse, writeParsed at batch end', () => {
    const t = createRestingTracker(640, 5, 1000, 40);
    // The batch's parse already parked the cursor elsewhere; the spanning cell
    // was promoted to the resting slot inside this same batch.
    noteCursorMove(t, 643, 127, 2000, 43);
    noteOutputParsed(t, 2000);
    expect(t).toMatchObject({ hasCaret: true, caretRelRow: 40, caretCol: 5 });
  });

  it('sub-quiet gaps never snapshot a caret', () => {
    const t = createRestingTracker(640, 5, 1000, 40);
    noteOutputParsed(t, 1000 + OUTPUT_QUIET_MS - 100);
    expect(t.hasCaret).toBe(false);
    // The clock still advanced — the next chunk measures from here.
    noteOutputParsed(t, 1000 + OUTPUT_QUIET_MS + 200);
    expect(t.hasCaret).toBe(false);
  });

  it('REGRESSION #951: a corner cell parked between stream bursts loses to the quiet caret', () => {
    // The field log scenario: 128x45 pane, caret on the input line (row 40),
    // Claude Code streaming. Between bursts the cursor sits on (127,43) far
    // longer than RESTING_MS — pre-#951 that dwell made it src=instant.
    const t = createRestingTracker(640, 5, 1000, 40);
    noteCursorMove(t, 643, 127, 2000, 43); // stream's first parse parks the corner
    noteOutputParsed(t, 2000);             // quiet span ended -> caret snapshot
    noteOutputParsed(t, 2300);             // stream keeps flowing…
    noteOutputParsed(t, 2700);             // …past the sustain threshold
    const sel = selectFreezeCell(t, 643, 127, 2760, { top: 600, rows: 45 }, 600);
    // held=760ms >= RESTING_MS would have certified the corner; output is only
    // 60ms old and has streamed for 760ms, so the caret wins.
    expect(sel).toMatchObject({ absRow: 640, col: 5, src: 'caret', outputGap: 60, caretAge: 760 });
  });

  it('an isolated echo burst keeps the freshly advanced cursor (fast-typist regression lock)', () => {
    // Quiet shell, user commits a syllable: the echo advances the cursor 4
    // cols. The echo IS recent output, but it is not a sustained stream — the
    // next composition must anchor on the advanced cursor, not the snapshot
    // taken before the word (which would drift further left every word).
    const t = createRestingTracker(640, 5, 1000, 40);
    noteCursorMove(t, 640, 9, 3000, 40); // echo parse advances the caret
    noteOutputParsed(t, 3000);           // snapshot exists, but epoch is fresh
    const sel = selectFreezeCell(t, 640, 9, 3200, { top: 600, rows: 45 }, 600);
    expect(sel).toMatchObject({ absRow: 640, col: 9, src: 'instant' });
  });

  it('the caret snapshot is a screen row: scrolled output rebases it onto the current ybase', () => {
    const t = createRestingTracker(640, 5, 1000, 40);
    noteOutputParsed(t, 1600); // snapshot at screen row 40 while ybase=600
    noteOutputParsed(t, 2000); // this output scrolled the buffer 10 rows on
    noteOutputParsed(t, 2300);
    const sel = selectFreezeCell(t, 655, 0, 2350, undefined, 610);
    expect(sel).toMatchObject({ absRow: 650, col: 5, src: 'caret' });
  });

  it('quiet output keeps the pre-#951 selection (regression lock)', () => {
    const t = createRestingTracker(30, 8, 1000, 30);
    noteOutputParsed(t, 1600); // a snapshot exists…
    // …but the last output is OUTPUT_QUIET_MS old: the parked cursor is the
    // TUI's own final position — trust it exactly as before.
    const sel = selectFreezeCell(t, 30, 8, 1600 + OUTPUT_QUIET_MS);
    expect(sel).toMatchObject({ absRow: 30, col: 8, src: 'instant', outputGap: OUTPUT_QUIET_MS });
  });

  it('streaming without a snapshot degrades to the resting/instant selection', () => {
    const t = createRestingTracker(640, 5, 1000, 40);
    noteCursorMove(t, 643, 127, 1100, 43); // mid-burst from the very first chunk
    noteOutputParsed(t, 1100);             // gap 100ms < quiet -> no caret ever
    const sel = selectFreezeCell(t, 643, 127, 1105, { top: 600, rows: 45 }, 600);
    expect(sel).toMatchObject({ absRow: 640, col: 5, src: 'resting' });
  });

  it('#953: a quiet line-end park is flagged edge=1 but NOT rerouted', () => {
    // Claude Code idling with an empty input box parks its real cursor at
    // the line end — (236,47) on a 237-col pane. Two fallback generations
    // (quiet snapshot, previous-composition anchor) both field-tested worse
    // than leaving the selection alone, so the park is only flagged for the
    // field log and the selection stays the instant cell.
    const t = createRestingTracker(640, 5, 1000, 40);
    noteCursorMove(t, 647, 236, 1100, 47);
    const sel = selectFreezeCell(t, 647, 236, 3000, { top: 600, rows: 48, cols: 237 }, 600);
    expect(sel).toMatchObject({ absRow: 647, col: 236, src: 'instant', edge: true });
  });

  it('#953: a line-end park defers to the snapshot while output is FLOWING', () => {
    // The reported streaming failure. A token-paced stream pauses longer than
    // OUTPUT_QUIET_MS between bursts, so `epochStart` keeps restarting and the
    // sustain gate is never met — yet a perfectly good snapshot exists, and
    // the live cursor is the TUI's line-end park. Anchoring there put the
    // candidate window in the pane's bottom-right corner.
    const t = createRestingTracker(640, 5, 1000, 40);
    noteOutputParsed(t, 1600);             // quiet span ends -> caret at (40,5)
    expect(t).toMatchObject({ hasCaret: true, caretCol: 5 });
    noteCursorMove(t, 647, 236, 1650, 47); // TUI parks at the line end
    noteOutputParsed(t, 1700);             // burst resumes; epoch is only 100ms old
    const sel = selectFreezeCell(t, 647, 236, 1750, { top: 600, rows: 48, cols: 237 }, 600);
    expect(sel).toMatchObject({ absRow: 640, col: 5, src: 'caret', edge: true });
  });

  it('#953: a mid-line cursor still waits out the sustain gate (commit echo)', () => {
    // The gate's actual job: a committed syllable's echo is recent output too,
    // and there the freshly moved cursor IS the caret. Nothing changes for it.
    const t = createRestingTracker(640, 5, 1000, 40);
    noteOutputParsed(t, 1600);
    noteCursorMove(t, 640, 100, 1650, 40);
    noteOutputParsed(t, 1700);
    const sel = selectFreezeCell(t, 640, 100, 1750, { top: 600, rows: 48, cols: 237 }, 600);
    expect(sel).toMatchObject({ absRow: 640, col: 100, src: 'instant', edge: false });
  });

  it('#953: a line-end park is refused as a snapshot, keeping the last good one', () => {
    // The field shape once the streaming path started using the snapshot:
    // `cursor=(13,36) sel=(127,43) src=caret` — the live cursor mid-line while
    // the snapshot pointed at the last column, so every composition anchored
    // bottom-right. A quiet span that finds the TUI parked there must keep the
    // caret the last real one recorded.
    const t = createRestingTracker(640, 5, 1000, 40);
    noteOutputParsed(t, 1600, 237);              // a real caret at (40,5)
    expect(t).toMatchObject({ hasCaret: true, caretRelRow: 40, caretCol: 5 });

    noteCursorMove(t, 647, 236, 1700, 47);       // TUI parks at the line end
    noteOutputParsed(t, 2300, 237);              // next quiet span spans it
    expect(t).toMatchObject({ hasCaret: true, caretRelRow: 40, caretCol: 5 });
  });

  it('#953: without a column count the refusal is off, not wrongly bounded', () => {
    // A caller with no geometry must keep the old behaviour rather than have
    // the check silently pick a bound and drop legitimate caret cells.
    const t = createRestingTracker(647, 236, 1000, 47);
    noteOutputParsed(t, 1600);
    expect(t).toMatchObject({ hasCaret: true, caretRelRow: 47, caretCol: 236 });
  });

  it('#953: a mid-line at-rest cursor keeps the instant selection, unflagged', () => {
    const t = createRestingTracker(640, 100, 1000, 40);
    noteOutputParsed(t, 1600);
    const sel = selectFreezeCell(t, 640, 100, 3400, { top: 600, rows: 48, cols: 237 }, 600);
    expect(sel).toMatchObject({ absRow: 640, col: 100, src: 'instant', edge: false });
  });

  it('a same-cell report still refreshes the screen row (scroll under a stationary cursor)', () => {
    // baseY up + cursorY down by the same amount keeps the absolute cell
    // identical while the screen row moves; the snapshot records screen rows,
    // so a quiet span after such a scroll must capture the fresh one.
    const t = createRestingTracker(640, 5, 1000, 40);
    noteCursorMove(t, 640, 5, 1010, 38); // same abs cell, screen row moved up 2
    expect(t.currentSince).toBe(1000);   // dwell clock untouched
    noteOutputParsed(t, 1600);
    expect(t).toMatchObject({ hasCaret: true, caretRelRow: 38, caretCol: 5 });
  });

  it('resetRestingTracker drops the caret across a reflow boundary and re-seeds the quiet clock', () => {
    const t = createRestingTracker(640, 5, 1000, 40);
    noteOutputParsed(t, 1600);
    expect(t.hasCaret).toBe(true);
    resetRestingTracker(t, 320, 0, 1650, 20);
    expect(t.hasCaret).toBe(false);
    // The quiet clock restarts at the reset: only silence observed entirely
    // in the new coordinate frame counts, AND the first post-reset quiet
    // chunk must be able to take the current-cell branch (currentSince ===
    // lastOutputAt) — preserving the old clock left `currentSince >
    // lastOutputAt` forever and the snapshot could never re-form on a pane
    // whose cursor stayed put (2-model panel finding).
    expect(t.lastOutputAt).toBe(1650);
    noteOutputParsed(t, 1650 + OUTPUT_QUIET_MS);
    expect(t).toMatchObject({ hasCaret: true, caretRelRow: 20, caretCol: 0 });
  });
});

describe('#951 quiet-caret wiring', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('a composition mid-stream anchors the candidate window to the quiet caret', () => {
    const dom = buildTerminalDom(10, 17.6, 45, 128);
    const t = makeTerminal(dom, 45, 128);
    let clock = 1000;
    const diag = vi.fn();
    // Caret parked on the TUI's input line (screen row 40) while idle.
    Object.assign(t.state, { baseY: 600, viewportY: 600, cursorY: 40, cursorX: 5 });
    const handle = attachImeAnchor(t.terminal, { now: () => clock, onCompositionDiagnostic: diag });
    // Stream's first batch after 1s of silence, in xterm's real order: the
    // parse parks the cursor on the corner, then onWriteParsed fires.
    clock = 2000;
    Object.assign(t.state, { cursorY: 43, cursorX: 127 });
    t.onCursorMove.fire(undefined);
    t.onWriteParsed.fire(undefined);
    // Stand in for xterm's own (instantaneous) anchoring of the textarea.
    dom.textarea.style.top = `${43 * 17.6}px`;
    dom.textarea.style.left = `${127 * 10}px`;
    clock = 2400;
    t.onWriteParsed.fire(undefined); // stream keeps flowing…
    clock = 2750;
    t.onWriteParsed.fire(undefined); // …past the sustain threshold
    clock = 2800; // corner held 800ms >= RESTING_MS — dwell alone would trust it
    dom.textarea.dispatchEvent(new Event('compositionstart'));
    expect(diag.mock.calls[0][0]).toMatchObject({
      src: 'caret', selY: 40, selX: 5, cursorY: 43, cursorX: 127, outputGap: 50, caretAge: 800,
    });
    expect(translateOf(dom.textarea)?.dy).toBeCloseTo((40 - 43) * 17.6, 6);
    expect(translateOf(dom.textarea)?.dx).toBeCloseTo((5 - 127) * 10, 6);
    // xterm re-anchors the inline preedit to the live cursor on every
    // compositionupdate. A caret-sourced composition must pull it back onto
    // the same frozen point as the textarea — the first quiet-caret build
    // left it on the live cursor, and the field report showed the pinyin
    // riding the agent's output rows while its candidate list sat at the
    // input line (the two IME surfaces torn apart).
    dom.compView.style.top = `${43 * 17.6}px`;
    dom.compView.style.left = `${127 * 10}px`;
    dom.textarea.dispatchEvent(new Event('compositionupdate'));
    expect(translateOf(dom.compView)?.dy).toBeCloseTo((40 - 43) * 17.6, 6);
    expect(translateOf(dom.compView)?.dx).toBeCloseTo((5 - 127) * 10, 6);
    handle.dispose();
  });
});

// ---------------------------------------------------------------------------

describe('#1016 input-line content scan (pure)', () => {
  const lines = (rows: string[]) => (r: number): string | undefined => rows[r];

  it('finds the prompt row under the box top border', () => {
    const screen = [
      'Some streamed output',
      '',
      '╭──────────────╮',
      '│ > 你好       │',
      '╰──────────────╯',
      '  ? for shortcuts',
    ];
    expect(scanClaudeInputLine(lines(screen), screen.length)).toEqual({ relRow: 3, col: 4 });
  });

  it('keeps the column honest on an indented box', () => {
    const screen = ['  ╭────╮', '  │ > x│'];
    expect(scanClaudeInputLine(lines(screen), screen.length)).toEqual({ relRow: 1, col: 6 });
  });

  it('the bottom-most match wins over quoted chrome in the transcript', () => {
    // An agent can print its own UI into the transcript; the live box is
    // always the bottom-most match.
    const screen = [
      '╭────────────╮',
      '│ > quoted   │',
      '╰────────────╯',
      'more output',
      '╭────────────╮',
      '│ > live     │',
      '╰────────────╯',
    ];
    expect(scanClaudeInputLine(lines(screen), screen.length)).toEqual({ relRow: 5, col: 4 });
  });

  it('a bare prompt-like line without the box top above is not matched', () => {
    const screen = ['output', '│ > printed by a program', 'output'];
    expect(scanClaudeInputLine(lines(screen), screen.length)).toBeNull();
  });

  it('wrapped multi-line input still anchors on the prompt row', () => {
    const screen = [
      '╭──────────────╮',
      '│ > first line │',
      '│   wrapped    │',
      '╰──────────────╯',
    ];
    expect(scanClaudeInputLine(lines(screen), screen.length)).toEqual({ relRow: 1, col: 4 });
  });

  it('bash and memory mode prompts are the same caret row', () => {
    // The live box must keep winning bottom-most while the user is in `!`
    // (bash) or `#` (memory) mode — otherwise a quoted `│ > ` in the
    // transcript above would take over.
    const bash = ['│ > quoted', '╭────╮', '│ ! ls│', '╰────╯'];
    expect(scanClaudeInputLine(lines(bash), bash.length)).toEqual({ relRow: 2, col: 4 });
    const memory = ['╭────╮', '│ # note│', '╰────╯'];
    expect(scanClaudeInputLine(lines(memory), memory.length)).toEqual({ relRow: 1, col: 4 });
  });

  it('returns null on an unreadable or markerless screen', () => {
    expect(scanClaudeInputLine(() => undefined, 40)).toBeNull();
    expect(scanClaudeInputLine(lines(['plain shell $']), 1)).toBeNull();
  });
});

describe('#1016 marker selection (pure)', () => {
  /** The 2026-08-23 field shape: the pane parked at (137,36) from the start,
   *  so the quiet span certifies the park itself as the snapshot — at column
   *  137 of a 139-column pane, which no column bound can refuse. */
  const parkSnapshotTracker = (): ReturnType<typeof createRestingTracker> => {
    const t = createRestingTracker(676, 137, 1000, 36);
    noteOutputParsed(t, 1600, 139); // quiet span ends -> the park IS the snapshot
    noteOutputParsed(t, 1900, 139); // stream keeps flowing (sub-quiet gaps)…
    noteOutputParsed(t, 2300, 139); // …past the sustain threshold
    return t;
  };

  it('the marker outranks a snapshot that is itself a park', () => {
    const t = parkSnapshotTracker();
    // Without the marker, the selection faithfully anchors to the park — the
    // exact bug in the 2026-08-23 log (137 passes the 138 last-column bound).
    expect(selectFreezeCell(t, 676, 137, 2350, { top: 640, rows: 41, cols: 139 }, 640))
      .toMatchObject({ absRow: 676, col: 137, src: 'caret' });
    // With it, content wins: the park sits on the prompt row's border zone
    // (col 137 of 139), which is repaint state, not a caret.
    const sel = selectFreezeCell(t, 676, 137, 2350, { top: 640, rows: 41, cols: 139 }, 640,
      () => ({ relRow: 36, col: 4 }));
    expect(sel).toMatchObject({ absRow: 676, col: 4, src: 'marker' });
  });

  it('the marker also covers a stream that never produced a snapshot', () => {
    const t = createRestingTracker(676, 137, 1000, 36);
    noteOutputParsed(t, 1300, 139); // sub-quiet from the start: no snapshot ever
    noteOutputParsed(t, 1600, 139);
    noteOutputParsed(t, 1900, 139);
    expect(t.hasCaret).toBe(false);
    const sel = selectFreezeCell(t, 676, 137, 1950, { top: 640, rows: 41, cols: 139 }, 640,
      () => ({ relRow: 31, col: 4 }));
    expect(sel).toMatchObject({ absRow: 671, col: 4, src: 'marker' });
  });

  it('a quiet pane ignores the marker — idle stays cursor-driven', () => {
    const t = createRestingTracker(640, 8, 1000, 30);
    noteOutputParsed(t, 1200, 139); // real output once, long quiet since
    const scan = vi.fn(() => ({ relRow: 31, col: 4 }));
    const sel = selectFreezeCell(t, 640, 8, 1200 + OUTPUT_QUIET_MS + 200,
      { top: 600, rows: 45, cols: 139 }, 600, scan);
    expect(sel).toMatchObject({ absRow: 640, col: 8, src: 'instant' });
    expect(scan).not.toHaveBeenCalled();
  });

  it('a fluid typist\'s snapshot on the prompt row keeps its column', () => {
    // Fluid CJK typing: every commit echo lands under OUTPUT_QUIET_MS for
    // longer than the sustain, so the streaming branch opens — but the
    // snapshot is the caret at the last pause, ON the prompt row, left of
    // the border zone. The marker's input-start floor must not drag the
    // preedit back over already-typed text (panel finding).
    const t = createRestingTracker(671, 20, 1000, 31);
    noteOutputParsed(t, 1600, 139); // snapshot: (20,31) — the typing caret
    noteOutputParsed(t, 1900, 139);
    noteOutputParsed(t, 2300, 139);
    const sel = selectFreezeCell(t, 671, 22, 2350, { top: 640, rows: 41, cols: 139 }, 640,
      () => ({ relRow: 31, col: 4 }));
    expect(sel).toMatchObject({ absRow: 671, col: 20, src: 'caret' });
  });

  it('a seeded output clock never opens the streaming branch', () => {
    // createRestingTracker seeds lastOutputAt with the creation clock; for
    // OUTPUT_QUIET_MS after an attach/reset that reads as "output just
    // arrived" even though nothing was parsed. With the cursor on the last
    // column (edge), the branch would open on the seed alone (panel
    // finding) — hasOutput keeps it shut until real output is observed.
    const t = createRestingTracker(676, 138, 1000, 36);
    const scan = vi.fn(() => ({ relRow: 31, col: 4 }));
    const sel = selectFreezeCell(t, 676, 138, 1100, { top: 640, rows: 41, cols: 139 }, 640, scan);
    expect(sel).toMatchObject({ src: 'instant' });
    expect(scan).not.toHaveBeenCalled();
  });
});

describe('#1016 input-line marker wiring', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  /** Viewport content with Claude Code's input box at `promptRow`. */
  const claudeScreen = (rows: number, promptRow: number): string[] => {
    const s: string[] = [];
    for (let i = 0; i < rows; i++) s.push(`output line ${i}`);
    s[promptRow - 1] = '╭──────────────╮';
    s[promptRow] = '│ > 你好       │';
    s[promptRow + 1] = '╰──────────────╯';
    return s;
  };

  /** Wire LIVE-screen content (baseY-relative rows) into the fake buffer's
   *  getLine — the scan must read the live screen, not the viewport. */
  const installLines = (
    active: ImeAnchorTerminal['buffer']['active'],
    content: string[],
  ): ReturnType<typeof vi.fn> => {
    const getLine = vi.fn((y: number) => {
      const line = content[y - active.baseY];
      return line === undefined ? undefined : { translateToString: () => line };
    });
    active.getLine = getLine;
    return getLine;
  };

  /** The #951 wiring scenario: idle caret at (5,40), then a stream parks the
   *  cursor on (127,43) and sustains past the threshold. */
  const streamTo2800 = (t: ReturnType<typeof makeTerminal>, dom: ReturnType<typeof buildTerminalDom>, setClock: (v: number) => void): void => {
    setClock(2000);
    Object.assign(t.state, { cursorY: 43, cursorX: 127 });
    t.onCursorMove.fire(undefined);
    t.onWriteParsed.fire(undefined);
    dom.textarea.style.top = `${43 * 17.6}px`;
    dom.textarea.style.left = `${127 * 10}px`;
    setClock(2400);
    t.onWriteParsed.fire(undefined);
    setClock(2750);
    t.onWriteParsed.fire(undefined);
    setClock(2800);
  };

  it('a recognized agent mid-stream anchors to the input line found by content', () => {
    const dom = buildTerminalDom(10, 17.6, 45, 128);
    const t = makeTerminal(dom, 45, 128);
    let clock = 1000;
    const diag = vi.fn();
    Object.assign(t.state, { baseY: 600, viewportY: 600, cursorY: 40, cursorX: 5 });
    installLines(t.terminal.buffer.active, claudeScreen(45, 31));
    const handle = attachImeAnchor(t.terminal, {
      now: () => clock,
      getAgentSlug: () => 'claude',
      onCompositionDiagnostic: diag,
    });
    streamTo2800(t, dom, (v) => { clock = v; });
    dom.textarea.dispatchEvent(new Event('compositionstart'));
    expect(diag.mock.calls[0][0]).toMatchObject({
      src: 'marker', selY: 31, selX: 4, cursorY: 43, cursorX: 127,
    });
    expect(translateOf(dom.textarea)?.dy).toBeCloseTo((31 - 43) * 17.6, 6);
    expect(translateOf(dom.textarea)?.dx).toBeCloseTo((4 - 127) * 10, 6);
    // A marker-sourced composition pins the preedit like a caret-sourced one:
    // the live cursor is the agent's repaint cursor, and following it tears
    // the two IME surfaces apart (#951 field report).
    dom.compView.style.top = `${43 * 17.6}px`;
    dom.compView.style.left = `${127 * 10}px`;
    dom.textarea.dispatchEvent(new Event('compositionupdate'));
    expect(translateOf(dom.compView)?.dy).toBeCloseTo((31 - 43) * 17.6, 6);
    expect(translateOf(dom.compView)?.dx).toBeCloseTo((4 - 127) * 10, 6);
    handle.dispose();
  });

  it('a scrolled-up viewport still scans the live screen, not history', () => {
    // The 3-model panel finding: a viewport-relative scan while scrolled up
    // reads history, which can quote the very chrome being scanned for. The
    // live rows keep the real box; the off-screen anchor then clamps to the
    // visible edge via pointFromCell, same as every other off-screen anchor.
    const dom = buildTerminalDom(10, 17.6, 45, 128);
    const t = makeTerminal(dom, 45, 128);
    let clock = 1000;
    const diag = vi.fn();
    // Scrolled up 20 rows: the viewport shows history.
    Object.assign(t.state, { baseY: 600, viewportY: 580, cursorY: 40, cursorX: 5 });
    installLines(t.terminal.buffer.active, claudeScreen(45, 31));
    const handle = attachImeAnchor(t.terminal, {
      now: () => clock,
      getAgentSlug: () => 'claude',
      onCompositionDiagnostic: diag,
    });
    streamTo2800(t, dom, (v) => { clock = v; });
    dom.textarea.dispatchEvent(new Event('compositionstart'));
    // The live box's prompt row (screen row 31) was found even though the
    // viewport is 20 rows up; absRow = 600 + 31 = 631, reported ybase-rel.
    expect(diag.mock.calls[0][0]).toMatchObject({ src: 'marker', selY: 31, selX: 4 });
    handle.dispose();
  });

  it('an unrecognized agent never scans and keeps the quiet-caret selection', () => {
    const dom = buildTerminalDom(10, 17.6, 45, 128);
    const t = makeTerminal(dom, 45, 128);
    let clock = 1000;
    const diag = vi.fn();
    Object.assign(t.state, { baseY: 600, viewportY: 600, cursorY: 40, cursorX: 5 });
    const getLine = installLines(t.terminal.buffer.active, claudeScreen(45, 31));
    const handle = attachImeAnchor(t.terminal, {
      now: () => clock,
      getAgentSlug: () => 'codex',
      onCompositionDiagnostic: diag,
    });
    streamTo2800(t, dom, (v) => { clock = v; });
    dom.textarea.dispatchEvent(new Event('compositionstart'));
    expect(diag.mock.calls[0][0]).toMatchObject({ src: 'caret', selY: 40, selX: 5 });
    expect(getLine).not.toHaveBeenCalled();
    handle.dispose();
  });

  it('a scan that finds nothing falls back to the quiet-caret selection', () => {
    const dom = buildTerminalDom(10, 17.6, 45, 128);
    const t = makeTerminal(dom, 45, 128);
    let clock = 1000;
    const diag = vi.fn();
    Object.assign(t.state, { baseY: 600, viewportY: 600, cursorY: 40, cursorX: 5 });
    const plain: string[] = [];
    for (let i = 0; i < 45; i++) plain.push(`output line ${i}`);
    installLines(t.terminal.buffer.active, plain);
    const handle = attachImeAnchor(t.terminal, {
      now: () => clock,
      getAgentSlug: () => 'claude',
      onCompositionDiagnostic: diag,
    });
    streamTo2800(t, dom, (v) => { clock = v; });
    dom.textarea.dispatchEvent(new Event('compositionstart'));
    expect(diag.mock.calls[0][0]).toMatchObject({ src: 'caret', selY: 40, selX: 5 });
    handle.dispose();
  });

  it('an idle composition never scans even for a recognized agent', () => {
    const dom = buildTerminalDom(10, 17.6, 45, 128);
    const t = makeTerminal(dom, 45, 128);
    let clock = 1000;
    const diag = vi.fn();
    Object.assign(t.state, { baseY: 600, viewportY: 600, cursorY: 40, cursorX: 5 });
    const getLine = installLines(t.terminal.buffer.active, claudeScreen(45, 31));
    const handle = attachImeAnchor(t.terminal, {
      now: () => clock,
      getAgentSlug: () => 'claude',
      onCompositionDiagnostic: diag,
    });
    clock = 5000; // no output since attach: quiet pane
    dom.textarea.dispatchEvent(new Event('compositionstart'));
    expect(diag.mock.calls[0][0]).toMatchObject({ src: 'instant', selY: 40, selX: 5 });
    expect(getLine).not.toHaveBeenCalled();
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

// ---------------------------------------------------------------------------

describe('#1032 row-gated preedit follow — the streaming pin never drags Korean typing', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('pure: only a cross-row cursor pins a caret/marker composition', () => {
    // Quiet-path sources always follow (the #942 contract, untouched).
    expect(preeditFollowsLiveCursor('instant', 34, 12)).toBe(true);
    expect(preeditFollowsLiveCursor('resting', 34, 12)).toBe(true);
    expect(preeditFollowsLiveCursor('scrolled_out', 34, 12)).toBe(true);
    // Streaming-path sources: same screen row = the caret, follow it;
    // any other row = the agent's repaint cursor, pin.
    expect(preeditFollowsLiveCursor('caret', 34, 34)).toBe(true);
    expect(preeditFollowsLiveCursor('caret', 34, 43)).toBe(false);
    expect(preeditFollowsLiveCursor('marker', 31, 31)).toBe(true);
    expect(preeditFollowsLiveCursor('marker', 31, 20)).toBe(false);
  });

  /** The #1032 field geometry (2026-08-26 correction comment): the quiet
   *  caret snapshot holds column 11 of the input row (screen row 34) while
   *  the user types a fresh word from column 2 on that same row. Commit
   *  echoes keep every output gap under OUTPUT_QUIET_MS for longer than
   *  STREAM_SUSTAIN_MS, so every composition takes the streaming branch. */
  function fluidKoreanTyping(getAgentSlug?: () => string | undefined): {
    dom: ReturnType<typeof buildTerminalDom>;
    t: ReturnType<typeof makeTerminal>;
    diag: ReturnType<typeof vi.fn>;
    handle: { dispose(): void };
    setClock: (v: number) => void;
    positionChildren: (r: number, c: number) => void;
  } {
    const dom = buildTerminalDom(10, 17.6, 45, 128);
    const t = makeTerminal(dom, 45, 128);
    let clock = 1000;
    const diag = vi.fn();
    Object.assign(t.state, { baseY: 600, viewportY: 600, cursorY: 34, cursorX: 11 });
    const handle = attachImeAnchor(t.terminal, {
      now: () => clock,
      getAgentSlug,
      onCompositionDiagnostic: diag,
    });
    // The chunk at 2000 ends a 1000ms quiet span: snapshot = (11,34). The
    // cursor moved to column 2 in the same chunk (fresh word), and the echo
    // bursts at 2400/2750 sustain the epoch past STREAM_SUSTAIN_MS.
    clock = 2000;
    Object.assign(t.state, { cursorY: 34, cursorX: 2 });
    t.onCursorMove.fire(undefined);
    t.onWriteParsed.fire(undefined);
    clock = 2400;
    t.onWriteParsed.fire(undefined);
    clock = 2750;
    t.onWriteParsed.fire(undefined);
    clock = 2800;
    const positionChildren = (r: number, c: number): void => {
      dom.textarea.style.top = `${r * 17.6}px`;
      dom.textarea.style.left = `${c * 10}px`;
      dom.compView.style.top = `${r * 17.6}px`;
      dom.compView.style.left = `${c * 10}px`;
    };
    positionChildren(34, 2);
    return { dom, t, diag, handle, setClock: (v) => { clock = v; }, positionChildren };
  }

  it('fluid typing mid-stream: the preedit follows the caret along the input row, the textarea stays pinned', () => {
    // The regression's exact numbers: pin.x = (sel_col - cursor_col) x 8px on
    // every record — a correction sized to cancel the live position and glue
    // the preedit to the stale snapshot column, so 정확히 어떻 read 떻확히 어.
    // The pin belongs on the textarea alone (#945's split): the preedit must
    // ride the advancing caret.
    const { dom, t, diag, handle, positionChildren } = fluidKoreanTyping();
    dom.textarea.dispatchEvent(new Event('compositionstart'));
    expect(diag.mock.calls[0][0]).toMatchObject({
      src: 'caret', selY: 34, selX: 11, cursorY: 34, cursorX: 2,
      preeditDx: 0, preeditDy: 0,
    });
    // Candidate-window anchor: still frozen to the snapshot cell (#951).
    expect(translateOf(dom.textarea)?.dx).toBeCloseTo((11 - 2) * 10, 6);
    // Inline preedit: the live cursor is ON the anchor row — it IS the caret.
    expect(dom.compView.style.transform).toBe('');
    // A committed syllable's echo advances the caret two cells; xterm
    // re-anchors both children there on the next compositionupdate.
    Object.assign(t.state, { cursorX: 4 });
    positionChildren(34, 4);
    dom.textarea.dispatchEvent(new Event('compositionupdate'));
    expect(translateOf(dom.textarea)?.dx).toBeCloseTo((11 - 4) * 10, 6);
    expect(dom.compView.style.transform).toBe('');
    handle.dispose();
  });

  it('a cross-row repaint cursor mid-composition pins the preedit, and the follow resumes on return', () => {
    // The #951 tear stays fixed: an agent chunk between keystrokes parks the
    // cursor on an output row, and following THAT cursor would drag the
    // pinyin/preedit onto the agent's output. The pin wins for exactly that
    // event, per-event, and the follow resumes once the cursor is back.
    const { dom, t, handle, positionChildren } = fluidKoreanTyping();
    dom.textarea.dispatchEvent(new Event('compositionstart'));
    expect(dom.compView.style.transform).toBe('');
    Object.assign(t.state, { cursorY: 20, cursorX: 100 });
    positionChildren(20, 100);
    dom.textarea.dispatchEvent(new Event('compositionupdate'));
    expect(translateOf(dom.compView)?.dx).toBeCloseTo((11 - 100) * 10, 6);
    expect(translateOf(dom.compView)?.dy).toBeCloseTo((34 - 20) * 17.6, 6);
    expect(translateOf(dom.compView)).toEqual(translateOf(dom.textarea));
    Object.assign(t.state, { cursorY: 34, cursorX: 4 });
    positionChildren(34, 4);
    dom.textarea.dispatchEvent(new Event('compositionupdate'));
    expect(dom.compView.style.transform).toBe('');
    expect(translateOf(dom.textarea)?.dx).toBeCloseTo((11 - 4) * 10, 6);
    handle.dispose();
  });

  it('a marker-sourced composition follows the caret inside the input box the same way', () => {
    // Korean typing while Claude Code streams (#874 RC-C population): the
    // content scan pins the candidate anchor to the input line's start, but
    // the caret typing inside the box is on the marker's own row — the
    // preedit must track it, not the box's first column.
    const dom = buildTerminalDom(10, 17.6, 45, 128);
    const t = makeTerminal(dom, 45, 128);
    let clock = 1000;
    const diag = vi.fn();
    Object.assign(t.state, { baseY: 600, viewportY: 600, cursorY: 40, cursorX: 5 });
    const content: string[] = [];
    for (let i = 0; i < 45; i++) content.push(`output line ${i}`);
    content[30] = '╭──────────────╮';
    content[31] = '│ > 정확히     │';
    content[32] = '╰──────────────╯';
    t.terminal.buffer.active.getLine = (y: number) => {
      const line = content[y - t.state.baseY];
      return line === undefined ? undefined : { translateToString: () => line };
    };
    const handle = attachImeAnchor(t.terminal, {
      now: () => clock,
      getAgentSlug: () => 'claude',
      onCompositionDiagnostic: diag,
    });
    clock = 2000;
    // Claude's box repaint leaves the cursor after the typed text, ON the
    // prompt row.
    Object.assign(t.state, { cursorY: 31, cursorX: 10 });
    t.onCursorMove.fire(undefined);
    t.onWriteParsed.fire(undefined);
    clock = 2400;
    t.onWriteParsed.fire(undefined);
    clock = 2750;
    t.onWriteParsed.fire(undefined);
    clock = 2800;
    dom.textarea.style.top = `${31 * 17.6}px`;
    dom.textarea.style.left = `${10 * 10}px`;
    dom.compView.style.top = `${31 * 17.6}px`;
    dom.compView.style.left = `${10 * 10}px`;
    dom.textarea.dispatchEvent(new Event('compositionstart'));
    expect(diag.mock.calls[0][0]).toMatchObject({
      src: 'marker', selY: 31, selX: 4, cursorY: 31, cursorX: 10,
    });
    // Candidate anchor at the input's start (the marker's line-level answer)…
    expect(translateOf(dom.textarea)?.dx).toBeCloseTo((4 - 10) * 10, 6);
    // …while the preedit stays on the caret (the character-level answer).
    expect(dom.compView.style.transform).toBe('');
    handle.dispose();
  });
});
