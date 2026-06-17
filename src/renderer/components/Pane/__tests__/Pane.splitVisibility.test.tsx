/**
 * Regression tests for the terminal+browser split blank-pane bug.
 *
 * Symptom: in a pane holding BOTH a terminal and a browser surface,
 * `SplitSurfaceView` lays them out side by side but each surface gated its
 * `display` on `surface.id === activeSurfaceId`. A pane has a single
 * `activeSurfaceId`, so focusing one side display:none'd the other — the
 * non-focused side went blank, toggling as the user switched.
 *
 * Fix: `pickSplitShownSurfaces` decouples visibility (what renders on each
 * side) from focus (`activeSurfaceId`). Each side shows its active surface when
 * the active surface is on that side, else its first surface — so neither side
 * ever blanks. These tests pin that contract.
 *
 * Runs in the repo's node (no-JSDOM) vitest env — same pattern as
 * Pane.notificationRing.test.tsx (the pure helper is the load-bearing piece).
 */
import { describe, it, expect } from 'vitest';
import { pickSplitShownSurfaces } from '../Pane';

const T = (id: string) => ({ id });

describe('pickSplitShownSurfaces — split visibility decoupled from focus', () => {
  it('common 1 terminal + 1 browser: BOTH sides shown when the terminal is focused', () => {
    const r = pickSplitShownSurfaces([T('term-1')], [T('brow-1')], 'term-1');
    expect(r.shownTerminalId).toBe('term-1');
    // The regression: the browser side must STILL show its surface, not blank.
    expect(r.shownBrowserId).toBe('brow-1');
  });

  it('common 1 terminal + 1 browser: BOTH sides shown when the browser is focused', () => {
    const r = pickSplitShownSurfaces([T('term-1')], [T('brow-1')], 'brow-1');
    // The regression in the other direction: the terminal side must not blank.
    expect(r.shownTerminalId).toBe('term-1');
    expect(r.shownBrowserId).toBe('brow-1');
  });

  it('neither side blanks for EITHER focus target (the core invariant)', () => {
    const terminals = [T('term-1')];
    const browsers = [T('brow-1')];
    for (const active of ['term-1', 'brow-1']) {
      const r = pickSplitShownSurfaces(terminals, browsers, active);
      expect(r.shownTerminalId).toBeDefined();
      expect(r.shownBrowserId).toBeDefined();
    }
  });

  it('multiple terminal tabs: the FOCUSED terminal shows; browser side shows its first', () => {
    const r = pickSplitShownSurfaces([T('term-1'), T('term-2')], [T('brow-1')], 'term-2');
    expect(r.shownTerminalId).toBe('term-2'); // active tab on the terminal side
    expect(r.shownBrowserId).toBe('brow-1'); // browser side keeps its first, never blank
  });

  it('multiple browser tabs: the FOCUSED browser shows; terminal side shows its first', () => {
    const r = pickSplitShownSurfaces([T('term-1'), T('term-2')], [T('brow-1'), T('brow-2')], 'brow-2');
    expect(r.shownTerminalId).toBe('term-1'); // terminal side falls back to first (active is a browser)
    expect(r.shownBrowserId).toBe('brow-2'); // active browser tab
  });

  it('active surface absent from both lists: each side falls back to its first', () => {
    const r = pickSplitShownSurfaces([T('term-1')], [T('brow-1')], 'stale-id');
    expect(r.shownTerminalId).toBe('term-1');
    expect(r.shownBrowserId).toBe('brow-1');
  });

  it('defensive: empty side yields undefined (no throw) without affecting the other', () => {
    expect(pickSplitShownSurfaces([], [T('brow-1')], 'brow-1')).toEqual({
      shownTerminalId: undefined,
      shownBrowserId: 'brow-1',
    });
    expect(pickSplitShownSurfaces([T('term-1')], [], 'term-1')).toEqual({
      shownTerminalId: 'term-1',
      shownBrowserId: undefined,
    });
  });
});
