// @vitest-environment jsdom
//
// Dynamic verification for #171 terminal font zoom.
//
// Unlike the source-invariant checks in useKeyboard.test.ts (which string-match
// the handler), this suite mounts the REAL useKeyboard hook against the REAL
// zustand store and dispatches REAL KeyboardEvents, then asserts the live
// terminalFontSize moved. It is the automated stand-in for clicking around the
// running app: key in → store out, through the actual capture-phase listener.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useKeyboard } from '../useKeyboard';
import { useStore } from '../../stores';

// React 19 logs a warning unless the test env flags act() support.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function mount(): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  function Harness(): null {
    useKeyboard();
    return null;
  }
  act(() => {
    root.render(React.createElement(Harness));
  });
}

function unmount(): void {
  act(() => {
    root.unmount();
  });
  container.remove();
}

/** Dispatch a real keydown on window (capture-phase listener picks it up). */
function press(init: KeyboardEventInit): void {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
}

const fontSize = (): number => useStore.getState().terminalFontSize;

beforeEach(() => {
  // Minimal electronAPI surface useKeyboard reads at mount + in adjacent paths.
  // The zoom path itself only touches the store, but createPrefixActions and the
  // platform read run on mount.
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'win32',
    window: { hide: vi.fn() },
    pty: { dispose: vi.fn(), create: vi.fn(), write: vi.fn() },
  };
  // Deterministic starting point — store is a module singleton across tests.
  act(() => {
    useStore.getState().setTerminalFontSize(14);
    useStore.getState().setPrefixMode(false);
  });
  mount();
});

afterEach(() => {
  unmount();
});

describe('#171 zoom — real key events move the live font size', () => {
  it('Ctrl+= zooms in one step (14 → 15)', () => {
    press({ ctrlKey: true, key: '=', code: 'Equal' });
    expect(fontSize()).toBe(15);
  });

  it('Ctrl+- zooms out one step (14 → 13)', () => {
    press({ ctrlKey: true, key: '-', code: 'Minus' });
    expect(fontSize()).toBe(13);
  });

  it('Ctrl+0 resets to the default (16 → 14)', () => {
    act(() => useStore.getState().setTerminalFontSize(16));
    press({ ctrlKey: true, key: '0', code: 'Digit0' });
    expect(fontSize()).toBe(14);
  });

  it('Ctrl++ (Shift+=) also zooms in — no need to release Shift', () => {
    press({ ctrlKey: true, shiftKey: true, key: '+', code: 'Equal' });
    expect(fontSize()).toBe(15);
  });

  it('Numpad +/- zoom by physical code', () => {
    press({ ctrlKey: true, key: '+', code: 'NumpadAdd' });
    expect(fontSize()).toBe(15);
    press({ ctrlKey: true, key: '-', code: 'NumpadSubtract' });
    expect(fontSize()).toBe(14);
  });

  it('zooms under a Hangul IME (e.key = "Process", resolved by code)', () => {
    // With an active IME e.key arrives as 'Process'; the handler falls back to
    // the physical code so zoom still fires. This is the #171 regression guard.
    press({ ctrlKey: true, key: 'Process', code: 'Equal' });
    expect(fontSize()).toBe(15);
  });

  it('clamps at the maximum (24) — extra zoom-ins do not overshoot', () => {
    for (let i = 0; i < 20; i++) press({ ctrlKey: true, key: '=', code: 'Equal' });
    expect(fontSize()).toBe(24);
  });

  it('clamps at the minimum (12) — extra zoom-outs do not undershoot', () => {
    for (let i = 0; i < 20; i++) press({ ctrlKey: true, key: '-', code: 'Minus' });
    expect(fontSize()).toBe(12);
  });

  it('does not zoom without Ctrl (bare "=" is a normal keystroke)', () => {
    press({ key: '=', code: 'Equal' });
    expect(fontSize()).toBe(14);
  });

  it('Ctrl+1 stays a workspace switch — it must not change the font size', () => {
    press({ ctrlKey: true, key: '1', code: 'Digit1' });
    expect(fontSize()).toBe(14);
  });
});
