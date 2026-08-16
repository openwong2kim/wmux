// @vitest-environment jsdom
//
// RemoteMirrorTerminal contract (Task 7): the remote's meta event is the sole
// driver of terminal geometry (reset + resize + repaint the decoded
// snapshot), data events append, and unmount tears down cleanly (unsubscribe
// + paneDetach). Real @xterm/xterm needs canvas/DOM APIs jsdom doesn't
// faithfully provide (same constraint documented in
// hooks/__tests__/useTerminal.osc52.test.ts), so this mocks '@xterm/xterm'
// with a minimal spy Terminal — the wiring under test is this component's
// own event handling, not xterm's rendering internals.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import RemoteMirrorTerminal from '../RemoteMirrorTerminal';
import { useStore } from '../../../stores';

// One shared log so "before open()" is an assertion about the same clock.
// Two independent counters would compare cleanly and prove nothing.
const setupLog = vi.hoisted(() => [] as string[]);
const widthModelMock = vi.hoisted(() => vi.fn());
vi.mock('../../../../shared/terminalUnicode', () => ({
  applyUnicodeWidthModel: (t: unknown) => {
    setupLog.push('width-model');
    widthModelMock(t);
  },
}));

class FakeTerminal {
  /** What the component asked for at construction. */
  ctorOptions: Record<string, unknown> = {};
  /** Live options bag, like xterm's — the runtime settings effect writes here. */
  options: Record<string, unknown> = {};
  written: unknown[] = [];
  resized: Array<{ cols: number; rows: number }> = [];
  resetCalls = 0;
  disposed = false;
  onDataHandler: ((data: string) => void) | null = null;

  open(): void {
    // Ordering only — the fake never touches the DOM container.
    setupLog.push('open');
  }
  reset(): void { this.resetCalls++; }
  resize(cols: number, rows: number): void { this.resized.push({ cols, rows }); }
  /**
   * xterm's `write(data, callback)` — the callback fires once the parser has
   * consumed the chunk, which is the seam the repaint gate hangs off. The fake
   * holds it so a test can drive "during the write" and "after the write"
   * separately, and `flushWrites()` is the "after".
   */
  pendingWriteCallbacks: Array<() => void> = [];
  /** Set to make write() throw the way xterm's WriteBuffer does past its
   *  discard watermark — BEFORE the callback is ever queued. */
  writeThrows = false;
  write(data: unknown, cb?: () => void): void {
    if (this.writeThrows) throw new Error('write buffer full');
    this.written.push(data);
    if (cb) this.pendingWriteCallbacks.push(cb);
  }
  flushWrites(): void {
    const cbs = this.pendingWriteCallbacks;
    this.pendingWriteCallbacks = [];
    cbs.forEach((cb) => cb());
  }
  onData(cb: (data: string) => void): { dispose: () => void } {
    this.onDataHandler = cb;
    return { dispose: vi.fn() };
  }
  dispose(): void { this.disposed = true; }
}

const termInstances: FakeTerminal[] = [];

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor(opts: Record<string, unknown>) {
      const t = new FakeTerminal();
      t.ctorOptions = { ...opts };
      t.options = { ...opts };
      termInstances.push(t);
      return t as unknown as this;
    }
  },
}));

type Handler = (e: Record<string, unknown>) => void;

