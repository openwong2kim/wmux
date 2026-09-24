import { useEffect, useRef } from 'react';
import { useStore } from '../stores';
import { useIpc } from './useIpc';
import { collectPaneTreePtyIds, findLeaf, getLeafPanes, getWorkspacePtyIds } from '../../shared/paneUtils';
import { terminalRegistry } from './useTerminal';
import { t } from '../i18n';
import { pastePtyChunked } from '../utils/clipboardChunk';
import { isPrefixTrigger, resolveShortcut, type ShortcutActionId } from '../../shared/keymap';
import { currentShortcutBindings, shortcutPressGuard } from '../utils/shortcutBindings';
import { createTerminalSurface } from '../utils/createTerminalSurface';
import { openUrlInBrowserPane } from '../utils/browserPaneActions';
import {
  destroyPaneTreeRemoteSessions,
  destroySurfaceRemoteSession,
  destroyWorkspaceRemoteSessions,
} from '../utils/remoteSessionTeardown';
import { disposePanePtys } from '../utils/paneTeardown';

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

/**
 * Built-in actions whose keydown must not reach any later listener — xterm
 * above all. Tab would emit a literal `\t` into the newly focused pane, and
 * Arrow chords would arrive as escape sequences.
 */
const STOP_PROPAGATION_ACTIONS: ReadonlySet<ShortcutActionId> = new Set<ShortcutActionId>([
  'nextPane', 'prevPane',
  'focusUp', 'focusDown', 'focusLeft', 'focusRight',
  'prevWorkspace', 'nextWorkspace',
]);

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

/**
 * Keys that are a MODIFIER being held, not a command. In prefix mode the user is
 * mid-chord reaching for a Shift-reached binding ('%', '"', '&', '?', ':', '!',
 * '{', 'K', …), so these must not resolve to an action or count as unknown.
 */
export const PREFIX_MODIFIER_KEYS: readonly string[] = ['Shift', 'Control', 'Alt', 'Meta'];

/**
 * The action a key runs in prefix mode, or null for "nothing bound".
 *
 * Keyed on `e.key` — the CHARACTER produced — and NOT on modifier state. That
 * is what lets the Shift-reached bindings work at all: `!` is Shift+1, `%` is
 * Shift+5, `K` is Shift+k, and every one of them arrives as its own `e.key`
 * with `shiftKey: true`. Consulting `e.shiftKey` here, or matching on `e.code`,
 * would break the whole shifted half of the default map (and every non-US
 * layout with it).
 *
 * Exported so the key→action contract is testable without mounting the hook:
 * the handler owns the side effects, this owns the lookup.
 */
