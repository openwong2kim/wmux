import { useEffect, useRef } from 'react';
import { useStore } from '../stores';
import { findLeaf } from '../../shared/paneUtils';
import { terminalRegistry } from './useTerminal';
import { t } from '../i18n';

// Lightweight bookmark toast — reuses the same DOM element pattern as showCopyToast
let bookmarkToastTimer: ReturnType<typeof setTimeout> | null = null;
function showBookmarkToast() {
  let el = document.getElementById('wmux-bookmark-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'wmux-bookmark-toast';
    el.style.cssText = 'position:fixed;bottom:28px;left:50%;transform:translateX(-50%);background:var(--accent-yellow);color:var(--bg-base);font-family:monospace;font-size:11px;font-weight:600;padding:3px 12px;border-radius:4px;z-index:9999;pointer-events:none;opacity:0;transition:opacity 0.2s';
    document.body.appendChild(el);
  }
  el.textContent = t('terminal.bookmarkAdded');
  el.style.opacity = '1';
  if (bookmarkToastTimer) clearTimeout(bookmarkToastTimer);
  bookmarkToastTimer = setTimeout(() => { el!.style.opacity = '0'; }, 1200);
}

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

/** Prefix mode timeout duration in ms */
const PREFIX_TIMEOUT_MS = 2000;
/** How long to show "Unknown: [key]" error */
const PREFIX_ERROR_DISPLAY_MS = 500;

/** Dispose all PTYs inside a pane tree */
function disposePanePtys(pane: import('../../shared/types').Pane): void {
  if (pane.type === 'leaf') {
    for (const s of pane.surfaces) {
      if (s.ptyId) window.electronAPI.pty.dispose(s.ptyId);
    }
  } else {
    for (const child of pane.children) disposePanePtys(child);
  }
}

