// ─── Multiview grid geometry — the ONE place the column count is decided ────
//
// Two consumers must agree or arrow navigation desyncs from what's on screen:
//   WorkspaceViewport  → gridTemplateColumns (what the user sees)
//   uiSlice.focusMultiviewDirection → Ctrl+Shift+Arrow tile walking
// Before this module the count was duplicated in both, so any layout change
// silently broke directional focus.

/** How the multiview grid arranges its tiles.
 *  `auto` = infer from tile count (historical behavior, the default).
 *  `columns` = one row, side by side. `rows` = one column, stacked. */
export type MultiviewArrangement = 'auto' | 'columns' | 'rows';

export const MULTIVIEW_ARRANGEMENTS: readonly MultiviewArrangement[] = ['auto', 'columns', 'rows'];

/** Minimum tile size, in px, for an EXPLICIT arrangement only. `columns` with 6
 *  tiles on a 1400px window would otherwise give 229px tiles ≈ 27 terminal
 *  columns. 320px ≈ 38 columns is not comfortable either — it is a deliberate
 *  compromise, not a "TUIs are happy here" number: a floor wide enough for a
 *  full-width TUI (~640px) would force a scrollbar on the common 2-up case,
 *  which is the layout people actually use. The floor exists to keep a tile
 *  legible, and the grid scrolls rather than shrinking past it. */
export const MULTIVIEW_MIN_TILE_WIDTH_PX = 320;
export const MULTIVIEW_MIN_TILE_HEIGHT_PX = 200;

/**
 * Column count for the multiview grid.
 *
 *   auto (n tiles)        columns (n=3)        rows (n=3)
 *   ┌─────┬─────┐         ┌───┬───┬───┐        ┌───────────┐
 *   │  A  │  B  │         │ A │ B │ C │        │     A     │
 *   ├─────┼─────┤         └───┴───┴───┘        ├───────────┤
 *   │  C  │  D  │                              │     B     │
 *   └─────┴─────┘                              ├───────────┤
 *   ≤4 → 2 cols, else 3                        │     C     │
 *                                              └───────────┘
 *
 * `auto` reproduces the historical rule exactly, so the default is
 * behavior-identical to before this preference existed. An unrecognized
 * arrangement (a forward-version session file) also lands on `auto` rather
 * than throwing — the grid degrades to the old layout instead of blanking.
 */
export function multiviewColumnCount(tileCount: number, arrangement: MultiviewArrangement): number {
  if (arrangement === 'rows') return 1;
  if (arrangement === 'columns') return Math.max(1, tileCount);
  return tileCount <= 4 ? 2 : 3;
}

/** Grid track + overflow style for the multiview container.
 *
 *  `auto` keeps bare `1fr` tracks and no scrolling — byte-for-byte the layout
 *  that shipped before this preference existed. That matters: a floor on the
 *  default would push tiles off-screen for anyone whose terminal area is
 *  narrower than cols × 320px, so every existing user on a narrow window would
 *  get a scrollbar and a different PTY size purely by upgrading. Only a user
 *  who explicitly picks `columns`/`rows` opts into floors and scrolling.
 */
export function multiviewGridStyle(
  tileCount: number,
  arrangement: MultiviewArrangement,
): { gridTemplateColumns: string; gridAutoRows: string; overflow: 'auto' | undefined } {
  const cols = multiviewColumnCount(tileCount, arrangement);
  if (arrangement === 'auto') {
    return { gridTemplateColumns: `repeat(${cols}, 1fr)`, gridAutoRows: '1fr', overflow: undefined };
  }
  return {
    gridTemplateColumns: `repeat(${cols}, minmax(${MULTIVIEW_MIN_TILE_WIDTH_PX}px, 1fr))`,
    gridAutoRows: `minmax(${MULTIVIEW_MIN_TILE_HEIGHT_PX}px, 1fr)`,
    overflow: 'auto',
  };
}
