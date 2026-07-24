// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
    // Calling isTerminalDragActive() multiple times must not re-register
    // document listeners — each call after the first is a flag read.
    isTerminalDragActive();
    isTerminalDragActive();
    isTerminalDragActive();

    const xtermEl = document.createElement('div');
    xtermEl.className = 'xterm';
    document.body.appendChild(xtermEl);

    xtermEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(isTerminalDragActive()).toBe(true);

    document.body.removeChild(xtermEl);
  });
});
