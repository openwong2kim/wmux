// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isTerminalDragActive, disposeWhenDragEnds, __resetTerminalDragForTests } from '../useTerminal';

// #582 — xterm's CoreMouseService registers document-level mouseup/mousemove
// listeners on mousedown so a drag can be released outside the terminal
// element. Terminal.dispose() nullifies _renderService before removing those
// listeners; a mouseup firing in that gap throws an uncaught TypeError from
// getMouseReportCoords. The cleanup in useTerminal defers dispose while
// isTerminalDragActive() is true. These tests pin the drag-detection logic.

describe('terminal mouse-drag guard (#582)', () => {
  beforeEach(() => {
    __resetTerminalDragForTests();
  });

  afterEach(() => {
    __resetTerminalDragForTests();
  });

  it('reports no drag before any interaction', () => {
    expect(isTerminalDragActive()).toBe(false);
  });

  it('activates on mousedown inside an .xterm element', () => {
    const xtermEl = document.createElement('div');
    xtermEl.className = 'xterm';
    document.body.appendChild(xtermEl);

    // isTerminalDragActive() lazily installs capture-phase listeners on first
    // call — trigger that before dispatching the event.
    isTerminalDragActive();

    xtermEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(isTerminalDragActive()).toBe(true);

    document.body.removeChild(xtermEl);
  });

  it('activates on mousedown on a child of .xterm (selection drag)', () => {
    const xtermEl = document.createElement('div');
    xtermEl.className = 'xterm';
    const screen = document.createElement('div');
    screen.className = 'xterm-screen';
    xtermEl.appendChild(screen);
    document.body.appendChild(xtermEl);

    isTerminalDragActive();
    screen.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(isTerminalDragActive()).toBe(true);

    document.body.removeChild(xtermEl);
  });

  it('does NOT activate on mousedown outside .xterm', () => {
    const button = document.createElement('button');
    document.body.appendChild(button);

    isTerminalDragActive();
    button.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(isTerminalDragActive()).toBe(false);

    document.body.removeChild(button);
  });

  it('clears on document mouseup (drag released anywhere)', () => {
    const xtermEl = document.createElement('div');
    xtermEl.className = 'xterm';
    document.body.appendChild(xtermEl);

    isTerminalDragActive();
    xtermEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(isTerminalDragActive()).toBe(true);

    // Mouse released OUTSIDE the terminal (the whole point of xterm's
    // document-level listeners).
    document.dispatchEvent(new MouseEvent('mouseup'));
    expect(isTerminalDragActive()).toBe(false);

    document.body.removeChild(xtermEl);
  });

  it('stays active across window blur while the button is still held', () => {
    // Regression for the first hardening pass's own gap: a `blur` clear ran on
    // Alt+Tab / a click into another window, but the button is still held and
    // xterm's document listeners are still armed — clearing there un-guarded
    // the exact race the guard exists for.
    const xtermEl = document.createElement('div');
    xtermEl.className = 'xterm';
    document.body.appendChild(xtermEl);

    isTerminalDragActive();
    xtermEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(isTerminalDragActive()).toBe(true);

    window.dispatchEvent(new Event('blur'));
    expect(isTerminalDragActive()).toBe(true);

    // Still guarded once focus returns with the button down (buttons: 1).
    window.dispatchEvent(new Event('focus'));
    document.dispatchEvent(new MouseEvent('mousemove', { buttons: 1 }));
    expect(isTerminalDragActive()).toBe(true);

    document.body.removeChild(xtermEl);
  });

  it('hands xterm a mouseup when the release happened off-window', () => {
    // The release we never saw: the button came up outside the window, so no
    // mouseup reached the document and xterm's own listeners are still armed.
    // Merely clearing our flag would let dispose proceed and leave xterm's
    // stale listener to throw on the next mouseup anywhere on the page, so the
    // guard synthesizes the mouseup xterm is waiting for instead.
    const xtermEl = document.createElement('div');
    xtermEl.className = 'xterm';
    document.body.appendChild(xtermEl);

    // Stand in for xterm's document-level mouseup listener.
    const xtermMouseUp = vi.fn();
    document.addEventListener('mouseup', xtermMouseUp);

    isTerminalDragActive();
    xtermEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(isTerminalDragActive()).toBe(true);

    document.dispatchEvent(new MouseEvent('mousemove', { buttons: 0, clientX: 42, clientY: 24 }));

    expect(xtermMouseUp).toHaveBeenCalledTimes(1);
    // Coordinates come from the live pointer so the mouse report is real.
    const ev = xtermMouseUp.mock.calls[0][0] as MouseEvent;
    expect([ev.clientX, ev.clientY]).toEqual([42, 24]);
    expect(ev.buttons).toBe(0);
    expect(isTerminalDragActive()).toBe(false);

    document.removeEventListener('mouseup', xtermMouseUp);
    document.body.removeChild(xtermEl);
  });

  it('synthesizes the mouseup once, not once per mousemove', () => {
    const xtermEl = document.createElement('div');
    xtermEl.className = 'xterm';
    document.body.appendChild(xtermEl);

    const xtermMouseUp = vi.fn();
    document.addEventListener('mouseup', xtermMouseUp);

    isTerminalDragActive();
    xtermEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    document.dispatchEvent(new MouseEvent('mousemove', { buttons: 0 }));
    document.dispatchEvent(new MouseEvent('mousemove', { buttons: 0 }));
    document.dispatchEvent(new MouseEvent('mousemove', { buttons: 0 }));

    // Disarmed by the first one — later moves are ordinary pointer traffic.
    expect(xtermMouseUp).toHaveBeenCalledTimes(1);

    document.removeEventListener('mouseup', xtermMouseUp);
    document.body.removeChild(xtermEl);
  });

  it('does not clear on mousemove while a button is still held (drag in progress)', () => {
    const xtermEl = document.createElement('div');
    xtermEl.className = 'xterm';
    document.body.appendChild(xtermEl);

    isTerminalDragActive();
    xtermEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    document.dispatchEvent(new MouseEvent('mousemove', { buttons: 1 }));
    expect(isTerminalDragActive()).toBe(true);

    document.body.removeChild(xtermEl);
  });

  it('installs listeners only once across multiple calls', () => {
    // Spy BEFORE the first call so registration counts are observable.
    // Repeated getter calls must not re-register document/window listeners —
    // each call after the first is a flag read.
    const docSpy = vi.spyOn(document, 'addEventListener');
    const winSpy = vi.spyOn(window, 'addEventListener');

    isTerminalDragActive();
    // First call installs three capture-phase document listeners: mousedown,
    // mouseup, mousemove. Nothing is installed on window (the old blur clear
    // was removed — see the blur test above).
    expect(docSpy).toHaveBeenCalledTimes(3);
    expect(winSpy).not.toHaveBeenCalled();

    isTerminalDragActive();
    isTerminalDragActive();
    // Subsequent calls are pure flag reads — no re-registration.
    expect(docSpy).toHaveBeenCalledTimes(3);
    expect(winSpy).not.toHaveBeenCalled();

    // Existing drag-activation behavior still holds after repeated calls.
    const xtermEl = document.createElement('div');
    xtermEl.className = 'xterm';
    document.body.appendChild(xtermEl);

    xtermEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(isTerminalDragActive()).toBe(true);

    document.body.removeChild(xtermEl);
    docSpy.mockRestore();
    winSpy.mockRestore();
  });

  it('detects a drag that started before any cleanup read (#582 regression)', () => {
    // The original bug: the mousedown listener was installed lazily from the
    // cleanup path (isTerminalDragActive), so a drag whose mousedown happened
    // before the first read was missed and dispose fired mid-drag. Once the
    // listener is installed (here by the first getter call, in production by
    // the mount effect), a selection that starts before the cleanup read must
    // still report active so dispose is deferred.
    isTerminalDragActive(); // install listeners

    const xtermEl = document.createElement('div');
    xtermEl.className = 'xterm';
    document.body.appendChild(xtermEl);

    // Drag starts — no isTerminalDragActive() call in between.
    xtermEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));

    // The cleanup read happens later and must see the active drag.
    expect(isTerminalDragActive()).toBe(true);

    document.body.removeChild(xtermEl);
  });
});

