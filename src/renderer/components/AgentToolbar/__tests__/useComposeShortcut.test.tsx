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
let focusedPtyId: string | null = 'pty-1';
vi.mock('../../../utils/focusedSurface', () => ({
  focusedTerminalPtyId: () => focusedPtyId,
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

/**
 * Turn a stored combo ('Ctrl+Shift+ArrowUp') into the event that combo
 * actually produces on `platform` — ⌘ substituted for Ctrl in the cmdOrCtrl
 * family under macOS, the way useKeyboard dispatches it, with `code` filled in
 * from the letter so the physical fallback is exercised too. The first version
 * of this helper set neither `metaKey` nor `code` and had a dead ternary, so it
 * only ever tested the win32 literal-Ctrl spelling (review on #1286).
 */
function eventForCombo(
  combo: string,
  platform: 'win32' | 'darwin',
  literalCtrl: boolean,
): KeyboardEventInit {
  const parts = combo.split('+');
  // 'Ctrl+Shift++' → the trailing '+' is the key, not a separator.
  const key = parts.pop() || '+';
  const wantsCtrl = parts.includes('Ctrl');
  const useMeta = wantsCtrl && platform === 'darwin' && !literalCtrl;
  return {
    key,
    code: /^[A-Za-z]$/.test(key) ? `Key${key.toUpperCase()}` : key,
    ctrlKey: wantsCtrl && !useMeta,
    metaKey: useMeta,
    shiftKey: parts.includes('Shift'),
    altKey: parts.includes('Alt'),
  };
}

beforeEach(() => {
  setToolbarPopover.mockClear();
  focusedPtyId = 'pty-1';
  state = { workspaces: [], activeWorkspaceId: 'w1', toolbarPopover: null, disabledShortcuts: [], inspectModeActive: false, setToolbarPopover };
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

  it('does not open Rich Input when no terminal surface is focused', () => {
    // A browser / editor / remote surface as the active leaf makes
    // focusedTerminalPtyId null. The pane gate cannot see that, which is why
    // only the active-leaf terminal opts into swallowing the key
    // (ownsComposeShortcut) — elsewhere it stays a pane byte.
    focusedPtyId = null;
    press({ key: 'g', code: 'KeyG', ctrlKey: true });
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

  it('no other keymap combo reaches Rich Input, on either platform', () => {
    // The converse of the Ctrl+Shift+G case, asked of every binding the
    // renderer owns — shift-bearing ones first (the superset bug fired on
    // Ctrl+Shift+G and would have on any shifted G spelling), but the whole
    // table is cheap and catches the next loose gate too.
    const shifted = WMUX_KEYMAP.filter((k) => k.combo.includes('+Shift+'));
    expect(shifted.length).toBeGreaterThan(10);
    for (const platform of ['win32', 'darwin'] as const) {
      (window as unknown as { electronAPI?: unknown }).electronAPI = { platform };
      for (const entry of WMUX_KEYMAP) {
        if (entry.combo === 'Ctrl+G') continue;
        setToolbarPopover.mockClear();
        press(eventForCombo(entry.combo, platform, entry.literalCtrl === true));
        expect(setToolbarPopover, `${entry.combo} on ${platform} must not toggle Rich Input`)
          .not.toHaveBeenCalled();
      }
    }
  });

  it('defers while an IME composition is open', () => {
    // Hangul preedit: `key` is 'Process' / a jamo and the physical KeyG
    // fallback would otherwise pop the popover mid-word. Every other
    // ctrl-letter path defers the same way, and xterm drops the keyCode-229
    // keydown, so the key is a no-op rather than a byte.
    press({ key: 'Process', code: 'KeyG', ctrlKey: true, isComposing: true });
    expect(setToolbarPopover).not.toHaveBeenCalled();
  });

  it('yields while inspect mode owns the keyboard', () => {
    state.inspectModeActive = true;
    press({ key: 'g', code: 'KeyG', ctrlKey: true });
    expect(setToolbarPopover).not.toHaveBeenCalled();
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
