// @vitest-environment jsdom
//
// A pane revealed without a WebGL context fits with the DOM renderer's cell,
// then takes its context later from webglUpgradeQueue. WebGL rounds the cell
// down to whole device pixels, so at a fractional cell width the DOM fit left
// the grid too few columns (a blank strip and a narrower PTY) until something
// refit. The upgrade job must refit after a successful acquire, through the
// same selection guard as the reveal, and must not refit when the acquire
// failed or the pane was hidden first.
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

const webgl = vi.hoisted(() => ({ created: 0, fail: false }));
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class {
    constructor() {
      if (webgl.fail) throw new Error('no WebGL');
      webgl.created += 1;
    }
    activate() { /* stub: xterm keeps its DOM renderer */ }
    onContextLoss() { return { dispose: () => undefined }; }
    dispose() { /* stub */ }
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
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  webgl.fail = false;
  vi.restoreAllMocks();
});

const settle = (ms = 50) => act(async () => { await deliberateSleep(ms, 'not yet converted (#2363): settle helper under act; callers assert after it'); });

async function setup(ptyId: string) {
  const { useTerminal } = await import('../useTerminal');
  // A measurable container, so fit() reaches FitAddon.fit.
  vi.spyOn(FitAddon.prototype, 'proposeDimensions').mockReturnValue({ cols: 100, rows: 30 });
  const fitSpy = vi.spyOn(FitAddon.prototype, 'fit').mockImplementation(() => undefined);
  const jobs: Array<() => void> = [];
  const cancel = vi.fn();
  vi.spyOn(webglUpgradeQueue, 'enqueue').mockImplementation((run) => {
    jobs.push(run);
    return cancel;
  });
  function Harness({ visible }: { visible: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    useTerminal(ref, { ptyId, isVisible: visible });
    return <div ref={ref} style={{ width: 800, height: 600 }} />;
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Harness visible />); });
  // The reveal's own fit (DOM renderer) runs here.
  await settle();
  return { Harness, fitSpy, jobs, cancel };
}

describe('useTerminal WebGL upgrade refit', { timeout: 60_000 }, () => {
  it('refits once after the queued upgrade builds the renderer', async () => {
    const { fitSpy, jobs } = await setup('p-upgrade-ok');
    expect(jobs.length).toBeGreaterThan(0);
    const created = webgl.created;
    fitSpy.mockClear();

    await act(async () => { jobs.at(-1)!(); });
    expect(webgl.created).toBe(created + 1);
    await settle();
    expect(fitSpy).toHaveBeenCalledTimes(1);
  });

  it('does not refit when building the renderer failed', async () => {
    const { fitSpy, jobs } = await setup('p-upgrade-fail');
    expect(jobs.length).toBeGreaterThan(0);
    webgl.fail = true;
    fitSpy.mockClear();

    await act(async () => { jobs.at(-1)!(); });
    await settle();
    expect(fitSpy).not.toHaveBeenCalled();
  });

  it('cancels the upgrade on hide, and a job that runs anyway fits nothing', async () => {
    const { Harness, fitSpy, jobs, cancel } = await setup('p-upgrade-hidden');
    expect(jobs.length).toBeGreaterThan(0);
    await act(async () => { root!.render(<Harness visible={false} />); });
    expect(cancel).toHaveBeenCalled();
    fitSpy.mockClear();

    await act(async () => { jobs.at(-1)!(); });
    await settle();
    expect(fitSpy).not.toHaveBeenCalled();
  });

  it('drops the scheduled refit when the pane hides before it runs', async () => {
    const { Harness, fitSpy, jobs } = await setup('p-upgrade-hide-race');
    expect(jobs.length).toBeGreaterThan(0);
    fitSpy.mockClear();

    await act(async () => {
      jobs.at(-1)!();
      root!.render(<Harness visible={false} />);
    });
    await settle();
    expect(fitSpy).not.toHaveBeenCalled();
  });
});

describe('useTerminal WebGL upgrade keeps the DOM frame off screen', { timeout: 60_000 }, () => {
  // At a fractional device pixel ratio the DOM cell is wider and taller than
  // the WebGL one, so showing the DOM frame first made the text visibly
  // tighten when the renderer swapped. The pane stays hidden until then.
  const xtermEl = () => host!.querySelector('.xterm') as HTMLElement;

  it('hides the pane until the upgraded renderer has refit', async () => {
    const { jobs } = await setup('p-upgrade-hidden-until-refit');
    expect(xtermEl().style.opacity).toBe('0');
    await act(async () => { jobs.at(-1)!(); });
    expect(xtermEl().style.opacity).toBe('0');
    await settle();
    expect(xtermEl().style.opacity).toBe('');
  });

  it('shows the pane when building the renderer failed', async () => {
    const { jobs } = await setup('p-upgrade-fail-shows');
    webgl.fail = true;
    await act(async () => { jobs.at(-1)!(); });
    expect(xtermEl().style.opacity).toBe('');
  });

  it('shows the pane after a bounded wait when the build never runs', async () => {
    await setup('p-upgrade-never-runs');
    expect(xtermEl().style.opacity).toBe('0');
    await act(async () => { await deliberateSleep(WEBGL_UPGRADE_HIDE_MAX_MS + 50, 'real timer: the bounded upgrade hide must expire'); });
    expect(xtermEl().style.opacity).toBe('');
  });

  it('shows the pane again when it hides before the upgrade ran', async () => {
    const { Harness } = await setup('p-upgrade-hide-shows');
    expect(xtermEl().style.opacity).toBe('0');
    await act(async () => { root!.render(<Harness visible={false} />); });
    expect(xtermEl().style.opacity).toBe('');
  });
});
