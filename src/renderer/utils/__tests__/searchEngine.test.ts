import { describe, it, expect } from 'vitest';
import { searchInBuffer, type SearchableBuffer } from '../searchEngine';
import {
  makeBuffer,
  makeBufferWithGap,
  WRAPPED_3ROW_LINE,
} from './fixtures/wrappedBuffer';

const HUGE_BUDGET = 1000;

describe('searchInBuffer — basic guards', () => {
  it('returns [] for an empty query', () => {
    const buf = makeBuffer([{ text: 'hello world' }]);
    expect(searchInBuffer(buf, '', { remainingBudget: HUGE_BUDGET })).toEqual([]);
  });

  it('returns [] for an empty buffer', () => {
    const buf = makeBuffer([]);
    expect(searchInBuffer(buf, 'anything', { remainingBudget: HUGE_BUDGET })).toEqual([]);
  });

  it('returns [] when remainingBudget is 0', () => {
    const buf = makeBuffer([{ text: 'hello world' }]);
    expect(searchInBuffer(buf, 'hello', { remainingBudget: 0 })).toEqual([]);
  });
});

describe('searchInBuffer — single-row substring match', () => {
  it('matches a substring on a single non-wrapped row', () => {
    const buf = makeBuffer([
      { text: 'unrelated' },
      { text: 'the quick brown fox' },
      { text: 'final' },
    ]);
    const matches = searchInBuffer(buf, 'brown', { remainingBudget: HUGE_BUDGET });
    expect(matches).toHaveLength(1);
    expect(matches[0].text).toBe('the quick brown fox');
    expect(matches[0].physicalBaseY).toBe(1);
  });

  it('returns no matches when the substring is absent (single-row miss)', () => {
    const buf = makeBuffer([{ text: 'the quick brown fox' }]);
    const matches = searchInBuffer(buf, 'cat', { remainingBudget: HUGE_BUDGET });
    expect(matches).toEqual([]);
  });
});

describe('searchInBuffer — wrap-coalescing', () => {
  it('coalesces a 3-row wrapped logical line and reports ONE match for content in the middle row', () => {
    const buf = makeBuffer(WRAPPED_3ROW_LINE);
    const matches = searchInBuffer(buf, 'bbbbb', { remainingBudget: HUGE_BUDGET });
    // Must be 1 match, NOT 3 — the wrap-coalescing collapses physical rows
    // 0..2 into a single logical line of 200 chars.
    expect(matches).toHaveLength(1);
    expect(matches[0].lineIdx).toBe(0);
    // physicalBaseY points at the FIRST physical row of the chain so
    // `terminal.scrollToLine` lands on the start of the wrap.
    expect(matches[0].physicalBaseY).toBe(0);
  });

  it('matches a query that spans the boundary between two wrapped physical rows', () => {
    const buf = makeBuffer(WRAPPED_3ROW_LINE);
    // Last 5 'b's of row 1 + first 5 'c's of row 2 — only matchable if
    // wrap-coalescing concatenates the row texts before searching.
    const matches = searchInBuffer(buf, 'bbbbbccccc', { remainingBudget: HUGE_BUDGET });
    expect(matches).toHaveLength(1);
    expect(matches[0].lineIdx).toBe(0);
    expect(matches[0].physicalBaseY).toBe(0);
  });

  it('treats two consecutive non-wrapped rows as separate logical lines', () => {
    const buf = makeBuffer([
      { text: 'line one with foo' },
      { text: 'line two with foo', isWrapped: false },
    ]);
    const matches = searchInBuffer(buf, 'foo', { remainingBudget: HUGE_BUDGET });
    expect(matches).toHaveLength(2);
    expect(matches[0].physicalBaseY).toBe(0);
    expect(matches[1].physicalBaseY).toBe(1);
  });
});

describe('searchInBuffer — 500 char text cap', () => {
  it('truncates the matched logical line text to 500 chars', () => {
    // 800-char logical line — 'X' followed by 'needle' followed by 'Y' fillers.
    // We put the needle near the start so the 500-char prefix still contains it.
    const longText = 'a'.repeat(50) + 'needle' + 'a'.repeat(800 - 50 - 6);
    expect(longText.length).toBe(800);
    const buf = makeBuffer([{ text: longText }]);
    const matches = searchInBuffer(buf, 'needle', { remainingBudget: HUGE_BUDGET });
    expect(matches).toHaveLength(1);
    expect(matches[0].text.length).toBe(500);
    expect(matches[0].text.startsWith('a'.repeat(50) + 'needle')).toBe(true);
  });

  it('truncates context lines to 500 chars each', () => {
    const longContext = 'c'.repeat(800);
    const buf = makeBuffer([
      { text: longContext },
      { text: 'needle here' },
      { text: longContext },
    ]);
    const matches = searchInBuffer(buf, 'needle', { remainingBudget: HUGE_BUDGET });
    expect(matches).toHaveLength(1);
    expect(matches[0].contextBefore[0].length).toBe(500);
    expect(matches[0].contextAfter[0].length).toBe(500);
  });
});

