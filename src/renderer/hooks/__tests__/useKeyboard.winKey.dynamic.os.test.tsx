// @vitest-environment jsdom
//
// #1831 — a shortcut recorded on the Win key (Meta+J, shown "Win+J") must run
// while the terminal has focus. The editable-field guard only let Ctrl / Alt
// chords through, so on Windows such a binding was accepted and then dead
// wherever the user types.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useStore } from '../../stores';
import { useKeyboard } from '../useKeyboard';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let textarea: HTMLTextAreaElement;

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
  // Stands in for xterm's helper textarea, where the terminal's keys arrive.
  textarea = document.createElement('textarea');
  document.body.appendChild(textarea);
  textarea.focus();
}

function pressInTextarea(init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => {
    textarea.dispatchEvent(event);
  });
  return event;
}

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'win32',
    window: { hide: vi.fn() },
    pty: { dispose: vi.fn(), create: vi.fn(), write: vi.fn() },
  };
  act(() => {
    useStore.setState((state) => {
      state.shortcutOverrides = { toggleToolbarPin: 'Meta+J' };
      state.agentToolbarPinned = false;
      state.keyCaptureActive = false;
      state.setPrefixMode(false);
    });
  });
  mount();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  textarea.remove();
});

describe('Win-key shortcuts from the terminal (Windows)', () => {
  it('runs a Win+J binding while a textarea has focus', () => {
    const event = pressInTextarea({ key: 'j', code: 'KeyJ', metaKey: true });
    expect(useStore.getState().agentToolbarPinned).toBe(true);
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves a Win chord that is no shortcut to the field', () => {
    const event = pressInTextarea({ key: 'k', code: 'KeyK', metaKey: true });
    expect(useStore.getState().agentToolbarPinned).toBe(false);
    expect(event.defaultPrevented).toBe(false);
  });
});
