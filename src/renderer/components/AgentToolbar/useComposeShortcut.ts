import { useEffect } from 'react';
import { useStore } from '../../stores';
import { focusedTerminalPtyId } from '../../utils/focusedSurface';
import { matchesDisabledShortcut } from '../../../shared/keymap';

/**
 * ⌘G / Ctrl+G toggles Rich Input on the focused terminal.
 *
 * Mounted by ToolbarHost ABOVE its enabled gate, because the binding is
 * documented to survive the inject-chrome setting being off. Keeping it inside
 * AgentToolbar tied the shortcut to the bar's own mount, which silently
 * dropped it for anyone on a minimal chrome preset.
 *
 * It only sets `toolbarPopover`; the bar renders the popover. With the bar
 * hidden the state still flips, and the bar holds itself open for it — that is
 * the keyboard route in.
 *
 * #1280 — the modifier set must match EXACTLY, like every other chord gate in
 * the renderer (useTerminalCopyShortcut, useKeyboard's if-chain). The old test
 * was `(ctrlKey || metaKey) && (key === 'g' || key === 'G')`, which accepted a
 * SUPERSET: `key` is 'G' precisely when Shift is held, so Ctrl+Shift+G — the
 * clearMultiview binding (useKeyboard, WMUX_KEYMAP) — also toggled Rich Input,
 * and so did Ctrl+Alt+G. Shift/Alt now disqualify the event, and the platform
 * decides which base modifier owns the chord: ⌘ on macOS (Ctrl+G there is a
 * readline byte), literal Ctrl elsewhere.
 */
export function useComposeShortcut(): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.shiftKey || e.altKey) return;
      const isMac = window.electronAPI?.platform === 'darwin';
      const baseModifier = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!baseModifier) return;
      // Physical `code` as the IME fallback: under a Hangul / non-Latin layout
      // `e.key` is a composed jamo or 'Process', never 'g' (same class as the
      // Ctrl+C / Ctrl+J handlers in useTerminal).
      if (e.key !== 'g' && e.key !== 'G' && e.code !== 'KeyG') return;
      // Key repeat must not flap the popover open and shut.
      if (e.repeat) return;
      // A combo the user switched off in Settings → Shortcuts belongs to the
      // pane; useTerminal's disabled gate writes the byte for it.
      if (matchesDisabledShortcut(
        useStore.getState().disabledShortcuts, e, isMac ? 'darwin' : 'win32',
      )) return;
      // Don't hijack the chord while the user is typing in a field that this
      // toolbar owns (Rich Input's textarea, snippet inputs). The focused
      // terminal's own xterm textarea is NOT one of those — it is the primary
      // entry point and must still toggle.
      const el = e.target as HTMLElement | null;
      if (el?.closest?.('[data-testid="agent-toolbar"], [data-toolbar-owned]')) {
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return;
      }
      const state = useStore.getState();
      const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
      if (!focusedTerminalPtyId(ws)) return;
      e.preventDefault();
      state.setToolbarPopover(state.toolbarPopover === 'rich' ? null : 'rich');
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);
}
