// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';
import { forceCharSizeMeasure, onCharSizeChange } from '../charSizeRefit';

// #1497 ??a pane opened before the bundled webfont loaded keeps a cell measured
// with the fallback font, and its first resize re-measures only AFTER FitAddon
// computed cols/rows from that stale cell.
//
// These tests drive xterm's REAL CharSizeService (the patched 6.0.0 build the
// app ships). Only its measure strategy is swapped: jsdom has no font metrics,
// so a stub stands in for "what the fonts measure right now".

const terminals: Terminal[] = [];
beforeAll(() => {
  // open() watches devicePixelRatio through matchMedia, which jsdom lacks.
  window.matchMedia ??= ((query: string) => ({
    matches: false, media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(),
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: () => false,
  })) as typeof window.matchMedia;
});
afterEach(() => { terminals.splice(0).forEach((t) => t.dispose()); });

interface CharSizeInternals {
  _core: {
    _charSizeService: {
      width: number;
      height: number;
      _measureStrategy: { measure: () => { width: number; height: number } };
    };
  };
}

/** An opened terminal whose font measurement the test controls. */
function openTerminal(initial: { width: number; height: number }) {
  const terminal = new Terminal({ cols: 80, rows: 24 });
  terminals.push(terminal);
  const host = document.createElement('div');
  document.body.appendChild(host);
  terminal.open(host);
  const service = (terminal as unknown as CharSizeInternals)._core._charSizeService;
  const fonts = { current: initial };
  service._measureStrategy = { measure: () => fonts.current };
  // Seed the stale cell the way open() does, with the fallback font.
  forceCharSizeMeasure(terminal);
  return { terminal, service, fonts };
}

const CONSOLAS = { width: 7.697, height: 17 };
const CASCADIA = { width: 8.203, height: 16 };

describe('#1497 ??char-size re-measure', () => {
  it('locks the private xterm paths the fix walks', () => {
    const { terminal, service } = openTerminal(CONSOLAS);
    expect(service).toBeDefined();
    expect(typeof (service as unknown as { measure: unknown }).measure).toBe('function');
    expect(typeof (service as unknown as { onCharSizeChange: unknown }).onCharSizeChange).toBe('function');
    expect(onCharSizeChange(terminal, vi.fn())).toBeDefined();
  });

  it('a font load that changes the cell is re-measured and reported', () => {
    const { terminal, service, fonts } = openTerminal(CONSOLAS);
    expect(service.width).toBe(CONSOLAS.width);
    const changed = vi.fn();
    onCharSizeChange(terminal, changed);

    fonts.current = CASCADIA; // the webfont finished loading
    forceCharSizeMeasure(terminal);

    expect(service.width).toBe(CASCADIA.width);
    expect(service.height).toBe(CASCADIA.height);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('re-measuring an unchanged cell does not report ??the refit cannot loop', () => {
    const { terminal, fonts } = openTerminal(CONSOLAS);
    const changed = vi.fn();
    onCharSizeChange(terminal, changed);
    fonts.current = CASCADIA;
    forceCharSizeMeasure(terminal);
    // The refit's own resize re-measures (xterm's _afterResize) and so does
    // every later font load event.
    forceCharSizeMeasure(terminal);
    terminal.resize(90, 30);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('xterm re-measures inside its own resize ??the event the hook refits on', () => {
    // The issue's mechanism: without a re-measure at font load, the first
    // cols/rows-changing resize is where the cell flips, after FitAddon has
    // already fitted with the old one. The subscription is what turns that
    // late flip into a second, correct fit.
    const { terminal, fonts } = openTerminal(CONSOLAS);
    const changed = vi.fn();
    onCharSizeChange(terminal, changed);
    fonts.current = CASCADIA;
    terminal.resize(70, 40);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('is a no-op on a terminal that is not open yet', () => {
    const terminal = new Terminal();
    terminals.push(terminal);
    expect(() => forceCharSizeMeasure(terminal)).not.toThrow();
    expect(onCharSizeChange(terminal, vi.fn())).toBeUndefined();
  });
});
