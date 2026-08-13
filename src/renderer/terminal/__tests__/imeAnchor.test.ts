// @vitest-environment jsdom
/**
 * #874 — IME candidate-window anchoring.
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
  isUsableGeometry,
  paintedCursorPosition,
  parsePxOrNull,
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
} {
  const root = document.createElement('div');
  root.className = 'xterm';
  const screen = document.createElement('div');
  screen.className = 'xterm-screen';
  const helpers = document.createElement('div');
  helpers.className = 'xterm-helpers';
  const textarea = document.createElement('textarea');
  textarea.className = 'xterm-helper-textarea';
  helpers.appendChild(textarea);
  screen.appendChild(helpers);
  root.appendChild(screen);
  document.body.appendChild(root);
  // jsdom has no layout; stand in for the measured cell grid.
  Object.defineProperty(screen, 'clientWidth', { value: cellWidth * cols, configurable: true });
  Object.defineProperty(screen, 'clientHeight', { value: cellHeight * rows, configurable: true });
  return { root, screen, helpers, textarea };
}

function makeTerminal(dom: ReturnType<typeof buildTerminalDom>, rows = 39, cols = 142): {
  terminal: ImeAnchorTerminal;
  onRender: FakeEmitter<unknown>;
  onScroll: FakeEmitter<unknown>;
  onResize: FakeEmitter<unknown>;
  state: ImeAnchorBufferState;
} {
  const onRender = new FakeEmitter<unknown>();
  const onScroll = new FakeEmitter<unknown>();
  const onResize = new FakeEmitter<unknown>();
  const state = buf();
  const terminal: ImeAnchorTerminal = {
    rows, cols,
    textarea: dom.textarea,
    element: dom.root,
    buffer: { active: state },
    onRender: onRender.event,
    onScroll: onScroll.event,
    onResize: onResize.event,
  };
  return { terminal, onRender, onScroll, onResize, state };
}

describe('#874 attachImeAnchor', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('does nothing until xterm has positioned the textarea', () => {
    const dom = buildTerminalDom();
    const { terminal, onRender } = makeTerminal(dom);
    const handle = attachImeAnchor(terminal);
    onRender.fire(undefined);
    // style.left is still xterm's -9999em stylesheet default.
    expect(dom.helpers.style.transform).toBe('');
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
    expect(translateOf(dom.helpers)?.dx).toBe(0);
    expect(translateOf(dom.helpers)?.dy).toBeCloseTo(8 * 17.6, 6);
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
    expect(dom.helpers.style.transform).toBe('');
    // User wheels up 4 rows. xterm leaves style.top alone; we absorb it.
    state.viewportY = 18;
    onScroll.fire(undefined);
    expect(translateOf(dom.helpers)?.dy).toBeCloseTo(4 * 17.6, 6);
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
    const spy = vi.spyOn(dom.helpers.style, 'transform', 'set');
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
    expect(dom.helpers.style.transform).toBe('');

    dom.textarea.dispatchEvent(new Event('compositionstart'));

    // The agent streams: the TUI parks the cursor 12 rows up and 40 cells left,
    // and xterm re-anchors the preedit there on every compositionupdate.
    Object.assign(state, { cursorY: 18, cursorX: 4 });
    dom.textarea.style.top = `${18 * 17.6}px`;
    dom.textarea.style.left = '40px';
    onRender.fire(undefined);

    // Candidate window must stay on row 30 / col 8 where the user started.
    expect(translateOf(dom.helpers)?.dx).toBeCloseTo(40, 6);
    expect(translateOf(dom.helpers)?.dy).toBeCloseTo(12 * 17.6, 6);

    dom.textarea.dispatchEvent(new Event('compositionend'));
    onRender.fire(undefined);
    expect(dom.helpers.style.transform).toBe('');
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
    expect(translateOf(dom.helpers)?.dy).toBeCloseTo(14 * 17.6, 6);
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
    expect(translateOf(dom.helpers)?.dy).toBeCloseTo(2 * 17.6, 6);
    // Font size bumped: cells get taller, and xterm re-anchors at the new
    // metrics. Our correction must track the new cell height, which it only
    // learns about from onResize (never from a per-frame layout read).
    Object.defineProperty(dom.screen, 'clientHeight', { value: 20 * 39, configurable: true });
    dom.textarea.style.top = `${4 * 20}px`;
    onResize.fire(undefined);
    expect(translateOf(dom.helpers)?.dy).toBeCloseTo(2 * 20, 6);
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
    expect(translateOf(dom.helpers)?.dy).toBe(32);
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
    expect(translateOf(dom.helpers)?.dy).toBe(32);

    dom.textarea.dispatchEvent(new Event('compositionstart'));
    // xterm now writes the preedit box height here, not a cell height.
    dom.textarea.style.height = '48px';
    onRender.fire(undefined);
    // Frozen at the composition-start row, and still using the 16px cell.
    expect(translateOf(dom.helpers)?.dy).toBe(32);
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
    expect(dom.helpers.style.transform).toBe('');
    handle.dispose();
  });

  it('reports the composition diagnostic once per composition', () => {
    const dom = buildTerminalDom(10, 17.6, 47);
    const { terminal, state } = makeTerminal(dom, 47);
    const diag = vi.fn();
    const handle = attachImeAnchor(terminal, { onCompositionDiagnostic: diag });
    Object.assign(state, { baseY: 22, viewportY: 14, cursorY: 38, cursorX: 12 });
    dom.textarea.style.top = `${38 * 17.6}px`;
    dom.textarea.style.left = '120px';
    dom.textarea.dispatchEvent(new Event('compositionstart'));
    expect(diag).toHaveBeenCalledTimes(1);
    expect(diag.mock.calls[0][0]).toMatchObject({ baseY: 22, viewportY: 14, cursorY: 38, cursorX: 12 });
    expect(diag.mock.calls[0][0].dy).toBeCloseTo(140.8, 6);
    dom.textarea.dispatchEvent(new Event('compositionupdate'));
    expect(diag).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it('dispose unsubscribes everything and clears the transform', () => {
    const dom = buildTerminalDom();
    const { terminal, onRender, onScroll, onResize, state } = makeTerminal(dom);
    const handle = attachImeAnchor(terminal);
    Object.assign(state, { baseY: 10, viewportY: 5, cursorY: 4, cursorX: 0 });
    dom.textarea.style.top = `${4 * 17.6}px`;
    dom.textarea.style.left = '0px';
    onRender.fire(undefined);
    expect(dom.helpers.style.transform).not.toBe('');

    handle.dispose();
    expect(dom.helpers.style.transform).toBe('');
    expect(onRender.size).toBe(0);
    expect(onScroll.size).toBe(0);
    expect(onResize.size).toBe(0);
    // A composition after dispose must not resurrect the transform.
    dom.textarea.dispatchEvent(new Event('compositionstart'));
    onRender.fire(undefined);
    expect(dom.helpers.style.transform).toBe('');
  });

  it('is a no-op when the helper container is missing', () => {
    const root = document.createElement('div');
    const textarea = document.createElement('textarea');
    const terminal = {
      rows: 39, cols: 142, textarea, element: root,
      buffer: { active: buf() },
      onRender: new FakeEmitter<unknown>().event,
      onScroll: new FakeEmitter<unknown>().event,
      onResize: new FakeEmitter<unknown>().event,
    } as ImeAnchorTerminal;
    expect(() => attachImeAnchor(terminal).dispose()).not.toThrow();
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
    expect(translateOf(dom.helpers)?.dy).toBeCloseTo(4 * 17.6, 6);
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