export function resolvePrefixActionId(
  bindings: Record<string, string>,
  key: string,
): string | null {
  if (PREFIX_MODIFIER_KEYS.includes(key)) return null;
  return bindings[key] ?? null;
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
 * tmux `{` / `}` — swap the active pane with its neighbour in layout order.
 *
 * Layout order is the DFS leaf order the user sees on screen (same order
 * `cyclePane` walks), and it wraps: swapping the last pane "next" trades it
 * with the first. Two leaves or fewer with no wrap-around target is a no-op.
 */
function swapActiveWithAdjacentLeaf(
  store: PrefixActionDeps['store'],
  direction: 'prev' | 'next',
): void {
  const state = store.getState();
  const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
  if (!ws) return;

  const leaves = getLeafPanes(ws.rootPane);
  if (leaves.length <= 1) return;

  const idx = leaves.findIndex((l) => l.id === ws.activePaneId);
  if (idx === -1) return;

  const delta = direction === 'next' ? 1 : -1;
  const neighbour = leaves[(idx + delta + leaves.length) % leaves.length];
  if (neighbour.id === ws.activePaneId) return;

  state.swapPanes(ws.id, ws.activePaneId, neighbour.id);
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

  // Traversal is the shared canonical walk; the dispose policy (this registry's
  // injected electronAPI, not the window global) stays local.
  const disposeTree = (pane: import('../../shared/types').Pane): void => {
    for (const ptyId of collectPaneTreePtyIds(pane)) electronAPI.pty.dispose(ptyId);
    // #1129 — remote-terminal surfaces have no ptyId; the walk above cannot
    // see them, so the sessions this desktop minted need their own teardown.
    destroyPaneTreeRemoteSessions(pane);
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
    // #645 — move the pane itself. Same four directions as focus, so the
    // muscle memory carries over; the store resolves the neighbour with the
    // same traversal focusPaneDirection uses.
    movePaneUp: () => { store.getState().moveActivePaneDirection('up'); },
    movePaneDown: () => { store.getState().moveActivePaneDirection('down'); },
    movePaneLeft: () => { store.getState().moveActivePaneDirection('left'); },
    movePaneRight: () => { store.getState().moveActivePaneDirection('right'); },
    // tmux's `{` / `}` — swap the active pane with the previous / next leaf in
    // layout order, wrapping at the ends like cyclePane does.
    swapPanePrev: () => { swapActiveWithAdjacentLeaf(store, 'prev'); },
    swapPaneNext: () => { swapActiveWithAdjacentLeaf(store, 'next'); },
    // #977 — take the active pane out of the layout without killing it. The
    // slice owns every guard (daemon connection, last visible leaf, surface
    // type) and reports refusals as toasts, so there is nothing to check here.
    stashPane: () => {
      const state = store.getState();
      const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
      if (ws) state.stashPane(ws.activePaneId, ws.id);
    },
    renameWorkspace: () => {
      doc.dispatchEvent(new CustomEvent('wmux:rename-workspace'));
    },
    killWorkspace: () => {
      const state = store.getState();
      const ws = state.workspaces.find((w) => w.id === state.activeWorkspaceId);
      if (!ws) return;
      // Workspace-wide (#977) — see Sidebar.disposeAllPtys: a stashed pane's
      // session dies with its workspace or it becomes an orphan.
      for (const ptyId of getWorkspacePtyIds(ws)) electronAPI.pty.dispose(ptyId);
      destroyWorkspaceRemoteSessions(ws); // #1129 — same reasoning, no ptyId
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
    // ─── Built-in shortcut actions ─────────────────────────────────────
    // What each ShortcutActionId (shared/keymap.ts) does. WHICH key runs it
    // is not decided here: the handler resolves the keydown against the
    // effective bindings — the one table, with the user's overrides applied —
    // so moving or switching off a shortcut in Settings changes this hook,
    // useTerminal and useComposeShortcut together (#1455).
    //
    // Actions with no entry (richInput, owned by useComposeShortcut) leave
    // the event alone.
    const activeWorkspace = () => {
      const state = store.getState();
      return state.workspaces.find((w) => w.id === state.activeWorkspaceId);
    };
    const jumpToWorkspace = (idx: number) => {
      const { workspaces } = store.getState();
      if (idx >= 0 && idx < workspaces.length) {
        store.getState().setActiveWorkspace(workspaces[idx].id);
      }
    };
    // Terminal font zoom writes through setTerminalFontSize, so xterm picks
    // it up via the runtime font effect in useTerminal (no terminal
    // re-creation, scrollback preserved).
    const zoomFont = (delta: number) => {
      const cur = store.getState().terminalFontSize;
      const next = clampFontSize(cur + delta);
      if (next !== cur) store.getState().setTerminalFontSize(next);
    };
    // Ctrl+Shift+Arrow MOVES focus — pane focus within the active workspace,
    // or (in multiview) focus between grid tiles.
    const moveFocus = (dir: 'up' | 'down' | 'left' | 'right') => {
      const { multiviewIds, activeWorkspaceId } = store.getState();
      if (multiviewIds.length >= 2 && multiviewIds.includes(activeWorkspaceId)) {
        store.getState().focusMultiviewDirection(dir);
      } else {
        store.getState().focusPaneDirection(dir);
      }
    };

    const builtinActions: Partial<Record<ShortcutActionId, () => void>> = {
      splitHorizontal: () => {
        const ws = activeWorkspace();
        if (ws) store.getState().splitPane(ws.activePaneId, 'horizontal');
      },
      splitVertical: () => {
        const ws = activeWorkspace();
        if (ws) store.getState().splitPane(ws.activePaneId, 'vertical');
      },
      newSurface: () => {
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
          void createTerminalSurface({
            workspaceId: ws.id,
            paneId: ws.activePaneId,
            paneGate: state.paneGate,
            workspaces: state.workspaces,
            startupDirectory: state.startupDirectory,
            defaultShell: state.defaultShell,
            ipcInvoke: ipcInvokeRef.current,
            ptyCreate: window.electronAPI.pty.create,
            addSurface: state.addSurface,
          });
        }
      },
      newWorkspace: () => { store.getState().addWorkspace(); },
      // Close active surface. If it was the last surface in the pane, also
      // collapse the pane so split layouts can actually be torn down via the
      // keyboard. Mirrors the X-button cascade in Pane.tsx — the tab strip
      // path was the only way to reach closePane before, and single-tab panes
      // don't render a tab strip at all.
      closeSurface: () => {
        const state = store.getState();
        const ws = activeWorkspace();
        if (!ws) return;
        const activePane = findLeaf(ws.rootPane, ws.activePaneId);
        if (activePane && activePane.activeSurfaceId) {
          const surface = activePane.surfaces.find((s) => s.id === activePane.activeSurfaceId);
          if (surface?.ptyId) {
            window.electronAPI.pty.dispose(surface.ptyId);
          }
          // #1129 — the tab-strip X does the same (Pane.handleCloseSurface);
          // the two close paths must not diverge on what closing a remote tab
          // means.
          destroySurfaceRemoteSession(surface);
          const wasLastSurface = activePane.surfaces.length <= 1;
          state.closeSurface(activePane.id, activePane.activeSurfaceId);
          if (wasLastSurface) {
            // Non-root panes collapse here; root pane is a no-op (paneSlice
            // refuses to drop it) so AppLayout's empty-leaf effect refills it
            // with a fresh PTY — same behaviour as before for the lone pane.
            state.closePane(activePane.id);
          }
        }
      },
      // Close active pane outright (tmux 'kill-pane' direct key). Disposes
      // every PTY in the subtree first so background terminals don't leak
      // when the pane disappears.
      closePane: () => {
        const ws = activeWorkspace();
        if (!ws) return;
        const activeLeaf = findLeaf(ws.rootPane, ws.activePaneId);
        if (activeLeaf) disposePanePtys(activeLeaf);
        store.getState().closePane(ws.activePaneId);
      },
      searchTerminal: () => { store.getState().toggleSearchBar(); },
      commandPalette: () => { store.getState().toggleCommandPalette(); },
      toggleNotifications: () => { store.getState().toggleNotificationPanel(); },
      // (Ctrl+Shift+C is reserved for clipboard copy, hence X.)
      viCopyMode: () => { store.getState().setViCopyModeActive(true); },
      // Handled by the Sidebar component via a custom event.
      renameWorkspace: () => { document.dispatchEvent(new CustomEvent('wmux:rename-workspace')); },
      highlightPane: () => { document.dispatchEvent(new CustomEvent('wmux:flash-pane')); },
      floatingPane: () => { store.getState().toggleFloatingPane(); },
      prevWorkspace: () => { prefixActions.prevWorkspace(); },
      nextWorkspace: () => { prefixActions.nextWorkspace(); },
      workspace1: () => jumpToWorkspace(0),
      workspace2: () => jumpToWorkspace(1),
      workspace3: () => jumpToWorkspace(2),
      workspace4: () => jumpToWorkspace(3),
      workspace5: () => jumpToWorkspace(4),
      workspace6: () => jumpToWorkspace(5),
      workspace7: () => jumpToWorkspace(6),
      workspace8: () => jumpToWorkspace(7),
      workspace9: () => jumpToWorkspace(store.getState().workspaces.length - 1),
      closeWorkspace: () => {
        const state = store.getState();
        const ws = activeWorkspace();
        if (ws) {
          // 워크스페이스가 소유한 모든 PTY 정리 — 보관된 페인 포함(#977).
          // Same reasoning as Sidebar's close button and the prefix
          // killWorkspace action: a stashed session outliving its workspace is
          // an orphan nothing can reach.
          for (const ptyId of getWorkspacePtyIds(ws)) window.electronAPI.pty.dispose(ptyId);
          destroyWorkspaceRemoteSessions(ws); // #1129 — same reasoning, no ptyId
        }
        state.removeWorkspace(state.activeWorkspaceId);
      },
      // Jump to the latest unread notification's workspace.
      jumpToUnread: () => {
        const state = store.getState();
        const unread = state.notifications
          .filter((n) => !n.read)
          .sort((a, b) => b.timestamp - a.timestamp);
        if (unread.length > 0) {
          const latest = unread[0];
          state.setActiveWorkspace(latest.workspaceId);
          state.markRead(latest.id);
        }
      },
      nextSurface: () => {
        const ws = activeWorkspace();
        if (ws) store.getState().nextSurface(ws.activePaneId);
      },
      prevSurface: () => {
        const ws = activeWorkspace();
        if (ws) store.getState().prevSurface(ws.activePaneId);
      },
      // Cycle through every leaf pane in the active workspace (wraps around).
      nextPane: () => { store.getState().cyclePane('next'); },
      prevPane: () => { store.getState().cyclePane('prev'); },
      focusUp: () => moveFocus('up'),
      focusDown: () => moveFocus('down'),
      focusLeft: () => moveFocus('left'),
      focusRight: () => moveFocus('right'),
      // The alternate combo; kept so the macOS ⌘+Alt+Arrow path and existing
      // muscle memory still work.
      focusUpAlt: () => { store.getState().focusPaneDirection('up'); },
      focusDownAlt: () => { store.getState().focusPaneDirection('down'); },
      focusLeftAlt: () => { store.getState().focusPaneDirection('left'); },
      focusRightAlt: () => { store.getState().focusPaneDirection('right'); },
      toggleSidebar: () => { store.getState().toggleSidebar(); },
      openSettings: () => { store.getState().toggleSettingsPanel(); },
      // S-C1 cockpit — every agent, one screen.
      toggleFleetView: () => { store.getState().toggleFleetView(); },
      toggleCompanyView: () => { store.getState().toggleCompanyView(); },
      // Back to single view.
      clearMultiview: () => { store.getState().clearMultiview(); },
      // Browser panel in a new horizontal split. forceNew keeps the
      // explicit-creation semantics — link/port clicks reuse an existing
      // browser pane, but this shortcut always makes another one.
      openBrowser: () => { openUrlInBrowserPane(undefined, { forceNew: true }); },
      // Scrollback bookmark at the current scroll position.
      addBookmark: () => {
        const state = store.getState();
        const ws = activeWorkspace();
        if (!ws) return;
        const pane = findLeaf(ws.rootPane, ws.activePaneId);
        if (!pane) return;
        const surface = pane.surfaces.find((s) => s.id === pane.activeSurfaceId);
        if (!surface?.ptyId) return;
        const term = terminalRegistry.get(surface.ptyId);
        if (!term) return;
        const line = term.buffer.active.baseY + term.buffer.active.viewportY;
        state.addBookmark(surface.ptyId, line);
        showBookmarkToast();
      },
      toggleMessageFeed: () => { store.getState().toggleMessageFeed(); },
      zoomIn: () => zoomFont(FONT_SIZE_STEP),
      zoomOut: () => zoomFont(-FONT_SIZE_STEP),
      zoomReset: () => {
        if (store.getState().terminalFontSize !== FONT_SIZE_DEFAULT) {
          store.getState().setTerminalFontSize(FONT_SIZE_DEFAULT);
        }
      },
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

    // OS-aware modifiers (DX D1 decision): most built-ins use ⌘ on macOS and
    // Ctrl elsewhere; the tmux prefix and the sidebar / bookmark family keep
    // literal Ctrl on every OS. That split lives in the keymap table
    // (`literalCtrl`); here it only matters for the editable-field guard.
    const isMac = window.electronAPI.platform === 'darwin';

    const handler = (e: KeyboardEvent) => {
      // The IME's plain-key follow-up of a press something already acted on
      // (Hangul composition: `Process` then `t` for one Ctrl+T). Swallowed
      // whole, before any mode below can read it as a second press.
      if (shortcutPressGuard.isDuplicate(e)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
      }
      // D-exclusive: inspect (point-and-style) is the top-level exclusive mode.
      // While it's active, suppress EVERY global shortcut — the prefix trigger,
      // split/close/zoom/focus, palette/settings toggles, custom keybindings —
      // so a stray key can't fire an action that mutates the pane tree or shakes
      // the marked-region DOM the overlay is reverse-mapping against. ESC is NOT
      // handled here: it stays unconsumed and bubbles to InspectOverlay's own
      // React onKeyDown (which calls exitInspect), so exiting still works.
      if (store.getState().inspectModeActive) return;
      // Settings is recording a combo (Settings → Shortcuts, custom
      // keybindings, prefix key): the chord belongs to the recorder, which
      // listens on the same capture phase but registered after this hook.
      if (store.getState().keyCaptureActive) return;

      const cmdOrCtrl = isMac ? e.metaKey : e.ctrlKey;
      const literalCtrl = e.ctrlKey;
      const shift = e.shiftKey;
      const alt = e.altKey;
      const key = e.key;
      const code = e.code;

      // Read prefix mode from store (fresh, no stale closure)
      const prefixMode = store.getState().prefixMode;

      // Custom-keybinding dispatch: runs when no built-in owns the combo —
      // including one the user switched off or moved away, so a custom macro
      // on that combo fires instead of dying with it (#1152).
      const dispatchCustomKeybinding = (): boolean => {
        // Custom keybindings are stored in literal "Ctrl+…" form for cross-OS
        // consistency; match against literalCtrl so user-defined combos behave
        // identically on Windows / Linux / macOS.
        const { customKeybindings } = store.getState();
        if (customKeybindings.length === 0) return false;
        const pressed = formatKeyCombo(literalCtrl, shift, alt, key);
        const match = customKeybindings.find((kb) => kb.key === pressed);
        if (!match) return false;
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
        return true;
      };

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
          shortcutPressGuard.noteActed(e);
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
        if (PREFIX_MODIFIER_KEYS.includes(key)) {
          prefixTimeoutRef.current = setTimeout(() => {
            store.getState().setPrefixMode(false);
            prefixTimeoutRef.current = null;
          }, PREFIX_TIMEOUT_MS);
          return;
        }

        // Look up action from store's prefix bindings. Keyed on the CHARACTER
        // (e.key), never on modifier state — see resolvePrefixActionId.
        const { prefixConfig } = store.getState();
        const actionId = resolvePrefixActionId(prefixConfig.bindings, key);
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
      if (isPrefixTrigger(e, store.getState().prefixConfig.key)) {
        e.preventDefault();
        shortcutPressGuard.noteActed(e);
        store.getState().setPrefixMode(true);
        // Start timeout — auto-exit prefix mode after 2s
        clearPrefixTimeout();
        prefixTimeoutRef.current = setTimeout(() => {
          store.getState().setPrefixMode(false);
          prefixTimeoutRef.current = null;
        }, PREFIX_TIMEOUT_MS);
        return;
      }

      // ─── Built-in shortcuts ─────────────────────────────────────────
      // One lookup in the effective bindings decides. A shortcut the user
      // switched off is simply not there, so the key goes on to whatever has
      // focus — useTerminal asks the same resolver and lets xterm encode it
      // for the PTY (Ctrl+T reaches Codex, Alt+Up reaches a TUI). A custom
      // macro on the combo still fires. (#1152, #1455)
      const action = resolveShortcut(e, currentShortcutBindings());
      const run = action ? builtinActions[action] : undefined;
      if (action && run) {
        e.preventDefault();
        if (STOP_PROPAGATION_ACTIONS.has(action)) e.stopImmediatePropagation();
        shortcutPressGuard.noteActed(e);
        run();
        return;
      }

      // ─── Custom keybindings → terminal input ─────────────────────────
      dispatchCustomKeybinding();
    };

    // The guard's view of when a press ends (see ShortcutPressGuard).
    const onKeyUp = (e: KeyboardEvent) => shortcutPressGuard.onKeyUp(e);

    // Use capture phase so we run BEFORE xterm's stopPropagation
    window.addEventListener('keydown', handler, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', handler, true);
      window.removeEventListener('keyup', onKeyUp, true);
      // Clean up prefix timeout on unmount
      if (prefixTimeoutRef.current !== null) {
        clearTimeout(prefixTimeoutRef.current);
        prefixTimeoutRef.current = null;
      }
    };
  }, []);
}