describe('searchInBuffer — context lines', () => {
  it('returns 2 context lines on each side by default', () => {
    const buf = makeBuffer([
      { text: 'before-2' },
      { text: 'before-1' },
      { text: 'match here' },
      { text: 'after-1' },
      { text: 'after-2' },
    ]);
    const matches = searchInBuffer(buf, 'match', { remainingBudget: HUGE_BUDGET });
    expect(matches).toHaveLength(1);
    expect(matches[0].contextBefore).toEqual(['before-2', 'before-1']);
    expect(matches[0].contextAfter).toEqual(['after-1', 'after-2']);
  });

  it('returns empty context arrays when contextLines = 0', () => {
    const buf = makeBuffer([
      { text: 'before' },
      { text: 'match here' },
      { text: 'after' },
    ]);
    const matches = searchInBuffer(buf, 'match', {
      remainingBudget: HUGE_BUDGET,
      contextLines: 0,
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].contextBefore).toEqual([]);
    expect(matches[0].contextAfter).toEqual([]);
  });

  it('clamps context at the start of the buffer', () => {
    const buf = makeBuffer([
      { text: 'match here' },
      { text: 'after-1' },
      { text: 'after-2' },
    ]);
    const matches = searchInBuffer(buf, 'match', { remainingBudget: HUGE_BUDGET });
    expect(matches).toHaveLength(1);
    expect(matches[0].contextBefore).toEqual([]);
    expect(matches[0].contextAfter).toEqual(['after-1', 'after-2']);
  });

  it('clamps context at the end of the buffer', () => {
    const buf = makeBuffer([
      { text: 'before-2' },
      { text: 'before-1' },
      { text: 'match here' },
    ]);
    const matches = searchInBuffer(buf, 'match', { remainingBudget: HUGE_BUDGET });
    expect(matches).toHaveLength(1);
    expect(matches[0].contextBefore).toEqual(['before-2', 'before-1']);
    expect(matches[0].contextAfter).toEqual([]);
  });
});

