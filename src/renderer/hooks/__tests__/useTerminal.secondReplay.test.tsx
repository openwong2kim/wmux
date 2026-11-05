// @vitest-environment jsdom
//
// Two reattaches of one pane can race (a split remounts it while the first
// mount's reconnect is in flight). The loser retries, and its full attach
// lands after the winner's pipe already delivered the session's live output:
// the daemon then flushes the whole ring again. Appended to the screen, that
// replay repeated everything already shown (Labs smoke, 2026-11-04: a pane's
// 1200-row output twice). main now leads every replay that follows a flush
// marker of the same session with a clear of the screen and the scrollback
// (replayResetGate.ts), so the renderer, unchanged, repaints the pane instead.
// Mounts the REAL useTerminal against a real xterm under jsdom, fed through
// main's real gate.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { installCanvas2dStub } from '../../../test-utils/canvas2dStub';
import { act, useRef, type MutableRefObject } from 'react';
import type { Terminal } from '@xterm/xterm';
import { createRoot, type Root } from 'react-dom/client';
import { FitAddon } from '@xterm/addon-fit';
import { setDaemonModeActive } from '../../daemon/daemonMode';
import { deliberateSleep } from '../../../test-utils/waitFor';
import { isTerminalDirty } from '../../terminal/terminalOutputScheduler';
import { createReplayResetGate } from '../../../main/ipc/handlers/replayResetGate';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// No WebGL under jsdom: the hook's own fallback (DOM renderer) takes over.
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class { constructor() { throw new Error('no WebGL in jsdom'); } },
}));

const unsub = () => () => undefined;
let emitData: ((ptyId: string, data: string, replay?: boolean) => void) | null = null;
let emitFlush: ((ptyId: string, recoveredBytes: number) => void) | null = null;
let emitRestarted: ((p: { ptyId: string; restartCount: number; exitCode: number | null }) => void) | null = null;
let resolveLoad: ((content: string) => void) | null = null;
const resync = vi.fn(async () => ({ success: true, mode: 'snapshot' }));
// Laid-out size of every element; 0 models a display:none workspace.
let layoutSize = 800;

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
        onExit: unsub,
        onRestarted: (cb: typeof emitRestarted) => { emitRestarted = cb; return () => undefined; },
        resize: vi.fn(async () => undefined),
        reconnect: vi.fn(async () => ({ success: true })),
        resync,
        setViewerVisibility: vi.fn(),
        write: vi.fn(async () => undefined),
        list: vi.fn(async () => []),
      },
      daemon: { onConnected: unsub },
      scrollback: {
        load: vi.fn(() => new Promise<string>((resolve) => { resolveLoad = resolve; })),
        save: vi.fn(async () => undefined),
      },
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
let rerender: ((key: string) => Promise<void>) | null = null;
let setShown: ((visible: boolean) => Promise<void>) | null = null;


beforeEach(() => {
  layoutSize = 800;
  propose = vi.spyOn(FitAddon.prototype, 'proposeDimensions').mockReturnValue({ cols: 40, rows: 12 });
  setDaemonModeActive(true);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  termRef = null;
  rerender = null;
  setShown = null;
  propose?.mockRestore();
  resync.mockClear();
  setDaemonModeActive(false);
});

const settle = () => act(async () => { await deliberateSleep(50, 'lets xterm parse the writes under act; nothing polled'); });

