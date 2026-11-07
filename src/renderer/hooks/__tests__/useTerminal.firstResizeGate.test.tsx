// @vitest-environment jsdom
//
// A pane restored right after boot fits before the bundled webfont loads, and
// again when WebGL rounds the cell, so its first PTY resizes were sizes the
// pane never kept. The daemon served the reattach's replay at the first of
// them and recorded it in the ring's geometry history, which cut the rows
// below the cursor on restore. The mount now sends nothing until the font is
// in and the grid holds (or a bound passes), then sends once, and the mount's
// reattach goes after that send.
// Mounts the REAL useTerminal against a real xterm under jsdom, with the WebGL
// upgrade job captured so the test decides when the renderer arrives.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { installCanvas2dStub } from '../../../test-utils/canvas2dStub';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FitAddon } from '@xterm/addon-fit';
import { webglUpgradeQueue } from '../../terminal/webglUpgradeQueue';
import { FIRST_RESIZE_GATE_BOUND_MS } from '../../terminal/firstResizeGate';
import { setDaemonModeActive } from '../../daemon/daemonMode';
import { deliberateSleep } from '../../../test-utils/waitFor';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    activate() { /* stub: xterm keeps its DOM renderer */ }
    onContextLoss() { return { dispose: () => undefined }; }
    dispose() { /* stub */ }
  },
}));

const unsub = () => () => undefined;
/** The pane's daemon:connected listener, fired by hand. */
let daemonConnected: (() => void) | null = null;
const resize = vi.fn(async (_id: string, _cols: number, _rows: number) => undefined);
const reconnect = vi.fn(async () => ({ success: true }));
/** What document.fonts.check answers for the terminal's own font. */
const font = { loaded: false };

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
        reconnect,
        setViewerVisibility: vi.fn(),
        write: vi.fn(async () => undefined),
        list: vi.fn(async () => []),
      },
      daemon: { onConnected: (cb: () => void) => { daemonConnected = cb; return () => undefined; } },
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
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 600 });
  (document as unknown as { fonts: unknown }).fonts = {
    // Never settles: the gate must not rely on it.
    ready: new Promise(() => undefined),
    status: 'loading',
    check: () => font.loaded,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  resize.mockClear();
  reconnect.mockClear();
  font.loaded = false;
  setDaemonModeActive(true);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  setDaemonModeActive(false);
  vi.restoreAllMocks();
});

const settle = (ms = 80) => act(async () => { await deliberateSleep(ms, 'lets frames and the gate run under act; callers assert after it'); });

async function mount(ptyId: string) {
  const { useTerminal } = await import('../useTerminal');
  // What a fit would give now: the fallback font's grid first.
  const size = { cols: 122, rows: 40 };
  vi.spyOn(FitAddon.prototype, 'proposeDimensions').mockImplementation(() => ({ ...size }));
  const jobs: Array<() => void> = [];
  vi.spyOn(webglUpgradeQueue, 'enqueue').mockImplementation((run) => {
    jobs.push(run);
    return () => undefined;
  });
  function Harness() {
    const ref = useRef<HTMLDivElement>(null);
    useTerminal(ref, { ptyId, isVisible: true });
    return <div ref={ref} style={{ width: 800, height: 600 }} />;
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Harness />); });
  await settle();
  return { size, jobs };
}

const sentFor = (ptyId: string) => resize.mock.calls.filter(([id]) => id === ptyId).map(([, cols, rows]) => `${cols}x${rows}`);
/** The sizes the pane sent, each once. After the attach the pane sends its
 *  size again (#1255), which the daemon skips as unchanged: no second size. */
const sizesFor = (ptyId: string) => [...new Set(sentFor(ptyId))];

describe('useTerminal first PTY resize waits for the grid the pane keeps', { timeout: 60_000 }, () => {
  it('sends nothing before the font and WebGL are in, then only the size they give, before the reattach', async () => {
    const { size, jobs } = await mount('p-gate-settled');
    expect(sentFor('p-gate-settled')).toEqual([]);
    expect(reconnect).not.toHaveBeenCalled();

    // The webfont arrives: a DOM-cell grid, WebGL still to come.
    font.loaded = true;
    Object.assign(size, { cols: 115, rows: 44 });
    await settle();
    expect(sentFor('p-gate-settled')).toEqual([]);
    expect(reconnect).not.toHaveBeenCalled();

    // WebGL rounds the cell: the grid the pane keeps.
    Object.assign(size, { cols: 118, rows: 44 });
    expect(jobs.length).toBeGreaterThan(0);
    await act(async () => { jobs.at(-1)!(); });
    await settle();

    expect(sizesFor('p-gate-settled')).toEqual(['118x44']);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(resize.mock.invocationCallOrder[0]).toBeLessThan(reconnect.mock.invocationCallOrder[0]);
  });

  it('does not attach a second time when another attach ran while the gate was closed', async () => {
    const { size, jobs } = await mount('p-gate-raced');
    expect(reconnect).not.toHaveBeenCalled();
    // A daemon generation connects inside the window: that attach runs now.
    await act(async () => { daemonConnected?.(); });
    await settle();
    expect(reconnect).toHaveBeenCalledTimes(1);

    font.loaded = true;
    Object.assign(size, { cols: 118, rows: 44 });
    await act(async () => { jobs.at(-1)!(); });
    await settle();
    // The gate opened (the pane sent its size) and the deferred at-mount
    // attach stood down: the ring is not replayed twice.
    expect(sizesFor('p-gate-raced')).toContain('118x44');
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it('goes with the measured size once the bound passes when the font never loads', async () => {
    await mount('p-gate-bound');
    expect(sentFor('p-gate-bound')).toEqual([]);
    expect(reconnect).not.toHaveBeenCalled();

    await settle(FIRST_RESIZE_GATE_BOUND_MS + 50);
    expect(sizesFor('p-gate-bound')).toEqual(['122x40']);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(resize.mock.invocationCallOrder[0]).toBeLessThan(reconnect.mock.invocationCallOrder[0]);
  });
});
