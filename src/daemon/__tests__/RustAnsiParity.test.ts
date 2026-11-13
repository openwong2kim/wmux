/**
 * Rendered parity of the Rust ANSI snapshot against xterm's, per control
 * class (the comparison and its accepted deviations are in _rustParity.ts).
 *
 * Runs where the native module is built (the rust-engine lane builds it).
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAnsiSnapshotBackendDiagnostics } from '../AnsiSnapshotBackend';
import { generateSnapshotUnqueued, type SnapshotRequest } from '../HeadlessSnapshot';
import { generateRustSnapshot } from '../RustSnapshot';
import { CLAUDE_WRAPPED_REPLY_80x30 } from '../../renderer/terminal/__tests__/fixtures/claudeWrappedReply';
import { restoreSeam } from '../../shared/restoreSeam';
import { available, expectParity, expectRustAloneDiverges, modulePath, parity, resized, synthetic, type Case } from './_rustParity';

const rowsOf8 = Array.from({ length: 8 }, (_, i) => `L${i}`).join('\r\n');
const savedThenScrolled = 'a\x1b[3;1H\x1b7\x1b[6;1H\n\n';
const twoRowHistory = (name: string, text: string): Case =>
  ({ name, backend: 'rust', req: { cols: 20, rows: 6, scrollback: 2, initial: Buffer.from(text) } });
/** From `start`, each step's text then the pane resized to its size; then `after`. */
const resizedThrough = (
  name: string, start: [number, number], steps: [string, [number, number]][], after: string, scrollback = 100,
): Case => {
  let text = '';
  const changes = steps.map(([chunk, [cols, rows]]) => {
    text += chunk;
    return { offset: Buffer.byteLength(text), cols, rows };
  });
  const [cols, rows] = steps[steps.length - 1][1];
  return { name, backend: 'rust', req: { cols, rows, scrollback, initial: Buffer.from(text + after),
    geometry: { start: { cols: start[0], rows: start[1] }, changes } } };
};
/** `before` at 20x6, the pane resized to `to`, then `after`. */
const resizedBetween = (name: string, before: string, to: [number, number], after: string): Case =>
  resizedThrough(name, [20, 6], [[before, to]], after);
const savedOnRow3CursorOnBottom = 'a\x1b[3;1H\x1b7\x1b[6;1Hb';
const longRows = Array.from({ length: 4 }, (_, i) => `${i}`.repeat(18)).join('\r\n');

