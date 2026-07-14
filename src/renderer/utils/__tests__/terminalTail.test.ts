/**
 * Tests for the shared terminal buffer-read used by `input.readScreen` and the
 * S-C2 Fleet View live-output tail.
 *
 * The single most important property this file pins is the GUARD ABSENCE:
 * unlike `serializeTerminalBuffer` (scrollbackDump.ts:86), `readPtyBufferLines`
 * MUST NOT consult `element.offsetWidth` / `element.isConnected`. Every
 * background pane is mounted `display:none` (offsetWidth 0), so copying that
 * guard would blank the tail for the entire background fleet. We assert a pane
 * whose DOM element would report offsetWidth 0 still yields a non-empty tail.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the registry module to a real Map we can inject fakes into. The tail
// reads `terminalRegistry.get(ptyId).buffer.active` only — never the element —
// so the fake Terminal here deliberately exposes an `element` with
// offsetWidth 0 / isConnected false to prove that path is never taken.
vi.mock('../../hooks/useTerminal', () => ({
  terminalRegistry: new Map(),
}));

import { terminalRegistry } from '../../hooks/useTerminal';
import { readPtyBufferLines, readPtyBufferTail, tailForPty, DEFAULT_READ_TAIL_LINES } from '../terminalTail';

/** Build a fake Terminal whose buffer yields `lines` (+ optional trailing
 *  empties). `elementOffsetWidth` / `elementConnected` model a display:none
 *  background pane — they MUST be ignored by the tail. */
function makeTerminal(opts: {
  lines: string[];
  trailingEmpty?: number;
  baseY?: number;
  elementOffsetWidth?: number;
  elementConnected?: boolean;
  /** Spy invoked on every `buffer.getLine(idx)` — proves the scan is bounded. */
  onGetLine?: (idx: number) => void;
}) {
  const {
    lines,
    trailingEmpty = 0,
    baseY = 0,
    elementOffsetWidth = 800,
    elementConnected = true,
    onGetLine,
  } = opts;
  const fullLines = lines.concat(Array.from({ length: trailingEmpty }, () => ''));
  const buffer = {
    length: fullLines.length,
    baseY,
    cursorY: fullLines.length === 0 ? 0 : fullLines.length - 1 - baseY,
    getLine(idx: number) {
      onGetLine?.(idx);
      const text = fullLines[idx];
      if (text === undefined) return undefined;
      return { translateToString: (_trimRight: boolean) => text };
    },
  };
  return {
    element: { offsetWidth: elementOffsetWidth, isConnected: elementConnected },
    buffer: { active: buffer },
  };
}

beforeEach(() => {
  (terminalRegistry as Map<string, unknown>).clear();
});

describe('readPtyBufferLines', () => {
  it('returns [] for a ptyId not in the registry', () => {
    expect(readPtyBufferLines('missing')).toEqual([]);
  });

  it('reads all lines 0..baseY+cursorY as plaintext', () => {
    (terminalRegistry as Map<string, unknown>).set(
      'p1',
      makeTerminal({ lines: ['line a', 'line b', 'line c'] }),
    );
    expect(readPtyBufferLines('p1')).toEqual(['line a', 'line b', 'line c']);
  });

  it('pops trailing empty lines (viewport padding past the cursor)', () => {
    (terminalRegistry as Map<string, unknown>).set(
      'p1',
      makeTerminal({ lines: ['real', 'output'], trailingEmpty: 4 }),
    );
    expect(readPtyBufferLines('p1')).toEqual(['real', 'output']);
  });
});

