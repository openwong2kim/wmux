import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/headless';
import { SearchAddon } from '@xterm/addon-search';

/**
 * #1266 — "search isn't functional": highlights land on unrelated characters
 * and stay frozen in the pane.
 *
 * The mechanism is a lifecycle leak, not a search-range bug. Once findNext()
 * runs with `decorations`, @xterm/addon-search caches the term and installs
 * an onWriteParsed hook that re-runs the search and re-creates the highlight
 * decorations 200ms after every subsequent chunk of output — indefinitely,
 * until clearDecorations() is called. Terminal.tsx only called clearSearch()
 * from the search bar's close button, but the bar is rendered under
 * `searchBarVisible && isActive`, so focusing another pane unmounts it
 * without closing it. The pane is then left re-highlighting a term the user
 * can no longer see a search box for.
 *
 * The first test pins the addon behaviour (real addon, real terminal, no
 * mock); the second pins that Terminal.tsx clears on the bar going away for
 * any reason rather than only on the close button.
 */

/** The addon only ever stores these; nothing under test disposes them. */
const noopDisposable = { dispose: (): void => undefined };

interface FakeDecoration {
  marker: unknown;
  disposed: boolean;
  onRender: (cb: (el: unknown) => void) => { dispose: () => void };
  onDispose: (cb: () => void) => { dispose: () => void };
  dispose: () => void;
}

/**
 * Drives the real addon far enough to own a cached term + write hook.
 *
 * Headless has no renderer, so `registerDecoration` has to be supplied — but
 * it returns a real object with the lifecycle surface the addon's
 * DecorationManager uses (marker, onRender, onDispose, dispose), so creation
 * AND teardown are genuinely exercised rather than short-circuited.
 */
function makeTerminal(): {
  term: Terminal;
  search: SearchAddon;
  results: number[];
  decorations: FakeDecoration[];
} {
  const term = new Terminal({ rows: 10, cols: 40, scrollback: 1000, allowProposedApi: true });
  const decorations: FakeDecoration[] = [];
  let selection: { start: { x: number; y: number }; end: { x: number; y: number } } | undefined;
  Object.assign(term, {
    registerDecoration: (options: { marker: unknown }): FakeDecoration => {
      const onDisposeCbs: Array<() => void> = [];
      const decoration: FakeDecoration = {
        marker: options.marker,
        disposed: false,
        onRender: () => noopDisposable,
        onDispose: (cb: () => void) => {
          onDisposeCbs.push(cb);
          return noopDisposable;
        },
        dispose: () => {
          if (decoration.disposed) return;
          decoration.disposed = true;
          for (const cb of onDisposeCbs) cb();
        },
      };
      decorations.push(decoration);
      return decoration;
    },
    getSelectionPosition: () => selection,
    clearSelection: () => { selection = undefined; },
    select: (col: number, row: number, size: number) => {
      selection = { start: { x: col, y: row }, end: { x: col + size, y: row } };
    },
  });
  const search = new SearchAddon();
  term.loadAddon(search);
  const results: number[] = [];
  search.onDidChangeResults((e) => results.push(e.resultCount));
  return { term, search, results, decorations };
}

const DECORATIONS = {
  matchBackground: '#E8A33D40',
  matchBorder: '#E8A33D',
  matchOverviewRuler: '#E8A33D',
  activeMatchBackground: '#E8A33D80',
  activeMatchBorder: '#E8A33D',
  activeMatchColorOverviewRuler: '#E8A33D',
};

const write = (term: Terminal, data: string) =>
  new Promise<void>((resolve) => term.write(data, () => resolve()));

const settle = () => new Promise((resolve) => setTimeout(resolve, 350));

describe('addon-search keeps re-highlighting until decorations are cleared (#1266)', () => {
  it('re-runs the cached search on every later write', async () => {
    const { term, search, results } = makeTerminal();
    for (let i = 0; i < 40; i++) await write(term, `line ${i} ${i % 7 === 0 ? 'NEEDLE' : 'plain'}\r\n`);

    search.findNext('NEEDLE', { decorations: DECORATIONS });
    const afterSearch = results.length;
    expect(afterSearch).toBeGreaterThan(0);

    // Output arriving after the user has moved on still drives the search.
    await write(term, 'unrelated output\r\n');
    await settle();
    expect(results.length).toBeGreaterThan(afterSearch);

    search.dispose();
    term.dispose();
  });

  it('stops once clearDecorations() runs — the fix Terminal.tsx must invoke', async () => {
    const { term, search, results, decorations } = makeTerminal();
    for (let i = 0; i < 40; i++) await write(term, `line ${i} ${i % 7 === 0 ? 'NEEDLE' : 'plain'}\r\n`);

    search.findNext('NEEDLE', { decorations: DECORATIONS });
    await settle();

    // One highlight decoration per match (plus the active-match decoration),
    // all live until the search is cleared.
    expect(decorations.length).toBeGreaterThanOrEqual(6);
    expect(decorations.some((d) => d.disposed)).toBe(false);

    search.clearDecorations();

    // Every decoration the addon created is torn down — this is what stops
    // the stale highlights sitting in the pane.
    expect(decorations.every((d) => d.disposed)).toBe(true);

    const quiesced = results.length;
    await write(term, 'unrelated output\r\n');
    await settle();
    expect(results.length).toBe(quiesced);

    search.dispose();
    term.dispose();
  });

  it('finds matches across the whole scrollback, not just the viewport', async () => {
    const { term, search } = makeTerminal();
    for (let i = 0; i < 40; i++) await write(term, `line ${i} ${i % 7 === 0 ? 'NEEDLE' : 'plain'}\r\n`);
    // Scroll up so the viewport no longer covers the last match.
    term.scrollLines(-30);
    expect(term.buffer.active.viewportY).toBeLessThan(term.buffer.active.baseY);

    let count = 0;
    search.onDidChangeResults((e) => { count = e.resultCount; });
    search.findNext('NEEDLE', { decorations: DECORATIONS });
    // 0, 7, 14, 21, 28, 35 — including rows below the scrolled-up viewport.
    expect(count).toBe(6);

    search.dispose();
    term.dispose();
  });
});
