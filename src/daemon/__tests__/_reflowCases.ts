// The reflow parity cases (RustReflowParity.test.ts): each writes at one
// size, resizes once or in steps, and may write more after.
import type { Case } from './_rustParity';

/** `n` rows `<tag><i> ` padded with x to `width` printed cells. */
const rows = (n: number, width: number, tag = 'l') =>
  Array.from({ length: n }, (_, i) => `${tag}${i} `.padEnd(width, 'x')).join('\r\n');

/**
 * Written at `start`, then each part in order: a string is written, a size
 * resizes the pane there. Extends `resized()` to several steps and to bytes
 * written after a resize.
 */
function script(name: string, start: [number, number], parts: Array<string | [number, number]>, backend: Case['backend'] = 'rust', scrollback = 100): Case {
  const chunks: Buffer[] = [];
  const changes: Array<{ offset: number; cols: number; rows: number }> = [];
  let offset = 0;
  let size = start;
  for (const part of parts) {
    if (typeof part === 'string') {
      const bytes = Buffer.from(part);
      chunks.push(bytes);
      offset += bytes.length;
    } else {
      size = part;
      changes.push({ offset, cols: part[0], rows: part[1] });
    }
  }
  return { name, backend, req: { cols: size[0], rows: size[1], scrollback, initial: Buffer.concat(chunks),
    geometry: { start: { cols: start[0], rows: start[1] }, changes } } };
}

const prompt = '$ ';
/** Up into the paragraph's first row, so the parity probe's CR LF enters a
 * continuation and ends that paragraph (xterm's lineFeed). */
const UP = '\x1b[A';