describe('readPtyBufferTail', () => {
  // The bounded read path behind terminal_read's default (RCA 2026-07-14
  // orchestrator lag). Must return the last N buffer rows, pop trailing empties,
  // and — the load-bearing property — read in O(N), NEVER walking the whole
  // scrollback the way readPtyBufferLines does.

  it('returns [] for a ptyId not in the registry', () => {
    expect(readPtyBufferTail('missing', 100)).toEqual([]);
  });

  it('returns [] for a non-positive cap', () => {
    (terminalRegistry as Map<string, unknown>).set(
      'p1',
      makeTerminal({ lines: ['a', 'b'] }),
    );
    expect(readPtyBufferTail('p1', 0)).toEqual([]);
    expect(readPtyBufferTail('p1', -5)).toEqual([]);
  });

  it('returns the whole buffer when it is shorter than the cap', () => {
    (terminalRegistry as Map<string, unknown>).set(
      'p1',
      makeTerminal({ lines: ['l1', 'l2', 'l3'] }),
    );
    expect(readPtyBufferTail('p1', 300)).toEqual(['l1', 'l2', 'l3']);
  });

  it('returns only the last N rows when the buffer exceeds the cap', () => {
    (terminalRegistry as Map<string, unknown>).set(
      'p1',
      makeTerminal({ lines: ['l1', 'l2', 'l3', 'l4', 'l5'] }),
    );
    expect(readPtyBufferTail('p1', 3)).toEqual(['l3', 'l4', 'l5']);
  });

  it('pops trailing empties (cursor padding past the last content row)', () => {
    (terminalRegistry as Map<string, unknown>).set(
      'p1',
      makeTerminal({ lines: ['real', 'output'], trailingEmpty: 4 }),
    );
    expect(readPtyBufferTail('p1', 300)).toEqual(['real', 'output']);
  });

  it('matches the full read when the cap covers the whole buffer', () => {
    (terminalRegistry as Map<string, unknown>).set(
      'p1',
      makeTerminal({ lines: ['top', 'mid', '', 'last'] }),
    );
    expect(readPtyBufferTail('p1', 300)).toEqual(readPtyBufferLines('p1'));
  });

  it('is O(cap), not O(scrollback): a 10k-row buffer reads ~cap lines, not all', () => {
    // This is the whole point of the fix. readPtyBufferLines would call getLine
    // 10000 times (and pin the renderer thread); readPtyBufferTail must read at
    // most ~cap rows regardless of how deep the scrollback is.
    const calls: number[] = [];
    const big = Array.from({ length: 10000 }, (_, i) => `row-${i}`);
    (terminalRegistry as Map<string, unknown>).set(
      'huge',
      makeTerminal({ lines: big, onGetLine: (idx) => calls.push(idx) }),
    );
    const out = readPtyBufferTail('huge', DEFAULT_READ_TAIL_LINES);
    expect(out.length).toBe(DEFAULT_READ_TAIL_LINES);
    expect(out[out.length - 1]).toBe('row-9999');
    expect(out[0]).toBe(`row-${10000 - DEFAULT_READ_TAIL_LINES}`);
    // The load-bearing assertion: it read the window, not the whole buffer.
    expect(calls.length).toBe(DEFAULT_READ_TAIL_LINES);
    expect(calls.length).toBeLessThan(10000);
  });

  it('still reads a display:none / offsetWidth-0 background pane', () => {
    (terminalRegistry as Map<string, unknown>).set(
      'bg',
      makeTerminal({
        lines: ['background', 'pane', 'output'],
        elementOffsetWidth: 0,
        elementConnected: false,
      }),
    );
    expect(readPtyBufferTail('bg', 300)).toEqual(['background', 'pane', 'output']);
  });
});

