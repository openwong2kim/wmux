import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import {
  parkTerminal,
  adoptTerminal,
  restoreParkedViewport,
  PARK_TTL_MS,
  __resetTerminalPark,
  __isParked,
} from '../terminalPark';

// #1002. The park window exists so a pane-tree restructure — split, drag-move,
// sibling collapse — can hand its xterm to the mount that replaces it instead
// of disposing it and watching the daemon replay the whole conversation back.
// Everything here is about the two halves of that contract: an adopter inside
// the window gets the SAME instance, and no adopter means the terminal is
// disposed exactly as it was before this module existed.

interface FakeTerminal {
  buffer: { active: { viewportY: number; baseY: number } };
  scrollToBottom: ReturnType<typeof vi.fn>;
  scrollToLine: ReturnType<typeof vi.fn>;
}

function fakeTerminal(viewportY = 100, baseY = 100): FakeTerminal {
  return {
    buffer: { active: { viewportY, baseY } },
    scrollToBottom: vi.fn(),
    scrollToLine: vi.fn(),
  };
}

const asTerminal = (t: FakeTerminal): Terminal => t as unknown as Terminal;
const fakeElement = (): HTMLElement => ({ tagName: 'DIV' } as unknown as HTMLElement);

describe('terminalPark', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { __resetTerminalPark(); vi.useRealTimers(); });

  it('hands the same terminal back to a mount that adopts inside the window', () => {
    const term = fakeTerminal();
    const dispose = vi.fn();
    parkTerminal('pty-1', asTerminal(term), fakeElement(), dispose);

    const adopted = adoptTerminal('pty-1');

    expect(adopted?.terminal).toBe(asTerminal(term));
    expect(dispose).not.toHaveBeenCalled();
    // Claiming transfers ownership: the pending dispose must be cancelled, or
    // the adopting mount's terminal dies the moment the task ends.
    vi.advanceTimersByTime(PARK_TTL_MS * 4);
    expect(dispose).not.toHaveBeenCalled();
    expect(__isParked('pty-1')).toBe(false);
  });

  it('disposes on the caller\'s behalf when nobody adopts — a closed pane', () => {
    const dispose = vi.fn();
    parkTerminal('pty-1', asTerminal(fakeTerminal()), fakeElement(), dispose);

    expect(dispose).not.toHaveBeenCalled();
    vi.advanceTimersByTime(PARK_TTL_MS);

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(adoptTerminal('pty-1')).toBeNull();
  });

  it('disposes only once, even if the ttl fires after an eviction attempt', () => {
    const dispose = vi.fn();
    parkTerminal('pty-1', asTerminal(fakeTerminal()), fakeElement(), dispose);
    vi.advanceTimersByTime(PARK_TTL_MS);
    vi.advanceTimersByTime(PARK_TTL_MS * 10);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('keys parks by ptyId, so one pane never adopts another pane\'s terminal', () => {
    const one = fakeTerminal();
    const two = fakeTerminal();
    parkTerminal('pty-1', asTerminal(one), fakeElement(), vi.fn());
    parkTerminal('pty-2', asTerminal(two), fakeElement(), vi.fn());

    expect(adoptTerminal('pty-2')?.terminal).toBe(asTerminal(two));
    expect(adoptTerminal('pty-1')?.terminal).toBe(asTerminal(one));
    expect(adoptTerminal('pty-3')).toBeNull();
  });

  it('disposes immediately rather than parking an empty ptyId', () => {
    const dispose = vi.fn();
    parkTerminal('', asTerminal(fakeTerminal()), fakeElement(), dispose);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(adoptTerminal('')).toBeNull();
  });

  it('releases the older instance when a second park lands on one ptyId', () => {
    // Two live terminals on one ptyId is the unmount/remount race the WebGL
    // pool comment already warns about. The first is unreachable once the
    // second parks, so it must be disposed rather than leaked.
    const firstDispose = vi.fn();
    const second = fakeTerminal();
    parkTerminal('pty-1', asTerminal(fakeTerminal()), fakeElement(), firstDispose);
    parkTerminal('pty-1', asTerminal(second), fakeElement(), vi.fn());

    expect(firstDispose).toHaveBeenCalledTimes(1);
    expect(adoptTerminal('pty-1')?.terminal).toBe(asTerminal(second));
  });

  it('parks a terminal whose buffer cannot be read', () => {
    const hostile = {
      get buffer(): never { throw new Error('disposed'); },
      scrollToBottom: vi.fn(),
      scrollToLine: vi.fn(),
    } as unknown as Terminal;
    const dispose = vi.fn();

    expect(() => parkTerminal('pty-1', hostile, fakeElement(), dispose)).not.toThrow();
    expect(adoptTerminal('pty-1')?.atBottom).toBe(true);
  });

  describe('viewport restoration', () => {
    it('puts a pane that was pinned to the bottom back at the bottom', () => {
      // The #1002 case: the pane is at the latest output when the user splits.
      const term = fakeTerminal(500, 500);
      parkTerminal('pty-1', asTerminal(term), fakeElement(), vi.fn());
      const adopted = adoptTerminal('pty-1');

      restoreParkedViewport(adopted!);

      expect(term.scrollToBottom).toHaveBeenCalledTimes(1);
      expect(term.scrollToLine).not.toHaveBeenCalled();
    });

    it('puts a pane scrolled back into history back where it was', () => {
      const term = fakeTerminal(120, 500);
      parkTerminal('pty-1', asTerminal(term), fakeElement(), vi.fn());
      const adopted = adoptTerminal('pty-1');

      restoreParkedViewport(adopted!);

      expect(term.scrollToLine).toHaveBeenCalledWith(120);
      expect(term.scrollToBottom).not.toHaveBeenCalled();
    });

    it('measures against the CURRENT bottom, so a reflow does not misplace the reader', () => {
      // The split changes the pane's width, and on a reflow-capable buffer that
      // rewraps every line — the absolute row the user was reading is not the
      // same row afterwards. Restoring by distance-from-bottom lands them near
      // what they were reading instead of somewhere else entirely.
      const term = fakeTerminal(400, 500); // 100 rows up from the bottom
      parkTerminal('pty-1', asTerminal(term), fakeElement(), vi.fn());
      const adopted = adoptTerminal('pty-1');

      term.buffer.active.baseY = 620; // the fit rewrapped: 120 more rows exist

      restoreParkedViewport(adopted!);

      expect(term.scrollToLine).toHaveBeenCalledWith(520);
    });

    it('never scrolls above the top of the buffer', () => {
      const term = fakeTerminal(10, 500);
      parkTerminal('pty-1', asTerminal(term), fakeElement(), vi.fn());
      const adopted = adoptTerminal('pty-1');

      term.buffer.active.baseY = 30; // rewrapped far shorter than the offset

      restoreParkedViewport(adopted!);

      expect(term.scrollToLine).toHaveBeenCalledWith(0);
    });

    it('does not take the adopting mount down when scrolling throws', () => {
      const term = fakeTerminal(500, 500);
      term.scrollToBottom.mockImplementation(() => { throw new Error('disposed'); });
      parkTerminal('pty-1', asTerminal(term), fakeElement(), vi.fn());
      const adopted = adoptTerminal('pty-1');

      expect(() => restoreParkedViewport(adopted!)).not.toThrow();
    });
  });
});