// One or more cases per control class the selector used to refuse wholesale.
const accepted: Case[] = [
  // OSC: not screen state (xterm's path drops it too) except OSC 8, restored.
  synthetic('osc-title-bel', '\x1b]0;title\x07hello'),
  synthetic('osc-title-st', '\x1b]2;t\x1b\\x'),
  synthetic('osc-133', '\x1b]133;A\x07$ ls\r\nout\x1b]133;D;0\x07'),
  synthetic('osc-query', '\x1b]11;?\x07x'),
  synthetic('osc-palette', '\x1b]4;1;rgb:ff/00/00\x07\x1b[31mred'),
  synthetic('osc-52', '\x1b]52;c;aGk=\x07x'),
  synthetic('osc-partial-tail', 'hi\x1b]0;tit'),
  synthetic('osc-esc-abort', '\x1b]0;a\x1b[31mred'),
  synthetic('osc-can', '\x1b]0;a\x18text'),
  synthetic('osc-utf8', '\x1b]0;✳ Claude\x07ok'),
  synthetic('osc8-link', '\x1b]8;;https://e.com\x07link\x1b]8;;\x07 after'),
  synthetic('osc8-styles', '\x1b]8;;http://x\x07\x1b[1mbold\x1b[0mplain\x1b]8;;\x07 no'),
  synthetic('osc8-open-tail', 'a\x1b]8;id=k;http://y\x07open'),
  synthetic('osc8-alt', '\x1b]8;;http://n\x07nn\x1b[?1049h\x1b]8;;http://a\x07aa'),
  // DEC line drawing in G0/G1, as xterm.js maps it (`_` stays itself).
  synthetic('designate-dec', '\x1b(0' + Array.from({ length: 32 }, (_, i) => String.fromCharCode(0x5f + i)).join('') + '\x1b(B', 'rust', 40),
  synthetic('smacs-box', '\x1b(0lqqk\x1b(B\r\n\x1b(0x\x1b(B  \x1b(0x\x1b(B\r\n\x1b(0mqqj\x1b(B'),
  synthetic('smacs-open-at-end', 'ab\x1b(0lqk'),
  synthetic('dec-sgr', '\x1b[31m\x1b(0lqk\x1b(B\x1b[0m'),
  synthetic('dec-wide', '\x1b(0q\ud55cq\x1b(B'),
  synthetic('dec-wrap', '\x1b(0' + 'q'.repeat(24) + '\x1b(B'),
  synthetic('rep-after-dec', '\x1b(0q\x1b[3b\x1b(Bx'),
  synthetic('tab-under-dec', '\x1b(0a\tb\x1b(B'),
  synthetic('designate-dec-twice', '\x1b(0\x1b(0q\x1b(B\x1b(Bq'),
  synthetic('ris-dec', '\x1b(0q\x1bcq'),
  synthetic('so-si-dec', '\x1b)0\x0elqk\x0fabc'),
  synthetic('so-open-at-end', '\x1b)0\x0elqk'),
  synthetic('g1-designate-only', '\x1b)0qx'),
  // DECSC/DECRC and the alternate screen save the designations and the shift.
  synthetic('so-dec-decsc', '\x1b)0\x0e\x1b7\x0fq\x1b8q'),
  synthetic('decsc-designation', '\x1b(0\x1b7\x1b(Bq\x1b8q'),
  synthetic('decrc-unsaved-dec', '\x1b(0\x1b8q'),
  synthetic('decrc-unsaved-so', '\x1b)0\x0e\x1b8q'),
  synthetic('alt-1049-designation', '\x1b(0\x1b[?1049hq\x1b(Bq\x1b[?1049lq'),
  synthetic('alt-1049-so', '\x1b)0\x1b[?1049h\x0eq\x1b[?1049lq'),
  synthetic('alt-1049-si-inside', '\x1b)0\x0e\x1b[?1049hq\x0fq\x1b[?1049lq'),
  // G2/G3 and the locking shifts (LS2, LS3, LS3R, LS2R, LS1R), `ESC -` and
  // `ESC .` (G1, G2), and selectDefaultCharset (`ESC % @`/`G`).
  synthetic('designate-g2', '\x1b*0\x1bnlq\x1b(Bz'),
  synthetic('designate-g3-ls3', '\x1b+0\x1bolq\x0fz'),
  synthetic('ls3r-ls2r', '\x1b+0\x1b|q\x1b*0\x1b}q'),
  synthetic('ls2-undesignated', '\x1b(0\x1bnq'),
  synthetic('ls1r', '\x1b)0\x1b~q'),
  synthetic('designate-dash-g1', '\x1b-0\x0eq\x0fq'),
  synthetic('designate-dot-g2', '\x1b.0\x1bnq\x0fq'),
  synthetic('percent-g', '\x1b(0\x1b%Gq'),
  synthetic('percent-at-keeps-g1', '\x1b)0\x0e\x1b%@q\x0eq'),
  synthetic('designate-slash', '\x1b(0\x1b/Aq'),
  // DECRC restores the charset slots designated at the save (xterm's
  // savedCharsets); with nothing saved both keep every slot.
  synthetic('decrc-saved-g2', '\x1b*0\x1b7\x1b(B\x1b*B\x1b8\x1bnq'),
  synthetic('decrc-unsaved-g2', '\x1b*0\x1b8\x1bnq'),
  // A slot designated since the save restores alike when it holds the set it
  // held at the save: designated again to it (sgr0's `ESC ( B` on Claude
  // Code's alternate screen), or changed and changed back. The GL shift is
  // saved with the cursor on both (xterm's savedGlevel, Alacritty's
  // active_charset), so a shift between save and restore is restored alike.
  synthetic('alt-1049-redesignate-ascii', '\x1b[?1049h\x1b(Bq\x1b[?1049lq'),
  synthetic('decrc-redesignate-same-g2', '\x1b7\x1b*B\x1b8\x1bnq'),
  synthetic('decrc-redesignate-g2-and-back', '\x1b7\x1b*0\x1b*B\x1b8\x1bnq'),
  synthetic('decrc-redesignate-shifted', '\x1b)0\x1b7\x0e\x1b)0\x1b8q\x0eq'),
  // A ?1049l on the main screen: xterm restores its saved absolute row, so
  // each row scrolled into history since the save moves it up (to 0 at
  // most); ED 3 moves it down. The save is DECSC, a ?1049h, or a soft reset.
  synthetic('main-1049l-no-scroll', 'a\x1b[3;1H\x1b7\x1b[6;1Hb\x1b[?1049lX'),
  synthetic('main-1049l-scrolled', `${savedThenScrolled}\x1b[?1049lX`),
  synthetic('main-1049l-scrolled-past-top', 'a\x1b[3;1H\x1b7\x1b[6;1H\n\n\n\n\x1b[?1049lX'),
  synthetic('main-1049l-scrolled-ind', 'a\x1b[3;1H\x1b7\x1b[6;1H\x1bD\x1bD\x1b[?1049lX'),
  synthetic('main-1049l-scrolled-region', 'a\x1b[1;4r\x1b[3;1H\x1b7\x1b[4;1H\n\n\x1b[r\x1b[?1049lX'),
  synthetic('main-1049l-scrolled-synchronized', '\x1b[?2026ha\x1b[3;1H\x1b7\x1b[6;1H\n\n\x1b[?1049lX\x1b[?2026l'),
  synthetic('main-1049l-after-alt-save', 'a\x1b[3;1H\x1b[?1049hzz\x1b[?1049l\x1b[6;1H\n\n\x1b[?1049lX'),
  synthetic('main-1049l-ed3', `${rowsOf8}\x1b[1;1H\x1b7\x1b[3J\x1b[?1049lX`),
  synthetic('main-1049l-decstr', `${rowsOf8}\x1b[3;1H\x1b7\x1b[3J\x1b[!p\x1b[?1049lX`),
  // A full history keeps its size as rows scroll: both keep the screen row.
  twoRowHistory('main-1049l-full-history', `${rowsOf8}\x1b[3;1H\x1b7\x1b[6;1H\n\n\x1b[?1049lX`),
  twoRowHistory('main-1049l-filling-history', 'a\r\nb\x1b[3;1H\x1b7\x1b[6;1H\n\n\n\n\x1b[?1049lX'),
  // DECRC and SCORC on the main screen restore xterm's row the same way;
  // a region that does not start at the top scrolls nothing into history.
  synthetic('decrc-no-scroll', 'a\x1b[3;1H\x1b7\x1b[6;1Hb\x1b8X'),
  synthetic('decrc-scrolled', `${savedThenScrolled}\x1b8X`),
  synthetic('scorc-scrolled', 'a\x1b[3;1H\x1b[s\x1b[6;1H\n\n\x1b[uX'),
  // (The region is reset at the end: neither snapshot serializes margins.)
  synthetic('decrc-scrolled-region', 'a\x1b[1;4r\x1b[3;1H\x1b7\x1b[4;1H\n\n\x1b8X\x1b[r'),
  synthetic('scorc-scrolled-region', 'a\x1b[1;4r\x1b[3;1H\x1b[s\x1b[4;1H\n\n\x1b[uX\x1b[r'),
  synthetic('decrc-scrolled-inner-region', 'a\x1b[2;5r\x1b[3;1H\x1b7\x1b[5;1H\n\n\x1b8X\x1b[r'),
  synthetic('decrc-ed3', `${rowsOf8}\x1b[1;1H\x1b7\x1b[3J\x1b8X`),
  // xterm's restore ends in _restrictCursor: past the bottom after ED 3, the
  // last row; with DECOM on, inside the scrolling region.
  synthetic('main-1049l-ed3-below-screen', `${rowsOf8}\x1b[5;1H\x1b7\x1b[3J\x1b[?1049lX`),
  synthetic('decrc-ed3-below-screen', `${rowsOf8}\x1b[5;1H\x1b7\x1b[3J\x1b8X`),
  synthetic('decrc-origin-scrolled-above-region',
    `\x1b[3;6r\x1b[?6h\x1b7\x1b[r${'\n'.repeat(8)}\x1b[3;6r\x1b8X\x1b[r\x1b[?6l`),
  synthetic('decrc-origin-ed3-below-region', `${rowsOf8}\x1b[1;2r\x1b[?6h\x1b7\x1b[3J\x1b8X\x1b[r\x1b[?6l`),
  synthetic('decrc-origin-no-scroll', 'a\x1b[2;5r\x1b[?6h\x1b[3;1H\x1b7\x1b8X\x1b[r\x1b[?6l'),
  twoRowHistory('decrc-full-history', `${rowsOf8}\x1b[3;1H\x1b7\x1b[6;1H\n\n\x1b8X`),
  twoRowHistory('scorc-full-history', `${rowsOf8}\x1b[3;1H\x1b[s\x1b[6;1H\n\n\x1b[uX`),
  // A resize between the scroll and the restore: the rows it moves between
  // the screen and the history are not the stream's scrolling.
  resizedBetween('main-1049l-scrolled-then-widened', savedThenScrolled, [24, 6], '\x1b[?1049lX'),
  resizedBetween('decrc-scrolled-then-taller', savedThenScrolled, [20, 8], '\x1b8X'),
  resizedBetween('decrc-scrolled-then-narrowed', `${longRows}\x1b[3;1H\x1b7\x1b[6;1H\n\n`, [12, 6], '\x1b8X'),
  resizedBetween('decrc-scrolled-then-widened', `${longRows}\r\n${'z'.repeat(30)}\x1b[3;1H\x1b7\x1b[6;1H\n\n`, [30, 6], '\x1b8X'),
  // Shorter between a main-screen save and its restore. Shrinking pushes the
  // rows the cursor needs into history on both; xterm keeps its absolute
  // saved row (less what its history cap trims), Alacritty clamps its saved
  // screen row (row_step in native_core.rs).
  // - The rows pushed for the cursor are not the stream's scrolling:
  resizedBetween('decrc-shorter-cursor-on-bottom', savedOnRow3CursorOnBottom, [20, 4], '\x1b8X'),
  resizedBetween('scorc-shorter-cursor-on-bottom', 'a\x1b[3;1H\x1b[s\x1b[6;1Hb', [20, 4], '\x1b[uX'),
  resizedBetween('main-1049l-shorter-cursor-on-bottom', savedOnRow3CursorOnBottom, [20, 4], '\x1b[?1049lX'),
  resizedBetween('decrc-shorter-cursor-mid', 'a\x1b[2;1H\x1b7\x1b[5;1Hb', [20, 4], '\x1b8X'),
  // - A saved row below the new bottom: Alacritty clamps it, xterm keeps it,
  //   which shows once the stream scrolls.
  resizedBetween('decrc-shorter-saved-below-bottom', 'a\x1b[6;1H\x1b7\x1b[2;1Hb', [20, 4], '\x1b[4;1H\n\n\x1b8X'),
  // - xterm's cap trims history rows and moves its saved row with them:
  resizedThrough('decrc-shorter-full-history', [20, 6], [[`${rowsOf8}\x1b[3;1H\x1b7\x1b[6;1Hb`, [20, 4]]], '\x1b8X', 2),
  resizedThrough('decrc-shorter-filling-history', [20, 6], [['a\r\nb\r\nc\x1b[4;1H\x1b7\x1b[6;1Hb', [20, 3]]], '\x1b8X', 2),
  resizedThrough('decrc-shorter-twice', [20, 8], [['a\x1b[5;1H\x1b7\x1b[8;1Hb', [20, 6]], ['x', [20, 4]]], '\x1b8X'),
  resizedThrough('decrc-shorter-then-taller', [20, 6], [[`a\x1b[4;1H\x1b7\x1b[6;1Hb`, [20, 4]], ['x', [20, 6]]], '\x1b8X'),
  resizedBetween('decrc-shorter-with-region', 'a\x1b[4;1H\x1b7\x1b[1;5r\x1b[6;1Hb', [20, 4], '\x1b8X'),
  // - Rows before columns, on both: narrower and wider while shorter.
  resizedBetween('decrc-narrower-and-shorter', `${'w'.repeat(30)}\r\nb\x1b[3;1H\x1b7\x1b[6;1Hc`, [12, 4], '\x1b8X'),
  resizedBetween('decrc-wider-and-shorter', `${'w'.repeat(30)}\r\nb\x1b[3;1H\x1b7\x1b[6;1Hc`, [30, 4], '\x1b8X'),
  // - Shorter with the alternate screen shown: the main screen's save is the
  //   `?1049h`'s, on the cursor's row, which both move alike.
  resizedBetween('main-shorter-under-alt', 'a\x1b[5;1H\x1b[?1049hzz', [20, 4], '\x1b[?1049l\n\n\x1b8X'),
  // A line feed inside the save runs first and scrolls before it.
  synthetic('decsc-line-feed-inside', 'a\x1b[6;1H\x1b\n7\x1b[2;1Hb\x1b8X'),
  synthetic('decsc-ls2', '\x1b*0\x1bn\x1b7\x0fq\x1b8q'),
  synthetic('alt-1049-ls2', '\x1b*0\x1bn\x1b[?1049h\x0fq\x1b[?1049lq'),
  synthetic('ls2-in-update', '\x1b*0\x1b[?2026h\x1bnq\x1b[?2026l'),
  // DECSTR, xterm's softReset: the cursor stays, the rest resets.
  synthetic('decstr', 'ab\x1b[4h\x1b[!pcd'),
  synthetic('decstr-margins-mid', 'ab\x1b[2;3r\x1b[3;2H\x1b[!pX'),
  synthetic('decstr-full-region', '1\r\n2\r\n3\x1b[1;2r\x1b[!p\x1b[6;1H\nX'),
  synthetic('decstr-pending-wrap', `${'x'.repeat(20)}\x1b[!pY`),
  synthetic('decstr-after-nowrap', `\x1b[?7l${'x'.repeat(22)}\x1b[!pY`),
  synthetic('decstr-origin', '\x1b[2;3r\x1b[?6h\x1b[2;2H\x1b[!pX\x1b[HY'),
  synthetic('decstr-sgr-link', '\x1b[1;31m\x1b]8;;http://x\x07a\x1b[!pb'),
  synthetic('decstr-modes', '\x1b[?1h\x1b=\x1b[?2004h\x1b[?1004h\x1b[?25l\x1b[4hx\x1b[!py'),
  synthetic('decstr-saved-cursor', 'ab\x1b[2;3H\x1b[1m\x1b7\x1b[!p\x1b[3;3H\x1b8X'),
  synthetic('decstr-saved-charsets', '\x1b(0\x1b7\x1b[!p\x1b8q'),
  synthetic('decstr-charsets', '\x1b(0\x1b)0\x0e\x1b*0\x1bn\x1b[!pq'),
  synthetic('decstr-alt', 'n\x1b[?1049hab\x1b[!pc'),
  synthetic('decstr-alt-left', 'n\x1b[?1049h\x1b[2;3r\x1b[!p\x1b[?1049lX'),
  synthetic('decstr-in-update', 'a\x1b[?2026hb\x1b[!pc'),
  synthetic('decstr-mouse', '\x1b[?1000;1006h\x1b[!px'),
  // SO/SI and ASCII designation: with only ASCII designated, shifts are no-ops.
  synthetic('so-si', '\x0eabc\x0fdef'),
  synthetic('designate-ascii', '\x1b(B\x1b)Babc\x0e\x1b[mx\x0f'),
  // DECSC/DECRC and SCOSC/SCORC: parsed alike; neither path restores the slot.
  synthetic('decsc', 'ab\x1b7cd\r\n\x1b8X'),
  synthetic('decrc-unsaved', 'abc\r\n\x1b8X'),
  synthetic('decsc-attrs', '\x1b[31m\x1b7\x1b[0m\x1b8X'),
  synthetic('decsc-alt', 'n\x1b7\x1b[?1049ha\x1b7b\x1b[?1049l\x1b8X'),
  synthetic('scosc', 'ab\x1b[scd\x1b[uX'),
  // Kitty keyboard flags: input state, restored by neither path.
  synthetic('kitty-push-pop', '\x1b[>1uhello\x1b[<u'),
  synthetic('kitty-query', '\x1b[?uhi'),
  synthetic('kitty-set', '\x1b[=1;1uhi'),
  // Tab stops (HTS, TBC): parsed alike, restored by neither path.
  synthetic('hts', '\x1b[1;5H\x1bH\r\ta\tb'),
  synthetic('tbc-all', '\x1b[3g\tX'),
  synthetic('tbc-one', '\x1b[1;9H\x1b[g\r\tX'),
  synthetic('tab-plain', 'a\tb\tc\r\nxx\t\ty'),
  synthetic('tab-at-wrap', 'abcdefgh\tX', 'rust', 8),
  // CSI q family: cursor style, LEDs, protection and version query.
  synthetic('decscusr', '\x1b[5 qhi'),
  synthetic('xtversion', '\x1b[>0qhi'),
  synthetic('decll', '\x1b[1qhi'),
  synthetic('decsca', '\x1b[1"qhi\x1b[0"q'),
  synthetic('sgr-no-overline', 'a\x1b[55mb'),
  // Rows and blanks.
  synthetic('trailing-printed-space', 'ab   \r\ncd'),
  synthetic('erase-bg', 'abc\x1b[44m\x1b[K\x1b[0m\r\nx\x1b[41m  \x1b[0m'),
  synthetic('erase-bg-middle', '\x1b[44m\x1b[2K\x1b[0m\x1b[1;5Hmid'),
  synthetic('wide-wrap', 'abcdefg中X', 'rust', 8),
  synthetic('modes', '\x1b[?1h\x1b[?2004h\x1b[?1002h\x1b[?1006h\x1b[?1004h\x1b=\x1b[4hready'),
  synthetic('mode-sgr-pixels', '\x1b[?1000h\x1b[?1016hx'),
  synthetic('mode-sync-open', '\x1b[?2026hx'),
  // A fullwidth glyph erased by half: xterm erases it whole.
  synthetic('wide-ech-first-half', 'a\u4e2db\x1b[1;2H\x1b[X'),
  synthetic('wide-el0-second-half', 'a\u4e2db\x1b[1;3H\x1b[K'),
  synthetic('wide-el1-first-half', 'a\u4e2db\x1b[1;2H\x1b[1K'),
  synthetic('wide-ed0-second-half', 'a\u4e2db\x1b[1;3H\x1b[J'),
  synthetic('wide-ed1-first-half', 'x\r\na\u4e2db\x1b[2;2H\x1b[1J'),
  synthetic('wide-ech-colored', 'a\x1b[42m\u4e2d\x1b[0mb\x1b[44m\x1b[1;3H\x1b[X\x1b[0m'),
  // Mouse protocol and encoding with xterm's semantics.
  synthetic('mouse-reset-by-other', '\x1b[?1002h\x1b[?1006h\x1b[?1000lx'),
  synthetic('mouse-1005-keeps-sgr', '\x1b[?1000h\x1b[?1006h\x1b[?1005hx'),
  synthetic('mouse-last-set-wins', '\x1b[?1003;1000h\x1b[?1016hx'),
  synthetic('rep-after-print', 'ab\x1b[3bc'),
  // ICH, DCH and ECH drop a pending wrap in xterm (the live probe then prints Z).
  synthetic('ech-at-pending-wrap', 'abcdefghij\x1b[X', 'rust', 10),
  synthetic('dch-at-pending-wrap', 'abcdefghij\x1b[P', 'rust', 10),
  synthetic('ich-at-pending-wrap', 'abcdefghij\x1b[@', 'rust', 10),
  // Mode spellings xterm reads by number.
  synthetic('mouse-embedded-c0', '\x1b[?100\r0hx'),
  synthetic('mouse-leading-zeros', '\x1b[?01002;01006hx'),
  synthetic('colon-rgb-colorspace', '\x1b[38:2::10:20:30mx\x1b[48:5:3my'),
  // DCH at a fullwidth glyph's first half: the spacer it pulls to the cursor
  // is filled with the erase attribute, as xterm's deleteCells does
  // (vendor/alacritty_terminal WMUX-PATCH.md).
  synthetic('wide-dch-first-half', 'a中b\x1b[1;2H\x1b[P'),
  synthetic('wide-dch-second-half-blank', ' 中b\x1b[44m\x1b[1;2H\x1b[P'),
  // ECH at either half of a fullwidth glyph erases the whole glyph, as
  // xterm's replaceCells does.
  synthetic('wide-ech-second-half', 'a中b\x1b[44m\x1b[1;3H\x1b[X'),
  synthetic('wide-ech-ending-on-first-half', 'a中b\x1b[44m\x1b[1;1H\x1b[2X'),
];

