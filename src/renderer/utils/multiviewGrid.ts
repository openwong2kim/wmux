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

/** Minimum tile size, in px. An explicit arrangement always wins over the tile
 *  count — `columns` with 6 tiles stays one row of 6 — but without a floor a
 *  1400px window gives 229px tiles ≈ 27 terminal columns, and a TUI needs ~80.
 *  So the tracks stop shrinking here and the grid scrolls instead. */
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
