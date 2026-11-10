# wmux compatibility fork

Source: the published `alacritty_terminal` 0.26.0 crate from crates.io.
The Apache-2.0 license and upstream README are retained. Only the library source
and normalized Cargo manifest are included; the omitted upstream reference-test
target was removed from the manifest.

Local changes:

- `src/wmux_unicode11.rs` is generated from the installed xterm Unicode 11
  provider by `scripts/generate-rust-unicode11.mjs`. Its header records the source
  hash. The xterm MIT license is included as `LICENSE-XTERM`. Native builds check
  that the table is current; regenerate deliberately after a provider update.
- `src/lib.rs` registers that module; `src/term/mod.rs` uses its width lookup for
  character input and exposes read-only `inactive_grid()` for snapshot replay.
- `src/grid/resize.rs` preserves the cursor paragraph without reflow, matching
  wmux's xterm configuration. Other paragraphs retain upstream reflow. Shrinking
  clamps the cursor and clears pending wrap. Clipped fullwidth cells are retained
  to match xterm; the ANSI serializer explicitly refuses an unrepresentable edge.
- `src/grid/resize.rs` `grow_lines`: more rows pull history rows down only while
  the cursor is on the bottom row, as xterm does (`Buffer.ts` `resize`, the rows
  grow branch, lines 196-221 in 6.1.0-beta.336). Otherwise blank rows are added
  below the cursor and history and both cursors stay put. Upstream always pulled
  `min(history, added)` rows. The window is rotated rather than scrolled, so no
  history row is dropped at the scrollback cap.
- `src/grid/resize.rs` `shrink_columns`: after the reflow, the cursor row
  follows xterm's rule rather than its content (`Buffer.ts` `_reflowSmaller`,
  the viewport adjustment at lines 466-486 in 6.1.0-beta.336). With no history,
  every added row moves the cursor down one row while there is room below,
  dropping the bottom row; the rest goes to history, kept past the cap by the
  rows dropped. With history, the cursor row stays. The saved cursor moves down
  with the room used. `native_core.rs` refuses a resize that reflows a paragraph
  below the cursor's, where xterm moves its cursor row off its content.
- `src/grid/tests.rs`: upstream's `shrink_reflow`, `shrink_reflow_twice`,
  `shrink_reflow_empty_cell_inside_line`, `grow_reflow` and
  `grow_reflow_multiline` leave the cursor at 0,0, inside the paragraph they
  resize, and expected it reflowed. They now expect xterm's result: the
  cursor's paragraph is not reflowed (`reflowCursorLine` false, `Buffer.ts`
  lines 391-397 and `BufferReflow.ts` lines 45-52). `shrink_reflow_cursor_below`
  and `grow_reflow_cursor_below` keep a reflow case with the cursor outside it.

- `src/term/cell.rs` uses the remaining u16 flag bit for SGR blink;
  `src/term/mod.rs` retains SGR 5, ignores SGR 6 like xterm, and clears blink on SGR 25/reset. This keeps
  the 24-byte cell layout while allowing native ANSI replay to preserve blink.
- `src/term/mod.rs` fills the rows SD (`CSI Ps T`) inserts with default
  attributes, as xterm.js's `InputHandler.scrollDown` does (it inserts
  `DEFAULT_ATTR_DATA` blanks), where upstream used the current background.
  Reverse index at the top margin keeps the erase colour (xterm.js
  `reverseIndex`), so it now calls `scroll_down_relative` directly.
- `src/term/mod.rs` deletes lines (DL, `CSI Ps M`) in place, as xterm.js's
  `InputHandler.deleteLines` does (it splices rows within the scroll region
  and never touches scrollback). Upstream rotated the deleted rows into
  history when the region started at the top row. `src/grid/mod.rs` adds
  `scroll_up_in_place` for it; linefeed still scrolls into history.