// Classes that stay on xterm because Alacritty parses them differently.
const refused: Case[] = [
  synthetic('sync-mixed-params', 'a\x1b[?2026hb\x1b[?2026;1lc', 'xterm'),
  synthetic('deccolm', 'abc\x1b[?3hd', 'xterm'),
  synthetic('colon-rgb-no-colorspace', '\x1b[38:2:10:20:30mx', 'xterm'),
  synthetic('colon-indexed-no-operand', '\x1b[31m\x1b[38:5mx', 'xterm'),
  synthetic('colon-rgb-short', '\x1b[38:2::10:20mx', 'xterm'),
  synthetic('alt-1047-leading-zero', 'n\x1b[?01047ha', 'xterm'),
  synthetic('rep-after-control', 'X\r\x1b[3b', 'xterm'),
  synthetic('rep-after-sgr', 'X\x1b[31m\x1b[3b', 'xterm'),
  synthetic('decaln', 'ab\x1b[2;3H\x1b#8', 'xterm'),
  synthetic('sd-caret', '1\r\n2\r\n3\x1b[1^x', 'xterm'),
  synthetic('ed2-embedded-c0', '1\r\n2\r\n3\x1b[2\x00Jx', 'xterm'),
  synthetic('designate-uk', '\x1b(A#x\x1b(B#', 'xterm'),
  synthetic('designate-uk-g2', '\x1b*A\x1bn#', 'xterm'),
  synthetic('ls2-with-c0-inside', '\x1b*0\x1b\x07nq', 'xterm'),
  synthetic('designate-unknown-final', '\x1b(0\x1b(Xq', 'xterm'),
  // xterm's DECSET 2 puts ASCII in G0-G3; vte ignores it.
  synthetic('decanm-resets-g2', '\x1b*0\x1b[?2h\x1bnq', 'xterm'),
  synthetic('decanm-resets-g0', '\x1b(0\x1b[?2hq', 'xterm'),
  // xterm restores only the slots it saved, and DECAWM/DECOM from the save.
  synthetic('decrc-later-g2', '\x1b7\x1b*0\x1b8\x1bnq', 'xterm'),
  synthetic('alt-1049-later-g2', '\x1b(0\x1b[?1049h\x1b*0\x1b[?1049l\x1bnq', 'xterm'),
  synthetic('alt-1049-later-g0-dec', '\x1b[?1049h\x1b(0q\x1b[?1049lq', 'xterm'),
  synthetic('decstr-decrc-nowrap', `\x1b[?7l\x1b7\x1b[!p\x1b8${'x'.repeat(25)}`, 'xterm'),
  synthetic('decrc-unsaved-nowrap', `\x1b[?7l\x1b8${'x'.repeat(25)}`, 'xterm'),
  synthetic('decstr-cut-by-del', 'ab\x1b[4h\x1b[!\x7fpcd', 'xterm'),
  synthetic('overline', '\x1b[53mover\x1b[55mno', 'xterm'),
  synthetic('sgr-21', '\x1b[21mx\x1b[24my', 'xterm'),
  synthetic('c1', 'a\u009b31mred', 'xterm'),
  synthetic('decsed', 'abc\r\ndef\x1b[?2J', 'xterm'),
  synthetic('decsel', 'abcdef\x1b[1;3H\x1b[?K', 'xterm'),
  synthetic('sl', 'abcdef\x1b[2 @', 'xterm'),
  synthetic('decic', 'abcdef\x1b[1;2H\x1b[2\'}', 'xterm'),
  synthetic('decstr-with-params', 'ab\x1b[4h\x1b[1!pcd', 'xterm'),
  synthetic('ed2-spelled-02', '1\r\n2\r\n3\x1b[02Jx', 'xterm'),
  synthetic('lnm', '\x1b[20ha\nb', 'xterm'),
  synthetic('mode-x10', '\x1b[?9hx', 'xterm'),
  synthetic('mode-reverse-wrap', '\x1b[?45hx', 'xterm'),
  synthetic('mode-decnkm', '\x1b[?66hx', 'xterm'),
  synthetic('alt-47', 'n\x1b[?47ha', 'xterm'),
  synthetic('alt-1047', 'n\x1b[?1047ha\x1b[?1047lb', 'xterm'),
  // The restore seam's controls where they diverge: ?47l and ?1047l leave
  // xterm's alternate screen, and a ?47 round trip shows a blank one while
  // it is open or once it holds more than kitty keyboard controls.
  synthetic('alt-47-leaves-1049', 'n\x1b[?1049ha\x1b[?47lb', 'xterm'),
  synthetic('alt-1047-leaves-1049', 'n\x1b[?1049ha\x1b[?1047lb', 'xterm'),
  synthetic('alt-47-round-trip-text', 'n\x1b[?47ha\x1b[?47lb', 'xterm'),
  synthetic('alt-47-round-trip-open', 'n\x1b[?47h\x1b[<99u', 'xterm'),
  // xterm reads the mode before a colon; the feed's tracker reads none.
  synthetic('alt-47-subparam', 'a\x1b[?47:0hXYZ', 'xterm'),
  synthetic('alt-1049-subparam', 'a\x1b[?1049:0hXYZ\x1b[?1049l', 'xterm'),
  synthetic('save-1048', 'ab\x1b[?1048hcd\r\n\x1b[?1048lX', 'xterm'),
  // Refused by the serializer: xterm drops a saved pending wrap.
  synthetic('decsc-wrap-pending', 'abcdefgh\x1b7\x1b[H\x1b8X', 'xterm', 8),
  synthetic('alt-save-at-wrap', 'abcdefgh\x1b[?1049h\x1b[?1049lX', 'xterm', 8),
  synthetic('alt-decsc-wrap-pending', 'n\x1b[?1049h\x1b[Habcdefgh\x1b7\x1b[H', 'xterm', 8),
];

