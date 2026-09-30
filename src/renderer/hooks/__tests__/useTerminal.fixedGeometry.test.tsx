// @vitest-environment jsdom
//
// `fixedGeometry` (wmux web): the pane's grid belongs to the desktop, so a
// terminal mounted with it must take the owner's cols/rows — at construction
// and on every later change — and must never call pty.resize, whatever fit
// path runs (mount, fonts.ready, ResizeObserver, visibility, font/theme).
// Mounts the REAL useTerminal against a real xterm under jsdom.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FitAddon } from '@xterm/addon-fit';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// No WebGL under jsdom: the hook's own fallback (DOM renderer) takes over.
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class { constructor() { throw new Error('no WebGL in jsdom'); } },
}));

const resize = vi.fn(async () => undefined);
const setViewerVisibility = vi.fn();
const unsub = () => () => undefined;

beforeAll(() => {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      platform: 'linux',
      windowsBuildNumber: null,
      pty: {
        onData: unsub, onExit: unsub, onFlushComplete: unsub, onRestarted: unsub,
        resize, setViewerVisibility,
        write: vi.fn(async () => undefined),
        list: vi.fn(async () => []),
        reconnect: vi.fn(async () => ({ success: true })),
      },
      daemon: { onConnected: unsub },
      shell: { openPath: vi.fn(async () => ({ ok: true })) },
    },
  });
  Object.defineProperty(window, 'clipboardAPI', {
    configurable: true,
    value: { writeText: vi.fn(async () => undefined), readText: vi.fn(async () => '') },
  });
  window.matchMedia ??= ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  globalThis.ResizeObserver ??= class { observe() { /* inert */ } unobserve() { /* inert */ } disconnect() { /* inert */ } } as unknown as typeof ResizeObserver;
  // jsdom has no layout: give every element a size so the fit paths run.
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 600 });
  (document as unknown as { fonts: unknown }).fonts ??= {
    ready: Promise.resolve(),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  resize.mockClear();
});

async function mount(fixedGeometry: { cols: number; rows: number } | undefined) {
  const { useTerminal, terminalRegistry } = await import('../useTerminal');
  function Harness({ geometry }: { geometry: { cols: number; rows: number } | undefined }) {
    const ref = useRef<HTMLDivElement>(null);
    useTerminal(ref, { ptyId: 'p1', isVisible: true, fixedGeometry: geometry });
    return <div ref={ref} style={{ width: 800, height: 600 }} />;
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Harness geometry={fixedGeometry} />); });
  await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
  const rerender = async (g: { cols: number; rows: number } | undefined) => {
    await act(async () => { root!.render(<Harness geometry={g} />); });
  };
  return { term: () => terminalRegistry.get('p1')!, rerender };
}

// The first case pays for importing the whole hook under jsdom.
describe('useTerminal fixedGeometry', { timeout: 60_000 }, () => {
  it('takes the owner\'s cols/rows and never resizes the PTY', async () => {
    const { term, rerender } = await mount({ cols: 132, rows: 43 });
    // The font fit reads xterm's private cell size (fixedGeometryFit.cellSize);
    // an xterm upgrade that moves it must fail here, not silently in browsers.
    const cell = (term() as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { width?: unknown; height?: unknown } } } } } })
      ._core?._renderService?.dimensions?.css?.cell;
    expect(typeof cell?.width).toBe('number');
    expect(typeof cell?.height).toBe('number');
    expect(term().cols).toBe(132);
    expect(term().rows).toBe(43);

    // The owner resized the pane.
    await rerender({ cols: 100, rows: 30 });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(term().cols).toBe(100);
    expect(term().rows).toBe(30);

    // A container resize runs the observer's fit: still the owner's grid.
    window.dispatchEvent(new Event('resize'));
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(term().cols).toBe(100);
    expect(resize).not.toHaveBeenCalled();
  });

  it('without the option the desktop fit is unchanged: it fits and resizes the PTY', async () => {
    // jsdom measures no glyphs, so stand in for the container measurement.
    const propose = vi.spyOn(FitAddon.prototype, 'proposeDimensions').mockReturnValue({ cols: 90, rows: 20 });
    try {
      const { term } = await mount(undefined);
      expect(term().cols).toBe(90);
      expect(resize).toHaveBeenCalledWith('p1', 90, 20);
    } finally {
      propose.mockRestore();
    }
  });
});
