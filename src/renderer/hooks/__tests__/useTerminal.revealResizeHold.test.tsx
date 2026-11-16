// @vitest-environment jsdom
//
// The first reveal of a pane mounted hidden (a background workspace after the
// app starts) queues its WebGL build on webglUpgradeQueue. The fits that run
// meanwhile measure the DOM renderer's cell, which the build replaces a frame
// later, so the PTY used to get two sizes (56, then 57 columns at DPR 1.25).
// No PTY resize goes out until the wait ends; whatever ends it sends the size
// the pane keeps, once. A pane hidden again before then sends nothing.
// Mounts the REAL useTerminal against a real xterm under jsdom, with the
// queue's job captured so the test decides when it runs.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { installCanvas2dStub } from '../../../test-utils/canvas2dStub';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FitAddon } from '@xterm/addon-fit';
import { WEBGL_UPGRADE_HIDE_MAX_MS, webglUpgradeQueue } from '../../terminal/webglUpgradeQueue';
import { deliberateSleep } from '../../../test-utils/waitFor';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const webgl = vi.hoisted(() => ({ fail: false }));
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    constructor() {
      if (webgl.fail) throw new Error('no WebGL');
    }
    activate() { /* stub: xterm keeps its DOM renderer */ }
    onContextLoss() { return { dispose: () => undefined }; }
    dispose() { /* stub */ }
  },
}));

const unsub = () => () => undefined;
const observers: Array<() => void> = [];
const fireLayoutResize = () => act(async () => { for (const cb of observers) cb(); });
const resize = vi.fn(async (_id: string, _cols: number, _rows: number) => undefined);

beforeAll(() => {
  installCanvas2dStub();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      platform: 'linux',
      windowsBuildNumber: null,
      pty: {
        onData: unsub, onExit: unsub, onFlushComplete: unsub, onRestarted: unsub,
        resize,
        setViewerVisibility: vi.fn(),
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
  // Captured, so a test can fire the layout resize that a reveal causes.
  globalThis.ResizeObserver = class {
    constructor(cb: () => void) { observers.push(cb); }
    observe() { /* fired by fireLayoutResize */ }
    unobserve() { /* inert */ }
    disconnect() { /* inert */ }
  } as unknown as typeof ResizeObserver;
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
  webgl.fail = false;
  vi.restoreAllMocks();
});

const settle = (ms = 50) => act(async () => { await deliberateSleep(ms, 'not yet converted (#2363): settle helper under act; callers assert after it'); });
const sends = (ptyId: string) => resize.mock.calls.filter(([id]) => id === ptyId).map(([, c, r]) => `${c}x${r}`);

/** Mounts the pane hidden (its first-resize gate opens at once), then reveals it. */
async function revealHiddenPane(ptyId: string) {
  const { useTerminal } = await import('../useTerminal');
  // The DOM renderer's cell gives 56 columns; the WebGL one, once built, 57.
  let cols = 56;
  vi.spyOn(FitAddon.prototype, 'proposeDimensions').mockImplementation(() => ({ cols, rows: 30 }));
  const fitSpy = vi.spyOn(FitAddon.prototype, 'fit').mockImplementation(function (this: FitAddon) {
    (this as unknown as { _terminal?: { resize(c: number, r: number): void } })._terminal?.resize(cols, 30);
  });
  const jobs: Array<() => void> = [];
  vi.spyOn(webglUpgradeQueue, 'enqueue').mockImplementation((run) => {
    jobs.push(() => { if (!webgl.fail) cols = 57; run(); });
    return vi.fn();
  });
  function Harness({ visible }: { visible: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    useTerminal(ref, { ptyId, isVisible: visible });
    return <div ref={ref} style={{ width: 800, height: 600 }} />;
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Harness visible={false} />); });
  await settle();
  resize.mockClear();
  fitSpy.mockClear();
  await act(async () => { root!.render(<Harness visible />); });
  // The reveal's frame runs here: it fits nothing while the build is queued.
  await settle();
  return { Harness, jobs, fitSpy, setDomCols: (c: number) => { cols = c; } };
}

describe('useTerminal reveal holds the PTY size until the WebGL build', { timeout: 60_000 }, () => {
  it('sends only the WebGL cell size, once, when the build succeeds', async () => {
    const { jobs, fitSpy } = await revealHiddenPane('p-hold-built');
    expect(jobs.length).toBeGreaterThan(0);
    // The reveal's frame did not fit the grid to the DOM cell either.
    expect(fitSpy).not.toHaveBeenCalled();
    expect(sends('p-hold-built')).toEqual([]);
    await act(async () => { jobs.at(-1)!(); });
    await settle();
    expect(sends('p-hold-built')).toEqual(['57x30']);
  });

  it('a layout resize during the wait fits locally but sends nothing', async () => {
    const { jobs, setDomCols } = await revealHiddenPane('p-hold-layout');
    // The box changed meanwhile: a fit now gives a size the PTY never had.
    setDomCols(55);
    await fireLayoutResize();
    // Past the fit scheduler's 100 ms debounce and its frame: the layout fit ran.
    await settle(300);
    expect(sends('p-hold-layout')).toEqual([]);
    await act(async () => { jobs.at(-1)!(); });
    await settle();
    // The release and the layout's own fit may both send; only the kept size goes out.
    expect(sends('p-hold-layout').length).toBeGreaterThan(0);
    expect(new Set(sends('p-hold-layout'))).toEqual(new Set(['57x30']));
  });

  it('sends the DOM cell size, once, when the build fails', async () => {
    const { jobs } = await revealHiddenPane('p-hold-failed');
    webgl.fail = true;
    await act(async () => { jobs.at(-1)!(); });
    await settle();
    expect(sends('p-hold-failed')).toEqual(['56x30']);
  });

  it('sends the cell it has after the bounded wait, then the WebGL cell when the build comes late', async () => {
    const { jobs } = await revealHiddenPane('p-hold-timeout');
    await act(async () => { await deliberateSleep(WEBGL_UPGRADE_HIDE_MAX_MS + 50, 'real timer: the bounded upgrade hide must expire'); });
    expect(sends('p-hold-timeout')).toEqual(['56x30']);
    await act(async () => { jobs.at(-1)!(); });
    await settle();
    expect(sends('p-hold-timeout')).toEqual(['56x30', '57x30']);
  });

  it('sends nothing when the pane is hidden again before the bounded wait or the build ends', async () => {
    const { Harness, jobs } = await revealHiddenPane('p-hold-rehidden');
    await act(async () => { root!.render(<Harness visible={false} />); });
    await act(async () => { await deliberateSleep(WEBGL_UPGRADE_HIDE_MAX_MS + 50, 'real timer: the bounded upgrade hide would have expired'); });
    await act(async () => { jobs.at(-1)!(); });
    await settle();
    expect(sends('p-hold-rehidden')).toEqual([]);
  });

  it('a reveal that needs no build fits and sends at once', async () => {
    const { Harness, jobs } = await revealHiddenPane('p-hold-second');
    await act(async () => { jobs.at(-1)!(); });
    await settle();
    resize.mockClear();
    await act(async () => { root!.render(<Harness visible={false} />); });
    await act(async () => { root!.render(<Harness visible />); });
    await settle();
    expect(sends('p-hold-second')).toEqual(['57x30']);
  });
});