// Served natively once the alternate screen that held the refused state is
// left: the payload carries none of that screen. (Its saved cursor, which
// xterm keeps, is in neither backend's payload.)
const leftAlt: Case[] = [
  synthetic('alt-decsc-wrap-pending-left', 'n\x1b[?1049h\x1b[Habcdefgh\x1b7\x1b[?1049lX', 'rust', 8),
];

// A recovered pane's ring: what the dead process left, the restore seam the
// daemon writes (the real one, at the pane's rows), then the fresh shell. Its
// prompt holds lowercase letters, which DEC line drawing would turn into
// glyphs: a charset or shift the seam leaves differently shows there.
const recovered = (name: string, dump: string | Buffer, after = 'PS> ls -la', cols = 20, rows = 6,
  backend: 'rust' | 'xterm' = 'rust'): Case =>
  ({ name: `seam/${name}`, backend, req: { cols, rows, scrollback: 100,
    initial: Buffer.concat([Buffer.from(dump), Buffer.from(restoreSeam(rows) + after)]) } });
const seams: Case[] = [
  recovered('plain', 'old> ls\r\nfile\r\nold> '),
  // xterm's ?1049l restores the main screen's saved cursor even on the main
  // screen (position, G0-G3 as saved, the GL shift); Alacritty's does only
  // when it leaves the alternate one, so the feed runs that restore there.
  recovered('cursor-away-unsaved', 'a\r\nb\r\nc\x1b[3;9H'),
  recovered('cursor-away-saved', 'a\x1b[2;5H\x1b7\x1b[5;12Hb'),
  recovered('main-saved-g0', '\x1b(B\x1b7\x1b(0q'),
  recovered('main-shifted-dec-g1', '\x1b)0\x0eq'),
  // A slot designated since the save to another set stays on xterm only.
  recovered('main-later-g0-dec', '\x1b7\x1b(0q', 'PS> ls -la', 20, 6, 'xterm'),
  recovered('cursor-pending-wrap', 'x'.repeat(20)),
  // A full-screen program that exited, then output that scrolled: the seam's
  // ?1049l restores the row that program's ?1049h saved.
  recovered('exited-app-then-scrolled', `a\x1b[3;1H\x1b[?1049hzz\x1b[?1049l${'out\r\n'.repeat(10)}`),
  // An agent that died on its alternate screen with input reporting on.
  recovered('died-on-alt', 'sh\r\n\x1b[>1u\x1b[?1049h\x1b[>3u\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b[?1004h\x1b[?1h\x1b=\x1b[?25l\x1b[3;3Hui'),
  recovered('died-on-main-modes', '\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[31mred'),
  recovered('twice', `a${restoreSeam(6)}PS> exit\r\n`),
  recovered('claude-capture', Buffer.from(CLAUDE_WRAPPED_REPLY_80x30, 'base64'), 'PS> ', 80, 30),
];

