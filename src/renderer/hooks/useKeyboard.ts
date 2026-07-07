import { useEffect, useRef } from 'react';
import { useStore } from '../stores';
import { findLeaf } from '../../shared/paneUtils';
import { terminalRegistry } from './useTerminal';
import { t } from '../i18n';
import { resolveStartupCwd, withDefaultShell, withWorkspaceProfile } from '../utils/ptyCreateOptions';
import { useIpc } from './useIpc';
import { pastePtyChunked } from '../utils/clipboardChunk';
import { openUrlInBrowserPane } from '../utils/browserPaneActions';

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

// Terminal font-size zoom bounds. Kept in lockstep with the Appearance tab's
// font-size slider (SettingsPanel TabAppearance: min 12 / max 24) and the
// store default (uiSlice terminalFontSize: 14) so keyboard zoom and the slider
// never disagree on the reachable range. One-px steps mirror the slider grain.
const FONT_SIZE_MIN = 12;
const FONT_SIZE_MAX = 24;
const FONT_SIZE_DEFAULT = 14;
const FONT_SIZE_STEP = 1;

/** Clamp a candidate terminal font size into the [MIN, MAX] zoom range. */
export function clampFontSize(n: number): number {
  return Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, n));
}

/**
 * Map a `Key<X>` `e.code` to the matching ASCII control byte (Ctrl+X).
 *
 * Used for tmux-style prefix pass-through: pressing the prefix combo twice
 * (e.g. Ctrl+B Ctrl+B) sends a literal Ctrl+B to the focused PTY so nested
 * multiplexers (tmux/screen running inside a wmux pane) still receive their
 * own prefix. Returns null for any non-letter prefix configuration — those
 * fall back to a silent exit rather than emitting random control characters.
 */
export function ctrlByteForKeyCode(code: string): string | null {
  const m = /^Key([A-Z])$/.exec(code);
  if (!m) return null;
  return String.fromCharCode(m[1].charCodeAt(0) - 64);
}

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

/**
 * Minimal dependency surface used by {@link createPrefixActions} — pulled out so
 * unit tests can inject lightweight stand-ins without touching `window` or the
 * real Zustand store. Tests instantiate the registry with a fake store/electron
 * API and verify side effects without simulating real key events.
 */
export interface PrefixActionDeps {
  store: typeof useStore;
  electronAPI: {
    window: { hide: () => void };
    pty: { dispose: (id: string) => void };
  };
  doc: Pick<Document, 'dispatchEvent'>;
}

/**
 * Build the prefix-mode action registry.
 *
 * Exported as a pure factory so {@link useKeyboard} can wire it to live
 * globals while tests can pass mocks. The registry is keyed by the action IDs
 * referenced from `DEFAULT_PREFIX_CONFIG.bindings` and `SettingsPanel`'s
 * `PREFIX_ACTION_IDS`; any change here must keep those three lists aligned.
 */
export function createPrefixActions(deps: PrefixActionDeps): Record<string, () => void> {
  const { store, electronAPI, doc } = deps;

  const disposeTree = (pane: import('../../shared/types').Pane): void => {
    if (pane.type === 'leaf') {
      for (const s of pane.surfaces) {
        if (s.ptyId) electronAPI.pty.dispose(s.ptyId);
      }
    } else {
      for (const child of pane.children) disposeTree(child);
    }
  };

  return {
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
      if (activeLeaf) disposeTree(activeLeaf);
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
    hideWindow: () => { electronAPI.window.hide(); },
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
    renameWorkspace: () => {
      doc.dispatchEvent(new CustomEvent('wmux:rename-workspace'));
    },
    killWorkspace: () => {
      const state = store.getState();
      const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
      if (!ws) return;
      disposeTree(ws.rootPane);
      state.removeWorkspace(state.activeWorkspaceId);
    },
    showCheatSheet: () => {
      store.getState().setCheatSheetForceShown(true);
    },
  };
}

