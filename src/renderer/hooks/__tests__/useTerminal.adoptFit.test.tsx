// @vitest-environment jsdom
//
// A split or a close restructures the pane tree, and the surviving pane's
// terminal is adopted into a new container (#1002) inside a Panel the layout
// Group has not sized yet. A fit at mount read that pre-layout box (a column
// short behind a transient scrollbar, rows of the old panel) and sent it to the
// PTY, and the real size followed a moment later: two SIGWINCH, and a width
// change where only rows should change. The adoption now fits on its
// container's first ResizeObserver callback, which comes after the layout.
// Mounts the REAL useTerminal against a real xterm under jsdom.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { installCanvas2dStub } from '../../../test-utils/canvas2dStub';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FitAddon } from '@xterm/addon-fit';
import { webglUpgradeQueue, WEBGL_UPGRADE_HIDE_MAX_MS } from '../../terminal/webglUpgradeQueue';
import type { Terminal } from '@xterm/xterm';
import { webglContextPool } from '../../terminal/webglContextPool';
import { holdFits, releaseFits } from '../../utils/layoutTransitionGate';
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
const resize = vi.fn(async (_id: string, _cols: number, _rows: number) => undefined);
const font = { loaded: false };
/** Whether a container has a size (a hidden workspace's has none). */
const shown = { value: true };