describe('deferred terminal disposal (#582)', () => {
  // Starts a drag on a real .xterm element so isTerminalDragActive() is true.
  function startDrag(): HTMLElement {
    const xtermEl = document.createElement('div');
    xtermEl.className = 'xterm';
    document.body.appendChild(xtermEl);
    isTerminalDragActive(); // install listeners
    xtermEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    return xtermEl;
  }

  beforeEach(() => {
    __resetTerminalDragForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    __resetTerminalDragForTests();
    document.body.innerHTML = '';
  });

  it('disposes synchronously when no drag is active', () => {
    const dispose = vi.fn();
    disposeWhenDragEnds(dispose);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('defers disposal until the drag is released', () => {
    startDrag();
    const dispose = vi.fn();

    disposeWhenDragEnds(dispose);
    expect(dispose).not.toHaveBeenCalled();

    // A long selection must not be cut down mid-drag.
    vi.advanceTimersByTime(10_000);
    expect(dispose).not.toHaveBeenCalled();

    document.dispatchEvent(new MouseEvent('mouseup'));
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes on the release the terminal never saw (off-window mouseup)', () => {
    // The guard synthesizes the missing mouseup, which both disarms xterm and
    // satisfies this pending disposal — no waiting for the backstop.
    startDrag();
    const dispose = vi.fn();
    disposeWhenDragEnds(dispose, { intervalMs: 1000, maxWaits: 5 });

    document.dispatchEvent(new MouseEvent('mousemove', { buttons: 0 }));
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes on the next re-check if the drag ends without any mouseup', () => {
    // Defensive: should the flag ever clear by a path that does not dispatch a
    // mouseup, the pending listener never fires and the backstop must catch it.
    startDrag();
    const dispose = vi.fn();
    disposeWhenDragEnds(dispose, { intervalMs: 1000, maxWaits: 5 });

    __resetTerminalDragForTests();
    expect(dispose).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('force-disposes after maxWaits and reports it', () => {
    startDrag(); // never released — a stuck button
    const dispose = vi.fn();
    const onForce = vi.fn();

    disposeWhenDragEnds(dispose, { intervalMs: 1000, maxWaits: 3, onForce });

    vi.advanceTimersByTime(2000);
    expect(dispose).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(onForce).toHaveBeenCalledWith(3000);
  });

  it('releases the mouseup listener and timer once disposed', () => {
    startDrag();
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const dispose = vi.fn();

    disposeWhenDragEnds(dispose, { intervalMs: 1000, maxWaits: 3 });
    document.dispatchEvent(new MouseEvent('mouseup'));
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledWith('mouseup', expect.any(Function));

    // Neither a second mouseup nor the elapsed backstop can dispose again.
    document.dispatchEvent(new MouseEvent('mouseup'));
    vi.advanceTimersByTime(10_000);
    expect(dispose).toHaveBeenCalledTimes(1);

    removeSpy.mockRestore();
  });

  it('disposes every terminal deferred concurrently on one mouseup', () => {
    // Workspace switch tearing down N terminals mid-drag.
    startDrag();
    const disposals = [vi.fn(), vi.fn(), vi.fn()];
    for (const d of disposals) disposeWhenDragEnds(d);
    expect(disposals.every((d) => d.mock.calls.length === 0)).toBe(true);

    document.dispatchEvent(new MouseEvent('mouseup'));
    for (const d of disposals) expect(d).toHaveBeenCalledTimes(1);
  });

  it('swallows a throw from an already-disposed terminal', () => {
    const dispose = vi.fn(() => { throw new Error('already disposed'); });
    expect(() => disposeWhenDragEnds(dispose)).not.toThrow();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
