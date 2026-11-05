// @vitest-environment jsdom
//
// #3088 — a custom keybinding on a digit, such as the shipped macOS Ctrl+7 /
// Ctrl+8 defaults, fires on Control and the physical digit key on a layout
// whose digit row needs Shift for the digit (French AZERTY types `!` or `_`
// there). A binding recorded on the layout still wins over that fallback.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createWorkspace } from '../../../shared/types';
import { useStore } from '../../stores';
import { customKeybindingFor, useKeyboard } from '../useKeyboard';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ctrl = (key: string, code: string, shift = false) => ({ ctrl: true, shift, alt: false, key, code });
const bindings = (...keys: string[]) => keys.map((key) => ({ key, command: key }));

describe('customKeybindingFor (#3088)', () => {
  it('matches a digit binding by the physical digit key when the layout types another key', () => {
    expect(customKeybindingFor(bindings('Ctrl+7', 'Ctrl+8'), ctrl('_', 'Digit8'))?.key).toBe('Ctrl+8');
    expect(customKeybindingFor(bindings('Ctrl+7', 'Ctrl+8'), ctrl('è', 'Digit7'))?.key).toBe('Ctrl+7');
  });

  it('lets a binding recorded on the layout win over the physical digit', () => {
    expect(customKeybindingFor(bindings('Ctrl+8', 'Ctrl+_'), ctrl('_', 'Digit8'))?.key).toBe('Ctrl+_');
    expect(customKeybindingFor(bindings('Ctrl+8', 'Ctrl+Shift+8'), ctrl('8', 'Digit8', true))?.key).toBe('Ctrl+Shift+8');
  });

  it('keeps the modifiers, and falls back only for the digit row', () => {
    expect(customKeybindingFor(bindings('Ctrl+8'), ctrl('8', 'Digit8', true))).toBeUndefined();
    expect(customKeybindingFor(bindings('Ctrl+8'), ctrl('_', 'Minus'))).toBeUndefined();
    expect(customKeybindingFor(bindings('Ctrl+A'), ctrl('q', 'KeyA'))).toBeUndefined();
  });
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'darwin',
    window: { hide: vi.fn() },
    pty: { dispose: vi.fn(), create: vi.fn(), write: vi.fn() },
  };
  const ws = createWorkspace('one');
  act(() => {
    useStore.setState((state) => {
      state.workspaces = [ws];
      state.activeWorkspaceId = ws.id;
      state.shortcutOverrides = {};
      state.customKeybindings = [{ key: 'Ctrl+8', label: 'resume', command: 'claude --resume' }] as typeof state.customKeybindings;
      state.setPrefixMode(false);
    });
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  function Harness(): null {
    useKeyboard();
    return null;
  }
  act(() => root.render(React.createElement(Harness)));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useKeyboard — a digit custom keybinding on an AZERTY layout (#3088)', () => {
  it('runs on Control and the physical 8 key', () => {
    const event = new KeyboardEvent('keydown', { key: '_', code: 'Digit8', ctrlKey: true, bubbles: true, cancelable: true });
    act(() => { window.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
  });
});
