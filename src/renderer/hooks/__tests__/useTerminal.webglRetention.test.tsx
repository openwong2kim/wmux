// @vitest-environment jsdom
//
// A hidden terminal keeps its WebGL context. Rebuilding the renderer on reveal
// (context + synchronous shader compile, ~225 ms per terminal measured) runs
// inside the workspace switch's input task, so a pane hidden longer than the
// old 5 s release timer painted only after it. Hiding must not dispose the
// addon, and revealing must not build a second one.
// Mounts the REAL useTerminal against a real xterm under jsdom, with a stub
// WebGL addon that counts constructions and disposals.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { installCanvas2dStub } from '../../../test-utils/canvas2dStub';
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const webgl = vi.hoisted(() => ({ created: 0, disposed: 0 }));
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    constructor() { webgl.created += 1; }
    activate() { /* stub: xterm keeps its DOM renderer */ }
    onContextLoss() { return { dispose: () => undefined }; }
    dispose() { webgl.disposed += 1; }
  },
}));

const unsub = () => () => undefined;

beforeAll(() => {
  installCanvas2dStub();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      platform: 'linux',
      windowsBuildNumber: null,
      pty: {
        onData: unsub, onExit: unsub, onFlushComplete: unsub, onRestarted: unsub,
        resize: vi.fn(async () => undefined),
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
  globalThis.ResizeObserver ??= class { observe() { /* inert */ } unobserve() { /* inert */ } disconnect() { /* inert */ } } as unknown as typeof ResizeObserver;
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
  vi.useRealTimers();
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

// The first case pays for importing the whole hook under jsdom.
describe('useTerminal WebGL retention', { timeout: 60_000 }, () => {
  it('keeps the WebGL addon across a long hide and reuses it on reveal', async () => {
    const { useTerminal } = await import('../useTerminal');
    function Harness({ visible }: { visible: boolean }) {
      const ref = useRef<HTMLDivElement>(null);
      useTerminal(ref, { ptyId: 'p-webgl', isVisible: visible });
      return <div ref={ref} style={{ width: 800, height: 600 }} />;
    }
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<Harness visible />); });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    // Mount builds the addon, then fonts.ready rebuilds it once for the atlas.
    // Count from that settled state.
    const created = webgl.created;
    const disposed = webgl.disposed;
    expect(created).toBeGreaterThan(0);

    // Hidden far longer than any grace period a release timer could use.
    vi.useFakeTimers();
    await act(async () => { root!.render(<Harness visible={false} />); });
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(webgl.disposed).toBe(disposed);
    vi.useRealTimers();

    await act(async () => { root!.render(<Harness visible />); });
    expect(webgl.created).toBe(created);
    expect(webgl.disposed).toBe(disposed);

    // Unmount still gives the context back.
    act(() => root!.unmount());
    root = null;
    expect(webgl.disposed).toBe(disposed + 1);
  });
});

// With more terminals than the budget, a pane shown without a context used to
// take one at once: evict another terminal and rebuild a renderer before it
// could paint, on every step of cycling workspaces by shortcut. Taking it a
// moment later instead swapped renderers on screen, and DOM and WebGL lay
// glyphs out up to a pixel apart. A shown pane now keeps the renderer it has;
// it takes a context on a later reveal once one is free.
describe('useTerminal WebGL grant when the pool is full', { timeout: 60_000 }, () => {
  const fillers: string[] = [];

  afterEach(async () => {
    const { webglContextPool } = await import('../../terminal/webglContextPool');
    for (const token of fillers.splice(0)) webglContextPool.release(token);
  });

  async function setup() {
    const { useTerminal } = await import('../useTerminal');
    const { webglContextPool, MAX_WEBGL_CONTEXTS } = await import('../../terminal/webglContextPool');
    for (let i = 0; i < MAX_WEBGL_CONTEXTS; i++) {
      const token = `filler-${i}`;
      fillers.push(token);
      webglContextPool.acquire(token, () => undefined, () => undefined);
    }
    function Harness({ visible }: { visible: boolean }) {
      const ref = useRef<HTMLDivElement>(null);
      useTerminal(ref, { ptyId: 'p-full-pool', isVisible: visible });
      return <div ref={ref} style={{ width: 800, height: 600 }} />;
    }
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    return { Harness, webglContextPool };
  }

  it('a pane shown while the pool is full keeps the DOM renderer and takes nothing', async () => {
    const { Harness, webglContextPool } = await setup();
    const before = webgl.created;
    await act(async () => { root!.render(<Harness visible />); });
    // Longer than any delay a deferred grant could use.
    await act(async () => { await new Promise((r) => setTimeout(r, 1_000)); });
    expect(webgl.created).toBe(before);
    expect(fillers.every((t) => webglContextPool.grantedTokens().includes(t))).toBe(true);
  });

  it('takes a freed slot on its next reveal, not while it is shown', async () => {
    const { Harness, webglContextPool } = await setup();
    const before = webgl.created;
    await act(async () => { root!.render(<Harness visible />); });
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });

    // A slot frees while the pane is on screen: no swap under the reader.
    webglContextPool.release(fillers.shift()!);
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
    expect(webgl.created).toBe(before);

    await act(async () => { root!.render(<Harness visible={false} />); });
    await act(async () => { root!.render(<Harness visible />); });
    expect(webgl.created).toBe(before + 1);
  });
});
