// @vitest-environment jsdom
//
// main re-flushes a pane on its own when the daemon's session pipe fell behind
// (main stopped reading it): it sends pty:resync-starting first, then the
// re-flush arrives like the renderer's own (RIS-led replay, flush marker), or
// pty:resync-failed. Mounts the REAL useTerminal against a real xterm under
// jsdom (the harness of useTerminal.secondReplay.test.tsx).

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
import { xtermKittyFlags } from '../../terminal/kittyKeyboard';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// No WebGL under jsdom: the hook's own fallback (DOM renderer) takes over.
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: class { constructor() { throw new Error('no WebGL in jsdom'); } },
}));

const unsub = () => () => undefined;
let emitData: ((ptyId: string, data: string, replay?: boolean) => void) | null = null;
let emitFlush: ((ptyId: string, recoveredBytes: number) => void) | null = null;
let emitRestarted: ((p: { ptyId: string; restartCount: number; exitCode: number | null }) => void) | null = null;
let emitStarting: ((ptyId: string) => void) | null = null;
let emitFailed: ((ptyId: string, code: string) => void) | null = null;
const resync = vi.fn(async () => ({ success: true, mode: 'snapshot' }));
const write = vi.fn(async (_id: string, _data: string) => undefined);
const reconnect = vi.fn(async (): Promise<{ success: boolean; code?: string }> => ({ success: true }));
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
        onResyncStarting: (cb: typeof emitStarting) => { emitStarting = cb; return () => undefined; },
        onResyncFailed: (cb: typeof emitFailed) => { emitFailed = cb; return () => undefined; },
        resize: vi.fn(async () => undefined),
        reconnect,
        resync,
        setViewerVisibility: vi.fn(),
        write,
        list: vi.fn(async () => []),
      },
      daemon: { onConnected: unsub },
      scrollback: {
        load: vi.fn(() => new Promise<string>(() => undefined)),
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
  setShown = null;
  propose?.mockRestore();
  resync.mockClear();
  reconnect.mockClear();
  write.mockClear();
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
  const key = 'first';
  let shown = visible;
  await act(async () => { root!.render(<Harness key={key} shown={shown} />); });
  await settle();
  // A workspace switch: the same mount hidden or shown.
  setShown = async (v: boolean) => {
    shown = v;
    layoutSize = v ? 800 : 0;
    await act(async () => { root!.render(<Harness key={key} shown={shown} />); });
    await settle();
  };
}

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

describe('useTerminal: a re-flush main started', { timeout: 60_000 }, () => {
  it('holds output until the re-flush lands, then repaints once, without asking for one', async () => {
    await mount('m-a');
    act(() => {
      replay('m-a', 'PS> ');
      marker('m-a', 4);
      live('m-a', 'echo a\r\na\r\nPS> ');
    });
    await settle();
    act(() => {
      emitStarting!('m-a');
      // Bytes the pipe still delivers ahead of the re-flush are held, not drawn.
      live('m-a', 'held\r\n');
    });
    await settle();
    expect(lines()).not.toContain('held');
    act(() => {
      replay('m-a', '\x1bcPS> echo a\r\na\r\nPS> echo b\r\nb\r\nPS> ');
      marker('m-a', 30);
      live('m-a', 'echo c\r\nc\r\nPS> ');
    });
    await settle();
    expect(lines().slice(0, 7)).toEqual(['PS> echo a', 'a', 'PS> echo b', 'b', 'PS> echo c', 'c', 'PS>']);
    expect(resync).not.toHaveBeenCalled();
  });

  it('a notice that arrives while the pane\'s own resync is pending joins it', async () => {
    let release: (v: { success: true; mode: string }) => void = () => undefined;
    resync.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    await mount('m-b', { visible: false });
    act(() => {
      replay('m-b', 'PS> ');
      marker('m-b', 4);
      live('m-b', 'echo a\r\na\r\nPS> ');
      // A second ring flush leaves the hidden pane dirty: its reveal resyncs.
      replay('m-b', 'PS> echo a\r\na\r\nPS> ');
      marker('m-b', 18);
    });
    await settle();
    await setShown!(true);
    expect(resync).toHaveBeenCalledTimes(1);
    act(() => emitStarting!('m-b'));
    await settle();
    act(() => {
      replay('m-b', '\x1bcPS> echo a\r\na\r\nPS> ');
      marker('m-b', 18);
      live('m-b', 'echo b\r\nb\r\nPS> ');
    });
    await act(async () => { release({ success: true, mode: 'snapshot' }); });
    await settle();
    expect(resync).toHaveBeenCalledTimes(1);
    expect(lines().slice(0, 5)).toEqual(['PS> echo a', 'a', 'PS> echo b', 'b', 'PS>']);
  });

  it('a hidden pane takes the re-flush, and its reveal needs no resync of its own', async () => {
    await mount('m-c', { visible: false });
    act(() => {
      replay('m-c', 'PS> ');
      marker('m-c', 4);
      live('m-c', 'echo a\r\na\r\nPS> ');
    });
    await settle();
    act(() => {
      emitStarting!('m-c');
      replay('m-c', '\x1bcPS> echo a\r\na\r\nPS> echo b\r\nb\r\nPS> ');
      marker('m-c', 30);
    });
    await settle();
    expect(isTerminalDirty(termRef!.current!)).toBe(false);
    await setShown!(true);
    expect(resync).not.toHaveBeenCalled();
    expect(lines().slice(0, 5)).toEqual(['PS> echo a', 'a', 'PS> echo b', 'b', 'PS>']);
  });

  it('a failed re-flush re-attaches the pane, and the attach flush settles it', async () => {
    await mount('m-e');
    act(() => {
      replay('m-e', 'PS> ');
      marker('m-e', 4);
    });
    await settle();
    act(() => {
      emitStarting!('m-e');
      live('m-e', 'echo held\r\nheld\r\nPS> ');
    });
    await settle();
    act(() => emitFailed!('m-e', 'rpc-error'));
    await settle();
    expect(reconnect).toHaveBeenCalledWith('m-e', { promote: false, joinOnly: true });
    expect(lines()).not.toContain('held');
    act(() => {
      replay('m-e', 'PS> echo held\r\nheld\r\nPS> ');
      marker('m-e', 27);
    });
    await settle();
    expect(lines().slice(0, 4)).toEqual(['PS> echo held', 'held', 'PS>', '']);
    expect(resync).not.toHaveBeenCalled();
  });

  it('a failed re-attach releases the held output instead of leaving the pane waiting', async () => {
    await mount('m-d');
    act(() => {
      replay('m-d', 'PS> ');
      marker('m-d', 4);
    });
    await settle();
    act(() => {
      emitStarting!('m-d');
      live('m-d', 'echo held\r\nheld\r\nPS> ');
    });
    await settle();
    expect(lines()).not.toContain('held');
    reconnect.mockResolvedValueOnce({ success: false, code: 'session-gone' });
    act(() => emitFailed!('m-d', 'rpc-error'));
    await settle();
    expect(lines().slice(0, 3)).toEqual(['PS> echo held', 'held', 'PS>']);
  });
});

