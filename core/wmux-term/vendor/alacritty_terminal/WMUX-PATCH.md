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
  character input and exposes read-only `inactive_grid()` and `scroll_region()`
  for snapshot replay.
- `src/grid/resize.rs` preserves the cursor paragraph without reflow, matching
  wmux's xterm configuration. Other paragraphs retain upstream reflow. Shrinking
  clamps the cursor and clears pending wrap. A fullwidth glyph whose lead a
  narrowing leaves in the new last column of that paragraph becomes a default
  cell, as xterm's trim resets it (`BufferLine.resize`, lines 452-455 in
  6.1.0-beta.336); its trailing half is cut off. Added 2026-11-14. Elsewhere
  (the alternate screen, which xterm does not trim) the ANSI serializer still
  refuses a fullwidth glyph in the last column.
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
  with the room used. `native_core.rs` refuses a narrowing that reflows a
  paragraph below the cursor's, where xterm moves its cursor row off its
  content.
- `src/grid/mod.rs` `narrowing_added` / `narrowing_trimmed`, set by
  `shrink_columns` and reset by every `Grid::resize`: the rows a narrowing's
  reflow added, and how many of them neither stayed on the screen nor fit in
  the history (trimmed at the cap). xterm moves its absolute saved row down
  by every added row, trimmed or not, clamped to the screen's last row
  (`Buffer.ts` `_reflowSmaller`, `savedY = Math.min(savedY + linesToAdd,
  ybase + newRows - 1)`, line 486 in 6.1.0-beta.336); `native_core.rs`
  carries the trimmed rows into the snapshot's saved row and applies that
  clamp once per width change (#3354). Read-only for the grid itself; not
  serialized. Added 2026-11-14.
- `src/grid/resize.rs` `grow_columns`: after the reflow, the cursor row and
  the saved cursor row follow xterm's rule rather than their content
  (`Buffer.ts` `_reflowLargerAdjustViewport`). Every removed row counts,
  above or below the cursor: it first takes a history row, then moves both
  rows up one, stopping at the top. Upstream moved them only for rows
  removed above. `native_core.rs` no longer refuses a widen that reflows a
  paragraph below the cursor. Added 2026-11-10.
- `src/grid/row.rs` `empty_from`: where the empty cells a widen gave a
  soft-wrapped row begin (`resize_cursor_row` sets it). xterm leaves the
  cursor's paragraph unreflowed, so those cells stay empty there, while the
  blanks a program printed up to a wrap are content; the ANSI serializer
  keeps the first empty. It adds nothing to the write path: `empty_from()`
  reads it past `occ`, which every write through the row's mutable
  indexing already raises past the cells it reaches, so a blank printed
  there later stays content. `take_wrap`/`put_wrap` move the wrap flag on a
  resize without raising `occ`, so a later widen keeps it; `reset` then
  covers the whole marked row, that flag included. Cleared when the row is
  reset or its cells move (append, split, physical edits), and when a
  narrowing cuts it off. Not serialized. Added 2026-11-10.
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
- `src/term/mod.rs` keeps a row's wrap where xterm.js keeps it, as the next
  row's `isWrapped`, which only line feeds and erases that clear whole rows
  change. Alacritty keeps it on the last cell, so every edit that replaced or
  moved that cell dropped it. Printing into the last column (`write_at_cursor`)
  and character insert, delete and erase and insert-mode printing
  (`edit_keeping_wrap`) now keep it at the edge, and `clear_line` keeps it for
  every EL. EL 2, and EL 0 from column 0, end the row's own wrap instead
  (`end_wrap_into`: the row above, a history row for the top one, stops
  wrapping into it; `Row::take_wrap`, so not a write). ED 0 from a pending wrap
  erases nothing on the cursor's row, as xterm's cursor is past the last column
  there; ED 0 and ED 1 end every wrap into a row they clear whole, the top row's
  from history included. ED 1 from the second row resets the top row too, as
  xterm does (upstream skipped it). Added 2026-11-12.
- `src/grid/row.rs` `empty_from` also marks the empty cells an erase leaves
  at a row's edge (EL through the last column, ECH to it, and what DCH fills
  or moves in from an empty run), so the serializer replays a soft-wrapped
  row's erased tail as erased, in its background, not as printed blanks.
  Cells an EL, ECH or ED 1 erases join a run they reach, and ICH and
  insert-mode printing move the run with the cells (`erased_run`,
  `inserted_run`); blanks they insert through the edge, or a wide glyph they
  push into the last column and blank, are empty cells too. `native_core`'s
  ED 1 now runs the vendored one, which matches xterm. The
  stored mark is one past the column (`empty_mark`, 0 still none), so a whole
  row can be marked; an erase lowers `occ` to its run, and a mark dropped when
  cells move (`forget_mark`) puts `occ` back over the row, since an erase's
  run can hold its background past `occ`. Added 2026-11-12.

These changes are experimental compatibility policy, not upstream behavior.
Revalidate width, resize, ANSI restoration and live continuation when upgrading.
Run both `scripts/rust-terminal-core-bench.mjs --verify-only` (with an output path
before the flag) and `scripts/rust-snapshot-verify.mjs` from the repository root.
The integration keeps xterm authoritative and is disabled by default.