export function useKeyboard() {
  const store = useStore;
  const prefixTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Action registry — maps action IDs to implementations
    const prefixActions: Record<string, () => void> = {
      splitHorizontal: () => {
        const state = store.getState();
        const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
        if (ws) state.splitPane(ws.activePaneId, 'horizontal');
      },
      splitVertical: () => {
        const state = store.getState();
        const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
        if (ws) state.splitPane(ws.activePaneId, 'vertical');
      },
      closePane: () => {
        const state = store.getState();
        const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
        if (!ws) return;
        const activeLeaf = findLeaf(ws.rootPane, ws.activePaneId);
        if (activeLeaf) disposePanePtys(activeLeaf);
        state.closePane(ws.activePaneId);
      },
      newWorkspace: () => { store.getState().addWorkspace(); },
      nextWorkspace: () => {
        const { workspaces, activeWorkspaceId } = store.getState();
        if (workspaces.length <= 1) return;
        const currentIdx = workspaces.findIndex((w) => w.id === activeWorkspaceId);
        const nextIdx = (currentIdx + 1) % workspaces.length;
        store.getState().setActiveWorkspace(workspaces[nextIdx].id);
      },
      prevWorkspace: () => {
        const { workspaces, activeWorkspaceId } = store.getState();
        if (workspaces.length <= 1) return;
        const currentIdx = workspaces.findIndex((w) => w.id === activeWorkspaceId);
        const prevIdx = (currentIdx - 1 + workspaces.length) % workspaces.length;
        store.getState().setActiveWorkspace(workspaces[prevIdx].id);
      },
      hideWindow: () => { window.electronAPI.window.hide(); },
      toggleZoom: () => {
        const state = store.getState();
        const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
        if (ws) state.togglePaneZoom(ws.activePaneId);
      },
      commandPalette: () => { store.getState().toggleCommandPalette(); },
      focusUp: () => { store.getState().focusPaneDirection('up'); },
      focusDown: () => { store.getState().focusPaneDirection('down'); },
      focusLeft: () => { store.getState().focusPaneDirection('left'); },
      focusRight: () => { store.getState().focusPaneDirection('right'); },
    };
    /** Clear the prefix timeout if running */
    const clearPrefixTimeout = () => {
      if (prefixTimeoutRef.current !== null) {
        clearTimeout(prefixTimeoutRef.current);
        prefixTimeoutRef.current = null;
      }
    };

    /** Exit prefix mode and clear timeout */
    const exitPrefixMode = () => {
      clearPrefixTimeout();
      store.getState().setPrefixMode(false);
    };

    // OS-aware shortcut mapping (DX D1 decision):
    //   • Most shortcuts (split, palette, settings, …) use ⌘ on macOS, Ctrl elsewhere.
    //   • tmux prefix (Ctrl+B), sidebar toggle (Ctrl+Shift+B) and bookmark (Ctrl+Shift+M)
    //     keep literal Ctrl on every OS to honor tmux convention.
    // On non-macOS systems cmdOrCtrl === literalCtrl, so Windows/Linux behaviour is
    // byte-identical to the previous implementation.
    const isMac = window.electronAPI.platform === 'darwin';

    const handler = (e: KeyboardEvent) => {
      const cmdOrCtrl = isMac ? e.metaKey : e.ctrlKey;
      const literalCtrl = e.ctrlKey;
      const shift = e.shiftKey;
      const alt = e.altKey;
      const key = e.key;
      const code = e.code;

      // Read prefix mode from store (fresh, no stale closure)
      const prefixMode = store.getState().prefixMode;

      // ─── Prefix mode: intercept the next key ───────────────────────
      if (prefixMode) {
        e.preventDefault();
        e.stopImmediatePropagation();
        clearPrefixTimeout();

        // Escape → just exit
        if (key === 'Escape') {
          exitPrefixMode();
          return;
        }

        // Ignore bare modifier keys (Shift, Control, Alt, Meta)
        if (['Shift', 'Control', 'Alt', 'Meta'].includes(key)) {
          return;
        }

        // Look up action from store's prefix bindings
        const { prefixConfig } = store.getState();
        const actionId = prefixConfig.bindings[key];
        const action = actionId ? prefixActions[actionId] : undefined;
        if (action) {
          action();
          exitPrefixMode();
          return;
        }

        // Unknown key → show error briefly, then exit
        const displayKey = key.length === 1 ? key : key;
        store.getState().setPrefixError(`Unknown: ${displayKey}`);
        store.getState().setPrefixMode(false);
        setTimeout(() => {
          store.getState().setPrefixError(null);
        }, PREFIX_ERROR_DISPLAY_MS);
        return;
      }

      // ─── Normal mode shortcuts below ───────────────────────────────

      // Skip shortcuts when typing in input/textarea/contenteditable
      // Exception: function keys (F1-F12) and custom keybindings should always work
      const tag = (e.target as HTMLElement)?.tagName;
      const isEditable = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable;
      const isFunctionKey = key.length > 1 && /^F\d{1,2}$/.test(key);
      // Allow shortcuts to fire inside editable fields when any modifier (Ctrl,
      // ⌘, or Alt) is pressed — covers both literal-Ctrl bindings (tmux prefix)
      // and cmdOrCtrl bindings (palette, settings, …).
      if (isEditable && !literalCtrl && !cmdOrCtrl && !alt && !isFunctionKey) return;

      // Ctrl+<prefixKey>: Enter prefix mode (configurable, default Ctrl+B)
      // Use e.code for Korean IME compatibility (see commit 60e39b0)
      // tmux convention → literal Ctrl on every OS (do NOT remap to ⌘ on macOS).
      const prefixKeyCode = store.getState().prefixConfig.key;
      if (literalCtrl && !shift && !alt && code === prefixKeyCode) {
        e.preventDefault();
        store.getState().setPrefixMode(true);
        // Start timeout — auto-exit prefix mode after 2s
        clearPrefixTimeout();
        prefixTimeoutRef.current = setTimeout(() => {
          store.getState().setPrefixMode(false);
          prefixTimeoutRef.current = null;
        }, PREFIX_TIMEOUT_MS);
        return;
      }

      // Ctrl+Shift+B: Toggle sidebar (moved from Ctrl+B)
      // Pairs with the tmux prefix above → literal Ctrl on every OS.
      if (literalCtrl && shift && !alt && code === 'KeyB') {
        e.preventDefault();
        store.getState().toggleSidebar();
        return;
      }

      // Ctrl+N: New workspace
      if (cmdOrCtrl && !shift && !alt && key === 'n') {
        e.preventDefault();
        store.getState().addWorkspace();
        return;
      }

      // Ctrl+Shift+W: Close workspace
      if (cmdOrCtrl && shift && !alt && key === 'W') {
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
      if (cmdOrCtrl && !shift && !alt && key >= '1' && key <= '9') {
        e.preventDefault();
        const { workspaces } = store.getState();
        const idx = key === '9' ? workspaces.length - 1 : parseInt(key) - 1;
        if (idx >= 0 && idx < workspaces.length) {
          store.getState().setActiveWorkspace(workspaces[idx].id);
        }
        return;
      }

      // Ctrl+D: Split right (horizontal)
      if (cmdOrCtrl && !shift && !alt && key === 'd') {
        e.preventDefault();
        const state = store.getState();
        const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
        if (ws) {
          state.splitPane(ws.activePaneId, 'horizontal');
        }
        return;
      }

      // Ctrl+Shift+D: Split down (vertical)
      if (cmdOrCtrl && shift && !alt && key === 'D') {
        e.preventDefault();
        const state = store.getState();
        const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
        if (ws) {
          state.splitPane(ws.activePaneId, 'vertical');
        }
        return;
      }

      // Ctrl+T: New surface
      if (cmdOrCtrl && !shift && !alt && key === 't') {
        e.preventDefault();
        const state = store.getState();
        const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
        if (ws) {
          window.electronAPI.pty.create({ workspaceId: ws.id }).then((result: { id: string }) => {
            store.getState().addSurface(ws.activePaneId, result.id, 'Terminal', '');
          });
        }
        return;
      }

      // Ctrl+W: Close surface
      if (cmdOrCtrl && !shift && !alt && key === 'w') {
        e.preventDefault();
        const state = store.getState();
        const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
        if (!ws) return;
        const activePane = findLeaf(ws.rootPane, ws.activePaneId);
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
      if (cmdOrCtrl && shift && !alt && key === ']') {
        e.preventDefault();
        const state = store.getState();
        const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
        if (ws) state.nextSurface(ws.activePaneId);
        return;
      }

      // Ctrl+Shift+[: Previous surface
      if (cmdOrCtrl && shift && !alt && key === '[') {
        e.preventDefault();
        const state = store.getState();
        const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
        if (ws) state.prevSurface(ws.activePaneId);
        return;
      }

      // Alt+Ctrl+Arrow: Focus pane directionally
      if (cmdOrCtrl && alt && !shift && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) {
        e.preventDefault();
        const dirMap: Record<string, 'up' | 'down' | 'left' | 'right'> = {
          ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
        };
        store.getState().focusPaneDirection(dirMap[key]);
        return;
      }

      // Ctrl+I: Toggle notification panel
      if (cmdOrCtrl && !shift && !alt && key === 'i') {
        e.preventDefault();
        store.getState().toggleNotificationPanel();
        return;
      }

      // Ctrl+Shift+M: Toggle message feed panel
      // Bookmark/message-feed convention → literal Ctrl on every OS.
      if (literalCtrl && shift && !alt && key === 'm') {
        e.preventDefault();
        store.getState().toggleMessageFeed();
        return;
      }

      // Ctrl+K: Toggle command palette
      if (cmdOrCtrl && !shift && !alt && key === 'k') {
        e.preventDefault();
        store.getState().toggleCommandPalette();
        return;
      }

      // Ctrl+,: Toggle settings panel
      if (cmdOrCtrl && !shift && !alt && key === ',') {
        e.preventDefault();
        store.getState().toggleSettingsPanel();
        return;
      }

      // Ctrl+Shift+U: Jump to latest unread notification's workspace
      if (cmdOrCtrl && shift && !alt && key === 'U') {
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
      if (cmdOrCtrl && shift && !alt && key === 'R') {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('wmux:rename-workspace'));
        return;
      }

      // Ctrl+Shift+L: Open browser panel in a new horizontal split
      if (cmdOrCtrl && shift && !alt && key === 'L') {
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
      if (cmdOrCtrl && shift && !alt && key === 'X') {
        e.preventDefault();
        store.getState().setViCopyModeActive(true);
        return;
      }

      // Ctrl+F: Toggle terminal search bar
      if (cmdOrCtrl && !shift && !alt && key === 'f') {
        e.preventDefault();
        store.getState().toggleSearchBar();
        return;
      }

      // Ctrl+`: Toggle floating terminal pane
      if (cmdOrCtrl && !shift && !alt && e.code === 'Backquote') {
        e.preventDefault();
        store.getState().toggleFloatingPane();
        return;
      }

      // Ctrl+Shift+H: Flash active pane to highlight its position
      if (cmdOrCtrl && shift && !alt && key === 'H') {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('wmux:flash-pane'));
        return;
      }

      // Ctrl+Shift+O: Toggle Company View overlay
      if (cmdOrCtrl && shift && !alt && key === 'O') {
        e.preventDefault();
        store.getState().toggleCompanyView();
        return;
      }

      // Ctrl+Shift+G: Clear multiview (back to single view)
      if (cmdOrCtrl && shift && !alt && key === 'G') {
        e.preventDefault();
        store.getState().clearMultiview();
        return;
      }

      // Ctrl+M: Add scrollback bookmark at current scroll position
      // Bookmark convention → literal Ctrl on every OS.
      if (literalCtrl && !shift && !alt && key === 'm') {
        e.preventDefault();
        const state = store.getState();
        const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
        if (ws) {
          const pane = findLeaf(ws.rootPane, ws.activePaneId);
          if (pane) {
            const surface = pane.surfaces.find((s) => s.id === pane.activeSurfaceId);
            if (surface?.ptyId) {
              const term = terminalRegistry.get(surface.ptyId);
              if (term) {
                const line = term.buffer.active.baseY + term.buffer.active.viewportY;
                state.addBookmark(surface.ptyId, line);
                showBookmarkToast();
              }
            }
          }
        }
        return;
      }

      // Ctrl+ArrowUp: Jump to previous bookmark (above current position)
      // Pairs with Ctrl+M bookmark add → literal Ctrl on every OS.
      if (literalCtrl && !shift && !alt && key === 'ArrowUp') {
        e.preventDefault();
        const state = store.getState();
        const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
        if (ws) {
          const pane = findLeaf(ws.rootPane, ws.activePaneId);
          if (pane) {
            const surface = pane.surfaces.find((s) => s.id === pane.activeSurfaceId);
            if (surface?.ptyId) {
              const term = terminalRegistry.get(surface.ptyId);
              const bookmarks = state.terminalBookmarks[surface.ptyId];
              if (term && bookmarks && bookmarks.length > 0) {
                const currentLine = term.buffer.active.baseY + term.buffer.active.viewportY;
                // Find nearest bookmark strictly above current position
                const above = bookmarks.filter((l) => l < currentLine);
                if (above.length > 0) {
                  term.scrollToLine(above[above.length - 1]);
                }
              }
            }
          }
        }
        return;
      }

      // Ctrl+ArrowDown: Jump to next bookmark (below current position)
      // Pairs with Ctrl+M bookmark add → literal Ctrl on every OS.
      if (literalCtrl && !shift && !alt && key === 'ArrowDown') {
        e.preventDefault();
        const state = store.getState();
        const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
        if (ws) {
          const pane = findLeaf(ws.rootPane, ws.activePaneId);
          if (pane) {
            const surface = pane.surfaces.find((s) => s.id === pane.activeSurfaceId);
            if (surface?.ptyId) {
              const term = terminalRegistry.get(surface.ptyId);
              const bookmarks = state.terminalBookmarks[surface.ptyId];
              if (term && bookmarks && bookmarks.length > 0) {
                const currentLine = term.buffer.active.baseY + term.buffer.active.viewportY;
                // Find nearest bookmark strictly below current position
                const below = bookmarks.filter((l) => l > currentLine);
                if (below.length > 0) {
                  term.scrollToLine(below[0]);
                }
              }
            }
          }
        }
        return;
      }

      // ─── Custom keybindings → terminal input ─────────────────────────
      // Custom keybindings are stored in literal "Ctrl+…" form for cross-OS
      // consistency; match against literalCtrl so user-defined combos behave
      // identically on Windows / Linux / macOS.
      const { customKeybindings } = store.getState();
      if (customKeybindings.length > 0) {
        const pressed = formatKeyCombo(literalCtrl, shift, alt, key);
        const match = customKeybindings.find((kb) => kb.key === pressed);
        if (match) {
          e.preventDefault();
          e.stopImmediatePropagation();
          const state = store.getState();
          const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
          if (ws) {
            const leaf = findLeaf(ws.rootPane, ws.activePaneId);
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
    return () => {
      window.removeEventListener('keydown', handler, true);
      // Clean up prefix timeout on unmount
      if (prefixTimeoutRef.current !== null) {
        clearTimeout(prefixTimeoutRef.current);
        prefixTimeoutRef.current = null;
      }
    };
  }, []);
}