describe('tailForPty', () => {
  it('returns the last N non-empty lines', () => {
    (terminalRegistry as Map<string, unknown>).set(
      'p1',
      makeTerminal({ lines: ['l1', 'l2', 'l3', 'l4', 'l5'] }),
    );
    expect(tailForPty('p1', 3)).toEqual(['l3', 'l4', 'l5']);
  });

  it('defaults to the last 3 lines', () => {
    (terminalRegistry as Map<string, unknown>).set(
      'p1',
      makeTerminal({ lines: ['l1', 'l2', 'l3', 'l4'] }),
    );
    expect(tailForPty('p1')).toEqual(['l2', 'l3', 'l4']);
  });

  it('returns fewer than N when the buffer is short', () => {
    (terminalRegistry as Map<string, unknown>).set(
      'p1',
      makeTerminal({ lines: ['only one'] }),
    );
    expect(tailForPty('p1', 3)).toEqual(['only one']);
  });

  it('pops trailing empties before taking the tail', () => {
    (terminalRegistry as Map<string, unknown>).set(
      'p1',
      makeTerminal({ lines: ['a', 'b', 'c', 'd'], trailingEmpty: 5 }),
    );
    // Tail must be the last 3 REAL lines, not 3 blank padding rows.
    expect(tailForPty('p1', 3)).toEqual(['b', 'c', 'd']);
  });

  it('n <= 0 returns every line', () => {
    (terminalRegistry as Map<string, unknown>).set(
      'p1',
      makeTerminal({ lines: ['x', 'y', 'z'] }),
    );
    expect(tailForPty('p1', 0)).toEqual(['x', 'y', 'z']);
  });

  it('returns [] for a missing ptyId', () => {
    expect(tailForPty('nope', 3)).toEqual([]);
  });

  // ── Fix 2: bounded tail equivalence + bounded scan ──────────────────────
  // The bounded tail must match the old full-read `slice(-n)` for the common
  // case, skip trailing empties within the bound, preserve INTERIOR empties,
  // and never walk the whole scrollback.

  it('common case: tailForPty equals the full-read slice(-n)', () => {
    (terminalRegistry as Map<string, unknown>).set(
      'p1',
      makeTerminal({ lines: ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'] }),
    );
    const fullSlice = readPtyBufferLines('p1').slice(-3);
    expect(tailForPty('p1', 3)).toEqual(fullSlice);
    expect(tailForPty('p1', 3)).toEqual(['l4', 'l5', 'l6']);
  });

  it('skips trailing empties within the bound (last N content lines)', () => {
    (terminalRegistry as Map<string, unknown>).set(
      'p1',
      makeTerminal({ lines: ['a', 'b', 'c', 'd'], trailingEmpty: 10 }),
    );
    expect(tailForPty('p1', 3)).toEqual(['b', 'c', 'd']);
  });

  it('preserves interior empty lines between content', () => {
    // Content rows with a blank line wedged in the middle; the blank is part of
    // the last-N window so it must survive (matches full-read slice(-n)).
    (terminalRegistry as Map<string, unknown>).set(
      'p1',
      makeTerminal({ lines: ['top', 'first', '', 'last'] }),
    );
    const fullSlice = readPtyBufferLines('p1').slice(-3);
    expect(tailForPty('p1', 3)).toEqual(fullSlice);
    expect(tailForPty('p1', 3)).toEqual(['first', '', 'last']);
  });

  it('bounded scan: a huge buffer reads ~SCAN_BOUND+n lines, not all', () => {
    // 10000 content rows. A full O(scrollback) read would call getLine 10000
    // times; the bounded tail caps the upward scan at SCAN_BOUND (= n + 50) and
    // then re-reads at most n rows to collect — so far fewer than 10000.
    const N = 3;
    const calls: number[] = [];
    const big = Array.from({ length: 10000 }, (_, i) => `row-${i}`);
    (terminalRegistry as Map<string, unknown>).set(
      'huge',
      makeTerminal({ lines: big, onGetLine: (idx) => calls.push(idx) }),
    );
    const out = tailForPty('huge', N);
    expect(out).toEqual(['row-9997', 'row-9998', 'row-9999']);
    // Upward scan stops at the first non-empty (the bottom row) = 1 call; the
    // collect loop reads n more. Hard ceiling = SCAN_BOUND (n + 50) + n. The
    // load-bearing assertion is simply "not 10000".
    expect(calls.length).toBeLessThanOrEqual(N + 50 + N);
    expect(calls.length).toBeLessThan(10000);
  });

  it('mostly-empty tail beyond the bound yields a short/empty tail (no full walk)', () => {
    // 100 blank rows of cursor padding past one content row near the top: the
    // content sits beyond SCAN_BOUND, so the bounded scan returns [] rather
    // than walking the whole buffer. Acceptable per the documented trade-off.
    const calls: number[] = [];
    const lines = ['lonely content'];
    (terminalRegistry as Map<string, unknown>).set(
      'sparse',
      makeTerminal({ lines, trailingEmpty: 100, onGetLine: (idx) => calls.push(idx) }),
    );
    expect(tailForPty('sparse', 3)).toEqual([]);
    expect(calls.length).toBeLessThanOrEqual(3 + 50);
  });

  // ── GUARD-ABSENCE LOCK ──────────────────────────────────────────────────
  // A background pane is mounted display:none → element.offsetWidth === 0 and
  // (when detached) isConnected === false. serializeTerminalBuffer bails on
  // exactly that (scrollbackDump.ts:86). The tail MUST NOT: it reads the buffer
  // regardless, so background cards still show output. If someone re-introduces
  // the offsetWidth/isConnected guard, this assertion goes red.
  it('still yields a non-empty tail for a display:none / offsetWidth-0 pane', () => {
    (terminalRegistry as Map<string, unknown>).set(
      'bg',
      makeTerminal({
        lines: ['background', 'pane', 'output'],
        elementOffsetWidth: 0,
        elementConnected: false,
      }),
    );
    expect(tailForPty('bg', 3)).toEqual(['background', 'pane', 'output']);
    expect(readPtyBufferLines('bg')).toEqual(['background', 'pane', 'output']);
  });
});