// A line feed into a soft-wrapped row's continuation: LF, VT and FF end the
// paragraph there (xterm's lineFeed), IND and NEL keep it (xterm's index),
// and neither touches it when it scrolls.
const para = `${'x'.repeat(25)}\x1b[1;1H`;
const bottom = `\x1b[6;1H${'x'.repeat(25)}\x1b[6;1H`;
const lineFeeds: Case[] = [
  synthetic('lf-into-continuation', `${para}\nY`),
  synthetic('lf-into-continuation-no-print', `${para}\n`),
  synthetic('vt-into-continuation', `${para}\x0bY`),
  synthetic('ff-into-continuation', `${para}\x0cY`),
  synthetic('lf-into-continuation-in-region', `${para}\x1b[1;4r\x1b[1;1H\n\x1b[rY`),
  synthetic('ind-into-continuation', `${para}\x1bDY`),
  synthetic('nel-into-continuation', `${para}\x1bEY`),
  synthetic('ind-into-continuation-in-update', `${para}\x1b[?2026h\x1bDY\x1b[?2026l`),
  synthetic('nel-c1-into-continuation', `${para}\u0085Y`, 'xterm'),
  synthetic('lf-scrolls-a-paragraph', `${bottom}\nY`),
  synthetic('ind-scrolls-a-paragraph', `${bottom}\x1bDY`),
  // An auto-wrap keeps its paragraph, also below a scroll region.
  synthetic('auto-wrap-below-region', `\x1b[1;3r\x1b[5;1H${'x'.repeat(25)}\x1b[r`),
  // Both drop a pending wrap: the next glyph lands in the last column.
  synthetic('lf-drops-pending-wrap', `${'x'.repeat(20)}\nY`),
  synthetic('ind-drops-pending-wrap', `${'x'.repeat(20)}\x1bDY`),
  // A C0 inside IND: left to the reference.
  synthetic('ind-with-c0-inside', `${para}\x1b\x07DY`, 'xterm'),
  synthetic('ind-with-del-inside', `${para}\x1b\x7fDY`, 'xterm'),
];

