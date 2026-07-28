import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes';
import { generateTextSnapshot } from '../HeadlessSnapshot';

// ── Unicode width model: grapheme clusters, and the CJK regression guard ────
//
// The product measures character width with @xterm/addon-unicode-graphemes
// ('15-graphemes') in BOTH places that own a terminal grid: the renderer
// (useTerminal.ts) and the daemon snapshot (HeadlessSnapshot.ts). The addon
// ships with an upstream "experimental" warning, so these tests pin the two
// properties we actually rely on:
//
//   1. multi-codepoint emoji measure as ONE cluster (the reason for the swap),
//   2. CJK and the other wide/narrow ranges are byte-for-byte unchanged from
//      the Unicode 11 tables we replaced (the regression we must not ship).
//
// (2) is written as a differential assertion against Unicode11Addon rather
// than hardcoded numbers: it keeps failing usefully if a future addon bump
// shifts a CJK width, which is exactly the risk the "experimental" tag names.

/** Cursor column after writing `text` at home — i.e. the measured width. */
async function measureWidth(text: string, version: '11' | '15-graphemes'): Promise<number> {
  // cols=200 so nothing here can wrap and confuse the reading.
  const term = new Terminal({ cols: 200, rows: 4, allowProposedApi: true, logLevel: 'off' });
  try {
    term.loadAddon(version === '11' ? new Unicode11Addon() : new UnicodeGraphemesAddon());
    term.unicode.activeVersion = version;
    await new Promise<void>((resolve) => term.write(`\x1b[H${text}`, resolve));
    return term.buffer.active.cursorX;
  } finally {
    term.dispose();
  }
}

describe('unicode width model — grapheme clustering', () => {
  // Each of these is a single user-perceived character. Unicode 11 widthed
  // every codepoint independently and summed, so they over- or under-measured;
  // grapheme clustering collapses each to one 2-cell cluster.
  const CLUSTERS: ReadonlyArray<readonly [string, string, number]> = [
    ['ZWJ family', '\u{1F468}‍\u{1F469}‍\u{1F467}', 6],
    ['ZWJ couple', '\u{1F469}‍❤️‍\u{1F468}', 5],
    ['skin-tone modifier', '\u{1F44D}\u{1F3FD}', 4],
    ['VS16 heart', '❤️', 1],
    ['VS16 check mark', '✔️', 1],
    ['keycap sequence', '1️⃣', 1],
  ];

  it.each(CLUSTERS)(
    '%s measures 2 cells as one cluster (Unicode 11 said %d)',
    async (_name, text, u11Width) => {
      // Guard the premise: this case really was mismeasured before the swap.
      expect(await measureWidth(text, '11')).toBe(u11Width);
      expect(await measureWidth(text, '15-graphemes')).toBe(2);
    },
  );

  it('a regional-indicator flag is one 2-cell cluster', async () => {
    // U+1F1F0 U+1F1F7 — the pair must not split across a row boundary as two
    // separate 1-wide indicators.
    expect(await measureWidth('\u{1F1F0}\u{1F1F7}', '15-graphemes')).toBe(2);
  });

  it('combining marks still add no width', async () => {
    expect(await measureWidth('é', '15-graphemes')).toBe(1);
  });
});

describe('unicode width model — CJK has no regression vs Unicode 11', () => {
  // Everything a Korean/Japanese/Chinese TUI user sees, plus the narrow ranges
  // that TUIs draw frames with. A width change in ANY of these would shift
  // cursor positioning and tear Claude Code / vim frames — the exact bug the
  // Unicode 11 addon was originally added to fix, so it must not come back.
  const NO_REGRESSION: ReadonlyArray<readonly [string, string]> = [
    ['Hangul syllables', '한글'],
    ['Hangul composed vs decomposed', '각각'],
    ['Hangul jamo block', 'ㄱㄴㄷ'],
    ['kanji', '日本語'],
    ['hiragana + katakana', 'ひらがなカタカナ'],
    ['fullwidth forms', 'ＡＢＣ１２３'],
    ['halfwidth katakana', 'ｱｲｳ'],
    ['CJK punctuation', '。、「」'],
    ['ambiguous-width symbols', '±§¶'],
    ['box drawing', '─│┌┐└┘├┤┬┴┼'],
    ['block elements', '█▉▊▋▌▍▎▏'],
    ['braille', '⣿⠿⡇'],
    ['powerline glyphs', ''],
    ['ASCII', 'hello world'],
    ['mixed CJK + ASCII', 'wmux 터미널 v3'],
  ];

  it.each(NO_REGRESSION)('%s keeps its Unicode 11 width', async (_name, text) => {
    const before = await measureWidth(text, '11');
    const after = await measureWidth(text, '15-graphemes');
    expect(after).toBe(before);
  });

  it('a range emoji is still wide (U+1F600 stays 2, not back to v6 width 1)', async () => {
    expect(await measureWidth('\u{1F600}', '15-graphemes')).toBe(2);
  });
});