function render(ui: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(ui));
  return {
    container,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe('RemoteMirrorTerminal', () => {
  let metaHandlers: Handler[];
  let resizeHandlers: Handler[];
  let dataHandlers: Handler[];
  let exitHandlers: Handler[];
  let errorHandlers: Handler[];
  let paneDetach: ReturnType<typeof vi.fn>;
  let paneWrite: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    setupLog.length = 0;
    termInstances.length = 0;
    metaHandlers = [];
    resizeHandlers = [];
    dataHandlers = [];
    exitHandlers = [];
    errorHandlers = [];
    paneDetach = vi.fn(() => Promise.resolve());
    paneWrite = vi.fn();

    (window as unknown as { electronAPI: unknown }).electronAPI = {
      remote: {
        onPaneMeta: (cb: Handler) => {
          metaHandlers.push(cb);
          return () => { metaHandlers = metaHandlers.filter((h) => h !== cb); };
        },
        onPaneResize: (cb: Handler) => {
          resizeHandlers.push(cb);
          return () => { resizeHandlers = resizeHandlers.filter((h) => h !== cb); };
        },
        onPaneData: (cb: Handler) => {
          dataHandlers.push(cb);
          return () => { dataHandlers = dataHandlers.filter((h) => h !== cb); };
        },
        onPaneExit: (cb: Handler) => {
          exitHandlers.push(cb);
          return () => { exitHandlers = exitHandlers.filter((h) => h !== cb); };
        },
        onPaneError: (cb: Handler) => {
          errorHandlers.push(cb);
          return () => { errorHandlers = errorHandlers.filter((h) => h !== cb); };
        },
        paneDetach,
        paneWrite,
      },
    };
  });

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('meta event resets, resizes, and repaints the decoded snapshot', () => {
    const { unmount } = render(<RemoteMirrorTerminal attachId="a1" />);
    const term = termInstances[0];
    expect(term).toBeDefined();

    act(() => {
      metaHandlers.forEach((h) => h({ attachId: 'a1', cols: 80, rows: 24, snapshotB64: btoa('hello') }));
    });

    expect(term.resetCalls).toBe(1);
    expect(term.resized).toEqual([{ cols: 80, rows: 24 }]);
    expect(term.written).toHaveLength(1);

    unmount();
  });

  it('ignores meta/data events for a different attachId', () => {
    const { unmount } = render(<RemoteMirrorTerminal attachId="a1" />);
    const term = termInstances[0];

    act(() => {
      metaHandlers.forEach((h) => h({ attachId: 'other', cols: 10, rows: 10, snapshotB64: btoa('x') }));
      dataHandlers.forEach((h) => h({ attachId: 'other', dataB64: btoa('x') }));
    });

    expect(term.resetCalls).toBe(0);
    expect(term.written).toHaveLength(0);

    unmount();
  });

  it('data event writes the decoded bytes', () => {
    const { unmount } = render(<RemoteMirrorTerminal attachId="a1" />);
    const term = termInstances[0];

    act(() => {
      dataHandlers.forEach((h) => h({ attachId: 'a1', dataB64: btoa('world') }));
    });

    expect(term.written).toHaveLength(1);

    unmount();
  });

  it('routes term input through remote.paneWrite', () => {
    const { unmount } = render(<RemoteMirrorTerminal attachId="a1" />);
    const term = termInstances[0];

    act(() => {
      term.onDataHandler?.('ls\n');
    });

    expect(paneWrite).toHaveBeenCalledWith('a1', 'ls\n');

    unmount();
  });

  // ①c — xterm auto-answers DA1/DSR/CPR through the same onData this component
  // forwards, so anything it parses can make the mirror type into the REMOTE
  // pane's stdin. The remote's own GUI is the authoritative responder
  // (HeadlessSnapshot never wires onData for the same reason).
  //
  // Two layers: replies are filtered by shape wherever they come from, and the
  // whole channel is closed for the duration of a repaint, where a snapshot's
  // worth of queries lands at once.
  const attach = (snapshot = 'scrollback'): void => {
    act(() => {
      metaHandlers.forEach((h) =>
        h({ attachId: 'a1', cols: 80, rows: 24, snapshotB64: btoa(snapshot) }),
      );
    });
  };

  it('★ suppresses paneWrite while a snapshot repaint is being written', () => {
    const { unmount } = render(<RemoteMirrorTerminal attachId="a1" />);
    const term = termInstances[0];
    attach('\x1b[?1049h\x1b[c');

    // Ordinary typing, not a reply — so this asserts the GATE, not the filter.
    // The write callback has not fired yet: the parser is still consuming, and
    // that is exactly when it emits its answers.
    act(() => { term.onDataHandler?.('x'); });
    expect(paneWrite).not.toHaveBeenCalled();

    // Once the chunk is consumed the gate drops and real typing flows again.
    act(() => { term.flushWrites(); });
    act(() => { term.onDataHandler?.('ls\n'); });
    expect(paneWrite).toHaveBeenCalledTimes(1);
    expect(paneWrite).toHaveBeenCalledWith('a1', 'ls\n');

    unmount();
  });

  it('★ keeps the gate closed while two repaints overlap', () => {
    // xterm parses a big write in ~12 ms slices, so a reconnect can start a
    // second repaint while the first is still being consumed. With a boolean
    // gate the FIRST callback reopened the channel underneath the second.
    const { unmount } = render(<RemoteMirrorTerminal attachId="a1" />);
    const term = termInstances[0];
    attach('first');
    attach('second');
    expect(term.pendingWriteCallbacks).toHaveLength(2);

    // The first snapshot finishes parsing; the second has not.
    act(() => { term.pendingWriteCallbacks.shift()?.(); });
    act(() => { term.onDataHandler?.('x'); });
    expect(paneWrite).not.toHaveBeenCalled();

    // Both done — back to normal.
    act(() => { term.flushWrites(); });
    act(() => { term.onDataHandler?.('x'); });
    expect(paneWrite).toHaveBeenCalledTimes(1);

    unmount();
  });

  it('★ a throwing write does not latch the gate shut forever', () => {
    // xterm's WriteBuffer refuses past its discard watermark, and it throws
    // before the callback exists — so nothing would ever reopen the gate, and
    // the pane would silently swallow every keystroke from then on.
    const { unmount } = render(<RemoteMirrorTerminal attachId="a1" />);
    const term = termInstances[0];
    term.writeThrows = true;
    attach('too much');
    term.writeThrows = false;

    act(() => { term.onDataHandler?.('ls\n'); });
    expect(paneWrite).toHaveBeenCalledWith('a1', 'ls\n');

    unmount();
  });

  it('★ never forwards a device-query reply on the LIVE data path', () => {
    // The repaint gate does not cover this: a TUI sends `ESC[6n` mid-session,
    // long after any snapshot, and the mirror was answering it.
    const { unmount } = render(<RemoteMirrorTerminal attachId="a1" />);
    const term = termInstances[0];
    attach();
    act(() => { term.flushWrites(); }); // repaint over — the gate is open

    const replies = [
      '\x1b[?62;1;6c', // DA1
      '\x1b[>0;276;0c', // DA2
      '\x1b[0n', // DSR
      '\x1b[24;80R', // CPR
      '\x1b[?2004;1$y', // DECRPM
      '\x1b[8;24;80t', // text-area report
      '\x1bP1$r0m\x1b\\', // DECRQSS
      '\x1b]11;rgb:1e1e/1e1e/2e2e\x07', // OSC background report
    ];
    act(() => { replies.forEach((r) => term.onDataHandler?.(r)); });
    expect(paneWrite).not.toHaveBeenCalled();

    unmount();
  });

  it('still forwards the escape sequences a KEY produces', () => {
    // The filter is shape-based, so it has to leave real input alone: arrows,
    // modified arrows, function keys, shift-tab, bracketed paste, mouse.
    const { unmount } = render(<RemoteMirrorTerminal attachId="a1" />);
    const term = termInstances[0];
    attach();
    act(() => { term.flushWrites(); });

    const keys = [
      '\x1b[A', '\x1b[D', '\x1b[1;5C', '\x1b[3~', '\x1b[15~', '\x1b[Z',
      '\x1bOR', '\x1b[200~pasted\x1b[201~', '\x1b[<0;10;5M', '\x03',
    ];
    act(() => { keys.forEach((k) => term.onDataHandler?.(k)); });
    expect(paneWrite).toHaveBeenCalledTimes(keys.length);

    unmount();
  });

  // A resize on the machine that owns the pane arrives as GEOMETRY. Answering
  // it with a fresh snapshot would mean `reset()` + replay on every viewer —
  // wiping the mirrored scrollback and yanking a user who was scrolled up back
  // to the bottom every time someone dragged a divider on the other machine.
  it('★ re-grids on a resize event without resetting or repainting', () => {
    const { unmount } = render(<RemoteMirrorTerminal attachId="a1" />);
    const term = termInstances[0];

    act(() => {
      metaHandlers.forEach((h) =>
        h({ attachId: 'a1', cols: 80, rows: 24, snapshotB64: btoa('scrollback') }),
      );
      term.flushWrites();
    });
    const resetsAfterAttach = term.resetCalls;
    const writesAfterAttach = term.written.length;

    act(() => {
      resizeHandlers.forEach((h) => h({ attachId: 'a1', cols: 120, rows: 40 }));
    });

    expect(term.resized.at(-1)).toEqual({ cols: 120, rows: 40 });
    expect(term.resetCalls).toBe(resetsAfterAttach); // scrollback survives
    expect(term.written).toHaveLength(writesAfterAttach); // nothing repainted

    unmount();
  });

  it('ignores a resize aimed at a different attach', () => {
    const { unmount } = render(<RemoteMirrorTerminal attachId="a1" />);
    const term = termInstances[0];
    act(() => {
      resizeHandlers.forEach((h) => h({ attachId: 'other', cols: 10, rows: 5 }));
    });
    expect(term.resized).toHaveLength(0);
    unmount();
  });

  it('calls remote.paneDetach on unmount', () => {
    const { unmount } = render(<RemoteMirrorTerminal attachId="a1" />);
    unmount();
    expect(paneDetach).toHaveBeenCalledWith('a1');
  });

  // m8 — a rejected paneDetach (e.g. daemon hiccup on teardown) must not
  // throw out of the unmount cleanup; it's best-effort and swallowed.
  it('does not throw when paneDetach rejects on unmount', async () => {
    paneDetach.mockImplementation(() => Promise.reject(new Error('IPC channel closed')));
    const { unmount } = render(<RemoteMirrorTerminal attachId="a1" />);
    expect(() => unmount()).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
  });

  // m7 — when the host is read-only, keystrokes must be swallowed locally
  // instead of forwarded (the server would reject them anyway, but a
  // forwarded write is a wasted POST at best and a confusing partial-echo
  // at worst).
  it('does not forward paneWrite when readOnly is true', () => {
    const { unmount } = render(<RemoteMirrorTerminal attachId="a1" readOnly />);
    const term = termInstances[0];

    act(() => {
      term.onDataHandler?.('ls\n');
    });

    expect(paneWrite).not.toHaveBeenCalled();

    unmount();
  });

  it('does nothing while attachId is null (attach still in flight)', () => {
    const { unmount } = render(<RemoteMirrorTerminal attachId={null} />);
    expect(metaHandlers).toHaveLength(0);
    unmount();
    expect(paneDetach).not.toHaveBeenCalled();
  });

  it('shows a disconnected overlay when the client gives up reconnecting', () => {
    const { container, unmount } = render(<RemoteMirrorTerminal attachId="a1" />);

    expect(container.textContent).not.toContain('Connection lost');

    act(() => {
      errorHandlers.forEach((h) => h({ attachId: 'a1', message: 'gave up reconnecting' }));
    });

    expect(container.textContent).toContain('Connection lost');

    unmount();
  });

  it('ignores an error event for a different attachId', () => {
    const { container, unmount } = render(<RemoteMirrorTerminal attachId="a1" />);

    act(() => {
      errorHandlers.forEach((h) => h({ attachId: 'other', message: 'gave up' }));
    });

    expect(container.textContent).not.toContain('Connection lost');

    unmount();
  });

  it('unsubscribes onPaneError on unmount', () => {
    const { unmount } = render(<RemoteMirrorTerminal attachId="a1" />);
    expect(errorHandlers).toHaveLength(1);
    unmount();
    expect(errorHandlers).toHaveLength(0);
  });

  /**
   * A mirror sits in the sidebar next to local panes and must not look like a
   * different application. Constructed bare it fell back to xterm's own
   * defaults — `monospace` at 15px on black, outside the theme's ANSI palette
   * — which read as "this pane is slightly bolder and bigger" and was.
   */
  /**
   * The mirror re-renders a grid the REMOTE daemon computed. `terminalUnicode`
   * exists because two grids that must agree drift silently otherwise, and
   * this was the one terminal that skipped it — visible as torn, interleaved
   * rows on CJK text, where every character is double-width.
   */
  it('applies the shared Unicode width model, before open()', () => {
    const { unmount } = render(<RemoteMirrorTerminal attachId="a1" />);

    expect(widthModelMock).toHaveBeenCalledWith(termInstances[0]);
    // The addon has to be installed before the terminal is attached, or the
    // first paint measures with the wrong model.
    expect(setupLog).toEqual(['width-model', 'open']);

    unmount();
  });

  // The component's header claims the parent CSS letterboxes an aspect
  // mismatch. Nothing in the chain did, so a remote pane taller than its cell
  // painted over the composer and the sidebar.
  it('clips its own overflow rather than trusting a parent to do it', () => {
    const { container, unmount } = render(<RemoteMirrorTerminal attachId="a1" />);

    const outer = container.firstElementChild as HTMLElement;
    expect(outer.className).toContain('overflow-hidden');
    expect((outer.firstElementChild as HTMLElement).className).toContain('overflow-hidden');

    unmount();
  });

  describe('visual settings', () => {
    // Reads the COMPONENT's ctor bag. The sibling ctor suite proves this flag
    // is what keeps the width model from throwing; this proves the component
    // actually sends it. Neither test alone would have caught the crash.
    it('asks for proposed API, which the width model requires', () => {
      const { unmount } = render(<RemoteMirrorTerminal attachId="a1" />);
      expect(termInstances[0]!.ctorOptions['allowProposedApi']).toBe(true);
      unmount();
    });

    it('constructs with the app font and theme, not xterm defaults', () => {
      const { unmount } = render(<RemoteMirrorTerminal attachId="a1" />);

      const opts = termInstances[0]!.ctorOptions;
      // xterm's own defaults are fontSize 15 / fontFamily 'monospace'. Asserting
      // against those specifically is the point: this is the regression.
      expect(opts['fontSize']).toBe(useStore.getState().terminalFontSize);
      expect(opts['fontSize']).not.toBe(15);
      expect(String(opts['fontFamily'])).toContain(useStore.getState().terminalFontFamily);
      expect(opts['fontFamily']).not.toBe('monospace');
      expect(opts['theme']).toBeTruthy();
      expect(typeof opts['minimumContrastRatio']).toBe('number');
      expect(opts['cursorStyle']).toBe(useStore.getState().terminalCursorStyle);

      unmount();
    });

    it('applies a font-family change without recreating the terminal', async () => {
      const { unmount } = render(<RemoteMirrorTerminal attachId="a1" />);
      const term = termInstances[0]!;
      const before = termInstances.length;

      await act(async () => {
        useStore.setState({ terminalFontFamily: 'IBM Plex Mono' });
      });

      // Same instance, new option — recreating would drop everything the
      // remote has already sent, and the remote only repaints on re-attach.
      expect(termInstances).toHaveLength(before);
      expect(term.disposed).toBe(false);
      expect(String(term.options['fontFamily'])).toContain('IBM Plex Mono');

      unmount();
    });

    it('applies a cursor-style change without recreating the terminal', async () => {
      const { unmount } = render(<RemoteMirrorTerminal attachId="a1" />);
      const term = termInstances[0]!;
      const before = termInstances.length;

      await act(async () => {
        useStore.setState({ terminalCursorStyle: 'bar' });
      });

      expect(termInstances).toHaveLength(before);
      expect(term.options['cursorStyle']).toBe('bar');

      unmount();
    });

    // fontSize has exactly ONE writer, the fit (see mirrorFit.ts) — the user's
    // setting is its upper bound, not a value assigned straight through. Two
    // writers is how the fit gets undone: this effect re-runs on any settings
    // change and would put the full-size font back, re-overflowing the box and
    // cropping the remote TUI's input row again.
    //
    // jsdom reports every layout as 0×0, so the fit correctly declines to
    // decide here and the constructed size stands. The arithmetic itself is
    // covered by mirrorFit.test.ts, which needs no DOM.
    it('does not let the settings effect write fontSize behind the fit', async () => {
      const { unmount } = render(<RemoteMirrorTerminal attachId="a1" />);
      const term = termInstances[0]!;
      const constructed = term.ctorOptions['fontSize'];

      await act(async () => {
        useStore.setState({ terminalFontSize: 22 });
      });

      expect(term.options['fontSize']).not.toBe(22);
      expect(term.options['fontSize'] ?? constructed).toBe(constructed);

      unmount();
    });
  });
});