describe('searchInBuffer — regex', () => {
  it('matches when regex: true and pattern is valid', () => {
    const buf = makeBuffer([
      { text: 'info ok' },
      { text: 'error 42' },
      { text: 'warn 7' },
    ]);
    const matches = searchInBuffer(buf, '^err.*\\d+$', {
      remainingBudget: HUGE_BUDGET,
      regex: true,
    });
    expect(matches).toHaveLength(1);
    expect(matches[0].text).toBe('error 42');
  });

  it('throws SyntaxError (not generic Error) for an invalid regex pattern', () => {
    const buf = makeBuffer([{ text: 'anything' }]);
    let thrown: unknown;
    try {
      searchInBuffer(buf, '[unclosed', {
        remainingBudget: HUGE_BUDGET,
        regex: true,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(SyntaxError);
  });
});

describe('searchInBuffer — budget enforcement', () => {
  it('stops early when remainingBudget is reached', () => {
    const rows = Array.from({ length: 5 }, () => ({ text: 'needle here' }));
    const buf = makeBuffer(rows);
    const matches = searchInBuffer(buf, 'needle', { remainingBudget: 2 });
    expect(matches).toHaveLength(2);
    expect(matches[0].physicalBaseY).toBe(0);
    expect(matches[1].physicalBaseY).toBe(1);
  });
});

describe('searchInBuffer — perBufferLineCap', () => {
  it('only scans up to perBufferLineCap physical rows', () => {
    // 100 rows, all containing 'needle' — but cap=10 means rows 0..9 only.
    const rows = Array.from({ length: 100 }, () => ({ text: 'needle here' }));
    const buf = makeBuffer(rows);
    const matches = searchInBuffer(buf, 'needle', {
      remainingBudget: HUGE_BUDGET,
      perBufferLineCap: 10,
    });
    expect(matches).toHaveLength(10);
    // Last match must come from physical row index < 10.
    expect(matches[matches.length - 1].physicalBaseY).toBeLessThan(10);
  });
});

describe('searchInBuffer — defensive paths', () => {
  it('skips an undefined row gracefully without throwing', () => {
    const rows = [
      { text: 'first match', isWrapped: false },
      { text: 'GAP-PLACEHOLDER', isWrapped: false }, // index 1 returns undefined
      { text: 'last match', isWrapped: false },
    ];
    const buf: SearchableBuffer = makeBufferWithGap(rows, 1);
    expect(() =>
      searchInBuffer(buf, 'match', { remainingBudget: HUGE_BUDGET }),
    ).not.toThrow();
    const matches = searchInBuffer(buf, 'match', { remainingBudget: HUGE_BUDGET });
    // Both real rows still yield matches; the gap row is skipped.
    expect(matches).toHaveLength(2);
    expect(matches[0].physicalBaseY).toBe(0);
    expect(matches[1].physicalBaseY).toBe(2);
  });
});

describe('searchInBuffer — result ordering', () => {
  it('returns results in ascending physicalBaseY order (forward scan)', () => {
    const rows = [
      { text: 'no' },
      { text: 'yes-A' },
      { text: 'no' },
      { text: 'yes-B' },
      { text: 'no' },
      { text: 'yes-C' },
    ];
    const buf = makeBuffer(rows);
    const matches = searchInBuffer(buf, 'yes', { remainingBudget: HUGE_BUDGET });
    expect(matches.map((m) => m.physicalBaseY)).toEqual([1, 3, 5]);
  });
});

describe('searchInBuffer — tail bounding (perf root-fix P5)', () => {
  it('T14: tailRows scans only the NEWEST rows — an older match is excluded', () => {
    const rows = [
      { text: 'old match' },
      { text: 'filler-1' },
      { text: 'filler-2' },
      { text: 'new match' },
    ];
    const buf = makeBuffer(rows);
    const matches = searchInBuffer(buf, 'match', { remainingBudget: HUGE_BUDGET, tailRows: 2 });
    expect(matches).toHaveLength(1);
    expect(matches[0].physicalBaseY).toBe(3); // absolute buffer index survives windowing
  });

  it('T16: a tailRows window covering the whole buffer behaves like a full scan', () => {
    const rows = [{ text: 'old match' }, { text: 'filler' }, { text: 'new match' }];
    const buf = makeBuffer(rows);
    const matches = searchInBuffer(buf, 'match', { remainingBudget: HUGE_BUDGET, tailRows: 1_000 });
    expect(matches.map((m) => m.physicalBaseY)).toEqual([0, 2]);
  });

  it('tailRows is bounded by perBufferLineCap (window = newest min(tail, cap) rows)', () => {
    const rows = [
      { text: 'match-0' },
      { text: 'match-1' },
      { text: 'match-2' },
      { text: 'match-3' },
    ];
    const buf = makeBuffer(rows);
    const matches = searchInBuffer(buf, 'match', {
      remainingBudget: HUGE_BUDGET,
      tailRows: 3,
      perBufferLineCap: 2,
    });
    // Window is the last min(3, 2) = 2 rows — the NEWEST two, not the oldest.
    expect(matches.map((m) => m.physicalBaseY)).toEqual([2, 3]);
  });

  it('a window starting mid-wrap truncates that logical line at the boundary', () => {
    const buf = makeBuffer(WRAPPED_3ROW_LINE); // one logical line over 3 physical rows
    // Window starts at the 2nd physical row (mid-wrap): the continuation rows
    // form their own (truncated) logical line rather than merging backwards.
    const full = searchInBuffer(buf, '', { remainingBudget: HUGE_BUDGET });
    expect(full).toHaveLength(0); // empty query guard unaffected
    const matches = searchInBuffer(buf, WRAPPED_3ROW_LINE[1].text.slice(0, 3), {
      remainingBudget: HUGE_BUDGET,
      tailRows: 2,
    });
    expect(matches.length).toBeGreaterThanOrEqual(1);
    expect(matches[0].physicalBaseY).toBe(1);
  });

  it('legacy behavior without tailRows is unchanged (head-first cap)', () => {
    const rows = [{ text: 'first match' }, { text: 'second match' }, { text: 'third match' }];
    const buf = makeBuffer(rows);
    const matches = searchInBuffer(buf, 'match', {
      remainingBudget: HUGE_BUDGET,
      perBufferLineCap: 2,
    });
    expect(matches.map((m) => m.physicalBaseY)).toEqual([0, 1]);
  });
});