describe('daemon snapshot uses the same width model as the renderer', () => {
  // The renderer and the daemon must agree cell-for-cell: if HeadlessSnapshot
  // widths a ZWJ family at 6 cells while the screen widths it at 2, the
  // restored snapshot paints shifted against the live grid.
  //
  // Content is placed hard against the RIGHT MARGIN on purpose. Plain text in
  // open space round-trips identically under either width model — the serialize
  // addon re-emits characters and the restoring terminal re-measures them — so
  // a mid-row comparison silently passes even when the two sides disagree. The
  // wrap column is where the width model becomes observable: at cols=40 a ZWJ
  // family starting at column 37 stays whole under grapheme clustering but is
  // torn across two rows by the Unicode 11 per-codepoint sum.
  const COLS = 40;
  const ROWS = 6;
  const FAMILY = '\u{1F468}‍\u{1F469}‍\u{1F467}';

  async function rowsOf(data: Buffer | string): Promise<string[]> {
    const term = new Terminal({
      cols: COLS,
      rows: ROWS,
      scrollback: 5000,
      allowProposedApi: true,
      logLevel: 'off',
    });
    try {
      term.loadAddon(new UnicodeGraphemesAddon());
      term.unicode.activeVersion = '15-graphemes';
      await new Promise<void>((resolve) => term.write(data as string, resolve));
      const buf = term.buffer.active;
      const out: string[] = [];
      for (let y = 0; y < ROWS; y++) {
        out.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '');
      }
      return out;
    } finally {
      term.dispose();
    }
  }

  it('keeps a wrap-boundary cluster in one cell pair (width 2 + width 0 spacer)', async () => {
    const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, logLevel: 'off' });
    try {
      term.loadAddon(new UnicodeGraphemesAddon());
      term.unicode.activeVersion = '15-graphemes';
      await new Promise<void>((resolve) => term.write(`\x1b[H${'X'.repeat(37)}${FAMILY}Y`, resolve));
      const line = term.buffer.active.getLine(0);
      expect(line).toBeTruthy();
      // Columns 37/38 are the cluster; 39 is the trailing marker. Under the old
      // per-codepoint tables the family consumed six cells and pushed 'Y' onto
      // the next row instead.
      expect(line?.getCell(37)?.getChars()).toBe(FAMILY);
      expect(line?.getCell(37)?.getWidth()).toBe(2);
      expect(line?.getCell(38)?.getWidth()).toBe(0);
      expect(line?.getCell(39)?.getChars()).toBe('Y');
    } finally {
      term.dispose();
    }
  });

  // The TEXT snapshot (readScreen / MCP) is where the daemon's width model is
  // directly observable: its rows are lifted straight out of the daemon's own
  // buffer, so the daemon's wrap decisions ARE the payload. (The ANSI snapshot
  // is not a useful probe here — the serialize addon re-emits characters and
  // the restoring terminal re-wraps them, which hides a width-model split.)
  const WRAP_CASES: ReadonlyArray<readonly [string, string]> = [
    ['ZWJ family at the margin', `${'X'.repeat(37)}${FAMILY}Y`],
    ['VS16 at the margin', `${'X'.repeat(38)}❤️Y`],
    ['skin-tone modifier at the margin', `${'X'.repeat(38)}\u{1F44D}\u{1F3FD}Y`],
    ['CJK at the margin (control — identical either way)', `${'X'.repeat(36)}한글Y`],
  ];

  it.each(WRAP_CASES)('text snapshot wraps %s exactly as the renderer does', async (_n, content) => {
    const raw = Buffer.from(content, 'utf8');

    const outcome = await generateTextSnapshot({ cols: COLS, rows: ROWS, initial: raw });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // Reference = a terminal configured exactly as the renderer is.
    const expected = (await rowsOf(content)).filter((r) => r !== '');
    expect(outcome.rows.map((r) => r.text)).toEqual(expected);
  });

  it('keeps the ZWJ family whole on one row instead of tearing it', async () => {
    // Pins the concrete before/after so the case above cannot pass by having
    // both sides broken the same way: Unicode 11 split this into two rows.
    const outcome = await generateTextSnapshot({
      cols: COLS,
      rows: ROWS,
      initial: Buffer.from(`${'X'.repeat(37)}${FAMILY}Y`, 'utf8'),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.rows.map((r) => r.text)).toEqual([`${'X'.repeat(37)}${FAMILY}Y`]);
  });
});