async function mount(ptyId: string, { visible = true, scrollbackFile }: { visible?: boolean; scrollbackFile?: string } = {}): Promise<void> {
  const { useTerminal } = await import('../useTerminal');
  function Harness({ shown }: { shown: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    termRef = useTerminal(ref, { ptyId, isVisible: shown, scrollbackFile }).terminal;
    return <div ref={ref} style={{ width: '100%', height: '100%' }} />;
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  let key = 'first';
  let shown = visible;
  await act(async () => { root!.render(<Harness key={key} shown={shown} />); });
  await settle();
  // A pane-tree restructure: the leaf unmounts and remounts in one commit.
  rerender = async (next: string) => {
    key = next;
    await act(async () => { root!.render(<Harness key={key} shown={shown} />); });
    await settle();
  };
  // A workspace switch: the same mount hidden or shown.
  setShown = async (v: boolean) => {
    shown = v;
    layoutSize = v ? 800 : 0;
    await act(async () => { root!.render(<Harness key={key} shown={shown} />); });
    await settle();
  };
}
const mountVisible = (ptyId: string) => mount(ptyId);

function lines(): string[] {
  const buf = termRef!.current!.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < buf.length; i++) out.push((buf.getLine(i)?.translateToString(true) ?? '').trimEnd());
  return out;
}

// What main forwards to the renderer: replay chunks through its reset gate,
// flush markers (the gate is armed once one went out), restarts (forgotten
// first, as onDaemonSessionRestarted does).
const gate = createReplayResetGate(() => undefined);
const replay = (id: string, text: string) => emitData!(id, gate.outgoing(id, text, true), true);
const live = (id: string, text: string) => emitData!(id, gate.outgoing(id, text, false), false);
const marker = (id: string, recoveredBytes: number) => {
  emitFlush!(id, recoveredBytes);
  gate.flushed(id);
};
const restart = (id: string) => {
  gate.forget(id);
  emitRestarted!({ ptyId: id, restartCount: 1, exitCode: 1 });
};

// The first case pays for importing the whole hook under jsdom.
describe('useTerminal: a second ring flush of a session', { timeout: 60_000 }, () => {
  it('repaints a visible pane, and live output after it lands after it', async () => {
    await mountVisible('p-a');
    act(() => {
      replay('p-a', 'PS> ');
      marker('p-a', 4);
      live('p-a', 'echo a\r\na\r\nPS> ');
    });
    await settle();
    expect(lines().slice(0, 3)).toEqual(['PS> echo a', 'a', 'PS>']);
    // The losing reconnect's retry attaches afresh: the whole ring again.
    act(() => {
      replay('p-a', 'PS> echo a\r\na\r\nPS> ');
      marker('p-a', 18);
      live('p-a', 'echo b\r\nb\r\nPS> ');
    });
    await settle();
    expect(lines().slice(0, 5)).toEqual(['PS> echo a', 'a', 'PS> echo b', 'b', 'PS>']);
    expect(resync).not.toHaveBeenCalled();
  });

  it('shows the rows the cut live pipe never delivered', async () => {
    await mountVisible('p-b');
    act(() => {
      replay('p-b', 'PS> ');
      marker('p-b', 4);
      live('p-b', 'seq 3\r\nrow-1\r\n');
    });
    await settle();
    act(() => {
      replay('p-b', 'PS> seq 3\r\nrow-1\r\n');
      replay('p-b', 'row-2\r\nrow-3\r\nPS> ');
      marker('p-b', 38);
    });
    await settle();
    expect(lines().slice(0, 5)).toEqual(['PS> seq 3', 'row-1', 'row-2', 'row-3', 'PS>']);
  });

  it('leaves a hidden pane under retention dirty, and its reveal resyncs it once', async () => {
    await mount('p-c', { visible: false });
    act(() => {
      replay('p-c', 'PS> ');
      marker('p-c', 4);
      live('p-c', 'echo a\r\na\r\nPS> ');
    });
    await settle();
    expect(isTerminalDirty(termRef!.current!)).toBe(false);
    act(() => {
      replay('p-c', 'PS> echo a\r\na\r\nPS> ');
      marker('p-c', 18);
    });
    await settle();
    expect(isTerminalDirty(termRef!.current!)).toBe(true);
    await setShown!(true);
    expect(resync).toHaveBeenCalledTimes(1);
    // The resync's re-flush (RIS-led, as the daemon sends it) settles the pane.
    act(() => {
      replay('p-c', '\x1bcPS> echo a\r\na\r\nPS> ');
      marker('p-c', 18);
      live('p-c', 'echo b\r\nb\r\nPS> ');
    });
    await settle();
    expect(lines().slice(0, 5)).toEqual(['PS> echo a', 'a', 'PS> echo b', 'b', 'PS>']);
  });

  it('shows a .txt-restored pane once after its load settled', async () => {
    await mount('p-d', { scrollbackFile: '/tmp/p-d.txt' });
    await act(async () => { resolveLoad!('old txt line\r\n'); });
    await settle();
    act(() => {
      replay('p-d', 'PS> ');
      marker('p-d', 4);
      live('p-d', 'echo a\r\na\r\nPS> ');
      replay('p-d', 'PS> echo a\r\na\r\nPS> ');
      marker('p-d', 18);
    });
    await settle();
    expect(lines().slice(0, 3)).toEqual(['PS> echo a', 'a', 'PS>']);
    expect(lines().filter((l) => l === 'a')).toHaveLength(1);
  });

  it('shows two replays held back by a .txt load once', async () => {
    await mount('p-d2', { scrollbackFile: '/tmp/p-d2.txt' });
    act(() => {
      replay('p-d2', 'PS> hello\r\n');
      marker('p-d2', 11);
      replay('p-d2', 'PS> hello\r\n');
      marker('p-d2', 11);
    });
    await settle();
    await act(async () => { resolveLoad!('old cache'); });
    await settle();
    expect(lines().filter((l) => l === 'PS> hello')).toHaveLength(1);
  });

  it("appends a supervised restart's first flush after the restart marker", async () => {
    await mountVisible('p-e');
    act(() => {
      replay('p-e', 'PS> ');
      marker('p-e', 4);
      live('p-e', 'old-output\r\n');
    });
    await settle();
    act(() => { restart('p-e'); });
    await settle();
    act(() => {
      replay('p-e', 'NEW> ');
      marker('p-e', 5);
    });
    await settle();
    const ls = lines();
    expect(ls[0]).toBe('PS> old-output');
    const marked = ls.findIndex((l) => l.includes('restart'));
    expect(marked).toBeGreaterThan(0);
    expect(ls.findIndex((l) => l.startsWith('NEW>'))).toBeGreaterThan(marked);
  });

  it('keeps the head of a first flush when the pane is adopted in its middle', async () => {
    await mountVisible('p-f');
    act(() => { replay('p-f', 'r1\r\nr2\r\nr3\r\n'); });
    await settle();
    await rerender!('second');
    act(() => {
      replay('p-f', 'r4\r\nPS> ');
      marker('p-f', 18);
    });
    await settle();
    expect(lines().slice(0, 5)).toEqual(['r1', 'r2', 'r3', 'r4', 'PS>']);
  });
});
