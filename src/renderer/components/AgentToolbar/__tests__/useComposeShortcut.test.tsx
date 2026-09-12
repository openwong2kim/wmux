// @vitest-environment jsdom
//
// #1280 — "Ctrl+G always activates Rich Input". Reported on Windows 11 /
// PowerShell 5.1 against 3.52.0: Ctrl+G wrote `^G` to the pane AND opened the
// popover, while Ctrl+Shift+G opened the popover alone.
//
// Both halves were one class of defect: this chord gate tested a SUPERSET of
// the modifier set (`(ctrlKey || metaKey) && (key === 'g' || key === 'G')`).
// `key` is 'G' exactly when Shift is held, so Ctrl+Shift+G — which
// WMUX_KEYMAP/useKeyboard own as clearMultiview — toggled Rich Input too.
// These tests pin an EXACT modifier match, in both directions, plus the same
// question asked of every other shift-bearing combo the keymap declares.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { WMUX_KEYMAP } from '../../../../shared/keymap';
import { useComposeShortcut } from '../useComposeShortcut';

const setToolbarPopover = vi.fn();
let state: Record<string, unknown>;

vi.mock('../../../stores', () => ({
  useStore: { getState: () => state },
}));
vi.mock('../../../utils/focusedSurface', () => ({
  focusedTerminalPtyId: () => 'pty-1',
}));


let container: HTMLDivElement;
let root: Root;

function Probe() {
  useComposeShortcut();
  return null;
}

function press(init: KeyboardEventInit): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  });
}

/** Split a stored combo ('Ctrl+Shift+ArrowUp') into a dispatchable event. */
function eventForCombo(combo: string): KeyboardEventInit {
  const parts = combo.split('+');
  // 'Ctrl+Shift++' → the trailing '+' is the key, not a separator.
  const key = parts.pop() || '+';
  return {
    ctrlKey: parts.includes('Ctrl'),
    shiftKey: parts.includes('Shift'),
    altKey: parts.includes('Alt'),
    key: key.length === 1 ? key : key,
  };
}

beforeEach(() => {
  setToolbarPopover.mockClear();
  state = { workspaces: [], activeWorkspaceId: 'w1', toolbarPopover: null, disabledShortcuts: [], setToolbarPopover };
  (window as unknown as { electronAPI?: unknown }).electronAPI = { platform: 'win32' };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root.render(createElement(Probe)); });
});

afterEach(() => {
  act(() => { root.unmount(); });
  container.remove();
});

describe('useComposeShortcut modifier matching (#1280)', () => {
  it('Ctrl+G toggles Rich Input and consumes the key', () => {
    const e = new KeyboardEvent('keydown', { key: 'g', code: 'KeyG', ctrlKey: true, bubbles: true, cancelable: true });
    act(() => { document.dispatchEvent(e); });
    expect(setToolbarPopover).toHaveBeenCalledWith('rich');
    expect(e.defaultPrevented).toBe(true);
  });

  it('Ctrl+Shift+G does NOT toggle Rich Input (it is clearMultiview)', () => {
    press({ key: 'G', code: 'KeyG', ctrlKey: true, shiftKey: true });
    expect(setToolbarPopover).not.toHaveBeenCalled();
  });

  it('Ctrl+Alt+G does NOT toggle Rich Input', () => {
    press({ key: 'g', code: 'KeyG', ctrlKey: true, altKey: true });
    expect(setToolbarPopover).not.toHaveBeenCalled();
  });

  it('a bare G does NOT toggle Rich Input', () => {
    press({ key: 'g', code: 'KeyG' });
    expect(setToolbarPopover).not.toHaveBeenCalled();
  });

  it('matches the physical KeyG under an IME (key is "Process")', () => {
    press({ key: 'Process', code: 'KeyG', ctrlKey: true });
    expect(setToolbarPopover).toHaveBeenCalledWith('rich');
  });

  it('yields when the user disabled Ctrl+G in Settings → Shortcuts', () => {
    state.disabledShortcuts = ['Ctrl+G'];
    press({ key: 'g', code: 'KeyG', ctrlKey: true });
    expect(setToolbarPopover).not.toHaveBeenCalled();
  });

  it('key repeat does not flap the popover', () => {
    press({ key: 'g', code: 'KeyG', ctrlKey: true, repeat: true });
    expect(setToolbarPopover).not.toHaveBeenCalled();
  });

  it('no shift-bearing keymap combo reaches Rich Input', () => {
    // The converse of the Ctrl+Shift+G case, asked of every shifted binding
    // the renderer owns — the superset bug would have fired on any of them
    // whose letter happens to be G, and the shape of it on all of them.
    const shifted = WMUX_KEYMAP.filter((k) => k.combo.includes('+Shift+'));
    expect(shifted.length).toBeGreaterThan(10);
    for (const entry of shifted) {
      setToolbarPopover.mockClear();
      press(eventForCombo(entry.combo));
      expect(setToolbarPopover, `${entry.combo} must not toggle Rich Input`).not.toHaveBeenCalled();
    }
  });

  describe('macOS', () => {
    beforeEach(() => {
      (window as unknown as { electronAPI?: unknown }).electronAPI = { platform: 'darwin' };
    });

    it('⌘G toggles Rich Input', () => {
      press({ key: 'g', code: 'KeyG', metaKey: true });
      expect(setToolbarPopover).toHaveBeenCalledWith('rich');
    });

    it('Ctrl+G does NOT toggle Rich Input on macOS (it is a readline byte)', () => {
      press({ key: 'g', code: 'KeyG', ctrlKey: true });
      expect(setToolbarPopover).not.toHaveBeenCalled();
    });

    it('⌘+Shift+G does NOT toggle Rich Input on macOS', () => {
      press({ key: 'G', code: 'KeyG', metaKey: true, shiftKey: true });
      expect(setToolbarPopover).not.toHaveBeenCalled();
    });
  });
});
