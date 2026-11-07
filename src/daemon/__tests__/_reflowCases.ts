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
  // the cells come back; Alacritty cut them. Refused until that is fixed.
  script('alt-narrow-widen', [80, 24], [`n\x1b[?1049h${rows(3, 70)}`, [40, 24], [80, 24]], 'xterm'),
  // Widening alone hides nothing: still native.
  script('alt-widen', [40, 24], [`n\x1b[?1049h${rows(3, 30)}`, [80, 24]]),
  // Soft-wrapped rows on the alternate screen keep their wrap flag in xterm
  // across any width change; Alacritty drops it. Refused until fixed.
  script('alt-wrapped-widen', [40, 24], [`\x1b[?1049h${rows(2, 70)}`, [80, 24]], 'xterm'),
  script('alt-wrapped-narrow', [80, 24], [`\x1b[?1049h${'w'.repeat(100)}`, [60, 24]], 'xterm'),
  // Narrowed on the main screen (short rows, nothing reflows), then into a
  // fresh alternate screen with short rows, and wider: nothing was cut or
  // wrapped there, so still native.
  script('alt-after-main-narrow', [80, 24], [`${rows(3, 30)}`, [40, 24], `\x1b[?1049h\x1b[H${rows(2, 30)}`, [80, 24]]),
];
