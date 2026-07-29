/**
 * The shared terminal width model.
 *
 * `applyUnicodeWidthModel` is the only place the renderer (useTerminal.ts) and
 * the daemon's snapshot terminals (HeadlessSnapshot.ts x2) get their width
 * tables from, so testing the helper covers all three grids. It is also
 * deliberately the ONLY coverage the ANSI snapshot path can have: the serialize
 * addon re-emits characters, so its payload is byte-identical under Unicode 6
 * and Unicode 11 and no black-box test can observe that path's width model.
 * Making divergence structurally impossible is the substitute for testing it.
 *
 * Two guards live here, and they fail for different reasons on purpose.
 */
import { describe, it, expect } from 'vitest';
import { Terminal } from '@xterm/headless';
import { applyUnicodeWidthModel, TERMINAL_UNICODE_VERSION } from '../terminalUnicode';

/** Cursor column after writing `text` at home — i.e. the measured width. */
async function measureWidth(text: string): Promise<number> {
  // cols=200 so nothing here can wrap and confuse the reading.
  const term = new Terminal({ cols: 200, rows: 4, allowProposedApi: true, logLevel: 'off' });
  try {
    applyUnicodeWidthModel(term);
    await new Promise<void>((resolve) => term.write(`\x1b[H${text}`, resolve));
    return term.buffer.active.cursorX;
  } finally {
    term.dispose();
  }
}

describe('applyUnicodeWidthModel — the version it claims is the version that registers', () => {
  it('registers and activates TERMINAL_UNICODE_VERSION', () => {
    const term = new Terminal({ cols: 20, rows: 4, allowProposedApi: true, logLevel: 'off' });
    try {
      applyUnicodeWidthModel(term);
      // `activeVersion` accepts only a registered id. If a future addon bump
      // renames or drops this one, the assignment does not throw — the terminal
      // quietly stays on xterm's Unicode 6 default and every width below
      // changes. Asserting the id is REGISTERED, not just assigned, is what
      // catches that: without the first expectation a renamed version would
      // still read back as '11' from a terminal measuring at v6.
      expect(term.unicode.versions).toContain(TERMINAL_UNICODE_VERSION);
      expect(term.unicode.activeVersion).toBe(TERMINAL_UNICODE_VERSION);
    } finally {
      term.dispose();
    }
  });
});

describe('applyUnicodeWidthModel — the widths TUI frames are built on', () => {
  // Widths are pinned as absolute numbers rather than compared against another
  // addon. The differential form this replaces (Unicode 11 vs the width model
  // of the day) only means something while two width models are in the tree;
  // absolute numbers keep meaning when there is one, and they are what a future
  // addon swap has to reproduce case by case.
  //
  // Read the table in two halves, because the halves guard different things:
  //
  //   • CJK and the box/block/braille/powerline ranges measure IDENTICALLY
  //     under xterm's Unicode 6 default, so these rows do NOT fail if the width
  //     model goes missing — that is the version guard's job above. They are
  //     here to fail on a future width-model CHANGE, which is the risk that
  //     costs users: a shifted Hangul or box-drawing width tears every Claude
  //     Code / vim frame drawn over Korean text, which is the exact bug the
  //     Unicode 11 tables were added to fix.
  //   • the emoji rows are what Unicode 11 buys over the v6 default (v6 says 1)
  //     and therefore DO fail if the model is dropped or mis-registered.
  const WIDTHS: ReadonlyArray<readonly [string, string, number]> = [
    ['Hangul syllables', '한글', 4],
    ['Hangul composed vs decomposed', '각각', 4],
    ['Hangul jamo block', 'ㄱㄴㄷ', 6],
    ['kanji', '日本語', 6],
    ['hiragana + katakana', 'ひらがなカタカナ', 16],
    ['fullwidth forms', 'ＡＢＣ１２３', 12],
    ['halfwidth katakana', 'ｱｲｳ', 3],
    ['CJK punctuation', '。、「」', 8],
    ['CJK ext-B (supplementary plane)', '\u{20000}\u{2A6DF}', 4],
    ['ambiguous-width symbols stay narrow', '±§¶', 3],
    ['box drawing', '─│┌┐└┘├┤┬┴┼', 11],
    ['block elements', '█▉▊▋▌▍▎▏', 8],
    ['braille', '⣿⠿⡇', 3],
    ['powerline glyphs', '', 2],
    ['ASCII', 'hello world', 11],
    ['mixed CJK + ASCII', 'wmux 터미널 v3', 14],
    ['combining marks add no width', 'é', 1],
    // Unicode 6 measures each of these as 1.
    ['emoji U+1F600', '\u{1F600}', 2],
    ['emoji U+1F926', '\u{1F926}', 2],
    ['emoji U+1F9D1', '\u{1F9D1}', 2],
  ];

  it.each(WIDTHS)('%s measures %s as %d cells', async (_name, text, expected) => {
    expect(await measureWidth(text)).toBe(expected);
  });

  it('measures emoji wider than xterm would without the width model', async () => {
    // Pins the premise of the emoji rows above: they are a real difference from
    // the default, not numbers that would pass with no addon loaded at all. If
    // this ever stops holding, the emoji rows have stopped guarding anything
    // and the table needs a new mutation-sensitive case.
    const bare = new Terminal({ cols: 200, rows: 4, allowProposedApi: true, logLevel: 'off' });
    try {
      await new Promise<void>((resolve) => bare.write('\x1b[H\u{1F600}', resolve));
      expect(bare.buffer.active.cursorX).toBe(1);
    } finally {
      bare.dispose();
    }
    expect(await measureWidth('\u{1F600}')).toBe(2);
  });
});

describe('applyUnicodeWidthModel — the known cost of measuring per codepoint', () => {
  it('over-measures multi-codepoint emoji, which is accepted (see terminalUnicode.ts)', async () => {
    // NOT a wish list. These numbers are the deliberate trade recorded in the
    // "Why Unicode 11 and not grapheme clustering" note: each of these is ONE
    // user-perceived character that Unicode 11 widths per codepoint and sums.
    // Pinned so the cost stays visible and so a width-model change that fixes
    // them shows up as a decision rather than as a surprise.
    expect(await measureWidth('\u{1F468}‍\u{1F469}‍\u{1F467}')).toBe(6);
    expect(await measureWidth('\u{1F44D}\u{1F3FD}')).toBe(4);
    // A regional-indicator flag already measures correctly.
    expect(await measureWidth('\u{1F1F0}\u{1F1F7}')).toBe(2);
  });
});
