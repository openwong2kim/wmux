// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isTerminalDragActive, __resetTerminalDragForTests } from '../useTerminal';

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

  it('clears on window blur (mouse left the window mid-drag)', () => {
    const xtermEl = document.createElement('div');
    xtermEl.className = 'xterm';
    document.body.appendChild(xtermEl);

    isTerminalDragActive();
    xtermEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(isTerminalDragActive()).toBe(true);

    window.dispatchEvent(new Event('blur'));
    expect(isTerminalDragActive()).toBe(false);

    document.body.removeChild(xtermEl);
  });

  it('installs listeners only once across multiple calls', () => {
    // Spy BEFORE the first call so registration counts are observable.
    // Repeated getter calls must not re-register document/window listeners —
    // each call after the first is a flag read.
    const docSpy = vi.spyOn(document, 'addEventListener');
    const winSpy = vi.spyOn(window, 'addEventListener');

    isTerminalDragActive();
    // First call installs: capture-phase mousedown + mouseup on document,
    // blur on window.
    expect(docSpy).toHaveBeenCalledTimes(2);
    expect(winSpy).toHaveBeenCalledTimes(1);

    isTerminalDragActive();
    isTerminalDragActive();
    // Subsequent calls are pure flag reads — no re-registration.
    expect(docSpy).toHaveBeenCalledTimes(2);
    expect(winSpy).toHaveBeenCalledTimes(1);

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
