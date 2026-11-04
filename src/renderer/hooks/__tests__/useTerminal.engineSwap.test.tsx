// @vitest-environment jsdom
//
// Labs wongtty switch: a pane whose engine changes (uiSlice.terminalEngine)
// rebuilds its terminal with the other engine while it stays mounted, and keeps
// the session's content: a daemon pane is repainted through pty.resync over the
// live pipe (never a reattach), a local one is carried over by serializing the
// old terminal. Mounts the REAL useTerminal against a real xterm under jsdom;
// "wongtty" is an xterm subclass here, so both engines run in jsdom.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { installCanvas2dStub } from '../../../test-utils/canvas2dStub';
import { act, useRef, type MutableRefObject } from 'react';
import { Terminal } from '@xterm/xterm';
import { createRoot, type Root } from 'react-dom/client';
import { FitAddon } from '@xterm/addon-fit';
import { setDaemonModeActive } from '../../daemon/daemonMode';
import { useStore } from '../../stores';
import { __resetColdFrames } from '../../terminal/coldFrame';
import { deliberateSleep } from '../../../test-utils/waitFor';
import { xtermKittyFlags } from '../../terminal/kittyKeyboard';
import { addAt } from '../../components/Terminal/scrollbackBookmarks';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class { constructor() { throw new Error('no WebGL in jsdom'); } },
}));

// snapshot: what FakeWongtty's ansiSnapshot does: refuse everything (the
// default), serialize, or refuse unless the modes are left out (scroll margins).
const fake = vi.hoisted(() => ({ openThrows: false, snapshot: 'refuse' as 'refuse' | 'ok' | 'margins' }));
vi.mock('../../terminal/wongtty/load', async () => {
  const xterm = await vi.importActual<typeof import('@xterm/xterm')>('@xterm/xterm');
  const { FitAddon: Fit } = await vi.importActual<typeof import('@xterm/addon-fit')>('@xterm/addon-fit');
  const { SearchAddon } = await vi.importActual<typeof import('@xterm/addon-search')>('@xterm/addon-search');
  const { WebLinksAddon } = await vi.importActual<typeof import('@xterm/addon-web-links')>('@xterm/addon-web-links');
  const { SerializeAddon } = await vi.importActual<typeof import('@xterm/addon-serialize')>('@xterm/addon-serialize');
  class FakeWongtty extends xterm.Terminal {
    open(parent: HTMLElement) {
      if (fake.openThrows) throw new Error('no WebGL2 context');
      super.open(parent);
    }
    ansiSnapshot(options: { scrollback: number; excludeModes: boolean }) {
      if (fake.snapshot === 'refuse' || (fake.snapshot === 'margins' && !options.excludeModes)) {
        return { ok: false as const, reason: fake.snapshot === 'margins' ? 'margins' : 'test' };
      }
      const addon = new SerializeAddon();
      this.loadAddon(addon);
      const text = addon.serialize({ scrollback: options.scrollback });
      addon.dispose();
      return { ok: true as const, payload: new TextEncoder().encode(text) };
    }
  }
  class ImageAddon { activate() { /* inert */ } dispose() { /* inert */ } }
  const mod = { Terminal: FakeWongtty, FitAddon: Fit, SearchAddon, WebLinksAddon, ImageAddon };
  return {
    preloadWongtty: async () => mod,
    loadedWongtty: () => mod,
    wongttyLoadFailure: () => null,
    isWongttyTerminal: (t: unknown) => t instanceof FakeWongtty,
    FakeWongtty,
  };
});

