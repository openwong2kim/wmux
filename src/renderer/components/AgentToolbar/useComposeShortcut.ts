import { useEffect } from 'react';
import { useStore } from '../../stores';
import { focusedTerminalPtyId } from '../../utils/focusedSurface';

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
 */
export function useComposeShortcut(): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || (e.key !== 'g' && e.key !== 'G')) return;
      // Key repeat must not flap the popover open and shut.
      if (e.repeat) return;
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
