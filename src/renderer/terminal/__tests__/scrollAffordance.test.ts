/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import {
  resolveScrollAffordance,
  bindScrollAffordance,
  NATIVE_SCROLL_CLASS,
  JOG_SCROLL_CLASS,
  type ScrollAffordance,
} from '../scrollAffordance';

type Listener = () => void;

/**
 * Minimal stand-in for the public xterm surface this module reads. The real
 * regression (#13) is entirely about which numbers come out of `buffer.active`,
 * so the stub models exactly those and the three events that can change them.
 */
function makeTerminal(init?: {
  type?: 'normal' | 'alternate';
  length?: number;
  rows?: number;
}) {
  const scrollListeners = new Set<Listener>();
  const resizeListeners = new Set<Listener>();
  const bufferChangeListeners = new Set<Listener>();
  const element = document.createElement('div');
  const state = {
    type: init?.type ?? 'normal',
    length: init?.length ?? 24,
    rows: init?.rows ?? 24,
  };
  const sub = (set: Set<Listener>) => (cb: Listener) => {
    set.add(cb);
    return { dispose: () => set.delete(cb) };
  };
  const terminal = {
    element,
    get rows() {
      return state.rows;
    },
    buffer: {
      get active() {
        return { type: state.type, length: state.length };
      },
      onBufferChange: sub(bufferChangeListeners),
    },
    onScroll: sub(scrollListeners),
    onResize: sub(resizeListeners),
  } as unknown as Terminal;

  return {
    terminal,
    element,
    state,
    counts: () => ({
      scroll: scrollListeners.size,
      resize: resizeListeners.size,
      bufferChange: bufferChangeListeners.size,
    }),
    fire: (which: 'scroll' | 'resize' | 'bufferChange') => {
      const set =
        which === 'scroll' ? scrollListeners
          : which === 'resize' ? resizeListeners
            : bufferChangeListeners;
      for (const cb of [...set]) cb();
    },
  };
}

describe('resolveScrollAffordance', () => {
  it('picks jog on the alternate buffer however many rows it has', () => {
    // The #13 case: a full-screen TUI holds no scrollback, so lines === rows and
    // Monaco can never produce a draggable slider no matter how long the
    // session runs.
    const { terminal, state } = makeTerminal({ type: 'alternate', length: 80, rows: 80 });
    expect(resolveScrollAffordance(terminal)).toBe('jog');
    state.length = 5000;
    expect(resolveScrollAffordance(terminal)).toBe('jog');
  });

  it('picks native once a normal buffer exceeds the viewport', () => {
    const { terminal, state } = makeTerminal({ length: 24, rows: 24 });
    expect(resolveScrollAffordance(terminal)).toBe('none');
    state.length = 25;
    expect(resolveScrollAffordance(terminal)).toBe('native');
    state.length = 3002;
    expect(resolveScrollAffordance(terminal)).toBe('native');
  });

  it('picks none for a normal buffer that fits, so nothing inert is shown', () => {
    const { terminal } = makeTerminal({ length: 10, rows: 24 });
    expect(resolveScrollAffordance(terminal)).toBe('none');
  });
});

describe('bindScrollAffordance', () => {
  it('marks the element native only while a real scroll range exists', () => {
    const { terminal, element, state, fire } = makeTerminal({ length: 24, rows: 24 });
    const binding = bindScrollAffordance(terminal);

    // This is the actual fix: with no scroll range the always-visible CSS must
    // not apply, so Monaco's own hidden state wins.
    expect(element.classList.contains(NATIVE_SCROLL_CLASS)).toBe(false);

    state.length = 500;
    fire('scroll');
    expect(element.classList.contains(NATIVE_SCROLL_CLASS)).toBe(true);
    expect(element.classList.contains(JOG_SCROLL_CLASS)).toBe(false);

    binding.dispose();
  });

  it('swaps to jog when a TUI takes over and back again on exit', () => {
    const { terminal, element, state, fire } = makeTerminal({ length: 500, rows: 24 });
    const seen: ScrollAffordance[] = [];
    const binding = bindScrollAffordance(terminal, (mode) => seen.push(mode));

    expect(element.classList.contains(NATIVE_SCROLL_CLASS)).toBe(true);

    state.type = 'alternate';
    state.length = 24;
    fire('bufferChange');
    expect(element.classList.contains(JOG_SCROLL_CLASS)).toBe(true);
    expect(element.classList.contains(NATIVE_SCROLL_CLASS)).toBe(false);

    state.type = 'normal';
    state.length = 500;
    fire('bufferChange');
    expect(element.classList.contains(NATIVE_SCROLL_CLASS)).toBe(true);

    expect(seen).toEqual(['native', 'jog', 'native']);
    binding.dispose();
  });

  it('reacts to a resize that shrinks rows below the line count without a scroll', () => {
    // Monaco leaves the bar tagged "not needed" here until something else
    // scrolls, so the class cannot be derived from Monaco's own state.
    const { terminal, element, state, fire } = makeTerminal({ length: 40, rows: 80 });
    const binding = bindScrollAffordance(terminal);
    expect(element.classList.contains(NATIVE_SCROLL_CLASS)).toBe(false);

    state.rows = 20;
    fire('resize');
    expect(element.classList.contains(NATIVE_SCROLL_CLASS)).toBe(true);
    binding.dispose();
  });

  it('reports each transition once, not once per event', () => {
    const { terminal, state, fire } = makeTerminal({ length: 500, rows: 24 });
    const onChange = vi.fn();
    const binding = bindScrollAffordance(terminal, onChange);
    expect(onChange).toHaveBeenCalledTimes(1);

    state.length = 600;
    fire('scroll');
    fire('scroll');
    fire('resize');
    expect(onChange).toHaveBeenCalledTimes(1);

    binding.dispose();
  });

  it('releases subscriptions and classes on dispose', () => {
    const { terminal, element, state, counts, fire } = makeTerminal({ length: 500, rows: 24 });
    const binding = bindScrollAffordance(terminal);
    expect(counts()).toEqual({ scroll: 1, resize: 1, bufferChange: 1 });
    expect(element.classList.contains(NATIVE_SCROLL_CLASS)).toBe(true);

    binding.dispose();
    expect(counts()).toEqual({ scroll: 0, resize: 0, bufferChange: 0 });
    expect(element.classList.contains(NATIVE_SCROLL_CLASS)).toBe(false);
    expect(element.classList.contains(JOG_SCROLL_CLASS)).toBe(false);

    // A late event must not resurrect the class after teardown.
    state.type = 'alternate';
    fire('bufferChange');
    expect(element.classList.contains(JOG_SCROLL_CLASS)).toBe(false);
  });
});