// Erases and character edits on a soft-wrapped paragraph. xterm keeps the
// wrap as the next row's isWrapped: EL, ECH, ICH and DCH never touch it, EL2
// and an EL0 from column 0 end the row's own (it is no longer a
// continuation), and ED resets every row it clears whole.
const para3 = `${'x'.repeat(45)}\x1b[1;1H`;
const history = 'x'.repeat(130); // the screen's top row continues a history row
const erases: Case[] = [
  synthetic('el0-on-a-pending-wrap', `${para}\x1b[1;20HX\x1b[K`),
  synthetic('el0-mid-continuation', `${para}\x1b[2;3H\x1b[K`),
  synthetic('el0-at-col0-on-a-continuation', `${para}\x1b[2;1H\x1b[K`),
  synthetic('el1-to-the-last-column', `${para}\x1b[1;20H\x1b[1K`),
  synthetic('el1-on-a-pending-wrap', `${para}\x1b[1;20HX\x1b[1K`),
  synthetic('el1-on-a-continuation', `${para}\x1b[2;3H\x1b[1K`),
  synthetic('el2-on-a-continuation', `${para}\x1b[2;3H\x1b[2K`),
  synthetic('ech-to-the-last-column', `${para}\x1b[1;18H\x1b[5X`),
  synthetic('ech-on-a-pending-wrap', `${para}\x1b[1;20HX\x1b[XY`),
  synthetic('ich-on-a-wrapping-row', `${para}\x1b[1;5H\x1b[3@`),
  synthetic('ich-on-a-pending-wrap', `${para}\x1b[1;20HX\x1b[@Y`),
  synthetic('dch-on-a-pending-wrap', `${para}\x1b[1;20HX\x1b[PY`),
  synthetic('irm-print-on-a-wrapping-row', `${para}\x1b[4h\x1b[1;5HAB\x1b[4l`),
  synthetic('ed0-mid-continuation', `${para3}\x1b[2;6H\x1b[J`),
  synthetic('ed0-at-col0-on-a-continuation', `${para3}\x1b[2;1H\x1b[J`),
  synthetic('ed0-on-a-pending-wrap', `${para}\x1b[1;20HX\x1b[J`),
  synthetic('ed0-on-a-pending-wrap-bottom', `\x1b[6;1H${'x'.repeat(20)}\x1b[J`),
  synthetic('ed0-at-col0-on-the-history-continuation', `${history}\x1b[1;1H\x1b[J`),
  synthetic('ed1-from-the-second-row', `abc\r\ndef\x1b[2;2H\x1b[1J`),
  synthetic('ed1-to-the-last-column', `${para3}\x1b[2;20H\x1b[1J`),
  synthetic('ed1-mid-row', `${para3}\x1b[2;3H\x1b[1J`),
  synthetic('ed1-on-the-history-continuation', `${history}\x1b[1;3H\x1b[1J`),
  synthetic('ed2-with-a-history-continuation', `${history}\x1b[2J`),
  synthetic('ed2-on-the-alternate-screen', `\x1b[?1049h${'x'.repeat(25)}\x1b[2J`),
  // A wrapped row whose cells an erase emptied through its edge: they replay
  // erased, in their background, not printed (then a line feed into the
  // continuation would leave them as trailing blanks).
  synthetic('el0-on-a-wrapping-row', `${para}\x1b[1;10H\x1b[K`),
  synthetic('el0-on-a-wrapping-row-bg', `${para}\x1b[1;10H\x1b[44m\x1b[K\x1b[0m`),
  synthetic('el0-at-col0-mid-paragraph', `${para3}\x1b[2;1H\x1b[K`),
  synthetic('el2-on-a-wrapping-row', `${para}\x1b[2K`),
  synthetic('el2-on-the-history-continuation', `${history}\x1b[1;1H\x1b[2K`),
  synthetic('ech-whole-row', `${para}\x1b[20X`),
  synthetic('dch-on-a-wrapping-row', `${para}\x1b[1;5H\x1b[3P`),
  // Later edits keep that run: an erase inside it or reaching into it, and
  // inserted cells, which move it.
  synthetic('ech-inside-an-erased-edge', `${para}\x1b[1;10H\x1b[K\x1b[1;15H\x1b[X`),
  synthetic('el1-into-an-erased-edge', `${para}\x1b[1;10H\x1b[K\x1b[1;12H\x1b[1K\x1b[1;2H`),
  synthetic('ich-on-an-erased-edge', `${para}\x1b[1;10H\x1b[K\x1b[1;3H\x1b[2@`),
  synthetic('irm-on-an-erased-edge', `${para}\x1b[1;10H\x1b[K\x1b[4h\x1b[1;3HZ\x1b[4l`),
  synthetic('ed1-into-an-erased-edge', `${para}\x1b[1;10H\x1b[K\x1b[1;12H\x1b[1J\x1b[1;2H`),
  // Inserted blanks through the edge, and a wide glyph insert mode pushes
  // into the last column (xterm blanks it), are empty cells too.
  synthetic('ich-to-the-edge', `${para}\x1b[1;3H\x1b[20@`),
  synthetic('irm-blanks-a-wide-glyph-at-the-edge', `${para}\x1b[1;19H한\x1b[4h\x1b[1;3Ha\x1b[4l`),
  // A wide glyph that ECH or DCH cuts goes whole: its other cell is erased
  // too, through the edge here.
  synthetic('ech-cuts-a-wide-glyph-at-the-edge', 'abc界de\x1b[1;4H\x1b[X\x1b[1;1H', 'rust', 5),
  synthetic('dch-at-a-wide-glyph-spacer-at-the-edge', 'abc界de\x1b[1;5H\x1b[P\x1b[1;1H', 'rust', 5),
];

