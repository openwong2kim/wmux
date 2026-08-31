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

  /** Selection + key plumbing the #895 editing conveniences hang off. Set
   *  `selection` to stand in for a user drag, then drive `keyHandler`. */
  selection = '';
  selectionHandler: (() => void) | null = null;
  keyHandler: ((e: KeyboardEvent) => boolean) | null = null;
  clearSelectionCalls = 0;
  onSelectionChange(cb: () => void): { dispose: () => void } {
    this.selectionHandler = cb;
    return { dispose: vi.fn() };
  }
  /** #1086/#1091 — RemoteMirrorTerminal always wires this in its mount
   *  effect now, whether or not a test passes onTitleChange. */
  titleHandler: ((title: string) => void) | null = null;
  onTitleChange(cb: (title: string) => void): { dispose: () => void } {
    this.titleHandler = cb;
    return { dispose: vi.fn() };
  }
  getSelection(): string { return this.selection; }
  hasSelection(): boolean { return this.selection.length > 0; }
  clearSelection(): void { this.clearSelectionCalls++; this.selection = ''; }
  attachCustomKeyEventHandler(cb: (e: KeyboardEvent) => boolean): void { this.keyHandler = cb; }

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
  let clipboardWrite: ReturnType<typeof vi.fn>;
  let clipboardRead: ReturnType<typeof vi.fn>;

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

    clipboardWrite = vi.fn(() => Promise.resolve());
    clipboardRead = vi.fn(() => Promise.resolve(''));
    (window as unknown as { clipboardAPI: unknown }).clipboardAPI = {
      writeText: clipboardWrite,
      readText: clipboardRead,
    };
  });

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    delete (window as unknown as { clipboardAPI?: unknown }).clipboardAPI;
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

  it('#1086/#1091 — fires onTitleChange with the sanitized OSC title', () => {
    const onTitleChange = vi.fn();
    const { unmount } = render(<RemoteMirrorTerminal attachId="a1" onTitleChange={onTitleChange} />);
    const term = termInstances[0];

    act(() => {
      term.titleHandler?.('claude: feature-x\x07');
    });

    expect(onTitleChange).toHaveBeenCalledWith('claude: feature-x');
    unmount();
  });

  it('#1086/#1091 — drops an all-control-character title (nothing printable to show)', () => {
    const onTitleChange = vi.fn();
    const { unmount } = render(<RemoteMirrorTerminal attachId="a1" onTitleChange={onTitleChange} />);
    const term = termInstances[0];

    act(() => {
      term.titleHandler?.('\x07');
    });

    expect(onTitleChange).not.toHaveBeenCalled();
    unmount();
  });

  it('#1086/#1091 — works without an onTitleChange prop (mirror-grid callers pass none)', () => {
    const { unmount } = render(<RemoteMirrorTerminal attachId="a1" />);
    const term = termInstances[0];

    expect(() => {
      act(() => {
        term.titleHandler?.('claude: feature-x');
      });
    }).not.toThrow();
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

  // #895 — the mirror forwarded EVERY keystroke raw, so the editing
  // conveniences that operate on the LOCAL selection and the LOCAL clipboard
  // were simply absent: a drag copied nothing, Ctrl+C interrupted the remote
  // instead of copying, Ctrl+V did nothing, Shift+Enter submitted.
  //
  // The chord table is covered by mirrorInput.test.ts, which needs no DOM.
  // These are about the WIRING it hangs on: that a copy never reaches
  // `paneWrite`, that a direct write carries the live attach, and that a
  // read-only host still receives nothing.
  describe('local editing conveniences', () => {
    function press(term: FakeTerminal, over: Record<string, unknown>): boolean {
      const ev = {
        type: 'keydown',
        key: 'a',
        code: 'KeyA',
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        isComposing: false,
        preventDefault: vi.fn(),
        ...over,
      } as unknown as KeyboardEvent;
      return term.keyHandler?.(ev) ?? true;
    }

    it('★ Ctrl+C over a selection copies locally and sends nothing to the remote', async () => {
      const { unmount } = render(<RemoteMirrorTerminal attachId="a1" />);
      const term = termInstances[0]!;
      term.selection = 'npm run build';

      let handled = true;
      await act(async () => {
        handled = press(term, { key: 'c', code: 'KeyC', ctrlKey: true });
      });

      expect(clipboardWrite).toHaveBeenCalledWith('npm run build');
      // The whole point: this used to arrive on the remote as SIGINT.
      expect(paneWrite).not.toHaveBeenCalled();
      expect(handled).toBe(false); // consumed here — xterm must not encode it

      unmount();
    });

    it('★ Ctrl+C with nothing selected still interrupts the remote', async () => {
      const { unmount } = render(<RemoteMirrorTerminal attachId="a1" />);
      const term = termInstances[0]!;

      let handled = false;
      await act(async () => {
        handled = press(term, { key: 'c', code: 'KeyC', ctrlKey: true });
      });

      expect(handled).toBe(true); // xterm encodes it → onData → paneWrite
      expect(clipboardWrite).not.toHaveBeenCalled();

      unmount();
    });

    // The CSI-u newline is a NEGOTIATED encoding, so the mirror has to have
    // seen the remote ask for it. It learns that the same way it learns
    // bracketed paste: from the remote's own output.
    it('Shift+Enter sends the CSI-u newline once the remote enables kitty keys', async () => {
      const { unmount } = render(<RemoteMirrorTerminal attachId="a1" />);
      const term = termInstances[0]!;

      await act(async () => {
        // CSI > 1 u — the remote pushes a kitty flag set.
        for (const h of dataHandlers) {
          h({ attachId: 'a1', dataB64: btoa('\x1b[>1u') });
        }
      });
      await act(async () => {
        press(term, { key: 'Enter', code: 'Enter', shiftKey: true });
      });

      expect(paneWrite).toHaveBeenCalledWith('a1', '\x1b[13;2u');

      unmount();
    });

    it('Shift+Enter goes through xterm while the remote has not asked', async () => {
      const { unmount } = render(<RemoteMirrorTerminal attachId="a1" />);
      const term = termInstances[0]!;

      await act(async () => {
        press(term, { key: 'Enter', code: 'Enter', shiftKey: true });
      });

      // No direct write: xterm encodes the legacy CR, which is what an app
      // that never negotiated expects. Injecting the escape form here is what
      // would leave vim's insert mode and run the remainder as commands.
      expect(paneWrite).not.toHaveBeenCalledWith('a1', '\x1b[13;2u');

      unmount();
    });

    it('Ctrl+V writes the clipboard text to the remote pane', async () => {
      clipboardRead.mockResolvedValue('echo hello');
      const { unmount } = render(<RemoteMirrorTerminal attachId="a1" />);
      const term = termInstances[0]!;

      await act(async () => {
        press(term, { key: 'v', code: 'KeyV', ctrlKey: true });
        await Promise.resolve();
      });

      const sent = paneWrite.mock.calls.map((c) => c[1]).join('');
      expect(sent).toContain('echo hello');
      expect(paneWrite.mock.calls.every((c) => c[0] === 'a1')).toBe(true);

      unmount();
    });

    it('auto-copies a finished selection, debounced', () => {
      vi.useFakeTimers();
      try {
        const { unmount } = render(<RemoteMirrorTerminal attachId="a1" />);
        const term = termInstances[0]!;
        term.selection = 'copied by drag';

        act(() => { term.selectionHandler?.(); });
        // Mid-drag: onSelectionChange fires once per cell, so nothing is
        // written until the user stops moving.
        expect(clipboardWrite).not.toHaveBeenCalled();

        act(() => { vi.advanceTimersByTime(200); });
        expect(clipboardWrite).toHaveBeenCalledWith('copied by drag');

        unmount();
      } finally {
        vi.useRealTimers();
      }
    });

    // `--allow-input` is off on the host. The remote would refuse the write, so
    // the mirror must not send one — including down the direct-write path,
    // which does not pass through the `onData` gate that already handles this.
    it('★ a read-only host receives nothing from a paste or a newline key', async () => {
      clipboardRead.mockResolvedValue('rm -rf /');
      const { unmount } = render(<RemoteMirrorTerminal attachId="a1" readOnly />);
      const term = termInstances[0]!;

      await act(async () => {
        press(term, { key: 'Enter', code: 'Enter', shiftKey: true });
        press(term, { key: 'v', code: 'KeyV', ctrlKey: true });
        await Promise.resolve();
      });

      expect(paneWrite).not.toHaveBeenCalled();

      unmount();
    });

    it('a read-only host can still copy — the selection is local', async () => {
      const { unmount } = render(<RemoteMirrorTerminal attachId="a1" readOnly />);
      const term = termInstances[0]!;
      term.selection = 'read me';

      await act(async () => {
        press(term, { key: 'c', code: 'KeyC', ctrlKey: true });
      });

      expect(clipboardWrite).toHaveBeenCalledWith('read me');

      unmount();
    });
  });
});