- `src/term/mod.rs` caps DCH (`CSI Ps P`) at the cells right of the cursor,
  as xterm.js's `InputHandler.deleteChars` (`BufferLine.deleteCells`) does.
  Upstream capped at the row width and then cleared the last `count` cells,
  so a count past the line end also cleared cells left of the cursor.
- `src/term/mod.rs` scrolls the region in place for SU (`CSI Ps S`), as
  xterm.js's `InputHandler.scrollUp` does (it splices rows within the
  scroll region and never touches scrollback). Upstream rotated the rows
  into history when the region started at the top row. Linefeed, which
  upstream routed through the same handler, now calls `scroll_up_relative`
  directly and keeps scrolling into history.
- `src/grid/mod.rs` keeps the active charset (the SI/SO G-level) on the
  cursor instead of on `Term`, so DECSC/DECRC and the alternate screen's
  save and restore carry it with the designations, as xterm.js's
  `saveCursor`/`restoreCursor` save `savedGlevel` with `savedCharsets`. It
  also records whether a cursor was saved since the last reset:
  `src/term/mod.rs` DECRC with nothing saved keeps the designations and
  returns to G0, as xterm.js does with an empty `savedCharsets`.
- `src/term/mod.rs` prints `_` unmapped under DEC line drawing: xterm.js's
  `CHARSETS['0']` table has no entry for it, where vte maps it to a blank.

`Cargo.lock` locks the crate's own test build (its dev-dependency, serde_json,
keeps it out of the wmux-term workspace). It keeps wmux-term's versions for every
shared dependency. CI runs `cargo test --manifest-path
core/wmux-term/vendor/alacritty_terminal/Cargo.toml --locked`.

- `src/grid/row.rs`, `src/grid/resize.rs`, `src/grid/mod.rs`, `src/grid/storage.rs` and
  `src/term/mod.rs` keep an alternate-screen row's cells past a narrower width,
  as xterm.js keeps its line's length: a resize without reflow moves them into
  the row's kept cells, and a later widen shows them again up to the new width
  (the rest is dropped, as xterm's line takes the new width). Character insert,
  delete and erase and insert-mode printing run over the whole physical row, a
  display erase fills whole rows over their physical width, DECALN fills it, and
  a reset row (a scroll, a new line, the alternate screen entered again) is a
  new line at the current width. The alternate screen's kept cells are
  dropped once it is no longer shown. `Storage::swap` uses a plain slice swap,
  since a row is no longer four machine words.
- `src/term/mod.rs` runs character insert, delete and erase and insert-mode
  printing on every row as xterm's `BufferLine` does: over the physical row,
  with its wide-glyph fixes (a glyph cut at the cursor or pushed to the end
  loses its first cell, a bare spacer left at the cursor by a delete is filled,
  a glyph shifted into the last column in insert mode is blanked, an erase
  that cuts a glyph at either end blanks all of it). A large
  delete no longer clears cells left of the cursor (upstream cleared from
  `columns - count`), and a wide glyph that does not fit wraps (or is dropped)
  before insert mode shifts anything. Modified 2026-11-08.
- `src/term/mod.rs` `linefeed`: a line feed that moves the cursor down
  without scrolling or clamping clears the wrap flag of the row it leaves, so
  the row it enters starts a new line, as xterm.js's `InputHandler.lineFeed`
  clears that row's `isWrapped` (LF, VT and FF). It also drops a pending
  wrap, as `lineFeed` and `index` both pull the cursor back into the last
  column. The motion moved to `line_down`, which `wrapline` calls without the
  clear, so an auto-wrap below a scroll region keeps its wrap. vte routes IND
  and NEL to the same handler, where xterm's `index` keeps the flag;
  `native_core.rs` puts it back for those. Added 2026-11-10.

These changes are experimental compatibility policy, not upstream behavior.
Revalidate width, resize, ANSI restoration and live continuation when upgrading.
Run both `scripts/rust-terminal-core-bench.mjs --verify-only` (with an output path
before the flag) and `scripts/rust-snapshot-verify.mjs` from the repository root.
The integration keeps xterm authoritative and is disabled by default.