export function useKeyboard() {
  const store = useStore;
  const prefixTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Capture the IPC invoker via ref so the once-on-mount effect below can
  // call it without re-binding when the memoised invoke identity changes.
  // Used to surface RESOURCE_EXHAUSTED toasts on Ctrl+T when the daemon
  // session cap is hit (without this, the rejected pty.create promise
  // would be silently dropped and the shortcut would look unresponsive).
  const { invoke: ipcInvoke } = useIpc();
  const ipcInvokeRef = useRef(ipcInvoke);
  ipcInvokeRef.current = ipcInvoke;

  useEffect(() => {
    // Action registry — built once per effect so the closure captures stable
    // refs to store/electronAPI/document. See `createPrefixActions` (module
    // scope) for the action implementations; the factory split lets unit tests
    // exercise each action with mock dependencies.
    const prefixActions = createPrefixActions({
      store,
      electronAPI: window.electronAPI,
      doc: document,
    });
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
      // D-exclusive: inspect (point-and-style) is the top-level exclusive mode.
      // While it's active, suppress EVERY global shortcut — the prefix trigger,
      // split/close/zoom/focus, palette/settings toggles, custom keybindings —
      // so a stray key can't fire an action that mutates the pane tree or shakes
      // the marked-region DOM the overlay is reverse-mapping against. ESC is NOT
      // handled here: it stays unconsumed and bubbles to InspectOverlay's own
      // React onKeyDown (which calls exitInspect), so exiting still works.
      if (store.getState().inspectModeActive) return;

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

        // tmux-style pass-through: pressing the prefix combo a second time
        // forwards a literal Ctrl+<prefix> to the active PTY so a tmux/screen
        // session running inside the pane still receives its own prefix.
        const prefixKeyCode = store.getState().prefixConfig.key;
        if (literalCtrl && !shift && !alt && code === prefixKeyCode) {
          const byte = ctrlByteForKeyCode(prefixKeyCode);
          if (byte !== null) {
            const state = store.getState();
            const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
            if (ws) {
              const leaf = findLeaf(ws.rootPane, ws.activePaneId);
              if (leaf) {
                const surface = leaf.surfaces.find((s) => s.id === leaf.activeSurfaceId);
                if (surface?.ptyId) {
                  window.electronAPI.pty.write(surface.ptyId, byte);
                }
              }
            }
          }
          exitPrefixMode();
          return;
        }

        // Escape → just exit
        if (key === 'Escape') {
          exitPrefixMode();
          return;
        }

        // Ignore bare modifier keys (Shift, Control, Alt, Meta) — the user is
        // mid-chord reaching for a modified binding (e.g. Shift before '%' / '"'
        // / '&' / '?' / ':'). clearPrefixTimeout() already ran above before the
        // key was classified, so re-arm the auto-exit timer here; otherwise a
        // lone modifier tap would leave prefix mode active with no timeout and
        // the next keypress — even minutes later — would be treated as a prefix
        // command. Exiting outright instead would make the Shift-reached
        // bindings unreachable, so re-arming is the behavior-preserving fix.
        if (['Shift', 'Control', 'Alt', 'Meta'].includes(key)) {
          prefixTimeoutRef.current = setTimeout(() => {
            store.getState().setPrefixMode(false);
            prefixTimeoutRef.current = null;
          }, PREFIX_TIMEOUT_MS);
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

        // Unknown key → show error briefly, then exit. Use exitPrefixMode()
        // (not a bare setPrefixMode(false)) so prefix-mode teardown stays in
        // one place; the prefix timeout was already cleared above but this
        // keeps the cleanup symmetric with every other exit path.
        const displayKey = key.length === 1 ? key.toUpperCase() : key;
        store.getState().setPrefixError(`Unknown: ${displayKey}`);
        exitPrefixMode();
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

      // ─── Terminal font zoom (Ctrl+= / Ctrl+- / Ctrl+0) ─────────────────
      // Matches the Windows Terminal / VS Code / browser convention. We match
      // both e.key and the physical e.code: '=' and '-' sit on the same keys
      // across Latin layouts, but resolving by code as well keeps zoom working
      // under a Hangul / non-Latin IME (where e.key can be a composed glyph or
      // 'Process'), mirroring the IME-safe split/prefix handling elsewhere in
      // this file. Numpad +/-/0 are accepted too. Ctrl+1~9 above already
      // returned, so '0' here is unambiguous (digit 0 is not a workspace key).
      //
      // The zoom step writes through setTerminalFontSize, so xterm picks it up
      // via the runtime font effect in useTerminal (no terminal re-creation,
      // scrollback preserved). For these to reach this handler while a terminal
      // is focused, useTerminal's attachCustomKeyEventHandler must let the combo
      // bubble (it does — see the zoom pass-through there).
      const zoomFont = (delta: number) => {
        const cur = store.getState().terminalFontSize;
        const next = clampFontSize(cur + delta);
        if (next !== cur) store.getState().setTerminalFontSize(next);
      };
      // Zoom in: Ctrl+= or Ctrl++ (Shift+=) — accept either so users needn't
      // reach for Shift. NumpadAdd covers the numeric keypad.
      if (cmdOrCtrl && !alt && (key === '=' || key === '+' || code === 'Equal' || code === 'NumpadAdd')) {
        e.preventDefault();
        zoomFont(FONT_SIZE_STEP);
        return;
      }
      // Zoom out: Ctrl+- (Shift produces '_', accepted for symmetry).
      if (cmdOrCtrl && !alt && (key === '-' || key === '_' || code === 'Minus' || code === 'NumpadSubtract')) {
        e.preventDefault();
        zoomFont(-FONT_SIZE_STEP);
        return;
      }
      // Reset zoom: Ctrl+0 → back to the default font size.
      if (cmdOrCtrl && !shift && !alt && (key === '0' || code === 'Digit0' || code === 'Numpad0')) {
        e.preventDefault();
        if (store.getState().terminalFontSize !== FONT_SIZE_DEFAULT) {
          store.getState().setTerminalFontSize(FONT_SIZE_DEFAULT);
        }
        return;
      }

      // Ctrl+D: Split right (horizontal)
      // Match by physical key code as well so Hangul / non-Latin IME state
      // (where e.key may be 'ㅇ' or 'Process') still triggers the split.
      if (cmdOrCtrl && !shift && !alt && (key === 'd' || code === 'KeyD')) {
        e.preventDefault();
        const state = store.getState();
        const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
        if (ws) {
          state.splitPane(ws.activePaneId, 'horizontal');
        }
        return;
      }

      // Ctrl+Shift+D: Split down (vertical)
      if (cmdOrCtrl && shift && !alt && (key === 'D' || code === 'KeyD')) {
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
        // S-A Step 1 — the renderer now mounts in parallel with the daemon
        // bootstrap, so this handler is live while the LOCAL→DAEMON handler
        // swap may still be in flight. A pty.create fired in that window
        // mints a local-mode id whose writes the daemon handler silently
        // drops (the dda4c0c first-keystroke bug). paneGate flips to
        // 'ready' only after the startup reconcile, which is serialized
        // behind the daemon-vs-local decision — gate on it like every
        // other create path.
        if (state.paneGate !== 'ready') return;
        const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
        if (ws) {
          // Wrap pty.create through useIpc so that a rejected promise (most
          // notably MAX_SESSIONS cap reached → RESOURCE_EXHAUSTED) surfaces
          // an actionable toast instead of being silently dropped — the
          // pre-v2.8.2 .then-only chain made the shortcut look unresponsive.
          // Issue #175: new tabs honor profile.startupCwd > global startupDirectory.
          const cwd = resolveStartupCwd({ splitInheritsCwd: false, profile: ws.profile, startupDirectory: state.startupDirectory });
          void ipcInvokeRef.current<{ id: string }>(() =>
            window.electronAPI.pty.create(withWorkspaceProfile(withDefaultShell({ workspaceId: ws.id, cwd, spawnKind: 'user-shell' }, state.defaultShell), ws.profile))
          ).then((result) => {
            if (result.ok) {
              store.getState().addSurface(ws.activePaneId, result.data.id, 'Terminal', '');
            }
            // On failure useIpc already surfaced a toast — nothing to do here.
          });
        }
        return;
      }

      // Ctrl+W: Close active surface. If it was the last surface in the pane,
      // also collapse the pane so split layouts can actually be torn down via
      // the keyboard. Mirrors the X-button cascade in Pane.tsx (line 85) — the
      // tab strip path was the only way to reach closePane before, and single-
      // tab panes don't render a tab strip at all.
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
          const wasLastSurface = activePane.surfaces.length <= 1;
          state.closeSurface(activePane.id, activePane.activeSurfaceId);
          if (wasLastSurface) {
            // Non-root panes collapse here; root pane is a no-op (paneSlice
            // refuses to drop it) so AppLayout's empty-leaf effect refills it
            // with a fresh PTY — same behaviour as before for the lone pane.
            state.closePane(activePane.id);
          }
        }
        return;
      }

      // Ctrl+Shift+Q: Close active pane outright (tmux 'kill-pane' direct key).
      // Disposes every PTY in the subtree first so background terminals don't
      // leak when the pane disappears. Matches the prefix-mode 'closePane'
      // action so users have both a discoverable shortcut and the tmux flow.
      if (cmdOrCtrl && shift && !alt && key === 'Q') {
        e.preventDefault();
        const state = store.getState();
        const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
        if (!ws) return;
        const activeLeaf = findLeaf(ws.rootPane, ws.activePaneId);
        if (activeLeaf) disposePanePtys(activeLeaf);
        state.closePane(ws.activePaneId);
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

      // Alt+Ctrl+Arrow: Focus pane directionally (alternate combo; kept so the
      // macOS ⌘+Alt+Arrow path and existing muscle memory still work).
      if (cmdOrCtrl && alt && !shift && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) {
        e.preventDefault();
        const dirMap: Record<string, 'up' | 'down' | 'left' | 'right'> = {
          ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
        };
        store.getState().focusPaneDirection(dirMap[key]);
        return;
      }

      // Ctrl+Tab / Ctrl+Shift+Tab: Cycle through every leaf pane in the active
      // workspace (wraps around). Browser-style tab switching — bare Tab would
      // break shell completion inside the terminal so we require literal Ctrl
      // on every OS (matches Chrome / VS Code convention, including macOS).
      // stopImmediatePropagation prevents xterm from also seeing the Tab and
      // emitting a literal `\t` into the now-focused pane.
      if (literalCtrl && !alt && key === 'Tab') {
        e.preventDefault();
        e.stopImmediatePropagation();
        store.getState().cyclePane(shift ? 'prev' : 'next');
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

      // Ctrl+Shift+A: Toggle Fleet View (S-C1 cockpit — every agent, one
      // screen). `code` fallback keeps it firing under IME composition where
      // e.key can arrive as the 229 dead-key (the #189/#153 lesson).
      if (cmdOrCtrl && shift && !alt && (key === 'A' || code === 'KeyA')) {
        e.preventDefault();
        store.getState().toggleFleetView();
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

      // Ctrl+Shift+L: Open browser panel in a new horizontal split. forceNew
      // keeps the explicit-creation semantics — link/port clicks reuse an
      // existing browser pane, but this shortcut always makes another one.
      if (cmdOrCtrl && shift && !alt && key === 'L') {
        e.preventDefault();
        openUrlInBrowserPane(undefined, { forceNew: true });
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

      // Ctrl+Shift+Arrow: MOVE focus — pane focus within the active workspace,
      // or (in multiview) focus between grid tiles. focusPaneDirection walks one
      // workspace's pane tree (bails at leaves<=1); focusMultiviewDirection
      // navigates the multiview grid. This is the primary directional-move
      // gesture (bare Ctrl+Arrow is intentionally unbound). split stays on
      // Ctrl+D / Ctrl+Shift+D. stopImmediatePropagation so xterm never sees it.
      if (literalCtrl && shift && !alt && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(key)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const dirMap: Record<string, 'up' | 'down' | 'left' | 'right'> = {
          ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
        };
        // Multiview grid → move between tiles (workspaces); else pane focus.
        const { multiviewIds, activeWorkspaceId } = store.getState();
        if (multiviewIds.length >= 2 && multiviewIds.includes(activeWorkspaceId)) {
          store.getState().focusMultiviewDirection(dirMap[key]);
        } else {
          store.getState().focusPaneDirection(dirMap[key]);
        }
        return;
      }

      // Alt+ArrowUp: previous workspace. wmux only had Ctrl+1-9 (jump to N) and
      // the prefix path before — this adds direct prev/next cycling on the
      // sidebar order (↑ = previous, ↓ = next). Reuses the prefix
      // prevWorkspace/nextWorkspace logic. stopImmediatePropagation so xterm
      // never sees Alt+Arrow as an escape sequence.
      if (alt && !literalCtrl && !shift && key === 'ArrowUp') {
        e.preventDefault();
        e.stopImmediatePropagation();
        prefixActions.prevWorkspace();
        return;
      }

      // Alt+ArrowDown: next workspace (pairs with Alt+ArrowUp = previous).
      // stopImmediatePropagation so xterm never sees Alt+Arrow as an escape seq.
      if (alt && !literalCtrl && !shift && key === 'ArrowDown') {
        e.preventDefault();
        e.stopImmediatePropagation();
        prefixActions.nextWorkspace();
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
                // Route through the paste chunker. User-authored keybinding
                // commands can contain multi-line shell snippets pasted into
                // the settings field; chunking normalizes CRLF, paces IPC,
                // and keeps the payload under the 100KB backstop. The
                // trailing `\r` from `sendEnter` is preserved by the
                // normalizer (lone `\r` is left alone).
                const surfacePtyId = surface.ptyId;
                void pastePtyChunked(
                  (d) => window.electronAPI.pty.write(surfacePtyId, d),
                  text,
                  null,
                ).catch((err) => console.error('[wmux:keybinding] chunk write failed:', err));
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
