// The sheet never runs past the window: the dock stays beside the panes only
// while they keep their floor, and goes to an overlay (out of the row) below.
import { describe, expect, it } from 'vitest';
import { DOCK_MAX_WIDTH, DOCK_MIN_WIDTH, PANE_MIN_WIDTH, dockMode, dockWidthFor } from '../dockLayout';

/** The icon rail beside the sheet (measured: 49px including its gap). */
const RAIL = 49;
/** BrowserWindow's minimum width (windowState.ts MIN_WINDOW_SIZE). */
const MIN_WINDOW = 800;

describe('dockLayout', () => {
  it('follows the dock width rule: 26vw between its bounds', () => {
    expect(dockWidthFor(800)).toBe(DOCK_MIN_WIDTH);
    expect(dockWidthFor(1000)).toBe(260);
    expect(dockWidthFor(2000)).toBe(DOCK_MAX_WIDTH);
  });

  it('no horizontal overflow at any window width, and the panes keep their floor beside an inline dock', () => {
    for (let viewport = MIN_WINDOW; viewport <= 2000; viewport += 10) {
      for (const sidebar of [0, 220, 264, 400]) {
        const shell = viewport - RAIL;
        const mode = dockMode(shell, sidebar, viewport);
        const dock = mode === 'inline' ? dockWidthFor(viewport) : 0;
        const panes = shell - sidebar - dock;
        // The row's fixed parts fit inside the sheet: nothing past the edge.
        expect(sidebar + dock, `${viewport}px, sidebar ${sidebar}`).toBeLessThanOrEqual(shell);
        if (mode === 'inline') expect(panes, `${viewport}px, sidebar ${sidebar}`).toBeGreaterThanOrEqual(PANE_MIN_WIDTH);
        // An overlay dock still fits inside the window.
        expect(dockWidthFor(viewport)).toBeLessThanOrEqual(viewport);
      }
    }
  });

  it('with the sidebar open, 900px puts the dock in an overlay and 1100px keeps it beside the panes', () => {
    expect(dockMode(900 - RAIL, 264, 900)).toBe('overlay');
    expect(dockMode(1100 - RAIL, 264, 1100)).toBe('inline');
    // Hiding the sidebar gives the panes back enough room at 900px.
    expect(dockMode(900 - RAIL, 0, 900)).toBe('inline');
  });
});
