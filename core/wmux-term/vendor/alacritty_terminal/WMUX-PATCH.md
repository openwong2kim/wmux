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

- `src/term/cell.rs` uses the remaining u16 flag bit for SGR blink;
  `src/term/mod.rs` retains SGR 5, ignores SGR 6 like xterm, and clears blink on SGR 25/reset. This keeps
  the 24-byte cell layout while allowing native ANSI replay to preserve blink.

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

These changes are experimental compatibility policy, not upstream behavior.
Revalidate width, resize, ANSI restoration and live continuation when upgrading.
Run both `scripts/rust-terminal-core-bench.mjs --verify-only` (with an output path
before the flag) and `scripts/rust-snapshot-verify.mjs` from the repository root.
The integration keeps xterm authoritative and is disabled by default.
