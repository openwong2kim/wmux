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
function script(name: string, start: [number, number], parts: Array<string | [number, number]>, backend: Case['backend'] = 'rust'): Case {
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
  return { name, backend, req: { cols: size[0], rows: size[1], scrollback: 100, initial: Buffer.concat(chunks),
    geometry: { start: { cols: start[0], rows: start[1] }, changes } } };
}

const prompt = '$ ';

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
  script('widen-below-cursor', [40, 24], [`${rows(4, 70)}\x1b[2H`, [80, 24]], 'xterm'),
  script('widen-history-below-cursor', [40, 24], [`${rows(40, 20)}\r\n${rows(6, 70)}\x1b[13H`, [80, 24]], 'xterm'),
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
  script('alt-wrapped-left-after-decstr', [80, 24], [`\x1b[?1049h${'w'.repeat(100)}`, [60, 24], '\x1b[!p\x1b[?1049l$ '], 'xterm'),
  // A fullwidth glyph cut at the narrow edge of an alternate screen: refused
  // while that screen is shown, native once it is left.
  script('alt-wide-edge', [80, 24], [`n\x1b[?1049h\x1b[H${'x'.repeat(38)}한`, [39, 24]], 'xterm'),
  script('alt-wide-edge-left', [80, 24], [`n\x1b[?1049h\x1b[H${'x'.repeat(38)}한`, [39, 24], '\x1b[?1049l$ '], 'rust'),
  // Narrowed on the main screen (short rows, nothing reflows), then into a
  // fresh alternate screen with short rows, and wider: nothing was cut or
  // wrapped there, so still native.
  script('alt-after-main-narrow', [80, 24], [`${rows(3, 30)}`, [40, 24], `\x1b[?1049h\x1b[H${rows(2, 30)}`, [80, 24]]),
];

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
];