// Controls the selector never refused, rechecked now that Rust is the default.
const others: Case[] = [
  synthetic('ris', 'abc\x1b[31m\x1bcdef'),
  synthetic('ind-nel-ri', 'a\x1bDb\x1bEc\x1bMd'),
  synthetic('cht-cbt', 'a\x1b[2Ib\x1b[Zc'),
  synthetic('cnl-cpl', 'a\r\nb\x1b[Fc\x1b[2Ed'),
  synthetic('hpa-vpa', '\x1b[5`a\x1b[3db'),
  synthetic('ich-dch-ech', 'abcdef\x1b[1;2H\x1b[2@\x1b[1P\x1b[2X'),
  // DCH past the line end clears from the cursor only (xterm.js deleteChars).
  synthetic('dch-past-line-end', 'abcdef\x1b[1;5H\x1b[44m\x1b[30P\x1b[0m'),
  synthetic('dch-past-line-end-full-row', 'abcdefghijklmnopqrst\x1b[1;18H\x1b[9P'),
  synthetic('il-dl', '1\r\n2\r\n3\x1b[2;1H\x1b[L\x1b[2M'),
  // SD fills with default attributes in xterm; IL and RI with the erase colour.
  synthetic('sd-bg', '1\r\n2\r\n3\x1b[44m\x1b[1T\x1b[0mx'),
  synthetic('sd-region-bg', '1\r\n2\r\n3\r\n4\x1b[2;4r\x1b[44m\x1b[2T\x1b[0m\x1b[rx'),
  synthetic('il-bg', '1\r\n2\x1b[44m\x1b[H\x1b[L\x1b[0mx'),
  synthetic('ri-top-bg', '1\r\n2\x1b[44m\x1b[H\x1bM\x1b[0mx'),
  // SU scrolls the region in place: xterm keeps nothing in history.
  synthetic('su', '1\r\n2\r\n3\x1b[2S\x1b[1T'),
  synthetic('su-full-screen', '1\r\n2\r\n3\r\n4\r\n5\r\n6\x1b[2Sx'),
  synthetic('su-with-history', '0\r\n1\r\n2\r\n3\r\n4\r\n5\r\n6\r\n7\x1b[3Sx'),
  synthetic('su-default-and-zero', '1\r\n2\r\n3\x1b[S\x1b[0Sx'),
  synthetic('su-past-screen', '1\r\n2\r\n3\x1b[44m\x1b[99S\x1b[0mx'),
  synthetic('su-bg', '1\r\n2\r\n3\x1b[44m\x1b[2S\x1b[0mx'),
  synthetic('su-region-top', '1\r\n2\r\n3\r\n4\r\n5\x1b[1;4r\x1b[2S\x1b[rx'),
  synthetic('su-region-middle', '1\r\n2\r\n3\r\n4\r\n5\x1b[2;5r\x1b[2S\x1b[rx'),
  synthetic('su-alt', 'n\x1b[?1049h1\r\n2\r\n3\x1b[2Sx'),
  synthetic('su-then-linefeed', 'a\x1b[S\x1b[6;1Hb\r\nc\r\nd'),
  // top: a region scrolled up while the header stays (ncurses `indn`).
  synthetic('su-top-like', `${Array.from({ length: 6 }, (_, i) => `row ${i}`).join('\r\n')}\x1b[3;6r\x1b[6;1H\x1b[2S\x1b[5;1Hnew a\x1b[6;1Hnew b\x1b[r\x1b[1;1HPID`),
  // DL on the top row deletes in place: xterm keeps nothing in history.
  synthetic('dl-row0', '1\r\n2\r\n3\x1b[H\x1b[Mx'),
  synthetic('dl-row0-history', '0\r\n1\r\n2\r\n3\r\n4\r\n5\r\n6\r\n7\x1b[H\x1b[2Mx'),
  synthetic('dl-row0-past-screen', '1\r\n2\r\n3\x1b[H\x1b[44m\x1b[9M\x1b[0mx'),
  synthetic('dl-row0-region', '1\r\n2\r\n3\r\n4\x1b[1;3r\x1b[H\x1b[M\x1b[rx'),
  synthetic('ed3', '1\r\n2\r\n3\r\n4\r\n5\r\n6\r\n7\r\n8\x1b[3J'),
  // ED 2 erases in place in xterm; Alacritty scrolls the screen into history.
  synthetic('ed2-primary', '1\r\n2\r\n3\x1b[2Jx'),
  synthetic('ed2-repeated', Array.from({ length: 20 }, (_, i) => `\x1b[H\x1b[2Jframe ${i}\r\n\x1b[3${i % 8}mstatus`).join('')),
  synthetic('ed2-bg', 'abc\r\ndef\x1b[44m\x1b[2J\x1b[0mx'),
  synthetic('ed2-in-sync', 'a\r\nb\x1b[?2026h\x1b[2Jc\x1b[?2026ld'),
  synthetic('ed2-sync-open', 'a\r\nb\x1b[?2026h\x1b[2Jc'),
  synthetic('ed2-osc-abort', 'a\r\nb\x1b]0;title\x1b[2Jc'),
  synthetic('ed2-alt', 'n\x1b[?1049ha\r\nb\x1b[2Jc'),
  synthetic('ed1-second-row', 'aaa\r\nbbb\x1b[1J'),
  synthetic('ed1-third-row', 'aaa\r\nbbb\r\nccc\x1b[1J'),
  synthetic('ed0', 'aaa\r\nbbb\x1b[1;2H\x1b[J'),
  synthetic('sgr', '\x1b[1;2;3;4;5;7;8;9;31;44mstyled\x1b[22;23;24;25;27;28;29mplain\x1b[4:3;58:2::1:2:3mcurl\x1b[91;102mbright'),
  synthetic('sgr-color-operands', '\x1b[38;5;53mx\x1b[48;2;53;55;6my\x1b[38:2::53:55:5mz'),
  synthetic('emoji-cjk', 'abc한\u{1F600}Z é \u{1F468}‍\u{1F469}', 'rust', 12),
  synthetic('dcs-apc', 'a\x1bP1$r0m\x1b\\b\x1b_x\x1b\\c'),
  synthetic('partial-sgr', 'hello\x1b[31;'),
  synthetic('scroll-history', Array.from({ length: 50 }, (_, i) => `\x1b[3${i % 8}mline${i}\x1b[0m`).join('\r\n')),
];

const box = Array.from({ length: 3 }, (_, k) => `${`[frame ${k}]`.padEnd(70, '=')}\r\n${`[body ${k}]`.padEnd(70, '.')}\r\n${k < 2 ? '\x1b[2A\r' : ''}`).join('');
const many = Array.from({ length: 30 }, (_, i) => `row ${i} ${'x'.repeat(i % 50)}`).join('\r\n');
const resizes: Case[] = [
  // vte holds bytes inside a synchronized update; xterm parsed them at 80.
  resized('resize-in-sync-update', '\x1b[?2026h\x1b[1;70HX', [80, 12], [40, 12]),
  // Rows a narrower reflow adds above the cursor with no history: xterm moves
  // the cursor down into the room below, and so does the native terminal.
  resized('narrow-cursor-high', `line before the box\r\n${box}`, [80, 12], [40, 12]),
  resized('narrow-cursor-low', many, [80, 12], [40, 12]),
  resized('widen-after-wrap', many, [40, 12], [80, 12]),
  resized('fewer-rows', many, [80, 12], [80, 6]),
  resized('more-rows', many, [80, 6], [80, 12]),
  resized('more-rows-short', 'a\r\nb', [80, 6], [80, 12]),
  resized('narrow-alt', `n\x1b[?1049h${box}`, [80, 12], [40, 12]),
  resized('widen-cursor-high', `top\r\n${'y'.repeat(70)}\r\nend`, [40, 12], [80, 12]),
  resized('fewer-rows-cursor-high', 'a\r\nb\r\nc\r\nd\x1b[2;1H', [80, 12], [80, 3]),
  resized('narrow-history-cursor-top', `${many}\x1b[H`, [80, 12], [40, 12]),
  resized('narrow-no-wrap', 'short\r\nlines\r\nonly', [80, 12], [40, 12]),
  // Colored CJK paragraphs reflowed to 9..20 columns (bench/rust-snapshot-parity.ts).
  ...Array.from({ length: 24 }, (_, i) => i + 1).filter(seed => seed !== 14).map(seed => resized(`reflow-seed-${seed}`,
    Array.from({ length: seed }, (_, i) => `\x1b[3${i % 8}m${'abc\ud55c'.repeat(1 + i % 5)}\x1b[0m`).join('\r\n'),
    [12, 6], [8 + seed % 13, 6])),
];

function corpus(): Case[] {
  const root = path.join(process.cwd(), 'core/harness/corpus');
  return fs.readdirSync(root).map(name => {
    const dir = path.join(root, name);
    const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const changes = events.filter(e => e.type === 'resize').map(e => ({ offset: e.byteOffset, ...e.geometry }));
    const start = events[0].geometry;
    const end = changes.at(-1) ?? start;
    return { name: `corpus/${name}`, backend: 'rust' as const,
      req: { cols: end.cols, rows: end.rows, scrollback: 5000, initial: fs.readFileSync(path.join(dir, 'recording.bin')), geometry: { start, changes } } };
  });
}

const claude: Case = { name: 'claude-code-capture', backend: 'rust',
  req: { cols: 80, rows: 30, scrollback: 1000, initial: Buffer.from(CLAUDE_WRAPPED_REPLY_80x30, 'base64') } };

