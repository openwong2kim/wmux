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

- `src/term/cell.rs` uses the remaining u16 flag bit for SGR blink;
  `src/term/mod.rs` retains SGR 5, ignores SGR 6 like xterm, and clears blink on SGR 25/reset. This keeps
  the 24-byte cell layout while allowing native ANSI replay to preserve blink.

These changes are experimental compatibility policy, not upstream behavior.
Revalidate width, resize, ANSI restoration and live continuation when upgrading.
Run both `scripts/rust-terminal-core-bench.mjs --verify-only` (with an output path
before the flag) and `scripts/rust-snapshot-verify.mjs` from the repository root.
The integration keeps xterm authoritative and is disabled by default.
