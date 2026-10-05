// @vitest-environment jsdom
//
// A sidebar toggle animates the column's width and holds terminal fits until
// the transition ends: each pane resizes its PTY exactly once, not per frame.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SidebarSlot, SIDEBAR_TOGGLE_FALLBACK_MS } from '../SidebarSlot';
import { createFitScheduler, fitsHeld, releaseFits, type FitScheduler } from '../../../utils/layoutTransitionGate';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CELL_PX = 8;
const DEBOUNCE_MS = 100;

/** A pane: its container width, the useTerminal-shaped fit, and the PTY IPC. */
function makePane(ptyId: string, ptyResize: (id: string, cols: number) => void) {
  let width = 800;
  let lastSentCols = 0;
  let raf: number | null = null;
  const runFit = () => {
    const cols = Math.floor(width / CELL_PX);
    // useTerminal's lastSentCols dedup
    if (cols !== lastSentCols) {
      lastSentCols = cols;
      ptyResize(ptyId, cols);
    }
  };
  const scheduler: FitScheduler = createFitScheduler({
    debounceMs: DEBOUNCE_MS,
    fitNextFrame: () => {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = null;
        runFit();
      });
    },
  });
  return {
    scheduler,
    /** A layout frame: the container grew, and its ResizeObserver ticks. */
    frame(newWidth: number) {
      width = newWidth;
      scheduler.onResize();
    },
  };
}

let host: HTMLDivElement;
let root: Root;
let reducedMotion = false;

function render(visible: boolean, width = 264) {
  act(() => {
    root.render(
      <SidebarSlot visible={visible} width={width} position="left">
        <div data-stub-sidebar />
      </SidebarSlot>,
    );
  });
}

const slot = () => host.querySelector('[data-testid="sidebar-slot"]') as HTMLDivElement;

function fireTransitionEnd(target: Element, propertyName: string) {
  const ev = new Event('transitionend', { bubbles: true });
  Object.defineProperty(ev, 'propertyName', { value: propertyName });
  act(() => {
    target.dispatchEvent(ev);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  reducedMotion = false;
  window.matchMedia = ((q: string) => ({ matches: reducedMotion && q.includes('reduce') })) as unknown as typeof window.matchMedia;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  releaseFits();
  vi.useRealTimers();
});

describe('SidebarSlot fit hold', () => {
  it('one toggle → exactly one PTY resize per pane, on transitionend', () => {
    const ptyResize = vi.fn();
    const panes = [makePane('a', ptyResize), makePane('b', ptyResize)];
    render(true);

    render(false); // collapse
    expect(fitsHeld()).toBe(true);
    expect(slot().hasAttribute('data-animating')).toBe(true);
    // The sidebar stays mounted while it animates closed.
    expect(host.querySelector('[data-stub-sidebar]')).not.toBeNull();

    // ~12 animation frames, each resizing every pane container. Frame 6
    // stalls past the debounce (a busy main thread): without the hold, the
    // debounce alone would resize every PTY mid-animation there.
    for (let f = 1; f <= 12; f++) {
      for (const p of panes) p.frame(800 + f * 22);
      vi.advanceTimersByTime(f === 6 ? DEBOUNCE_MS + 20 : 16);
    }
    expect(ptyResize).not.toHaveBeenCalled();

    // A sidebar row's own transition bubbling up does not end the hold.
    fireTransitionEnd(host.querySelector('[data-stub-sidebar]')!, 'background-color');
    expect(fitsHeld()).toBe(true);

    fireTransitionEnd(slot(), 'width');
    expect(fitsHeld()).toBe(false);
    vi.advanceTimersByTime(16); // the queued frame
    expect(ptyResize).toHaveBeenCalledTimes(2);
    expect(ptyResize).toHaveBeenCalledWith('a', Math.floor((800 + 12 * 22) / CELL_PX));
    expect(ptyResize).toHaveBeenCalledWith('b', Math.floor((800 + 12 * 22) / CELL_PX));

    // The final layout frame's observer tick can land after transitionend:
    // same geometry, so the dedup keeps it from a second resize.
    for (const p of panes) p.frame(800 + 12 * 22);
    vi.advanceTimersByTime(DEBOUNCE_MS + 32);
    expect(ptyResize).toHaveBeenCalledTimes(2);
    // Collapsed and settled: the sidebar unmounts.
    expect(host.querySelector('[data-stub-sidebar]')).toBeNull();
    expect(slot().hasAttribute('data-animating')).toBe(false);
  });

  it('no transitionend → the fallback releases with one resize per pane', () => {
    const ptyResize = vi.fn();
    const panes = [makePane('a', ptyResize), makePane('b', ptyResize)];
    render(false);

    render(true); // expand
    for (let f = 1; f <= 5; f++) {
      for (const p of panes) p.frame(800 - f * 50);
      vi.advanceTimersByTime(16);
    }
    expect(ptyResize).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(SIDEBAR_TOGGLE_FALLBACK_MS);
    });
    vi.advanceTimersByTime(16);
    expect(fitsHeld()).toBe(false);
    expect(ptyResize).toHaveBeenCalledTimes(2);
    expect(slot().hasAttribute('data-animating')).toBe(false);
  });

  it('a drag-resize of the width does not animate or hold', () => {
    render(true, 264);
    render(true, 300);
    expect(fitsHeld()).toBe(false);
    expect(slot().hasAttribute('data-animating')).toBe(false);
    expect(slot().style.width).toBe('300px');
  });

  it('reduced motion: instant, no hold, sidebar unmounts at once', () => {
    reducedMotion = true;
    render(true);
    render(false);
    expect(fitsHeld()).toBe(false);
    expect(slot().hasAttribute('data-animating')).toBe(false);
    expect(host.querySelector('[data-stub-sidebar]')).toBeNull();
  });
});
