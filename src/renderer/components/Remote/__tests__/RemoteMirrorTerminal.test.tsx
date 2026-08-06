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

class FakeTerminal {
  written: unknown[] = [];
  resized: Array<{ cols: number; rows: number }> = [];
  resetCalls = 0;
  disposed = false;
  onDataHandler: ((data: string) => void) | null = null;

  open(): void { /* noop — the fake never touches the DOM container */ }
  reset(): void { this.resetCalls++; }
  resize(cols: number, rows: number): void { this.resized.push({ cols, rows }); }
  write(data: unknown): void { this.written.push(data); }
  onData(cb: (data: string) => void): { dispose: () => void } {
    this.onDataHandler = cb;
    return { dispose: vi.fn() };
  }
  dispose(): void { this.disposed = true; }
}

const termInstances: FakeTerminal[] = [];

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    constructor() {
      const t = new FakeTerminal();
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
  let dataHandlers: Handler[];
  let exitHandlers: Handler[];
  let errorHandlers: Handler[];
  let paneDetach: ReturnType<typeof vi.fn>;
  let paneWrite: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    termInstances.length = 0;
    metaHandlers = [];
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
});
