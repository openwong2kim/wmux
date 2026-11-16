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
import { deliberateSleep, waitFor } from '../../../test-utils/waitFor';
import { setDaemonModeActive } from '../../daemon/daemonMode';

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
const reconnect = vi.fn(async (_id: string, _opts?: unknown): Promise<{ success: boolean; cols?: number; rows?: number }> => ({ success: true }));
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
        reconnect,
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
  observers.length = 0;
  setDaemonModeActive(false);
  reconnect.mockReset();
  reconnect.mockImplementation(async () => ({ success: true }));
  vi.restoreAllMocks();
});

// A span for something that must NOT happen (a send, a fit): nothing to wait for.
const quiet = (ms: number, why: string) => act(async () => { await deliberateSleep(ms, `quiet window: ${why}`); });
const sends = (ptyId: string) => resize.mock.calls.filter(([id]) => id === ptyId).map(([, c, r]) => `${c}x${r}`);
const sendsReach = (ptyId: string, n: number) => act(async () => { await waitFor(() => sends(ptyId).length >= n, 4000, `${n} sends for ${ptyId}`); });
/** Past the reveal's frame, the fit scheduler's 100 ms debounce and its frame. */
const FRAMES_MS = 300;

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
  await quiet(FRAMES_MS, 'the hidden mount settles before the reveal is measured');
  resize.mockClear();
  fitSpy.mockClear();
  await act(async () => { root!.render(<Harness visible />); });
  await quiet(FRAMES_MS, 'the reveal frame must fit and send nothing while the build is queued');
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
    await sendsReach('p-hold-built', 1);
    await quiet(FRAMES_MS, 'no second size may follow');
    expect(sends('p-hold-built')).toEqual(['57x30']);
  });

  it('a layout resize during the wait neither fits nor sends; later fits still send', async () => {
    const { jobs, fitSpy, setDomCols } = await revealHiddenPane('p-hold-layout');
    // The box changed meanwhile: a fit now would give a size the PTY never had.
    setDomCols(55);
    await fireLayoutResize();
    await quiet(FRAMES_MS, 'the layout fit must wait for the build');
    expect(fitSpy).not.toHaveBeenCalled();
    expect(sends('p-hold-layout')).toEqual([]);
    await act(async () => { jobs.at(-1)!(); });
    await sendsReach('p-hold-layout', 1);
    await quiet(FRAMES_MS, 'no other size may follow');
    expect(new Set(sends('p-hold-layout'))).toEqual(new Set(['57x30']));
    // Nothing the wait skipped is cached as sent: a later fit at 55 goes out.
    setDomCols(55);
    await fireLayoutResize();
    await act(async () => { await waitFor(() => sends('p-hold-layout').includes('55x30'), 4000, 'the later layout fit sends 55x30'); });
  });

  it('a reattach that lands during the wait does not send its DOM-cell re-assert', async () => {
    // The daemon reattach resolves after the reveal, while the build is still
    // queued: its #1255 re-assert measures the DOM cell, and must wait too.
    setDaemonModeActive(true);
    let land: (v: { success: boolean }) => void = () => undefined;
    reconnect.mockImplementation(() => new Promise((r) => { land = r; }));
    const { jobs } = await revealHiddenPane('p-hold-reattach');
    await act(async () => { await waitFor(() => reconnect.mock.calls.length > 0, 4000, 'the reattach started'); });
    await act(async () => { land({ success: true }); });
    await quiet(FRAMES_MS, 'the re-assert must not send the DOM cell while the build is queued');
    expect(sends('p-hold-reattach')).toEqual([]);
    await act(async () => { jobs.at(-1)!(); });
    await sendsReach('p-hold-reattach', 1);
    await quiet(FRAMES_MS, 'no other size may follow');
    expect(new Set(sends('p-hold-reattach'))).toEqual(new Set(['57x30']));
  });

  it('after a release, a fit landing on the size sent before the wait still goes out', async () => {
    // The release fits like the layout does, so what it sends is what the
    // dedup cache holds. A release that sent past that cache left it at the
    // size from before the wait, and a later fit back to that size went unsent.
    const { Harness, jobs, setDomCols } = await revealHiddenPane('p-hold-cache');
    webgl.fail = true;
    await act(async () => { jobs.at(-1)!(); });
    await sendsReach('p-hold-cache', 1);
    setDomCols(54);
    await fireLayoutResize();
    await sendsReach('p-hold-cache', 2);
    expect(sends('p-hold-cache')).toEqual(['56x30', '54x30']);
    // Hidden, then revealed again: no renderer yet (the build failed), so a
    // new build is queued and held. This one succeeds: 57.
    await act(async () => { root!.render(<Harness visible={false} />); });
    webgl.fail = false;
    const queued = jobs.length;
    await act(async () => { root!.render(<Harness visible />); });
    await act(async () => { await waitFor(() => jobs.length > queued, 4000, 'the second reveal queued a build'); });
    await act(async () => { jobs.at(-1)!(); });
    await sendsReach('p-hold-cache', 3);
    expect(sends('p-hold-cache').at(-1)).toBe('57x30');
    setDomCols(54);
    await fireLayoutResize();
    await sendsReach('p-hold-cache', 4);
    expect(sends('p-hold-cache').at(-1)).toBe('54x30');
  });

  it('sends the DOM cell size, once, when the build fails', async () => {
    const { jobs } = await revealHiddenPane('p-hold-failed');
    webgl.fail = true;
    await act(async () => { jobs.at(-1)!(); });
    await sendsReach('p-hold-failed', 1);
    await quiet(FRAMES_MS, 'no second size may follow');
    expect(sends('p-hold-failed')).toEqual(['56x30']);
  });

  it('sends the cell it has after the bounded wait, then the WebGL cell when the build comes late', async () => {
    const { jobs } = await revealHiddenPane('p-hold-timeout');
    await sendsReach('p-hold-timeout', 1);
    expect(sends('p-hold-timeout')).toEqual(['56x30']);
    await act(async () => { jobs.at(-1)!(); });
    await sendsReach('p-hold-timeout', 2);
    expect(sends('p-hold-timeout')).toEqual(['56x30', '57x30']);
  });

  it('sends nothing when the pane is hidden again before the bounded wait or the build ends', async () => {
    const { Harness, jobs } = await revealHiddenPane('p-hold-rehidden');
    await act(async () => { root!.render(<Harness visible={false} />); });
    await quiet(WEBGL_UPGRADE_HIDE_MAX_MS + 50, 'real timer: the bounded upgrade hide would have expired, and must send nothing');
    await act(async () => { jobs.at(-1)!(); });
    await quiet(FRAMES_MS, 'a build that runs anyway must send nothing');
    expect(sends('p-hold-rehidden')).toEqual([]);
  });

  it('a reveal that needs no build fits and sends at once', async () => {
    const { Harness, jobs } = await revealHiddenPane('p-hold-second');
    await act(async () => { jobs.at(-1)!(); });
    await sendsReach('p-hold-second', 1);
    resize.mockClear();
    await act(async () => { root!.render(<Harness visible={false} />); });
    await act(async () => { root!.render(<Harness visible />); });
    await sendsReach('p-hold-second', 1);
    expect(sends('p-hold-second')).toEqual(['57x30']);
  });
});
