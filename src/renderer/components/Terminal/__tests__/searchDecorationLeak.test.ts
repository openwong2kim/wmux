import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
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

/** Drives the real addon far enough to own a cached term + write hook. */
function makeTerminal(): { term: Terminal; search: SearchAddon; results: number[] } {
  const term = new Terminal({ rows: 10, cols: 40, scrollback: 1000, allowProposedApi: true });
  // Headless has no renderer, so decoration creation is a no-op. The addon's
  // cached-term / write-hook lifecycle — the part under test — does not care.
  let selection: { start: { x: number; y: number }; end: { x: number; y: number } } | undefined;
  Object.assign(term, {
    registerDecoration: () => undefined,
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
  return { term, search, results };
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
    const { term, search, results } = makeTerminal();
    for (let i = 0; i < 40; i++) await write(term, `line ${i} ${i % 7 === 0 ? 'NEEDLE' : 'plain'}\r\n`);

    search.findNext('NEEDLE', { decorations: DECORATIONS });
    await settle();
    search.clearDecorations();

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

describe('Terminal.tsx clears search decorations when the bar goes away (#1266)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'Terminal.tsx'), 'utf-8');

  it('has an effect keyed on showSearchBar that calls clearSearch', () => {
    expect(src).toMatch(/if \(showSearchBar\) return;\s*\n\s*clearSearch\(\);\s*\n\s*\}, \[showSearchBar, clearSearch\]\);/);
  });

  it('still clears on the explicit close button', () => {
    expect(src).toMatch(/const handleCloseSearch = \(\) => \{\s*\n\s*clearSearch\(\);/);
  });
});