export const reflowCases: Case[] = [
  // Narrower with no history: xterm moves the cursor down into the room
  // below, one row per row the reflow adds, dropping the bottom row.
  script('narrow-room-no-history', [80, 24], [`${rows(3, 70)}\r\n${prompt}`, [40, 24]]),
  // The room runs out partway; the rest goes to history.
  script('narrow-room-exhausted', [80, 24], [`${rows(18, 70)}\r\n${prompt}`, [40, 24]]),
  // History already there: both scroll into it.
  script('narrow-history-room-below', [80, 24], [`${rows(40, 20)}\x1b[2J\x1b[H${rows(3, 70)}\r\n${prompt}`, [40, 24]]),
  // A font zoom-in: fewer rows and columns at once.
  script('zoomin-room', [100, 30], [`${rows(6, 90)}\r\n${prompt}`, [80, 24]]),
  // The rows phase uses up the room below before the columns shrink.
  script('zoomin-room-consumed-by-rows', [80, 24], [`${rows(21, 70)}\r\n${prompt}`, [60, 20]]),
  // A zoom-out unwraps rows written narrow.
  script('zoomout-unwrap', [40, 20], [`${rows(5, 70)}\r\n${prompt}`, [80, 24]]),
  // Fullwidth cells across the wrap edge, narrower, then back.
  script('wide-edge-narrow', [80, 24], [`${'한'.repeat(50)}\r\n${prompt}`, [39, 24]]),
  script('wide-edge', [80, 24], [`${'한'.repeat(50)}\r\n${prompt}`, [39, 24], [80, 24]]),
  // History at the cap, narrower.
  script('narrow-at-cap', [80, 24], [`${rows(150, 70)}\r\n${prompt}`, [40, 24]]),
  // No history, but the reflow adds more rows than the room and the cap hold.
  script('narrow-no-history-past-cap', [80, 24], [`${rows(20, 79)}\r\n${prompt}`, [8, 24]]),
  // Rows below the cursor that fit the new width do not reflow.
  script('narrow-below-cursor-short', [80, 24], [`${rows(4, 30)}\x1b[2H`, [40, 24]]),
  // A cursor saved before a narrowing with room below, restored after it.
  script('saved-cursor-narrow', [80, 24], [`${rows(3, 70)}\r\n${prompt}\x1b7`, [40, 24], '\x1b8Z']),
  // A paragraph below the cursor reflows: xterm moves its cursor row as if
  // the rows were above it, off its content. Refused.
  script('reflow-below-cursor', [80, 24], [`${rows(4, 70)}\x1b[2H`, [40, 24]], 'xterm'),
  script('narrow-history-below-cursor', [80, 24], [`${rows(40, 20)}\r\n${rows(6, 70)}\x1b[19H`, [40, 24]], 'xterm'),
  // Wider: xterm counts every row the reflow removes, above or below the
  // cursor: each takes a history row first, then moves both cursors up.
  script('widen-below-cursor', [40, 24], [`${rows(4, 70)}\x1b[2H`, [80, 24]]),
  script('widen-history-below-cursor', [40, 24], [`${rows(40, 20)}\r\n${rows(6, 70)}\x1b[13H`, [80, 24]]),
  script('widen-below-cursor-saved', [40, 24], [`${rows(4, 70)}\x1b[3H\x1b7\x1b[2H`, [80, 24], '\x1b8Z']),
  script('widen-history-short-cursor-clamped', [40, 24], [`${rows(14, 70)}\x1b[3H`, [80, 24], 'Z']),
  script('widen-history-short-saved', [40, 24], [`${rows(14, 70)}\x1b[20H\x1b7\x1b[3H`, [80, 24], '\x1b8Z']),
  script('widen-twice', [30, 24], [`${rows(5, 70)}\x1b[2H`, [50, 24], [80, 24], 'Z']),
  script('widen-then-type', [40, 24], [`${rows(4, 70)}\x1b[2H`, [80, 24], 'Z\r\nY']),
  script('widen-while-alt-primary-below-cursor', [40, 24], [`${rows(4, 70)}\x1b[2H\x1b[?1049hq`, [80, 24], '\x1b[?1049lZ']),
  // The unreflowed cursor paragraph's rows are soft-wrapped with empty tails.
  // A colored cell right before the tail (the pen is colored there).
  script('widen-tail-after-colored', [40, 24], [`${'x'.repeat(39)}\x1b[41mR\x1b[0m${'y'.repeat(10)}`, [80, 24], UP]),
  // History above: the filler wraps at the bottom, scrolling the replay.
  script('widen-tail-at-bottom', [40, 24], [`${rows(30, 20)}\r\n${'p'.repeat(50)}`, [80, 24], UP]),
  // The cursor on the row after the tail, and with a pending wrap there.
  script('widen-tail-cursor-on-continuation', [40, 24], [`${rows(3, 20)}\r\n${'q'.repeat(50)}`, [80, 24]]),
  script('widen-tail-pending-wrap', [40, 24], [`${rows(3, 20)}\r\n${'q'.repeat(80)}`, [80, 24]]),
  // A fullwidth glyph right before the tail.
  script('widen-tail-after-wide', [40, 24], [`${'x'.repeat(38)}한yy`, [80, 24], UP]),
  // A fullwidth glyph that did not fit: its spacer sits inside the row after
  // the widen, an empty cell in xterm.
  script('widen-tail-after-leading-spacer', [40, 24], [`${'x'.repeat(39)}한${'y'.repeat(38)}`, [80, 24], UP]),
  // Blanks a program printed up to a soft wrap stay content (no widen).
  script('wrap-at-printed-spaces', [20, 24], [`${'a'.repeat(17)}   bbbb${UP}`]),
  // Two tails in a row.
  script('widen-two-tails', [30, 24], [`${'z'.repeat(75)}`, [80, 24], UP]),
  // More rows with history while the cursor is mid-screen: xterm adds blank
  // rows below and pulls nothing from history (Buffer.ts:196-221).
  script('zoomout-history-cursor-mid', [80, 24], [`${rows(40, 20)}\x1b[8H${prompt}`, [100, 30]]),
  // A cursor saved mid-screen survives more rows where it was.
  script('saved-cursor-more-rows', [80, 24], [`${rows(40, 20)}\x1b[8H\x1b7`, [80, 30], '\x1b8Z']),
  // With the cursor on the bottom row, xterm pulls history rows down instead.
  script('more-rows-cursor-bottom', [80, 24], [`${rows(40, 20)}\r\n${prompt}`, [80, 30]]),
  // History at the scrollback cap: more rows lose no history row, either way.
  script('more-rows-at-cap-cursor-mid', [80, 24], [`${rows(150, 20)}\x1b[8H${prompt}`, [80, 30]]),
  script('more-rows-at-cap-cursor-bottom', [80, 24], [`${rows(150, 20)}\r\n${prompt}`, [80, 30]]),
  // The alternate screen narrowed, then widened: xterm never cut its rows, so
  // the cells come back, and the vendored grid keeps them too: native.
  script('alt-narrow-widen', [80, 24], [`n\x1b[?1049h${rows(3, 70)}`, [40, 24], [80, 24]]),
  // Widening alone hides nothing: still native.
  script('alt-widen', [40, 24], [`n\x1b[?1049h${rows(3, 30)}`, [80, 24]]),
  // Soft-wrapped rows on the alternate screen keep their wrap flag in xterm
  // across any width change; Alacritty drops it. Refused until fixed.
  script('alt-wrapped-widen', [40, 24], [`\x1b[?1049h${rows(2, 70)}`, [80, 24]], 'xterm'),
  script('alt-wrapped-narrow', [80, 24], [`\x1b[?1049h${'w'.repeat(100)}`, [60, 24]], 'xterm'),
  // Leaving the alternate screen discards those rows on both: native again,
  // also with a fresh alternate screen entered after it, in the same write.
  script('alt-wrapped-widen-left', [40, 24], [`$ less\r\n\x1b[?1049h${rows(2, 70)}`, [80, 24], '\x1b[?1049l$ '], 'rust'),
  script('alt-wrapped-narrow-left', [80, 24], [`$ vim\r\n\x1b[?1049h${'w'.repeat(100)}`, [60, 24], 'q\x1b[?1049l$ '], 'rust'),
  script('alt-wrapped-reset', [80, 24], [`\x1b[?1049h${'w'.repeat(100)}`, [60, 24], '\x1bc$ '], 'rust'),
  script('alt-wrapped-left-entered-again', [80, 24], [`\x1b[?1049h${'w'.repeat(100)}`, [60, 24], `\x1b[?1049l$ less\r\n\x1b[?1049h\x1b[H${rows(2, 30)}`], 'rust'),
  // Still on an alternate screen whose wrapped rows changed width since.
  script('alt-wrapped-left-entered-again-resized', [80, 24], [`\x1b[?1049h${'w'.repeat(100)}`, [60, 24], `\x1b[?1049l\x1b[?1049h${'v'.repeat(100)}`, [80, 24]], 'xterm'),
  // Another refusal set in the same resize or after it outlives the leave.
  script('alt-wrapped-left-reflow-below-cursor', [80, 24], [`${rows(4, 70)}\x1b[2H\x1b[?1049h${'w'.repeat(100)}`, [40, 24], '\x1b[?1049l'], 'xterm'),
  script('alt-wrapped-left-after-refused-decstr', [80, 24], [`\x1b[?1049h${'w'.repeat(100)}`, [60, 24], '\x1b[1!p\x1b[?1049l$ '], 'xterm'),
  // DECSTR in its plain spelling is no refusal: the leave lifts the reflow.
  script('alt-wrapped-left-after-decstr', [80, 24], [`\x1b[?1049h${'w'.repeat(100)}`, [60, 24], '\x1b[!p\x1b[?1049l$ '], 'rust'),
  // A fullwidth glyph cut at the narrow edge of an alternate screen: refused
  // while that screen is shown, native once it is left.
  script('alt-wide-edge', [80, 24], [`n\x1b[?1049h\x1b[H${'x'.repeat(38)}한`, [39, 24]], 'xterm'),
  script('alt-wide-edge-left', [80, 24], [`n\x1b[?1049h\x1b[H${'x'.repeat(38)}한`, [39, 24], '\x1b[?1049l$ '], 'rust'),
  // Narrowed on the main screen (short rows, nothing reflows), then into a
  // fresh alternate screen with short rows, and wider: nothing was cut or
  // wrapped there, so still native.
  script('alt-after-main-narrow', [80, 24], [`${rows(3, 30)}`, [40, 24], `\x1b[?1049h\x1b[H${rows(2, 30)}`, [80, 24]]),
  ...trimmedSavedRowCases(),
];