const unsub = () => () => undefined;
let emitData: ((ptyId: string, data: string, replay?: boolean) => void) | null = null;
let emitFlush: ((ptyId: string, recoveredBytes: number) => void) | null = null;
const resync = vi.fn(async () => ({ success: true, mode: 'snapshot' }));
const reconnect = vi.fn(async () => ({ success: true }));
const resize = vi.fn(async () => undefined);

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
        resize, reconnect, resync,
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
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 800 });
  (document as unknown as { fonts: unknown }).fonts ??= {
    ready: Promise.resolve(),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let termRef: MutableRefObject<Terminal | null> | null = null;
let containerEl: HTMLDivElement | null = null;
const disposeSpy = vi.spyOn(Terminal.prototype, 'dispose');

beforeEach(() => {
  __resetColdFrames();
  vi.spyOn(FitAddon.prototype, 'proposeDimensions').mockReturnValue({ cols: 40, rows: 6 });
  useStore.setState({ terminalEngine: 'xterm', terminalEngineFailure: null, terminalWongtty: false, terminalBookmarks: {} });
  fake.openThrows = false;
  fake.snapshot = 'refuse';
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  termRef = null;
  vi.mocked(FitAddon.prototype.proposeDimensions).mockRestore();
  resync.mockClear();
  reconnect.mockClear();
  disposeSpy.mockClear();
  setDaemonModeActive(false);
});

const settle = () => act(async () => { await deliberateSleep(60, 'lets xterm parse and the swap settle under act; nothing polled'); });

type UseTerminal = typeof import('../useTerminal').useTerminal;
function Harness({ useTerminal, ptyId, visible }: { useTerminal: UseTerminal; ptyId: string; visible: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  termRef = useTerminal(ref, { ptyId, isVisible: visible }).terminal;
  return <div ref={(el) => { ref.current = el; containerEl = el; }} style={{ width: '100%', height: '100%' }} />;
}

let mountKey = 0;
async function render(ptyId: string, visible = true, opts: { remount?: boolean; before?: () => void } = {}): Promise<void> {
  const { useTerminal } = await import('../useTerminal');
  if (!root) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  if (opts.remount) mountKey++;
  const r = root;
  await act(async () => {
    opts.before?.();
    r.render(<Harness key={mountKey} useTerminal={useTerminal} ptyId={ptyId} visible={visible} />);
  });
  await settle();
}

const setEngine = async (engine: 'xterm' | 'wongtty') => {
  await act(async () => { useStore.setState({ terminalEngine: engine }); });
  await settle();
};

function lines(t: Terminal): string[] {
  const b = t.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
  return out;
}
const count = (t: Terminal, text: string) => lines(t).filter((l) => l === text).length;
const history = (n: number) => Array.from({ length: n }, (_, i) => `L${i}`).join('\r\n');

async function fakeWongttyClass() {
  return ((await import('../../terminal/wongtty/load')) as unknown as { FakeWongtty: typeof Terminal }).FakeWongtty;
}

describe('useTerminal engine swap (Labs wongtty switch)', { timeout: 60_000 }, () => {
  it('rebuilds a visible daemon pane with the new engine: old one disposed once, resync once, no reattach', async () => {
    const FakeWongtty = await fakeWongttyClass();
    setDaemonModeActive(true);
    await render('p-swap');
    const old = termRef!.current!;
    expect(old).not.toBeInstanceOf(FakeWongtty);
    expect(containerEl!.dataset.terminalEngine).toBe('xterm');
    const reconnects = reconnect.mock.calls.length;

    await setEngine('wongtty');
    const now = termRef!.current!;
    expect(now).toBeInstanceOf(FakeWongtty);
    expect(now).not.toBe(old);
    expect(containerEl!.dataset.terminalEngine).toBe('wongtty');
    expect(disposeSpy.mock.contexts.filter((c) => c === old)).toHaveLength(1);
    expect(reconnect.mock.calls.length).toBe(reconnects);
    expect(resync).toHaveBeenCalledTimes(1);
    expect(resync.mock.calls[0]).toEqual(['p-swap', expect.anything()] as never);
    // Same container and font: the same grid on both engines, so no resize (R10).
    expect([now.cols, now.rows]).toEqual([old.cols, old.rows]);
  });

  it('carries the content: buffer, scroll offset, bookmarks, kitty flags and focus; no byte twice (R7, R8)', async () => {
    setDaemonModeActive(true);
    await render('p-carry');
    const old = termRef!.current!;
    await act(async () => {
      emitData!('p-carry', `${history(30)}\r\n\x1b[>5u`, false);
    });
    await settle();
    old.scrollToLine(old.buffer.active.baseY - 5);
    old.scrollToLine(old.buffer.active.viewportY); // the top row is "L<n>"
    expect(addAt(old, 'p-carry', useStore)).toBe('added');
    const markedRow = old.buffer.active.getLine(old.buffer.active.viewportY)!.translateToString(true);
    expect(xtermKittyFlags(old)).toBe(5);
    old.focus();

    await setEngine('wongtty');
    const now = termRef!.current!;
    expect(resync).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(now.textarea);
    // Held while the resync is in flight: live bytes from before the marker
    // (also inside the snapshot), the snapshot itself (RIS first, as the
    // daemon sends it), then a live byte after the marker.
    await act(async () => {
      emitData!('p-carry', 'A\r\n', false);
      emitData!('p-carry', `\x1bc${history(30)}\r\nA\r\n`, true);
      emitFlush!('p-carry', 200);
      emitData!('p-carry', 'B', false);
    });
    await settle();
    expect(count(now, 'A')).toBe(1);
    expect(count(now, 'L0')).toBe(1);
    expect(lines(now)).toContain('B');
    const b = now.buffer.active;
    expect(b.baseY - b.viewportY).toBe(5);
    expect(xtermKittyFlags(now)).toBe(5);
    const ids = useStore.getState().terminalBookmarks['p-carry'] ?? [];
    expect(ids).toHaveLength(1);
    // Back on the line it marked, whatever the new output moved.
    const marker = now.markers.find((m) => m.id === ids[0]);
    expect(marker && now.buffer.active.getLine(marker.line)?.translateToString(true)).toBe(markedRow);
  });

  it('a hidden pane is marked dirty, not resynced, until it is shown', async () => {
    const FakeWongtty = await fakeWongttyClass();
    setDaemonModeActive(true);
    await render('p-hidden', false);
    await setEngine('wongtty');
    expect(termRef!.current).toBeInstanceOf(FakeWongtty);
    expect(resync).not.toHaveBeenCalled();
    await render('p-hidden', true);
    expect(resync).toHaveBeenCalledTimes(1);
  });

  it('a local pane (no daemon) is carried by serializing the old terminal; bytes during the swap land once (R12)', async () => {
    const FakeWongtty = await fakeWongttyClass();
    setDaemonModeActive(false);
    await render('p-local');
    await act(async () => { emitData!('p-local', `${history(10)}\r\nBEFORE\r\n`, false); });
    await settle();
    await act(async () => {
      useStore.setState({ terminalEngine: 'wongtty' });
      // After the capture began, before the new terminal is mounted.
      emitData!('p-local', 'DURING\r\n', false);
    });
    await settle();
    const now = termRef!.current!;
    expect(now).toBeInstanceOf(FakeWongtty);
    await act(async () => { emitData!('p-local', 'AFTER\r\n', false); });
    await settle();
    expect(resync).not.toHaveBeenCalled();
    for (const text of ['L0', 'L9', 'BEFORE', 'DURING', 'AFTER']) expect(count(now, text)).toBe(1);
  });

  it('a local pane switched back to xterm.js keeps its content when wongtty refuses a full snapshot', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setDaemonModeActive(false);
    for (const mode of ['margins', 'refuse'] as const) {
      useStore.setState({ terminalEngine: 'wongtty' });
      fake.snapshot = mode;
      const ptyId = `p-local-off-${mode}`;
      await render(ptyId, true, { remount: true });
      await act(async () => { emitData!(ptyId, `${history(10)}\r\nBEFORE\r\n`, false); });
      await settle();
      await setEngine('xterm');
      await settle(); // the capture waits on a parse barrier before the swap
      const now = termRef!.current!;
      expect(now).not.toBeInstanceOf(await fakeWongttyClass());
      for (const text of ['L0', 'L9', 'BEFORE']) expect(count(now, text)).toBe(1);
    }
    vi.mocked(console.warn).mockRestore();
  });

  it('a local pane flipped off and on again while its capture waits loses no byte', async () => {
    setDaemonModeActive(false);
    await render('p-local-flip');
    await act(async () => { emitData!('p-local-flip', `${history(10)}\r\nBEFORE\r\n`, false); });
    await settle();
    await act(async () => { useStore.setState({ terminalEngine: 'wongtty' }); });
    await act(async () => {
      emitData!('p-local-flip', 'D1\r\n', false);
      useStore.setState({ terminalEngine: 'xterm' });
    });
    await act(async () => {
      useStore.setState({ terminalEngine: 'wongtty' });
      emitData!('p-local-flip', 'D2\r\n', false);
    });
    await settle();
    await settle();
    const now = termRef!.current!;
    expect(now).toBeInstanceOf(await fakeWongttyClass());
    await act(async () => { emitData!('p-local-flip', 'AFTER\r\n', false); });
    await settle();
    for (const text of ['L0', 'BEFORE', 'D1', 'D2', 'AFTER']) expect(count(now, text)).toBe(1);
  });

  it('a daemon pane whose swap repaint fails keeps the old terminal\'s content and stays dirty', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setDaemonModeActive(true);
    await render('p-gone');
    await act(async () => { emitData!('p-gone', `${history(30)}\r\nLAST\r\n`, false); });
    await settle();
    resync.mockResolvedValueOnce({ success: false, code: 'session-gone', transient: false } as never);
    await setEngine('wongtty');
    const now = termRef!.current!;
    for (const text of ['L0', 'L29', 'LAST']) expect(count(now, text)).toBe(1);
    const { isTerminalDirty } = await import('../../terminal/terminalOutputScheduler');
    expect(isTerminalDirty(now)).toBe(true);
    vi.mocked(console.warn).mockRestore();
  });

  it('a hidden pane switched on and off again before it is shown keeps its bookmarks and scroll offset', async () => {
    setDaemonModeActive(true);
    await render('p-twice');
    const old = termRef!.current!;
    await act(async () => { emitData!('p-twice', history(30), false); });
    await settle();
    old.scrollToLine(old.buffer.active.baseY - 5);
    expect(addAt(old, 'p-twice', useStore)).toBe('added');
    const markedRow = old.buffer.active.getLine(old.buffer.active.viewportY)!.translateToString(true);
    await render('p-twice', false);
    await setEngine('wongtty');
    await setEngine('xterm');
    expect(resync).not.toHaveBeenCalled();
    await render('p-twice', true);
    expect(resync).toHaveBeenCalledTimes(1);
    const now = termRef!.current!;
    await act(async () => {
      emitData!('p-twice', `\x1bc${history(30)}`, true);
      emitFlush!('p-twice', 200);
    });
    await settle();
    expect(now.buffer.active.baseY - now.buffer.active.viewportY).toBe(5);
    const ids = useStore.getState().terminalBookmarks['p-twice'] ?? [];
    expect(ids).toHaveLength(1);
    const marker = now.markers.find((m) => m.id === ids[0]);
    expect(marker && now.buffer.active.getLine(marker.line)?.translateToString(true)).toBe(markedRow);
  });

  it('a raw replay that pushes the program\'s kitty flags leaves them pushed once', async () => {
    setDaemonModeActive(true);
    await render('p-raw');
    const old = termRef!.current!;
    await act(async () => { emitData!('p-raw', 'x\x1b[>5u', false); });
    await settle();
    expect(xtermKittyFlags(old)).toBe(5);
    resync.mockResolvedValueOnce({ success: true, mode: 'raw' } as never);
    await setEngine('wongtty');
    const now = termRef!.current!;
    await act(async () => {
      emitData!('p-raw', '\x1bcx\x1b[>5u', true);
      emitFlush!('p-raw', 20);
    });
    await settle();
    expect(xtermKittyFlags(now)).toBe(5);
    // The program's one pop on exit leaves no flags behind.
    await act(async () => { emitData!('p-raw', '\x1b[<u', false); });
    await settle();
    expect(xtermKittyFlags(now)).toBe(0);
  });

  it('a parked terminal of the other engine is disposed, not adopted (R6)', async () => {
    const FakeWongtty = await fakeWongttyClass();
    setDaemonModeActive(true);
    await render('p-park');
    const old = termRef!.current!;
    // A restructure (the pane remounts in one commit) in the same commit as the flip.
    await render('p-park', true, { remount: true, before: () => useStore.setState({ terminalEngine: 'wongtty' }) });
    const now = termRef!.current!;
    expect(now).toBeInstanceOf(FakeWongtty);
    expect(disposeSpy.mock.contexts.filter((c) => c === old)).toHaveLength(1);
  });

  it('a wongtty pane that cannot open sends every pane back to xterm.js, reported once (R13)', async () => {
    const FakeWongtty = await fakeWongttyClass();
    const pushToast = vi.spyOn(useStore.getState(), 'pushToast');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setDaemonModeActive(true);
    await render('p-broken');
    fake.openThrows = true;
    await setEngine('wongtty');
    await settle();
    expect(useStore.getState().terminalEngine).toBe('xterm');
    expect(useStore.getState().terminalEngineFailure).toEqual({ message: 'no WebGL2 context' });
    expect(termRef!.current).not.toBeNull();
    expect(termRef!.current).not.toBeInstanceOf(FakeWongtty);
    expect(containerEl!.dataset.terminalEngine).toBe('xterm');
    expect(pushToast).toHaveBeenCalledTimes(1);
    vi.mocked(console.warn).mockRestore();
  });
});
