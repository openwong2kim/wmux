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
import { readPtyBufferLines, tailForPty } from '../terminalTail';

/** Build a fake Terminal whose buffer yields `lines` (+ optional trailing
 *  empties). `elementOffsetWidth` / `elementConnected` model a display:none
 *  background pane — they MUST be ignored by the tail. */
function makeTerminal(opts: {
  lines: string[];
  trailingEmpty?: number;
  baseY?: number;
  elementOffsetWidth?: number;
  elementConnected?: boolean;
}) {
  const {
    lines,
    trailingEmpty = 0,
    baseY = 0,
    elementOffsetWidth = 800,
    elementConnected = true,
  } = opts;
  const fullLines = lines.concat(Array.from({ length: trailingEmpty }, () => ''));
  const buffer = {
    length: fullLines.length,
    baseY,
    cursorY: fullLines.length === 0 ? 0 : fullLines.length - 1 - baseY,
    getLine(idx: number) {
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