/**
 * #3354: xterm moves its saved row down by every row a narrowing's reflow
 * adds, also the rows it then trims at the cap, clamped to the screen's
 * last row (`_reflowSmaller`). Each restores after the narrowing.
 */
function trimmedSavedRowCases(): Case[] {
  const SAVE = '\x1b7';
  const RESTORE = '\x1b8X';
  const lines = (...parts: string[]) => parts.join('\r\n');
  const long = (n: number, ch: string) => ch.repeat(n);
  // Four 30-cell lines at 20 columns: each grows by one row at 10.
  const savedTop = SAVE + lines(long(30, '0'), long(30, '1'), long(30, '2'), long(30, '3'), 'end');
  const savedRow2 = lines(long(30, '0'), long(30, '1'), SAVE + long(30, '2'), long(30, '3'), 'end');
  const noSave = lines(long(30, '0'), long(30, '1'), long(30, '2'), long(30, '3'), 'end');
  // No history before: three 40-cell lines at 40 columns, four rows each at 10.
  const emptyHistory = lines(long(40, 'a'), SAVE + long(40, 'b'), long(40, 'c'), 'end');
  // Small paragraphs above, a big one, one below the save, the save near the bottom.
  const mixed = lines(long(35, 'a'), long(35, 'b'), long(90, 'C'), `${SAVE}s`, long(35, 'd'), 'end');
  const aboveScreen = SAVE + lines('top', ...[0, 1, 2, 3, 4, 5].map((i) => long(30, String(i))), 'end');
  const out: Case[] = [
    // The issue's stream: history at its cap.
    script('trim-saved-top-sb1', [20, 6], [savedTop, [10, 6], RESTORE], 'rust', 1),
    // Below the cap by less than the rows added: trimmed too.
    ...[3, 4, 5, 6, 7, 100].map((sb) => script(`trim-saved-row2-sb${sb}`, [20, 6], [savedRow2, [10, 6], RESTORE], 'rust', sb)),
    // No history before the narrowing (the rows kept on screen first).
    ...[1, 2, 100].map((sb) => script(`trim-empty-history-sb${sb}`, [40, 8], [emptyHistory, [10, 8], RESTORE], 'rust', sb)),
    // The clamp at the screen's last row, with room left partway. (At a
    // scrollback of 1 or 2 xterm's own reflow loses rows: a known gap below.)
    ...[3, 4, 6, 12, 100].map((sb) => script(`trim-mixed-sb${sb}`, [30, 8], [mixed, [10, 8], RESTORE], 'rust', sb)),
    // The save scrolled above the screen, and no save at all (xterm's 0).
    script('trim-save-above-screen-sb3', [20, 6], [aboveScreen, [10, 6], RESTORE], 'rust', 3),
    script('trim-no-save-sb1', [20, 6], [noSave, [10, 6], RESTORE], 'rust', 1),
  ];
  // Composed with a later resize before the restore; at 3 and 4 the
  // narrowing trims.
  for (const sb of [3, 4, 100]) {
    out.push(
      script(`trim-then-widen-sb${sb}`, [30, 8], [mixed, [10, 8], [30, 8], RESTORE], 'rust', sb),
      script(`trim-then-shorter-sb${sb}`, [30, 8], [mixed, [10, 8], [10, 5], RESTORE], 'rust', sb),
      script(`trim-then-taller-sb${sb}`, [30, 8], [mixed, [10, 8], [10, 10], RESTORE], 'rust', sb),
      script(`trim-twice-sb${sb}`, [30, 8], [mixed, [20, 8], [10, 8], RESTORE], 'rust', sb),
      // Narrowed while the alternate screen is shown: the main screen reflows
      // behind it, and leaving it restores the save its ?1049h made.
      script(`trim-while-alt-sb${sb}`, [30, 8], [`${mixed}\x1b[?1049hq`, [10, 8], '\x1b[?1049lX'], 'rust', sb),
      script(`trim-while-alt-decsc-sb${sb}`, [30, 8], [`${mixed}\x1b[?1049hq`, [10, 8], `\x1b[?1049l${RESTORE}`], 'rust', sb),
    );
  }
  return out;
}

/**
 * Known gaps: Rust still answers these and differs from xterm. Each test
 * asserts the divergence, so it fails, and moves to `reflowCases`, once the
 * fix it names lands.
 */
export const knownGaps: Case[] = [
  // xterm counts a printed space as content and wraps a padded row's spaces
  // onto the next row when narrower; Alacritty cannot tell a printed space
  // from a blank cell and drops them. Fixed by S0's print-time marker for
  // printed blanks (after its charset PR).
  script('trailing-spaces', [80, 24], [`x${' '.repeat(60)}\r\n${prompt}`, [40, 24]]),
  // xterm's narrowing reflow, inserting more rows than its buffer holds (12
  // into 10 here), loses the bottom rows and repeats stale ones; Alacritty
  // keeps the content. No save or restore is involved (#3372).
  script('narrow-inserts-past-buffer-content-diverges-today', [30, 8], [
    [`${'a'.repeat(35)}`, `${'b'.repeat(35)}`, `${'C'.repeat(90)}`, 's', `${'d'.repeat(35)}`, 'end'].join('\r\n'), [10, 8],
  ], 'rust', 2),
];