describe.skipIf(!available)('Rust ANSI snapshot rendered parity', { timeout: 30_000 }, () => {
  beforeEach(() => vi.stubEnv('WMUX_RUST_SNAPSHOT_MODULE', modulePath));
  afterEach(() => vi.unstubAllEnvs());

  it.each([...accepted, ...refused, ...leftAlt, ...seams, ...lineFeeds, ...erases, ...others, ...resizes, ...corpus(), claude].map(c => [c.name, c] as const))('%s', async (_name, c) => {
    await expectParity(c);
  });

  it('takes an attach-sized request and refuses a history past the native cap', async () => {
    const lines = (n: number) => Buffer.from(Array.from({ length: n }, (_, i) => `l${i}`).join('\r\n'));
    // 4M cells / 1000 columns leave 3999 history rows next to one screen row.
    const fits: SnapshotRequest = { cols: 1000, rows: 1, scrollback: 100000, initial: lines(50) };
    const overflows: SnapshotRequest = { ...fits, initial: lines(5000) };
    expect(await generateRustSnapshot(overflows, 'ansi')).toMatchObject({ ok: false, detail: expect.stringMatching(/^unsupported-history-limit/) });
    for (const [req, backend] of [[fits, 'rust'], [overflows, 'xterm']] as const) {
      vi.stubEnv('WMUX_RUST_SNAPSHOT', 'off');
      const reference = await generateSnapshotUnqueued(req);
      vi.stubEnv('WMUX_RUST_SNAPSHOT', 'ansi');
      const selected = await generateSnapshotUnqueued(req);
      if (!reference.ok || !selected.ok) throw new Error('snapshot failed');
      expect(getAnsiSnapshotBackendDiagnostics().last?.backend).toBe(backend);
      // The fallback is xterm's own payload; replaying 4M cells adds nothing.
      if (backend === 'xterm') expect(selected.payload.equals(reference.payload)).toBe(true);
      else expect(await parity(req, selected.payload, reference.payload)).toBeUndefined();
    }
  });

  it('refuses a divergent control that arrives on the live tee, split from the history', async () => {
    const tee = () => { const queue = [[Buffer.from('A#')], [Buffer.from('\x1b(Bok')]]; return () => queue.shift() ?? []; };
    const req: SnapshotRequest = { cols: 20, rows: 6, scrollback: 100, initial: Buffer.from('hello\x1b(') };
    vi.stubEnv('WMUX_RUST_SNAPSHOT', 'off');
    const reference = await generateSnapshotUnqueued({ ...req, drainQueue: tee() });
    vi.stubEnv('WMUX_RUST_SNAPSHOT', 'ansi');
    const selected = await generateSnapshotUnqueued({ ...req, drainQueue: tee() });
    if (!reference.ok || !selected.ok) throw new Error('snapshot failed');
    expect(getAnsiSnapshotBackendDiagnostics().last).toEqual({ backend: 'xterm', reason: 'state' });
    expect(selected.payload.equals(reference.payload)).toBe(true);
  });

  // The fallback is counted under the refused control's family (`wmux doctor
  // --performance`), so a national set shows apart from the other refusals.
  it.each([
    ['\x1b(A#', 'unsupported-state-charset'],
    ['\x1b[1!p', 'unsupported-state-decstr'],
    ['\x1b[?47hx', 'unsupported-state-mode'],
    ['\x1b[?47h\x1b[<99u', 'unsupported-state-mode'],
  ])('names the refused control in the refusal: %j', async (stream, family) => {
    const native = await generateRustSnapshot({ cols: 20, rows: 6, scrollback: 100, initial: Buffer.from(stream) }, 'ansi');
    expect(native.ok).toBe(false);
    if (!native.ok) expect(native.detail?.split(':')[0]).toBe(family);
  });

  // The counters' `reasonsSeen`: what else a refused stream holds.
  it('lists every refusal family of a refused stream, the reported one first', async () => {
    const stream = 'a\x1b[?47hb\x1b(Ac\x1b[53md\x1b(Ke';
    const native = await generateRustSnapshot({ cols: 20, rows: 6, scrollback: 100, initial: Buffer.from(stream) }, 'ansi');
    expect(native.ok).toBe(false);
    if (!native.ok) {
      expect(native.detail?.split(':')[0]).toBe('unsupported-state-mode');
      expect(native.families).toEqual(['unsupported-state-mode', 'unsupported-state-charset', 'unsupported-state-sgr']);
    }
    const served = await generateRustSnapshot({ cols: 20, rows: 6, scrollback: 100, initial: Buffer.from('plain') }, 'ansi');
    expect(served.ok).toBe(true);
    // Out of budget while scanning past the refusal: still that refusal.
    const late = await generateRustSnapshot({ cols: 20, rows: 6, scrollback: 100, budgetMs: 0, initial: Buffer.from(stream) }, 'ansi');
    expect(late.ok).toBe(false);
    if (!late.ok) {
      expect(late.reason).toBe('error');
      expect(late.detail?.split(':')[0]).toBe('unsupported-state-mode');
    }
  });

  // xterm's public modes do not expose the mouse encoding, so capture() cannot
  // compare it: check the restored ?1016 directly.
  it.each(['\x1b[?1003;1016hx', '\x1b[?1002;1006;1016hx', '\x1b[?1016hx', '\x1b[?1000;1016h\x1b[?1016lx', '\x1b[?1000;1016h\x1bcx'])('restores the pixel mouse encoding as xterm does: %j', async (stream) => {
    const req: SnapshotRequest = { cols: 20, rows: 4, scrollback: 100, initial: Buffer.from(stream) };
    vi.stubEnv('WMUX_RUST_SNAPSHOT', 'off');
    const reference = await generateSnapshotUnqueued(req);
    const native = await generateRustSnapshot(req, 'ansi');
    if (!reference.ok || !native.ok) throw new Error('snapshot failed');
    const pixels = (payload: Buffer) => payload.toString('latin1').includes('\x1b[?1016h');
    expect(pixels(native.payload as Buffer)).toBe(pixels(reference.payload));
  });

  // The seam's ?47 round trip and ?1047l rely on this (ContextRule in
  // native_core.rs): xterm swaps the kitty flags there and Alacritty does
  // not, which is safe only while neither payload carries them.
  it('writes no kitty keyboard flags into either payload', async () => {
    const req: SnapshotRequest = { cols: 20, rows: 6, scrollback: 100, initial: Buffer.from('a\x1b[>1u\x1b[?1049h\x1b[>5ub') };
    const native = await generateRustSnapshot(req, 'ansi');
    if (!native.ok) throw new Error(`refused: ${native.detail}`);
    vi.stubEnv('WMUX_RUST_SNAPSHOT', 'off');
    const reference = await generateSnapshotUnqueued(req);
    if (!reference.ok) throw new Error('xterm snapshot failed');
    for (const payload of [native.payload as Buffer, reference.payload]) {
      // ESC shown as `^`: no control character in the pattern.
      expect(payload.toString('latin1').replaceAll('\x1b', '^')).not.toMatch(/\^\[[<>=?][\d;]*u/);
    }
  });

  // Evidence for each refusal: without it the Rust payload would diverge.
  it.each(refused.map(c => [c.name, c] as const))('Rust alone diverges on %s', async (_name, c) => {
    await expectRustAloneDiverges(c);
  });
});
