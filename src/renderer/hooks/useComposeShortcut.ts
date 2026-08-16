import { useEffect } from 'react';
import { useStore } from '../stores';
import { focusedTerminalPtyId } from '../utils/focusedSurface';

/**
 * ⌘G / Ctrl+G always opens Compose — even when inject chrome is hidden.
 * Lives at the layout so it survives the old AgentToolbar unmount.
 *
 * Does not steal the shortcut while the operator is typing inside Compose
 * itself. The focused terminal's xterm textarea still toggles Compose; that
 * is the primary entry.
 */
export function useComposeShortcut(): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || (e.key !== 'g' && e.key !== 'G')) return;
      const el = e.target as HTMLElement | null;
      if (el && typeof el.closest === 'function' && el.closest('[data-compose-host]')) {
        const tag = el.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return;
      }
      const state = useStore.getState();
      const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
      const ptyId = focusedTerminalPtyId(ws);
      if (!ptyId || !ws) return;
      e.preventDefault();
      if (state.toolbarPopover === 'rich') {
        state.closeCompose();
        return;
      }
      state.openCompose({ paneId: ws.activePaneId, ptyId });
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);
}