/** A ResizeObserver the test fires by hand, as the browser would after layout. */
class ManualResizeObserver {
  static live = new Set<ManualResizeObserver>();
  readonly targets = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    ManualResizeObserver.live.add(this);
  }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); ManualResizeObserver.live.delete(this); }
  static fire() {
    for (const observer of [...ManualResizeObserver.live]) {
      const entries = [...observer.targets].map((target) => ({ target }) as unknown as ResizeObserverEntry);
      if (entries.length) observer.callback(entries, observer as unknown as ResizeObserver);
    }
  }
}

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
        reconnect: vi.fn(async () => ({ success: true })),
        setViewerVisibility: vi.fn(),
        write: vi.fn(async () => undefined),
        list: vi.fn(async () => []),
      },
      daemon: { onConnected: () => () => undefined },
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
  globalThis.ResizeObserver = ManualResizeObserver as unknown as typeof ResizeObserver;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => (shown.value ? 800 : 0) });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => (shown.value ? 600 : 0) });
  (document as unknown as { fonts: unknown }).fonts = {
    ready: new Promise(() => undefined),
    status: 'loaded',
    check: () => font.loaded,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

beforeEach(() => {
  resize.mockClear();
  font.loaded = false;
  shown.value = true;
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

const settle = (ms = 80) => act(async () => { await deliberateSleep(ms, 'lets frames and timers run under act; callers assert after it'); });
const sentFor = (ptyId: string) => resize.mock.calls.filter(([id]) => id === ptyId).map(([, cols, rows]) => `${cols}x${rows}`);
/** The sizes sent, each once: a repeat of the current size is a no-op the daemon skips. */
const sizesFor = (ptyId: string) => [...new Set(sentFor(ptyId))];

/** A settled pane (its first resize sent), and a restructure that remounts it. */
async function settledPane(ptyId: string) {
  const { useTerminal } = await import('../useTerminal');
  // What a fit reads now.
  const size = { cols: 57, rows: 8 };
  vi.spyOn(FitAddon.prototype, 'proposeDimensions').mockImplementation(() => ({ ...size }));
  const jobs: Array<() => void> = [];
  vi.spyOn(webglUpgradeQueue, 'enqueue').mockImplementation((run) => {
    jobs.push(run);
    return () => undefined;
  });
  const log = vi.spyOn(console, 'log');
  let live: Terminal | null = null;
  function Harness() {
    const ref = useRef<HTMLDivElement>(null);
    const { terminal } = useTerminal(ref, { ptyId, isVisible: true });
    live = terminal.current;
    return <div ref={ref} style={{ width: 800, height: 600 }} />;
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Harness key="first" />); });
  await settle();
  // The first-resize gate opens: the pane's own size goes out once.
  font.loaded = true;
  await act(async () => { jobs.at(-1)?.(); });
  await settle();
  expect(sentFor(ptyId)).toContain('57x8');
  resize.mockClear();
  const restructure = async (key: string) => {
    jobs.length = 0;
    await act(async () => { root!.render(<Harness key={key} />); });
    expect(log.mock.calls.some(([line]) => String(line).includes(`ptyId=${ptyId} mount=adopted`))).toBe(true);
  };
  /** The park dropped WebGL; the reveal queued its rebuild. Run it, and its refit frame. */
  const upgrade = async () => {
    expect(jobs.length).toBeGreaterThan(0);
    await act(async () => { jobs.at(-1)!(); });
    await settle(40);
  };
  /** The xterm instance the last render saw. */
  const term = () => {
    if (!live) throw new Error('no terminal');
    return live;
  };
  return { size, restructure, upgrade, term };
}

/** The bound's log line, for this pane. */
const boundLines = (warn: { mock: { calls: unknown[][] } }, ptyId: string) =>
  warn.mock.calls.filter(([line]) => String(line).includes(`ptyId=${ptyId} first fit: renderer not settled`));

describe('useTerminal: an adopted terminal fits after the layout, not against the box before it', { timeout: 60_000 }, () => {
  it('sends nothing for the pre-layout box, then only the laid-out size, once', async () => {
    const { size, restructure, upgrade } = await settledPane('p-adopt-close');
    // Before the Group lays out, the box reads a column short (a transient
    // scrollbar) and the old panel's rows.
    Object.assign(size, { cols: 56, rows: 8 });
    await restructure('second');
    await settle();
    expect(sentFor('p-adopt-close')).toEqual([]);

    // The Group lays out; the container's first callback carries the size it keeps.
    Object.assign(size, { cols: 57, rows: 20 });
    act(() => ManualResizeObserver.fire());
    await upgrade();
    expect(sentFor('p-adopt-close')).toEqual(['57x20']);
  });

  it('still fits and sends its first resize when the restructure leaves the size as it was', async () => {
    const { restructure, upgrade } = await settledPane('p-adopt-same');
    await restructure('second');
    await settle();
    expect(sentFor('p-adopt-same')).toEqual([]);
    // A new container is observed afresh, so it gets its first callback even
    // though its size equals the old one's.
    act(() => ManualResizeObserver.fire());
    await upgrade();
    expect(sentFor('p-adopt-same')).toEqual(['57x8']);
  });

  it('adopted into a hidden container, it fits on the reveal, the first callback it gets', async () => {
    const { size, restructure, upgrade } = await settledPane('p-adopt-hidden');
    shown.value = false;
    await restructure('second');
    await settle(200);
    expect(sentFor('p-adopt-hidden')).toEqual([]);

    shown.value = true;
    Object.assign(size, { cols: 90, rows: 30 });
    act(() => ManualResizeObserver.fire());
    await upgrade();
    expect(sentFor('p-adopt-hidden')).toEqual(['90x30']);
  });

  it('waits for the WebGL renderer the park dropped: no fit with the DOM renderer cell', async () => {
    // The layout first: the DOM renderer's cell is wider, so a fit now would
    // come out a column short. Nothing goes until WebGL is back.
    const { size, restructure, upgrade } = await settledPane('p-adopt-webgl-late');
    await restructure('second');
    Object.assign(size, { cols: 56, rows: 20 });
    act(() => ManualResizeObserver.fire());
    await settle();
    expect(sentFor('p-adopt-webgl-late')).toEqual([]);
    Object.assign(size, { cols: 57, rows: 20 });
    const warn = vi.spyOn(console, 'warn');
    await upgrade();
    expect(sentFor('p-adopt-webgl-late')).toEqual(['57x20']);
    // The renderer settled in time: the bound is cleared and never fires.
    await settle(WEBGL_UPGRADE_HIDE_MAX_MS + 100);
    expect(sentFor('p-adopt-webgl-late')).toEqual(['57x20']);
    expect(boundLines(warn, 'p-adopt-webgl-late')).toEqual([]);
  });

  it('a renderer that never settles holds the first fit only up to the bound', async () => {
    const { size, restructure, upgrade } = await settledPane('p-adopt-bound');
    const warn = vi.spyOn(console, 'warn');
    await restructure('second');
    // The layout is in; the upgrade job never runs.
    Object.assign(size, { cols: 56, rows: 20 });
    act(() => ManualResizeObserver.fire());
    await settle(WEBGL_UPGRADE_HIDE_MAX_MS / 2);
    expect(sentFor('p-adopt-bound')).toEqual([]);
    // Past the bound: the pane fits with the cell it has, and says so once.
    await settle(WEBGL_UPGRADE_HIDE_MAX_MS / 2 + 150);
    expect(sentFor('p-adopt-bound')).toEqual(['56x20']);
    expect(boundLines(warn, 'p-adopt-bound')).toHaveLength(1);
    // Later resizes are ordinary ones.
    Object.assign(size, { cols: 80, rows: 20 });
    act(() => ManualResizeObserver.fire());
    await settle(250);
    expect(sizesFor('p-adopt-bound')).toEqual(['56x20', '80x20']);
    // An upgrade that does come late refits to its own cell.
    Object.assign(size, { cols: 82, rows: 20 });
    await upgrade();
    expect(sizesFor('p-adopt-bound')).toEqual(['56x20', '80x20', '82x20']);
    expect(boundLines(warn, 'p-adopt-bound')).toHaveLength(1);
  });

  it('a teardown before the bound clears it', async () => {
    const { restructure } = await settledPane('p-adopt-bound-teardown');
    const warn = vi.spyOn(console, 'warn');
    await restructure('second');
    act(() => ManualResizeObserver.fire());
    // Gone before the bound: the pane unmounts for good.
    act(() => root?.unmount());
    root = null;
    await settle(WEBGL_UPGRADE_HIDE_MAX_MS + 150);
    expect(boundLines(warn, 'p-adopt-bound-teardown')).toEqual([]);
    expect(sentFor('p-adopt-bound-teardown')).toEqual([]);
  });

  it('a WebGL upgrade that lands before the layout leaves the fit to the layout', async () => {
    const { size, restructure, upgrade } = await settledPane('p-adopt-webgl-early');
    await restructure('second');
    Object.assign(size, { cols: 56, rows: 8 });
    await upgrade();
    expect(sentFor('p-adopt-webgl-early')).toEqual([]);
    Object.assign(size, { cols: 57, rows: 20 });
    act(() => ManualResizeObserver.fire());
    await settle(20);
    expect(sentFor('p-adopt-webgl-early')).toEqual(['57x20']);
  });

  it('an upgrade that settled without a renderer is not waited for again when a slot frees later', async () => {
    const { size, restructure, upgrade } = await settledPane('p-adopt-webgl-skipped');
    await restructure('second');
    // No room for a context when the job runs: it settles without one.
    const evict = vi.spyOn(webglContextPool, 'acquireWouldEvict').mockReturnValue(true);
    await upgrade();
    // A slot frees afterwards (another pane closed in the same restructure).
    evict.mockReturnValue(false);
    Object.assign(size, { cols: 57, rows: 20 });
    act(() => ManualResizeObserver.fire());
    await settle(20);
    expect(sentFor('p-adopt-webgl-skipped')).toEqual(['57x20']);
  });

  it('a pool full at the reveal queues no upgrade: a slot freed before the layout does not hold the first fit', async () => {
    const { size, restructure } = await settledPane('p-adopt-pool-full');
    const evict = vi.spyOn(webglContextPool, 'acquireWouldEvict').mockReturnValue(true);
    await restructure('second');
    evict.mockReturnValue(false);
    Object.assign(size, { cols: 57, rows: 20 });
    act(() => ManualResizeObserver.fire());
    await settle(20);
    expect(sizesFor('p-adopt-pool-full')).toEqual(['57x20']);
  });

  it('during an animated layout change the first fit waits for the release, and still for the renderer', async () => {
    const { size, restructure, upgrade } = await settledPane('p-adopt-held');
    await restructure('second');
    holdFits(5_000);
    try {
      Object.assign(size, { cols: 57, rows: 20 });
      act(() => ManualResizeObserver.fire());
      await upgrade();
      // Mid-animation: nothing yet, whatever has arrived.
      expect(sentFor('p-adopt-held')).toEqual([]);
    } finally {
      act(() => releaseFits());
    }
    await settle();
    expect(sentFor('p-adopt-held')).toEqual(['57x20']);
  });

  it('a callback under the floor is not the laid-out size: the next one fits, at once', async () => {
    const { size, restructure, upgrade } = await settledPane('p-adopt-floor');
    await restructure('second');
    await upgrade();
    // The box is still collapsed when the first callback comes: under #1255's floor.
    Object.assign(size, { cols: 57, rows: 1 });
    act(() => ManualResizeObserver.fire());
    await settle(20);
    expect(sentFor('p-adopt-floor')).toEqual([]);
    // Laid out: the next callback fits without the scheduler's debounce.
    Object.assign(size, { cols: 57, rows: 20 });
    act(() => ManualResizeObserver.fire());
    await settle(20);
    expect(sentFor('p-adopt-floor')).toEqual(['57x20']);
  });

  it('a live selection does not hold the adopted pane at its old grid', async () => {
    const { size, restructure, upgrade } = await settledPane('p-adopt-selected');
    const { Terminal } = await import('@xterm/xterm');
    vi.spyOn(Terminal.prototype, 'hasSelection').mockReturnValue(true);
    await restructure('second');
    Object.assign(size, { cols: 57, rows: 20 });
    act(() => ManualResizeObserver.fire());
    await upgrade();
    expect(sentFor('p-adopt-selected')).toEqual(['57x20']);
  });

  it('a second restructure before the first fit keeps the scroll position', async () => {
    const { size, restructure, upgrade, term } = await settledPane('p-adopt-twice');
    await act(async () => { await new Promise<void>((done) => term().write('line\r\n'.repeat(100), done)); });
    act(() => term().scrollLines(-10));
    const fromBottom = () => term().buffer.active.baseY - term().buffer.active.viewportY;
    expect(fromBottom()).toBe(10);
    // A split, then a second one before the first adoption has fitted.
    await restructure('second');
    await restructure('third');
    await settle();
    expect(sentFor('p-adopt-twice')).toEqual([]);
    Object.assign(size, { cols: 57, rows: 20 });
    act(() => ManualResizeObserver.fire());
    await upgrade();
    expect(sentFor('p-adopt-twice')).toEqual(['57x20']);
    expect(term().rows).toBe(20);
    expect(fromBottom()).toBe(10);
  });

  it('a real resize after the adoption still reaches the PTY', async () => {
    const { size, restructure, upgrade } = await settledPane('p-adopt-then-resize');
    await restructure('second');
    act(() => ManualResizeObserver.fire());
    await upgrade();
    expect(sizesFor('p-adopt-then-resize')).toEqual(['57x8']);

    Object.assign(size, { cols: 80, rows: 8 });
    act(() => ManualResizeObserver.fire());
    // The scheduler's debounce, then a frame.
    await settle(250);
    expect(sizesFor('p-adopt-then-resize')).toEqual(['57x8', '80x8']);
  });
});
