// Alternate-screen width changes (RustAltParity.test.ts): a full-screen app's
// frame, with soft-wrapped rows, across a narrowing, a widening and leaving
// the screen. xterm never reflows or cuts the alternate screen, and keeps a
// wrapped line wrapped across any width change.
import type { Case } from './_rustParity';
import { rows, script } from './_reflowCases';

/** A frame drawn by cursor address: a title wider than the screen (it wraps),
 * a body, a status row, and the cursor parked in the body. */
const frame = (cols: number, tag = 't') =>
  `\x1b[H\x1b[2J${tag}itle `.padEnd(cols + 20, '=') +
  `\x1b[4;1H${rows(4, Math.floor(cols / 2), `${tag}b`)}` +
  `\x1b[10;1H${'s'.repeat(cols + 5)}` +
  '\x1b[5;7H';

export const altCases: Case[] = [
  script('alt-frame-narrow', [80, 24], [`$ top\r\n\x1b[?1049h${frame(80)}`, [60, 24]]),
  script('alt-frame-widen', [40, 24], [`$ top\r\n\x1b[?1049h${frame(40)}`, [80, 24]]),
  script('alt-frame-narrow-widen', [80, 24], [`$ top\r\n\x1b[?1049h${frame(80)}`, [50, 24], [90, 24]]),
  // The app redraws at the new width, as it does on SIGWINCH.
  script('alt-frame-redrawn', [80, 24], [`\x1b[?1049h${frame(80)}`, [60, 24], frame(60, 'r')]),
  // Left after the width changes: the main screen comes back as it was.
  script('alt-frame-left', [80, 24], [`$ top\r\n\x1b[?1049h${frame(80)}`, [60, 24], [70, 24], '\x1b[?1049l$ ']),
  // Fewer rows too: a font zoom-in while the app is up.
  script('alt-frame-zoom', [80, 24], [`\x1b[?1049h${frame(80)}`, [60, 18]]),
  // Text written after the width change continues on the wrapped row.
  script('alt-frame-written-after', [80, 24], [`\x1b[?1049h${frame(80)}`, [60, 24], '\x1b[2;1Hmore']),
  // A row erased with a background color, narrowed past the erase's start
  // or before it, then widened: the kept cells come back erased.
  script('alt-erased-narrow-widen', [80, 24], [`$ top\r\n\x1b[?1049h\x1b[3;1Hstatus\x1b[42m\x1b[K\x1b[0m\x1b[5;7H`, [40, 24], [80, 24]]),
  script('alt-erased-hidden-narrow-widen', [80, 24], [`$ top\r\n\x1b[?1049h\x1b[3;1H${'s'.repeat(50)}\x1b[42m\x1b[K\x1b[0m\x1b[5;7H`, [40, 24], [80, 24]]),
];

/** A small seeded generator (mulberry32), so the cases are the same on every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seeded random alternate-screen sequences: rows written at random cells with
 * random widths (some wrapping, some with a fullwidth glyph), the cursor moved
 * to a random cell, one to three width or height changes, and sometimes the
 * screen left after. Which backend serves each is not fixed: Rust must replay
 * like xterm when it answers, and refuse with a named reason otherwise.
 */
export function randomAltCases(seed: number, count: number): Case[] {
  const next = seeded(seed);
  const int = (n: number) => Math.floor(next() * n);
  const out: Case[] = [];
  for (let k = 0; k < count; k++) {
    const cols = 30 + int(60);
    const height = 8 + int(16);
    const writes = Array.from({ length: 2 + int(6) }, (_, i) => {
      const text = `a${i} `.padEnd(Math.max(4, int(cols * 2)), String.fromCharCode(97 + int(26)));
      return `\x1b[${1 + int(height)};${1 + int(cols)}H${next() < 0.2 ? `${text.slice(0, -2)}한` : text}`;
    }).join('');
    const cursor = `\x1b[${1 + int(height)};${1 + int(cols)}H`;
    const steps = Array.from({ length: 1 + int(3) }, () => [10 + int(cols + 20), next() < 0.3 ? 6 + int(height) : height] as [number, number]);
    const leave = next() < 0.3 ? ['\x1b[?1049l$ '] : [];
    out.push(script(`alt-random-${seed}-${k}`, [cols, height], [`$ app\r\n\x1b[?1049h${writes}${cursor}`, ...steps, ...leave]));
  }
  return out;
}
