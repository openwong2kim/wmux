# Rust ANSI snapshot — 2026-10-31

On the rust terminal engine the daemon's ANSI snapshot (attach, resync, phone
screen stream) now runs on the native core. `WMUX_RUST_SNAPSHOT=off` keeps
xterm; any refusal, error, invalid result or spent half-budget falls back to
xterm on the same bytes, a live tee's drained chunks included.

## Parity

`src/daemon/__tests__/RustAnsiParity.test.ts` replays the xterm payload, the
Rust payload and (as tie-breaker) the raw stream into fresh `@xterm/headless`
terminals and compares rows, wrap flags, cursor, modes and every cell, again
after live bytes continue the stream and after leaving the alternate screen.
Rust must match xterm's payload, or the live terminal where xterm's own
payload loses state (a colored erase below the last written row, OSC 8
links). 164 cases (127 served by Rust, 37 refused to xterm): one or more
per control class, resize reflow (the 23 seeds of `rust-snapshot-parity.ts`),
the `core/harness` corpus and a real Claude Code capture; 0 mismatches. Each
refused class also has a case proving that Rust alone would diverge. Accepted differences, by construction of the check:

- A blank cell's foreground, weight, slant and blink are not compared (not
  visible; xterm's reflow leaves them at random).
- Alacritty cannot tell a printed space from an erased cell. Trailing blanks
  replay as empty cells, so a restored row may lose trailing printed spaces
  from its copied text. Blanks left of the cursor replay as printed (a shell
  prompt's space), and inside a soft-wrapped paragraph the edge is ignored.

`node scripts/rust-snapshot-verify.mjs` (the older raw-replay bench) passes
60/60 with the same visible-cell comparison.

## Control classes

| Class | Decision |
|---|---|
| OSC (titles, cwd, 133, queries, palette, 52) | Accepted: not screen state; xterm's path drops it too |
| OSC 8 hyperlinks | Restored natively (xterm's path turns them into a plain underline) |
| SO/SI, `ESC ( B`, `ESC ) B` | Accepted: with only ASCII designated, shifts are no-ops |
| DEC graphics, national sets, G2/G3 | Refused: `_` maps differently, sets missing, DECRC restores the shift only in xterm |
| DECSC/DECRC, SCOSC/SCORC | Accepted; a cursor saved with a pending wrap is refused (xterm drops the wrap on restore) |
| Kitty keyboard (`CSI > u` …), DECSCUSR, XTVERSION, DECLL, DECSCA | Accepted: input/cursor state neither path restores |
| HTS, TBC (`ESC H`, `CSI g`) | Accepted; tab cells now replay as blanks (they were replayed as TAB) |
| SGR 55 / SGR 53, 21, malformed colors | 55 accepted; 53, 21 and malformed colors refused; colon colors only as `38:5:n` or `38:2:cs:r:g:b` (vte reads `38:2:r:g:b` as r,g,b where xterm reads g,b,0, and ignores `38:5`) |
| ED 2 / ED 1 | Native feed gives xterm's semantics (Alacritty's ED 2 scrolled the screen into history; its ED 1 skipped row 0 from row 1); spelled with an embedded C0 refused |
| Half a fullwidth glyph left by ECH, EL or ED | Replayed as the blank its erased partner holds (xterm erases the glyph whole); refused when the partner is content, and always after DCH or ICH (xterm fills it with the erase attribute) |
| ICH, DCH, ECH at a pending wrap | Native feed drops the pending wrap first, as xterm's cursor restriction does |
| Mouse protocol 9/1000/1002/1003, encodings 1006/1016 | Tracked with xterm's semantics (any protocol reset turns tracking off; ?1005 leaves SGR on; modes read by number, embedded C0 ignored) and restored from that |
| Resize inside an open ?2026 update | The bytes vte holds are parsed at the old size first, as xterm did |
| `?2026` sharing a DECSET/DECRST with other modes | Refused: vte leaves the update only on exactly `CSI ? 2026 l` |
| REP | Accepted right after a printed character; refused after any control (xterm forgets the character, vte repeats it) |
| C1 code points, DECSED/DECSEL, SL/SR, DECIC/DECDC, DECSTR, SU, SD as `CSI ^`, DECALN, modes 3/9/20/45/47/66/1047/1048 | Refused: Alacritty parses them differently |
| Narrowing reflow that scrolls rows above the cursor into history | Refused (xterm moves the cursor down instead) |

Refusal is decided by the native feed while it parses, so a refused stream
stops early and xterm starts with most of the budget left.

## 8 MiB ring, attach-sized (120x40, 100k scrollback) — ms

`bench/rust-ansi-snapshot-bench.ts`, macOS arm64, median of 3, second run of
two (machine load average 7–11 from other work):

| Workload | xterm | Rust | Selected |
|---|---:|---:|---|
| Claude Code frames | 350 | 103 | Rust 102 |
| Redraw (clear + repaint) | 830 | 90 | Rust 93 |
| Shell (prompts, output, clears) | 832 | 39 (refused) | xterm 846 |
| Log flood | 808 | 36 (refused) | xterm 840 |

The native grid is capped at four million cells (rows are allocated only as
output fills them), so an attach's 100k-row history fits only 33k rows at
120 columns. A pure-append history past that is refused within ~40 ms and
served by xterm, which ships it raw anyway when the snapshot gains nothing.
