import { useEffect } from 'react';
import { useStore } from '../stores';

/**
 * Convert a KeyboardEvent into a normalized key combo string.
 * e.g. Ctrl+Shift held, key='1' → 'Ctrl+Shift+1'
 *      no modifiers, key='F7' → 'F7'
 */
function formatKeyCombo(ctrl: boolean, shift: boolean, alt: boolean, key: string): string {
  const parts: string[] = [];
  if (ctrl) parts.push('Ctrl');
  if (shift) parts.push('Shift');
  if (alt) parts.push('Alt');
  let normalizedKey = key;
  if (key.length === 1) normalizedKey = key.toUpperCase();
  parts.push(normalizedKey);
  return parts.join('+');
}

export function useKeyboard() {
  const store = useStore;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey;
      const shift = e.shiftKey;
      const alt = e.altKey;
      const key = e.key;

      // Skip shortcuts when typing in input/textarea/contenteditable
      // Exception: function keys (F1-F12) and custom keybindings should always work
      const tag = (e.target as HTMLElement)?.tagName;
      const isEditable = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable;
      const isFunctionKey = key.length > 1 && /^F\d{1,2}$/.test(key);
      if (isEditable && !ctrl && !alt && !isFunctionKey) return;

      // Ctrl+B: Toggle sidebar
      if (ctrl && !shift && !alt && key === 'b') {
        e.preventDefault();
        store.getState().toggleSidebar();
        return;
      }

      // Ctrl+N: New workspace
      if (ctrl && !shift && !alt && key === 'n') {
        e.preventDefault();
        store.getState().addWorkspace();
        return;
      }

      // Ctrl+Shift+W: Close workspace
      if (ctrl && shift && !alt && key === 'W') {
        e.preventDefault();
        const state = store.getState();
        const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
        if (ws) {
          // 워크스페이스 내 모든 PTY 정리
          const disposePtys = (pane: import('../../shared/types').Pane) => {
            if (pane.type === 'leaf') {
              for (const s of pane.surfaces) {
                if (s.ptyId) window.electronAPI.pty.dispose(s.ptyId);
              }
            } else {
              for (const child of pane.children) disposePtys(child);
            }
          };
          disposePtys(ws.rootPane);
        }
        state.removeWorkspace(state.activeWorkspaceId);
        return;
      }

      // Ctrl+1~9: Switch workspace
      if (ctrl && !shift && !alt && key >= '1' && key <= '9') {
        e.preventDefault();
        const { workspaces } = store.getState();
        const idx = key === '9' ? workspaces.length - 1 : parseInt(key) - 1;
        if (idx >= 0 && idx < workspaces.length) {
          store.getState().setActiveWorkspace(workspaces[idx].id);
        }
        return;
      }

      // Ctrl+D: Split right (horizontal)
      if (ctrl && !shift && !alt && key === 'd') {
        e.preventDefault();
        const state = store.getState();
        const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
        if (ws) {
          state.splitPane(ws.activePaneId, 'horizontal');
        }
        return;
      }

      // Ctrl+Shift+D: Split down (vertical)
      if (ctrl && shift && !alt && key === 'D') {
        e.preventDefault();
        const state = store.getState();
        const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
        if (ws) {
          state.splitPane(ws.activePaneId, 'vertical');
        }
        return;
      }

      // Ctrl+T: New surface
      if (ctrl && !shift && !alt && key === 't') {
        e.preventDefault();
        const state = store.getState();
        const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
        if (ws) {
          window.electronAPI.pty.create().then((result: { id: string }) => {
            store.getState().addSurface(ws.activePaneId, result.id, 'Terminal', '');
          });
        }
        return;
      }

      // Ctrl+W: Close surface
      if (ctrl && !shift && !alt && key === 'w') {
        e.preventDefault();
        const state = store.getState();
        const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
        if (!ws) return;
        const findLeaf = (pane: import('../../shared/types').Pane): import('../../shared/types').PaneLeaf | null => {
          if (pane.type === 'leaf' && pane.id === ws.activePaneId) return pane;
          if (pane.type === 'branch') {
            for (const c of pane.children) {
              const found = findLeaf(c);
              if (found) return found;
            }
          }
          return null;
        };
        const activePane = findLeaf(ws.rootPane);
        if (activePane && activePane.activeSurfaceId) {
          const surface = activePane.surfaces.find((s) => s.id === activePane.activeSurfaceId);
          if (surface?.ptyId) {
            window.electronAPI.pty.dispose(surface.ptyId);
          }
          state.closeSurface(activePane.id, activePane.activeSurfaceId);
        }
        return;
      }

      // Ctrl+Shift+]: Next surface
      if (ctrl && shift && !alt && key === ']') {
        e.preventDefault();
        const state = store.getState();
        const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
        if (ws) state.nextSurface(ws.activePaneId);
        return;
      }

      // Ctrl+Shift+[: Previous surface
      if (ctrl && shift && !alt && key === '[') {
        e.preventDefault();
        const state = store.getState();
        const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
        if (ws) state.prevSurface(ws.activePaneId);
        return;
      }

      // Alt+Ctrl+Arrow: Focus pane directionally
      if (ctrl && alt && !shift && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) {
        e.preventDefault();
        const dirMap: Record<string, 'up' | 'down' | 'left' | 'right'> = {
          ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
        };
        store.getState().focusPaneDirection(dirMap[key]);
        return;
      }

      // Ctrl+I: Toggle notification panel
      if (ctrl && !shift && !alt && key === 'i') {
        e.preventDefault();
        store.getState().toggleNotificationPanel();
        return;
      }

      // Ctrl+Shift+M: Toggle message feed panel
      if (ctrl && shift && !alt && key === 'm') {
        e.preventDefault();
        store.getState().toggleMessageFeed();
        return;
      }

      // Ctrl+K: Toggle command palette
      if (ctrl && !shift && !alt && key === 'k') {
        e.preventDefault();
        store.getState().toggleCommandPalette();
        return;
      }

      // Ctrl+,: Toggle settings panel
      if (ctrl && !shift && !alt && key === ',') {
        e.preventDefault();
        store.getState().toggleSettingsPanel();
        return;
      }

      // Ctrl+Shift+U: Jump to latest unread notification's workspace
      if (ctrl && shift && !alt && key === 'U') {
        e.preventDefault();
        const state = store.getState();
        const unread = state.notifications
          .filter((n) => !n.read)
          .sort((a, b) => b.timestamp - a.timestamp);
        if (unread.length > 0) {
          const latest = unread[0];
          state.setActiveWorkspace(latest.workspaceId);
          state.markRead(latest.id);
        }
        return;
      }

      // Ctrl+Shift+R: Rename workspace (triggers inline rename in sidebar)
      // This is handled by the Sidebar component via a custom event
      if (ctrl && shift && !alt && key === 'R') {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('wmux:rename-workspace'));
        return;
      }

      // Ctrl+Shift+L: Open browser panel in a new horizontal split
      if (ctrl && shift && !alt && key === 'L') {
        e.preventDefault();
        const state = store.getState();
        const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
        if (ws) {
          state.splitPane(ws.activePaneId, 'horizontal');
          // After split, the new pane becomes active; add browser surface to it
          const newState = store.getState();
          const newWs = newState.workspaces.find((w) => w.id === newState.activeWorkspaceId);
          if (newWs) {
            newState.addBrowserSurface(newWs.activePaneId);
          }
        }
        return;
      }

      // Ctrl+Shift+X: Enter Vi Copy Mode for terminal scrollback
      // (Ctrl+Shift+C is reserved for clipboard copy)
      if (ctrl && shift && !alt && key === 'X') {
        e.preventDefault();
        store.getState().setViCopyModeActive(true);
        return;
      }

      // Ctrl+F: Toggle terminal search bar
      if (ctrl && !shift && !alt && key === 'f') {
        e.preventDefault();
        store.getState().toggleSearchBar();
        return;
      }

      // Ctrl+Shift+H: Flash active pane to highlight its position
      if (ctrl && shift && !alt && key === 'H') {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('wmux:flash-pane'));
        return;
      }

      // Ctrl+Shift+O: Toggle Company View overlay
      if (ctrl && shift && !alt && key === 'O') {
        e.preventDefault();
        store.getState().toggleCompanyView();
        return;
      }

      // Ctrl+Shift+G: Clear multiview (back to single view)
      if (ctrl && shift && !alt && key === 'G') {
        e.preventDefault();
        store.getState().clearMultiview();
        return;
      }

      // ─── Custom keybindings → terminal input ─────────────────────────
      const { customKeybindings } = store.getState();
      if (customKeybindings.length > 0) {
        const pressed = formatKeyCombo(ctrl, shift, alt, key);
        const match = customKeybindings.find((kb) => kb.key === pressed);
        if (match) {
          e.preventDefault();
          e.stopImmediatePropagation();
          const state = store.getState();
          const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
          if (ws) {
            const findLeaf = (pane: import('../../shared/types').Pane): import('../../shared/types').PaneLeaf | null => {
              if (pane.type === 'leaf' && pane.id === ws.activePaneId) return pane;
              if (pane.type === 'branch') {
                for (const c of pane.children) {
                  const found = findLeaf(c);
                  if (found) return found;
                }
              }
              return null;
            };
            const leaf = findLeaf(ws.rootPane);
            if (leaf) {
              const surface = leaf.surfaces.find((s) => s.id === leaf.activeSurfaceId);
              if (surface?.ptyId) {
                const text = match.sendEnter ? match.command + '\r' : match.command;
                window.electronAPI.pty.write(surface.ptyId, text);
              }
            }
          }
          return;
        }
      }
    };

    // Use capture phase so we run BEFORE xterm's stopPropagation
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);
}
