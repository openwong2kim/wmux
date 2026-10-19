// @vitest-environment jsdom
//
// At startup every workspace mounts, the inactive ones hidden (display:none),
// so a hidden mount has no fit and cannot paint a cold frame. It must leave
// the frame in the cache, and the pane's first reveal (a workspace switch,
// which does not remount) paints it. Before, every hidden mount took its frame
// and dropped it, and the pane sat blank on first reveal after a restart.
// Also: cold frames reach localStorage only while "Restore on launch" is on.
// Mounts the REAL useTerminal against a real xterm under jsdom.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { installCanvas2dStub } from '../../../test-utils/canvas2dStub';
import { act, useRef, type MutableRefObject } from 'react';
import type { Terminal } from '@xterm/xterm';
import { createRoot, type Root } from 'react-dom/client';
import { FitAddon } from '@xterm/addon-fit';
import { setDaemonModeActive } from '../../daemon/daemonMode';
import { useStore } from '../../stores';
import { __coldFrameKeys, __resetColdFrames, COLD_FRAME_STORAGE_KEY, rememberColdFrame } from '../../terminal/coldFrame';
import { deliberateSleep } from '../../../test-utils/waitFor';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// No WebGL under jsdom: the hook's own fallback (DOM renderer) takes over.
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class { constructor() { throw new Error('no WebGL in jsdom'); } },
}));

const unsub = () => () => undefined;
let emitData: ((ptyId: string, data: string, replay?: boolean) => void) | null = null;
let emitFlush: ((ptyId: string, recoveredBytes: number) => void) | null = null;
const resync = vi.fn(async () => ({ success: true, mode: 'snapshot' }));
// Laid-out size of every element; 0 models a display:none workspace.
let layoutSize = 0;

beforeAll(() => {
  installCanvas2dStub();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      platform: 'linux',
      windowsBuildNumber: null,
      pty: {
        onData: (cb: typeof emitData) => { emitData = cb; return () => undefined; },
        onFlushComplete: (cb: typeof emitFlush) => { emitFlush = cb; return () => undefined; },
        onExit: unsub, onRestarted: unsub,
        resize: vi.fn(async () => undefined),
        reconnect: vi.fn(async () => ({ success: true })),
        resync,
        setViewerVisibility: vi.fn(),
        write: vi.fn(async () => undefined),
        list: vi.fn(async () => []),
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
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => layoutSize });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => layoutSize });
  (document as unknown as { fonts: unknown }).fonts ??= {
    ready: Promise.resolve(),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
});

let root: Root | null = null;
let termRef: MutableRefObject<Terminal | null> | null = null;
let host: HTMLDivElement | null = null;
let propose: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  __resetColdFrames();
  // The width a revealed pane fits to; a hidden one never gets that far.
  propose = vi.spyOn(FitAddon.prototype, 'proposeDimensions').mockReturnValue({ cols: 40, rows: 6 });
  setDaemonModeActive(true);
  useStore.getState().setScrollbackRestoreEnabled(true);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  termRef = null;
  propose?.mockRestore();
  resync.mockClear();
  setDaemonModeActive(false);
  localStorage.clear();
});

const settle = () => act(async () => { await deliberateSleep(50, 'not yet converted (#2363): lets the reveal settle under act; nothing polled'); });

async function mount(ptyId: string, visible: boolean): Promise<(visible: boolean) => Promise<void>> {
  const { useTerminal } = await import('../useTerminal');
  function Harness({ visible: v }: { visible: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    termRef = useTerminal(ref, { ptyId, isVisible: v }).terminal;
    return <div ref={ref} style={{ width: '100%', height: '100%' }} />;
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(<Harness visible={visible} />); });
  await settle();
  return async (v: boolean) => {
    if (v) layoutSize = 800;
    await act(async () => { root!.render(<Harness visible={v} />); });
    await settle();
  };
}

function row(n: number): string {
  return termRef?.current?.buffer.active.getLine(n)?.translateToString(true) ?? '';
}

const cold = { frame: 'cold screen', cols: 40, rows: 6 };

// The first case pays for importing the whole hook under jsdom.
describe('useTerminal cold frame of a pane mounted hidden', { timeout: 60_000 }, () => {
  it('a hidden mount leaves the frame cached; its first reveal paints it', async () => {
    rememberColdFrame('p-hidden', cold);
    layoutSize = 0;
    const setVisible = await mount('p-hidden', false);
    expect(__coldFrameKeys()).toContain('p-hidden');
    expect(row(0)).toBe('');

    await setVisible(true);
    expect(__coldFrameKeys()).not.toContain('p-hidden');
    expect(row(0)).toBe('cold screen');
  });

  it('a boot replay discarded while hidden: the frame shows until the reveal resync lands', async () => {
    rememberColdFrame('p-dirty', cold);
    layoutSize = 0;
    const setVisible = await mount('p-dirty', false);
    // Retained while hidden, then discarded at the flush marker (dirty).
    act(() => {
      emitData!('p-dirty', 'replayed screen', true);
      emitFlush!('p-dirty', 15);
    });
    await settle();
    expect(row(0)).toBe('');
    expect(__coldFrameKeys()).toContain('p-dirty');

    await setVisible(true);
    expect(resync).toHaveBeenCalledWith('p-dirty', expect.anything());
    expect(row(0)).toBe('cold screen');

    // The resync replay (RIS-prefixed, as SessionPipe sends it) replaces it.
    act(() => {
      emitData!('p-dirty', '\x1bcreal screen', true);
      emitFlush!('p-dirty', 13);
    });
    await settle();
    expect(row(0)).toBe('real screen');
  });

  it('a hidden pane whose attach settled with nothing replayed is not painted', async () => {
    rememberColdFrame('p-empty', cold);
    layoutSize = 0;
    const setVisible = await mount('p-empty', false);
    act(() => { emitFlush!('p-empty', 0); });
    await settle();

    await setVisible(true);
    expect(row(0)).toBe('');
    expect(__coldFrameKeys()).not.toContain('p-empty');
  });
});

describe('cold frames on disk follow "Restore on launch"', { timeout: 60_000 }, () => {
  it('on: the save writes the frames', async () => {
    const { persistColdFramesNow } = await import('../useTerminal');
    rememberColdFrame('p', cold);
    persistColdFramesNow();
    expect(localStorage.getItem(COLD_FRAME_STORAGE_KEY)).toContain('cold screen');
  });

  it('off: the save writes nothing and clears what is stored', async () => {
    const { persistColdFramesNow } = await import('../useTerminal');
    localStorage.setItem(COLD_FRAME_STORAGE_KEY, 'stored earlier');
    useStore.getState().setScrollbackRestoreEnabled(false);
    rememberColdFrame('p', cold);
    persistColdFramesNow();
    expect(localStorage.getItem(COLD_FRAME_STORAGE_KEY)).toBeNull();
    // The in-memory cache is untouched.
    expect(__coldFrameKeys()).toEqual(['p']);
  });

  it('turning it off at runtime clears the stored frames at once', async () => {
    const { watchColdFramePersistence } = await import('../useTerminal');
    const stop = watchColdFramePersistence();
    try {
      localStorage.setItem(COLD_FRAME_STORAGE_KEY, 'stored earlier');
      useStore.getState().setScrollbackRestoreEnabled(true);
      expect(localStorage.getItem(COLD_FRAME_STORAGE_KEY)).toBe('stored earlier');
      useStore.getState().setScrollbackRestoreEnabled(false);
      expect(localStorage.getItem(COLD_FRAME_STORAGE_KEY)).toBeNull();
    } finally {
      stop();
    }
  });
});