// What the pane's Shift+Enter sends: the form the program negotiated.
async function shiftEnter(ptyId: string): Promise<string> {
  write.mockClear();
  const textarea = termRef!.current!.textarea!;
  act(() => {
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, shiftKey: true, bubbles: true, cancelable: true }));
  });
  await settle();
  return write.mock.calls.filter(([id]) => id === ptyId).map(([, data]) => data).join('');
}

describe('useTerminal: keyboard negotiation across a re-flush main started', { timeout: 60_000 }, () => {
  // The program negotiated at startup, long before the ring the re-flush is
  // cut from: the replay holds none of it.
  const KITTY = '\x1b[>1u';
  const MODIFY_OTHER_KEYS = '\x1b[>4;2m';

  async function negotiated(ptyId: string, negotiation: string): Promise<void> {
    await mount(ptyId);
    act(() => {
      replay(ptyId, 'PS> ');
      marker(ptyId, 4);
      live(ptyId, `tui\r\n${negotiation}tui> `);
    });
    await settle();
  }

  it('a pane that negotiated kitty keys keeps them', async () => {
    await negotiated('k-a', KITTY);
    expect(await shiftEnter('k-a')).toBe('\x1b[13;2u');
    act(() => {
      emitStarting!('k-a');
      replay('k-a', '\x1bcPS> tui\r\ntui> ');
      marker('k-a', 20);
    });
    await settle();
    expect(xtermKittyFlags(termRef!.current!)).toBe(1);
    expect(await shiftEnter('k-a')).toBe('\x1b[13;2u');
  });

  it('a pane that negotiated modifyOtherKeys keeps it', async () => {
    await negotiated('k-b', MODIFY_OTHER_KEYS);
    act(() => {
      emitStarting!('k-b');
      replay('k-b', '\x1bcPS> tui\r\ntui> ');
      marker('k-b', 20);
    });
    await settle();
    expect(await shiftEnter('k-b')).toBe('\x1b[27;2;13~');
  });

  it('joined to the pane\'s own resync, kitty keys survive and a negotiation only the replay holds counts', async () => {
    let release: (v: { success: true; mode: string }) => void = () => undefined;
    resync.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    await negotiated('k-c', KITTY);
    await setShown!(false);
    act(() => {
      // A second ring flush leaves the hidden pane dirty: its reveal resyncs.
      replay('k-c', 'PS> tui\r\ntui> ');
      marker('k-c', 16);
    });
    await settle();
    await setShown!(true);
    expect(resync).toHaveBeenCalledTimes(1);
    act(() => emitStarting!('k-c'));
    await settle();
    act(() => {
      // Printed while the pipe was behind: modifyOtherKeys, never seen live.
      replay('k-c', `\x1bcPS> tui\r\n${MODIFY_OTHER_KEYS}tui> `);
      marker('k-c', 30);
    });
    await act(async () => { release({ success: true, mode: 'snapshot' }); });
    await settle();
    expect(xtermKittyFlags(termRef!.current!)).toBe(1);
    expect(await shiftEnter('k-c')).toBe('\x1b[13;2u');
    // The kitty pop on exit leaves the modifyOtherKeys the replay carried.
    act(() => live('k-c', '\x1b[<u'));
    await settle();
    expect(await shiftEnter('k-c')).toBe('\x1b[27;2;13~');
  });
});
