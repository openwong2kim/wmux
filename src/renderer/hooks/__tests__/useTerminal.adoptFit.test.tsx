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
import { webglUpgradeQueue } from '../../terminal/webglUpgradeQueue';
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
  function Harness() {
    const ref = useRef<HTMLDivElement>(null);
    useTerminal(ref, { ptyId, isVisible: true });
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
    await act(async () => { root!.render(<Harness key={key} />); });
    expect(log.mock.calls.some(([line]) => String(line).includes(`ptyId=${ptyId} mount=adopted`))).toBe(true);
  };
  return { size, restructure };
}

describe('useTerminal: an adopted terminal fits after the layout, not against the box before it', { timeout: 60_000 }, () => {
  it('sends nothing for the pre-layout box, then only the laid-out size, once', async () => {
    const { size, restructure } = await settledPane('p-adopt-close');
    // Before the Group lays out, the box reads a column short (a transient
    // scrollbar) and the old panel's rows.
    Object.assign(size, { cols: 56, rows: 8 });
    await restructure('second');
    await settle();
    expect(sentFor('p-adopt-close')).toEqual([]);

    // The Group lays out; the container's first callback carries the size it keeps.
    Object.assign(size, { cols: 57, rows: 20 });
    act(() => ManualResizeObserver.fire());
    await settle();
    expect(sentFor('p-adopt-close')).toEqual(['57x20']);
  });

  it('still fits and sends its first resize when the restructure leaves the size as it was', async () => {
    const { restructure } = await settledPane('p-adopt-same');
    await restructure('second');
    await settle();
    expect(sentFor('p-adopt-same')).toEqual([]);
    // A new container is observed afresh, so it gets its first callback even
    // though its size equals the old one's.
    act(() => ManualResizeObserver.fire());
    await settle();
    expect(sentFor('p-adopt-same')).toEqual(['57x8']);
  });

  it('adopted into a hidden container, it fits on the reveal, the first callback it gets', async () => {
    const { size, restructure } = await settledPane('p-adopt-hidden');
    shown.value = false;
    await restructure('second');
    await settle(200);
    expect(sentFor('p-adopt-hidden')).toEqual([]);

    shown.value = true;
    Object.assign(size, { cols: 90, rows: 30 });
    act(() => ManualResizeObserver.fire());
    await settle();
    expect(sentFor('p-adopt-hidden')).toEqual(['90x30']);
  });

  it('a real resize after the adoption still reaches the PTY', async () => {
    const { size, restructure } = await settledPane('p-adopt-then-resize');
    await restructure('second');
    act(() => ManualResizeObserver.fire());
    await settle();
    expect(sizesFor('p-adopt-then-resize')).toEqual(['57x8']);

    Object.assign(size, { cols: 80, rows: 8 });
    act(() => ManualResizeObserver.fire());
    // The scheduler's debounce, then a frame.
    await settle(250);
    expect(sizesFor('p-adopt-then-resize')).toEqual(['57x8', '80x8']);
  });
});
