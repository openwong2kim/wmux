import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { useStore } from '../stores';
import { t } from '../i18n';
import { XTERM_THEMES, extractXtermColors, type ThemeId, type BuiltinThemeId } from '../themes';
import { isLight } from '../tailwindPalette';
import { isDaemonModeActive } from '../daemon/daemonMode';
import { pastePtyChunked, chunkOnDataIfNeeded } from '../utils/clipboardChunk';
import { openTerminalUrl } from '../utils/browserPaneActions';
import { runCopyWithFeedback } from '../utils/copyWithFeedback';
import { shouldFitWhilePreservingSelection } from '../utils/fitGuard';
import { createAutoSelectionCopy } from '../utils/autoSelectionCopy';
import { terminalFontFamilyCss } from '../utils/terminalFont';
import { createPathLinkProvider } from '../terminal/pathLinkProvider';
import { resolveNewlineKeyByte } from '../terminal/newlineKeys';
import { attachImeResidueGuard } from '../terminal/imeResidueGuard';
import { attachImeStormGuard } from '../terminal/imeStormGuard';
import { webglContextPool } from '../terminal/webglContextPool';
import { teardownWebglAddon } from '../terminal/webglTeardown';
import { createGlyphRepaintScheduler, type GlyphRepaintScheduler } from '../terminal/glyphRepaint';
import { reconnectPtyWithRetry as reconnectPtyWithRetryImpl } from './reconnectPtyWithRetry';

// Module-level terminal registry for scrollback persistence
const terminalRegistry = new Map<string, Terminal>();
export { terminalRegistry };

// Registration push channel. Restored terminals register only after their
// async scrollback load completes — often far beyond useActivePaneFocus's
// 10-frame retry window during a session-restore boot — so polling alone
// leaves DOM focus on <body> until the user switches panes. Subscribers get
// the ptyId the moment registerTerminal runs.
const terminalRegistrationListeners = new Set<(ptyId: string) => void>();
export function onTerminalRegistered(listener: (ptyId: string) => void): () => void {
  terminalRegistrationListeners.add(listener);
  return () => terminalRegistrationListeners.delete(listener);
}
function registerTerminal(ptyId: string, terminal: Terminal): void {
  terminalRegistry.set(ptyId, terminal);
  for (const listener of [...terminalRegistrationListeners]) listener(ptyId);
}

// Monotonic token source so each useTerminal instance gets a stable, unique key
// in the shared WebGL context pool. We never key the pool on ptyId directly —
// a fast unmount→remount can briefly run two instances on the same ptyId, and
// the pool's accounting must treat them as distinct slots.
let webglTokenSeq = 0;

// RCA (2026-05-29 view-switch lag): when a terminal is hidden we DEFER releasing
// its WebGL context (back to the shared pool) by this delay instead of freeing
// it immediately. A hidden terminal usually reappears within seconds (workspace
// switch back, multiview<->single toggle); immediate release+reload thrashes GPU
// context creation, which is the main source of the view-switch lag the user
// reported. If the terminal becomes visible again before the timer fires, the
// release is cancelled and the live context reused. The HARD ceiling on
// simultaneous contexts is enforced by webglContextPool (LRU eviction under
// Chromium's ~16 cap); this timer is only the no-pressure cleanup.
export const WEBGL_HIDDEN_DISPOSE_DELAY_MS = 10_000;

// RCA A1 — reconnect-with-retry policy lives in its own module so it can be
// unit-tested without xterm/zustand/electron. Bound to the live deps here.
function reconnectPtyWithRetry(ptyId: string, isCurrent: () => boolean): Promise<void> {
  return reconnectPtyWithRetryImpl(ptyId, isCurrent, {
    reconnect: (id) => window.electronAPI.pty.reconnect(id),
    clearPtyId: (id) => useStore.getState().clearSurfacePtyIdByPty(id),
  });
}

// Lightweight copy feedback toast — injects/removes a DOM element
let copyToastTimer: ReturnType<typeof setTimeout> | null = null;
function showCopyToast() {
  let el = document.getElementById('wmux-copy-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'wmux-copy-toast';
    el.style.cssText = 'position:fixed;bottom:28px;left:50%;transform:translateX(-50%);background:var(--accent-green);color:var(--bg-base);font-family:monospace;font-size:11px;font-weight:600;padding:3px 12px;border-radius:4px;z-index:9999;pointer-events:none;opacity:0;transition:opacity 0.2s';
    document.body.appendChild(el);
  }
  el.textContent = t('terminal.copied');
  el.style.opacity = '1';
  if (copyToastTimer) clearTimeout(copyToastTimer);
  copyToastTimer = setTimeout(() => { el!.style.opacity = '0'; }, 1200);
}

// Surfaces openPath outcomes that the user cannot otherwise see — without
// this, Ctrl+clicking an .exe (blocked main-side) or a missing file
// silently reveals the parent folder via showItemInFolder with no
// explanation, which reads as "the click didn't do anything." Yellow for
// blocked (security gate), red for generic failure (file gone, no
// associated app). Shares no DOM with the copy toasts so they can briefly
// overlap if a user copies-then-clicks in quick succession.
let openPathToastTimer: ReturnType<typeof setTimeout> | null = null;
function showOpenPathToast(messageKey: 'terminal.openPathBlocked' | 'terminal.openPathFailed') {
  let el = document.getElementById('wmux-openpath-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'wmux-openpath-toast';
    el.style.cssText = 'position:fixed;bottom:28px;left:50%;transform:translateX(-50%);color:var(--bg-base);font-family:monospace;font-size:11px;font-weight:600;padding:3px 12px;border-radius:4px;z-index:9999;pointer-events:none;opacity:0;transition:opacity 0.2s';
    document.body.appendChild(el);
  }
  el.style.background = messageKey === 'terminal.openPathBlocked'
    ? 'var(--accent-yellow)'
    : 'var(--accent-red)';
  el.textContent = t(messageKey);
  el.style.opacity = '1';
  if (openPathToastTimer) clearTimeout(openPathToastTimer);
  openPathToastTimer = setTimeout(() => { el!.style.opacity = '0'; }, 2400);
}

// Error variant — surfaced when clipboardAPI.writeText rejects so the user
// learns the copy failed instead of silently believing it succeeded.
// Shares no DOM with the success toast so the two can briefly overlap.
let copyErrorToastTimer: ReturnType<typeof setTimeout> | null = null;
function showCopyErrorToast() {
  let el = document.getElementById('wmux-copy-error-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'wmux-copy-error-toast';
    el.style.cssText = 'position:fixed;bottom:28px;left:50%;transform:translateX(-50%);background:var(--accent-red);color:var(--bg-base);font-family:monospace;font-size:11px;font-weight:600;padding:3px 12px;border-radius:4px;z-index:9999;pointer-events:none;opacity:0;transition:opacity 0.2s';
    document.body.appendChild(el);
  }
  el.textContent = t('terminal.copyFailed');
  el.style.opacity = '1';
  if (copyErrorToastTimer) clearTimeout(copyErrorToastTimer);
  copyErrorToastTimer = setTimeout(() => { el!.style.opacity = '0'; }, 1800);
}

/**
 * Centralized async copy helper. main may now `throw` on validation/size/lock
 * failures (clipboard.handler), so renderer must await + catch to surface the
 * error rather than silently dropping it. On failure we keep the selection
 * so the user can retry without re-dragging.
 *
 * Forgiving about a missing terminal — callers may pass `null` during
 * teardown. Pure branching logic lives in `runCopyWithFeedback` so tests
 * don't need a DOM.
 */
export function copySelectionWithFeedback(
  terminal: { clearSelection(): void } | null,
  selection: string,
  options?: { keepSelection?: boolean },
): Promise<void> {
  return runCopyWithFeedback(selection, {
    write: (text) => window.clipboardAPI.writeText(text),
    // `keepSelection` leaves the highlight in place after a successful copy.
    // The right-click copy path uses this so the selection survives the
    // gesture: the old async clearSelection() wiped it a tick later, and a
    // fast second right-click then saw an empty selection and fell through to
    // the paste branch — the reported copy↔paste collision. Keeping the
    // selection makes a repeat right-click copy again (idempotent) instead.
    clearSelection: () => { if (!options?.keepSelection) terminal?.clearSelection(); },
    onSuccess: showCopyToast,
    onError: showCopyErrorToast,
  });
}

// How long after a right-click copy we suppress a right-click paste. A second
// contextmenu within this window is treated as a stray repeat of the copy
// gesture (double right-click, or the selection getting wiped by incoming PTY
// data between two intentional clicks) rather than an intent to paste. This is
// the deterministic guard that kills the copy↔paste collision even when the
// selection is no longer present on the second click.
const RIGHT_CLICK_PASTE_SUPPRESS_MS = 300;

export interface ContextMenuEvent {
  x: number;
  y: number;
  hasSelection: boolean;
  selectedText: string;
  linkUrl: string | null;
}

interface UseTerminalOptions {
  ptyId: string | null;
  /** Combined visibility flag: true only when the terminal's workspace AND surface tab are both active.
   *  When false the terminal DOM container may be hidden (display:none / zero-size). */
  isVisible?: boolean;
  /** If set, load scrollback content from this file (surfaceId) before connecting PTY data */
  scrollbackFile?: string;
  /** Called once when the first chunk of PTY data is received (useful for hiding restore overlays) */
  onFirstData?: () => void;
  /** Called on right-click to show context menu */
  onContextMenu?: (e: ContextMenuEvent) => void;
}

export function useTerminal(containerRef: React.RefObject<HTMLDivElement | null>, options: UseTerminalOptions) {
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  // WebGL addon ref — shared across effects so visibility toggling can
  // dispose/recreate the addon without exceeding the GPU context limit.
  const webglAddonRef = useRef<WebglAddon | null>(null);
  // loadWebgl closure ref — set by the main effect, called by visibility effect.
  const loadWebglRef = useRef<(() => void) | null>(null);
  // disposeWebgl closure ref — the pool calls this to evict our context.
  const disposeWebglRef = useRef<(() => void) | null>(null);
  // Stable unique token for this terminal's slot in the shared WebGL pool.
  const webglTokenRef = useRef<string>('');
  if (!webglTokenRef.current) webglTokenRef.current = `wgl-${++webglTokenSeq}`;
  // Pending deferred-WebGL-release timer (see WEBGL_HIDDEN_DISPOSE_DELAY_MS).
  const webglDisposeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Glyph-corruption repair scheduler (issue #166) — created by the main
  // effect, also poked by the visibility effect on regain.
  const glyphRepaintRef = useRef<GlyphRepaintScheduler | null>(null);
  const { ptyId, isVisible = true, scrollbackFile, onFirstData, onContextMenu } = options;
  const ptyIdRef = useRef(ptyId);
  ptyIdRef.current = ptyId;
  // Live visibility for long-lived callbacks (the burst repaint below) — the
  // closure value captured at mount would go stale across workspace switches.
  const isVisibleRef = useRef(isVisible);
  isVisibleRef.current = isVisible;
  const onFirstDataRef = useRef(onFirstData);
  onFirstDataRef.current = onFirstData;
  const onContextMenuRef = useRef(onContextMenu);
  onContextMenuRef.current = onContextMenu;
  const terminalFontSize = useStore((s) => s.terminalFontSize);
  const terminalFontFamily = useStore((s) => s.terminalFontFamily);
  const scrollbackLines = useStore((s) => s.scrollbackLines);
  const theme = useStore((s) => s.theme) as ThemeId;
  const customThemeColors = useStore((s) => s.customThemeColors);
  const xtermTheme = theme === 'custom' && customThemeColors
    ? extractXtermColors(customThemeColors)
    : XTERM_THEMES[theme as BuiltinThemeId] ?? XTERM_THEMES['catppuccin-mocha'];
  // On light backgrounds (hinomaru, taegeuk, light custom palettes), apps that
  // emit true-color white text (e.g. Claude Code, some TUI tools) bypass our
  // palette mapping and render as literally #FFFFFF — invisible on a cream
  // background. Enforce WCAG AA contrast (4.5:1) on light themes so xterm
  // auto-darkens those foregrounds. Dark themes keep the default (1 = no
  // enforcement) to preserve intentionally subtle dimmed text.
  const minimumContrastRatio = xtermTheme.background && isLight(xtermTheme.background) ? 4.5 : 1;

  // Resize the daemon PTY without letting a rejected RPC float as an
  // "Uncaught (in promise)". Two transient daemon errors are expected here and
  // are both benign to the UI:
  //   • "rate limited" — a reconnect burst (many panes recreating at once)
  //     momentarily exceeds the daemon's per-socket cap (50 RPC/s, 1 s window).
  //     The dropped resize would otherwise strand the PTY at a stale geometry
  //     (callers update lastSentCols/Rows *before* the send, so an identical
  //     re-fit is suppressed and never retries). Re-send the *live* geometry
  //     once after the window clears (~1.1 s) so the size self-heals.
  //   • "not found" — the session was swapped/disposed mid-resize; the main
  //     pty:resize handler already retries-then-logs this, so we swallow it.
  const sendResize = useCallback((targetPtyId: string, cols: number, rows: number) => {
    window.electronAPI.pty.resize(targetPtyId, cols, rows).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('rate limited')) return; // not-found / other: handled upstream
      window.setTimeout(() => {
        const term = terminalRef.current;
        // Bail if the terminal was disposed or the pane swapped PTYs meanwhile.
        if (!term || ptyIdRef.current !== targetPtyId) return;
        const { cols: c, rows: r } = term;
        if (c > 0 && r > 0) {
          window.electronAPI.pty.resize(targetPtyId, c, r).catch(() => { /* give up quietly */ });
        }
      }, 1100);
    });
  }, []);

  const fit = useCallback(() => {
    const container = containerRef.current;
    if (!fitAddonRef.current || !terminalRef.current || !container) return;
    // Guard: skip fit entirely when the container is hidden (zero dimensions).
    // Calling fit() on a display:none element produces 0 cols/rows which
    // corrupts the xterm buffer and causes the "infinite copy downward" bug.
    if (container.offsetWidth === 0 || container.offsetHeight === 0) return;
    try {
      fitAddonRef.current.fit();
      const currentPtyId = ptyIdRef.current;
      if (currentPtyId) {
        const { cols, rows } = terminalRef.current;
        // Never send 0-size resize to PTY — that corrupts the terminal buffer.
        if (cols > 0 && rows > 0) {
          sendResize(currentPtyId, cols, rows);
        }
      }
    } catch {
      // ignore fit errors during unmount
    }
  }, [ptyId, containerRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !ptyId) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: terminalFontSize,
      scrollback: scrollbackLines,
      scrollOnUserInput: false,
      fontFamily: terminalFontFamilyCss(terminalFontFamily),
      theme: xtermTheme,
      minimumContrastRatio,
      allowProposedApi: true,
      // Enable xterm 6's Windows-aware ConPTY reflow path. ConPTY emits
      // spurious row-change events on resize; the dedicated reflow logic
      // suppresses them, which in turn keeps SelectionService from
      // unconditionally clearing the user's selection mid-drag.
      // macOS/Linux PTY는 ConPTY가 아니므로 이 reflow 경로를 켜면 오히려
      // focus/resize 시 줄바꿈이 어긋나 글자가 깨진다(좌측 팬 garble). win32 한정.
      ...(window.electronAPI.platform === 'win32'
        ? { windowsPty: { backend: 'conpty' as const, buildNumber: 21376 } }
        : {}),
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    const unicode11Addon = new Unicode11Addon();
    // Smart link routing (X3): localhost URLs open in the embedded browser
    // pane, external ones in the system browser; Ctrl/Cmd+click inverts. The
    // ptyId identifies the owning workspace (multiview-safe reverse lookup).
    const webLinksAddon = new WebLinksAddon((event, uri) => {
      openTerminalUrl(uri, {
        modifierHeld: event.ctrlKey || event.metaKey,
        ptyId: ptyIdRef.current || undefined,
      });
    });
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    terminal.loadAddon(unicode11Addon);
    terminal.loadAddon(webLinksAddon);
    // Path link provider — Ctrl+click an absolute filesystem path to open
    // it in Explorer / Finder. Coexists with WebLinksAddon (URLs); the two
    // detect disjoint token shapes so a single span never claims both.
    // Main-side validation in shell.handler.openPath is the security
    // boundary; the renderer regex is only a UX filter.
    const pathLinkDisposable = terminal.registerLinkProvider(
      createPathLinkProvider(terminal, (filePath) => {
        void window.electronAPI.shell.openPath(filePath).then((result) => {
          // Main-side outcomes:
          //   • ok=true → opened cleanly, nothing to surface
          //   • error='BLOCKED_EXTENSION' → security gate refused (.exe etc.)
          //   • error=<message> → openPath failed (file gone, no handler);
          //     main already revealed the parent folder via showItemInFolder
          // The toast tells the user *why* their click landed on a folder
          // instead of opening the file — otherwise it reads as a no-op.
          if (!result || result.ok) return;
          showOpenPathToast(
            result.error === 'BLOCKED_EXTENSION'
              ? 'terminal.openPathBlocked'
              : 'terminal.openPathFailed',
          );
        }).catch((err: unknown) => {
          // IPC-level rejection (validation throw: non-string, NUL byte,
          // not absolute, length cap). These are developer-visible bugs
          // rather than user-actionable failures — log only.
          console.warn('[useTerminal] openPath failed:', err);
        });
      }, window.electronAPI.platform),
    );
    // Activate Unicode 11 width tables — required for correct CJK / emoji
    // width. Without this, xterm defaults to v6 and TUI apps that use cursor
    // positioning (Claude Code, vim, etc.) collide frames over Korean text.
    terminal.unicode.activeVersion = '11';
    terminal.open(container);

    // Issue #167: keep the hidden IME textarea empty while idle. xterm only
    // clears it on blur, so IME-committed text accumulates there after it was
    // already sent to the PTY, and external field-replacing injectors (voice
    // IME like AutoGLM) "replace" that residue with destructive results — the
    // forwarded DELs wipe the user's already-typed line. Upstream:
    // xtermjs/xterm.js#6012. Gated off under screenReaderMode, where xterm
    // intentionally retains the text until blur for announcement (wmux never
    // enables that option today).
    // Off by default since v3.1.1: the wipe is a programmatic mutation of the
    // IME-owned textarea, and it is the prime suspect for the field-reported
    // "input dead until remount" 229-claim storms on Korean Windows (the
    // exact trigger is machine-dependent and did not reproduce locally). The
    // AutoGLM-style voice-injector protection it provides is opt-in via
    // Settings → Terminal. Read once at terminal creation, like the other
    // constructor-time options.
    const imeResidueGuard = (terminal.options.screenReaderMode || !useStore.getState().imeResidueGuardEnabled)
      ? null
      : attachImeResidueGuard(terminal);

    // Dead-input self-healing (always on): if the IME claim-storm signature
    // shows up — consecutive keyCode-229 keydowns across distinct keys with
    // zero composition activity — resync the IME context with a blur/refocus
    // (the same thing a remount does) and tell the user what happened.
    const imeStormGuard = attachImeStormGuard(terminal, {
      onRecover: ({ count, codes }) => {
        console.error(
          `[wmux:ime] keydown-229 claim storm on pty=${ptyId} (${count} keys: ${codes.join(', ')}) — IME context resynced via blur/refocus`,
        );
        useStore.getState().pushToast({ message: t('terminal.imeInputRecovered'), level: 'info' });
      },
    });

    // Paint the container backdrop with the xterm theme background so the 4px
    // padding (and the sub-cell rounding gap xterm leaves around its grid) fades
    // into the terminal content instead of exposing the app's --bg-base behind
    // it. Without this, a theme whose UI base differs from its terminal palette
    // (e.g. a dark custom base wrapping the light Hinomaru terminal) frames the
    // terminal in a mismatched border. Falls back to no override when the theme
    // omits a background. Re-applied on theme change in the font/theme effect.
    container.style.backgroundColor = xtermTheme.background ?? '';

    // WebGL addon loading — driven by the shared webglContextPool, NOT called
    // directly. Chromium hard-caps simultaneous WebGL contexts (~16); exceeding
    // it force-evicts the oldest context and blanks that terminal. The pool
    // bounds the live count below the cap and grants contexts to the most
    // recently shown terminals, so persistence can restore an arbitrary session
    // count without any pane going blank. loadWebgl is the pool's "acquire"
    // callback; disposeWebgl is its "evict" callback (reverts to DOM renderer).
    function loadWebgl() {
      if (webglAddonRef.current) return; // already loaded
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          // A real GPU driver reset (not our pool eviction): the context is
          // gone. Dispose, drop to xterm's DOM renderer, and free our pool slot
          // so the pool stops counting us and can re-grant on the next toggle.
          console.warn('[Terminal] WebGL context lost — falling back to DOM renderer');
          addon.dispose();
          webglAddonRef.current = null;
          webglContextPool.notifyDisposed(webglTokenRef.current);
          try {
            terminal.refresh(0, terminal.rows - 1);
          } catch {
            // terminal may already be disposed
          }
        });
        terminal.loadAddon(addon);
        webglAddonRef.current = addon;
      } catch {
        console.warn('WebGL addon failed, using DOM renderer');
        webglAddonRef.current = null;
      }
    }
    loadWebglRef.current = loadWebgl;
    // Controlled teardown the pool calls when this terminal is evicted to stay
    // under Chromium's context cap. Disposing the addon reverts xterm to its
    // DOM renderer (always available), so the terminal keeps rendering — it
    // just loses GPU acceleration until it is granted a context again.
    function disposeWebgl() {
      if (!webglAddonRef.current) return;
      teardownWebglAddon(webglAddonRef.current);
      webglAddonRef.current = null;
      try {
        terminal.refresh(0, terminal.rows - 1);
      } catch {
        // terminal may already be disposed
      }
    }
    disposeWebglRef.current = disposeWebgl;

    // Issue #166 — defensive full-range repaint for the "garbled glyphs until
    // resize" corruption (dirty-region desync). Strategy and trigger rationale
    // live in terminal/glyphRepaint.ts. Every reason (focus / visible / burst)
    // does a plain full-range refresh; "focus" is throttled because it fires on
    // every keyboard pane-nav / MCP pane.focus via useActivePaneFocus's
    // term.focus(), not just mouse clicks, so the throttle is load-bearing. The
    // repaint must NOT clearTextureAtlas (see the repaint body): xterm shares one
    // glyph atlas across same-config panes, so clearing it corrupts the others.
    const glyphRepaint = createGlyphRepaintScheduler({
      repaint: (reason) => {
        if (terminalRef.current !== terminal) return;
        // A hidden pane (background workspace/tab, display:none) skips the
        // burst refresh — nobody can see the staleness, and the `visible`
        // repaint on re-show repairs it at the moment it matters. Without
        // this gate, N background agent panes each schedule a full-range
        // refresh after every output burst.
        if (reason === 'burst' && !isVisibleRef.current) return;
        // Do NOT clearTextureAtlas here (#191). xterm shares ONE glyph atlas
        // across every same-config terminal (CharAtlasCache); clearing it from
        // one pane empties it for all of them, and siblings that do not rebuild
        // their model on a focus event then sample an emptied/repositioned atlas
        // and render garbled or blank glyphs. A full-range refresh repairs only
        // this pane's dirty-region staleness without mutating the shared atlas.
        try {
          terminal.refresh(0, terminal.rows - 1);
        } catch {
          // terminal may already be disposed
        }
      },
    });
    glyphRepaintRef.current = glyphRepaint;
    const onTextareaFocus = () => glyphRepaint.onFocus();
    // terminal.textarea exists once open() has run (above).
    terminal.textarea?.addEventListener('focus', onTextareaFocus);

    // Only fit immediately if the container is actually visible (non-zero size).
    // If the workspace starts hidden (display:none), skip the initial fit so we
    // don't corrupt the terminal with 0 cols/rows. The visibility-watcher effect
    // below will trigger a proper fit when the workspace is shown.
    if (container.offsetWidth > 0 && container.offsetHeight > 0) {
      fitAddon.fit();
    }

    // Wait for fonts to fully load, then rebuild the WebGL glyph atlas.
    // font-display:swap causes the browser to render with a fallback font first,
    // so the WebGL atlas may contain glyphs measured with wrong metrics.
    // A simple refresh() doesn't rebuild the atlas — we must dispose and
    // recreate the WebGL addon to force a full atlas rebuild.
    document.fonts.ready.then(() => {
      if (!terminalRef.current || terminalRef.current !== terminal) return;
      if (container.offsetWidth === 0 || container.offsetHeight === 0) return;
      if (webglAddonRef.current) {
        // [#191/#197] Release the old context (not just dispose) before
        // recreating — this runs once per terminal on mount, so on a multi-pane
        // restore it is a burst of dispose+create pairs; leaking the old
        // contexts here is a prime zombie-context source.
        teardownWebglAddon(webglAddonRef.current);
        webglAddonRef.current = null;
        loadWebgl();
      }
      // Selection-preservation guard — this is mostly defensive (fonts.ready
      // resolves on mount before the user can select anything), but pinning
      // the contract here prevents future regressions if anything triggers
      // a font load mid-session.
      if (!shouldFitWhilePreservingSelection(terminalRef.current)) {
        console.debug('[Terminal] fonts.ready fit skipped — active selection');
        return;
      }
      fitAddon.fit();
      terminal.refresh(0, terminal.rows - 1);
    });

    // Track last sent dimensions to avoid redundant resizes
    let lastSentCols = 0;
    let lastSentRows = 0;
    let resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;

    // Auto-copy on selection (debounced) — selection survives just long enough
    // for the user to release the mouse, then we push it to the clipboard.
    // Without this, the only path is the explicit Ctrl+C / right-click flow,
    // which loses selections that get wiped by PTY data, focus changes, or
    // any fit() that slipped past the guards. The debounce + empty-filter
    // logic lives in `createAutoSelectionCopy` so it can be unit-tested
    // without xterm. We deliberately do NOT show the success toast here —
    // auto-copy wasn't keybind-triggered, so a flashing "Copied!" would be
    // UI noise. Errors are also silent: the explicit Ctrl+C path still
    // surfaces them on retry.
    const autoCopy = createAutoSelectionCopy({
      write: (text) => window.clipboardAPI.writeText(text),
    });
    const selectionDisposable = terminal.onSelectionChange(() => {
      autoCopy.onSelection(terminal.getSelection());
    });

    // Clipboard + shortcut handling
    terminal.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;

      // Deterministic newline keys (Shift+Enter, Ctrl+J). Resolved by physical
      // `code` where needed so a CJK IME can't mangle the keystroke: xterm
      // derives Ctrl+<letter> from the deprecated `keyCode`, which becomes 229
      // ("Process") under an active IME, silently dropping Ctrl+J. We emit the
      // byte ourselves and bypass xterm. The resolver defers during an active
      // IME composition and when the user has bound Ctrl+J themselves. See
      // terminal/newlineKeys.ts.
      const newlineByte = resolveNewlineKeyByte(e, {
        hasCustomCtrlJBinding: useStore.getState().customKeybindings.some(
          (kb) => kb.key === 'Ctrl+J',
        ),
      });
      if (newlineByte !== null) {
        e.preventDefault();
        window.electronAPI.pty.write(ptyId, newlineByte);
        return false;
      }

      // IME-safe Escape (same class of bug as the Ctrl+J newline above).
      // When a CJK IME is active, Windows/Chromium delivers the Escape
      // keydown with `keyCode === 229` ("Process"). xterm's CompositionHelper
      // drops EVERY keyCode-229 keydown (it returns false, so `_keyDown` bails
      // before emitting), so no `\x1b` ever reaches the PTY — Esc silently does
      // nothing inside in-pane TUIs (Claude Code's /status dialog, fzf, less, …)
      // while Tab still works (Tab is keyCode 9, which the IME doesn't claim).
      // We emit the ESC byte ourselves and bypass xterm. `keyCode === 229` is
      // exactly the set xterm drops, so this never double-sends on the normal
      // keyCode-27 path. `!isComposing` defers to the IME while a candidate
      // window / preedit is open, where Escape legitimately cancels the
      // composition rather than the foreground app (mirrors newlineKeys).
      if (e.code === 'Escape' && !e.isComposing && e.keyCode === 229) {
        e.preventDefault();
        window.electronAPI.pty.write(ptyId, '\x1b');
        return false;
      }

      // Pass app shortcuts through to useKeyboard (don't let xterm consume them).
      // 'd' is the Ctrl+D split-right shortcut — without it xterm sends EOT (0x04)
      // to the PTY and PowerShell echoes it back as `^D` instead of triggering split.
      if (e.ctrlKey && !e.shiftKey && [',', 'b', 'd', 'k', 'i', 'n', 't', 'm', 'ArrowUp', 'ArrowDown', '`'].includes(e.key)) {
        return false; // let DOM bubble to useKeyboard
      }
      // Cross-layout / IME-safe fallback: when a Hangul or other non-Latin layout
      // is active, e.key is the composed letter (e.g. 'ㅇ') or 'Process', and the
      // allowlist above misses. Match by physical key code so the split shortcut
      // still works under any layout/IME state.
      if (e.ctrlKey && !e.shiftKey && ['KeyB', 'KeyD', 'KeyK', 'KeyI', 'KeyN', 'KeyT', 'KeyM', 'Comma', 'ArrowUp', 'ArrowDown'].includes(e.code)) {
        return false;
      }
      // Ctrl+` by code (cross-layout)
      if (e.ctrlKey && !e.shiftKey && e.code === 'Backquote') {
        return false;
      }
      // Terminal font zoom: Ctrl+= / Ctrl+- / Ctrl+0 (#171). Let these bubble to
      // useKeyboard instead of feeding '=' / '-' / '0' bytes to the PTY. Match by
      // physical code as well so zoom survives a Hangul / non-Latin IME. The
      // Ctrl++ (Shift+=) and numpad variants are already covered: the Ctrl+Shift
      // catch-all below bubbles the former, and useKeyboard maps NumpadAdd etc.
      if (e.ctrlKey && !e.shiftKey && (
        e.key === '=' || e.key === '-' || e.key === '0' ||
        e.code === 'Equal' || e.code === 'Minus' || e.code === 'Digit0' ||
        e.code === 'NumpadAdd' || e.code === 'NumpadSubtract' || e.code === 'Numpad0'
      )) {
        return false; // let DOM bubble to useKeyboard's zoom handlers
      }
      // Ctrl+Shift+C / Ctrl+Shift+V are explicit copy/paste, handled below.
      // Let them fall through; bubble every OTHER Ctrl+Shift combo to app
      // shortcuts. Exception matched by physical `code` so it survives a CJK IME
      // (e.key would be a composed jamo / 'Process', not 'C'/'V') — without this
      // the copy/paste handlers below were dead under any IME and even plain.
      if (e.ctrlKey && e.shiftKey && e.code !== 'KeyC' && e.code !== 'KeyV') {
        return false; // all other Ctrl+Shift combos → app shortcuts
      }

      // Custom keybindings: let function keys and matched combos pass through to useKeyboard
      const { customKeybindings } = useStore.getState();
      if (customKeybindings.length > 0) {
        const parts: string[] = [];
        if (e.ctrlKey) parts.push('Ctrl');
        if (e.shiftKey) parts.push('Shift');
        if (e.altKey) parts.push('Alt');
        let k = e.key;
        if (k.length === 1) k = k.toUpperCase();
        parts.push(k);
        const combo = parts.join('+');
        if (customKeybindings.some((kb) => kb.key === combo)) {
          return false; // let useKeyboard handle it
        }
      }

      // macOS-native clipboard: ⌘C copies the selection, ⌘V pastes. The Ctrl
      // handlers below stay intact, so Ctrl+C still sends SIGINT and the
      // Windows/Linux flow is unchanged. Match physical `code` so it survives a
      // CJK IME (e.key would be a composed jamo / 'Process', not 'c'/'v').
      const isMac = window.electronAPI?.platform === 'darwin';
      if (isMac && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === 'c' || e.code === 'KeyC')) {
        const sel = terminal.getSelection();
        if (sel) {
          void copySelectionWithFeedback(terminal, sel);
          return false;
        }
        return true; // no selection → let the OS handle ⌘C
      }
      if (isMac && e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && (e.key === 'v' || e.code === 'KeyV')) {
        e.preventDefault();
        void (async () => {
          const text = await window.clipboardAPI.readText();
          if (text) {
            const modes = (terminal as unknown as { modes?: { bracketedPasteMode?: boolean } }).modes;
            await pastePtyChunked((d) => window.electronAPI.pty.write(ptyId, d), text, modes);
            return;
          }
          if (window.clipboardAPI.readImage) {
            const imagePath = await window.clipboardAPI.readImage();
            if (imagePath) {
              const quoted = imagePath.includes(' ') ? `"${imagePath}"` : imagePath;
              window.electronAPI.pty.write(ptyId, quoted);
            }
          }
        })().catch(() => {});
        return false;
      }

      // Ctrl+C: copy if selection exists, otherwise send SIGINT. Match physical
      // `code` (KeyC) too — under a CJK IME xterm derives Ctrl+<letter> from the
      // deprecated keyCode, which becomes 229 ("Process"), so `e.key` is the
      // composed jamo ('ㅊ') or 'Process' rather than 'c'. Without the code
      // fallback the copy silently falls through to SIGINT (the reported "Ctrl+C
      // copy broken in Hangul mode" bug). Same IME class as the Ctrl+J / Escape
      // handlers above.
      if (e.ctrlKey && !e.shiftKey && (e.key === 'c' || e.code === 'KeyC')) {
        const sel = terminal.getSelection();
        if (sel) {
          // main now throws on clipboard failure — await + catch so the
          // user sees an error toast and the selection stays put for retry.
          void copySelectionWithFeedback(terminal, sel);
          return false;
        }
        return true; // no selection → SIGINT
      }

      // Ctrl+V: paste from clipboard (use our IPC clipboard, block event
      // so xterm doesn't also paste via browser's native paste event)
      if (e.ctrlKey && !e.shiftKey && (e.key === 'v' || e.code === 'KeyV')) {
        e.preventDefault();
        void (async () => {
          // Try text first
          const text = await window.clipboardAPI.readText();
          if (text) {
            // Async chunked write — paces IPC, normalizes CRLF to \r so
            // PowerShell does not execute mid-paste, keeps surrogate pairs
            // whole, and wraps the body in bracketed-paste markers when
            // the foreground app enabled DECSET 2004.
            const modes = (terminal as unknown as { modes?: { bracketedPasteMode?: boolean } }).modes;
            await pastePtyChunked((d) => window.electronAPI.pty.write(ptyId, d), text, modes);
            return;
          }
          // No text — check for image, save to temp file, paste path
          if (window.clipboardAPI.readImage) {
            const imagePath = await window.clipboardAPI.readImage();
            if (imagePath) {
              const quoted = imagePath.includes(' ') ? `"${imagePath}"` : imagePath;
              window.electronAPI.pty.write(ptyId, quoted);
            }
          }
        })().catch(() => {});
        return false;
      }

      // Ctrl+Shift+C: copy fallback
      if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.code === 'KeyC')) {
        const sel = terminal.getSelection();
        if (sel) {
          // Note: original handler did NOT clearSelection here. Preserve that
          // behavior — the helper's clearSelection runs on success only,
          // matching the Ctrl+C path; users wanting to keep selection used
          // Ctrl+Shift+C historically without an explicit "keep" toggle. We
          // intentionally still pass the terminal so a successful copy ends
          // up consistent with Ctrl+C.
          void copySelectionWithFeedback(terminal, sel);
        }
        return false;
      }
      // Ctrl+Shift+V: paste fallback
      if (e.ctrlKey && e.shiftKey && (e.key === 'V' || e.code === 'KeyV')) {
        e.preventDefault();
        void (async () => {
          const text = await window.clipboardAPI.readText();
          if (text) {
            const modes = (terminal as unknown as { modes?: { bracketedPasteMode?: boolean } }).modes;
            await pastePtyChunked((d) => window.electronAPI.pty.write(ptyId, d), text, modes);
            return;
          }
          if (window.clipboardAPI.readImage) {
            const imagePath = await window.clipboardAPI.readImage();
            if (imagePath) {
              const quoted = imagePath.includes(' ') ? `"${imagePath}"` : imagePath;
              window.electronAPI.pty.write(ptyId, quoted);
            }
          }
        })().catch(() => {});
        return false;
      }

      return true;
    });

    // Right-click behavior (Windows Terminal style):
    //  • On a link → show small context menu (open / copy link)
    //  • Selection present → copy (keep selection), no menu
    //  • Otherwise → paste immediately, no menu
    // `lastRightClickCopyAt` records when the most recent right-click copy ran
    // so the paste branch can suppress a paste that lands within
    // RIGHT_CLICK_PASTE_SUPPRESS_MS — the fix for the copy↔paste collision.
    let lastRightClickCopyAt = 0;
    terminal.element?.addEventListener('contextmenu', (e) => {
      e.preventDefault();

      // Detect if right-click target is a link element
      let linkUrl: string | null = null;
      const target = e.target as HTMLElement | null;
      if (target) {
        const anchor = target.closest('a[href]') as HTMLAnchorElement | null;
        if (anchor) linkUrl = anchor.href;
      }

      const sel = terminal.getSelection();

      // Link → defer to host (renders ContextMenu)
      if (linkUrl && onContextMenuRef.current) {
        onContextMenuRef.current({
          x: e.clientX,
          y: e.clientY,
          hasSelection: !!sel,
          selectedText: sel || '',
          linkUrl,
        });
        return;
      }

      // Selection → copy, KEEP selection (no menu). We deliberately do NOT
      // clear the selection here: the old async clearSelection() created a
      // window where a fast second right-click saw an empty selection and
      // pasted. Cancel any pending debounced auto-copy so this is the single
      // authoritative clipboard write for the selection, and stamp the copy
      // time so the paste branch can reject an immediately-following click.
      if (sel) {
        lastRightClickCopyAt = Date.now();
        autoCopy.dispose();
        void copySelectionWithFeedback(terminal, sel, { keepSelection: true });
        return;
      }

      // Foreground app owns the mouse (xterm mouseTrackingMode is non-'none' —
      // x10/vt200/drag/any, i.e. DECSET 9/1000/1002/1003): a plain right-click
      // already reaches the app as a mouse event, so wmux must NOT also paste —
      // that double-handling is the reported right-click double-paste.
      // Shift+right-click forces wmux's own paste (the suppression guard below
      // honours Shift too), matching Windows Terminal's Shift-override.
      const mouseMode = (terminal as unknown as { modes?: { mouseTrackingMode?: string } })
        .modes?.mouseTrackingMode ?? 'none';
      if (mouseMode !== 'none' && !e.shiftKey) {
        return;
      }

      // No selection, no link → paste immediately (text or image). Guard:
      // if a right-click copy just happened, this contextmenu is almost
      // certainly a stray repeat of the copy gesture (double right-click, or
      // the selection got wiped by incoming PTY data between two intentional
      // clicks). Suppressing the paste here is what kills the reported
      // copy↔paste collision. A held Shift is a deliberate paste, so it
      // bypasses this suppression — keeping Shift+right-click a true override.
      if (!e.shiftKey && Date.now() - lastRightClickCopyAt < RIGHT_CLICK_PASTE_SUPPRESS_MS) {
        return;
      }
      void (async () => {
        const modes = (terminal as unknown as { modes?: { bracketedPasteMode?: boolean } }).modes;

        // Text first, image fallback — matches the Ctrl+V handler. Browsers
        // populate clipboards with BOTH text/plain and a selection-screenshot
        // PNG when copying paragraphs; image-first would silently swap the
        // text out for a PNG path here, which is almost never the user's
        // intent. Image-only clipboards (Snipping Tool / PrtSc / image
        // editors) still flow through the fallback. readImage saves a PNG
        // temp file and returns its path — quoted on spaces and wrapped in
        // bracketed-paste sequences when the foreground app (Claude Code,
        // fish, modern bash) supports them so the path is recognized as a
        // single paste rather than streamed character-by-character.
        const text = await window.clipboardAPI.readText();
        if (text) {
          // Async chunked write: paces the IPC queue so the conpty input
          // pipe drains between chunks, normalizes line endings to \r so
          // PowerShell does not execute mid-paste, keeps surrogate pairs
          // whole, and wraps the body in bracketed-paste markers when
          // the foreground app enabled DECSET 2004.
          await pastePtyChunked((d) => window.electronAPI.pty.write(ptyId, d), text, modes);
          return;
        }

        const hasImg = await window.clipboardAPI.hasImage();
        if (hasImg) {
          const imagePath = await window.clipboardAPI.readImage();
          if (imagePath) {
            const quoted = imagePath.includes(' ') ? `"${imagePath}"` : imagePath;
            if (modes?.bracketedPasteMode) {
              window.electronAPI.pty.write(ptyId, `\x1b[200~${quoted}\x1b[201~`);
            } else {
              window.electronAPI.pty.write(ptyId, quoted);
            }
          }
        }
      })().catch((err) => console.error('[wmux:clipboard] right-click error:', err));
    });

    // Drag-and-drop is handled globally in preload via webUtils.getPathForFile()

    // Forward user input to PTY and track commands for palette history.
    //
    // `onData` is the catch-all for input that did not flow through our
    // explicit paste handlers — Shift+Insert, OS menu paste, middle-click
    // paste on Linux/macOS, IME commits, and normal keystrokes all land
    // here. Normal keystrokes are 1-4 code units and ship as a single
    // IPC write; anything larger is almost certainly an xterm-native
    // paste that bypassed our chunker, so route it through
    // `chunkOnDataIfNeeded` to pace the IPC queue and avoid the 100KB
    // silent backstop in `pty.handler.ts`. The helper preserves xterm's
    // own bracketed-paste markers if it pre-wrapped the payload.
    let inputBuffer = '';
    terminal.onData((data) => {
      // X6 ②: the user is driving this shell themselves — retract any pending
      // resume offer so the pill can't fire into a session they've moved on in.
      //
      // BUT onData also carries terminal REPORTS that are not user typing — most
      // notably focus-tracking (CSI I / CSI O), which xterm emits every time the
      // pane mounts or refocuses. A recovered agent pane fires CSI I on mount, so
      // without this guard the resume pill is cleared the instant it hydrates and
      // never renders (the bug that made the pill invisible after every reboot).
      // Focus reports are the only non-input bytes observed here; real keys,
      // pastes, and IME commits all still clear as intended.
      if (data !== '\x1b[I' && data !== '\x1b[O') {
        useStore.getState().clearResumeHint(ptyId);
      }
      void chunkOnDataIfNeeded(
        (d) => window.electronAPI.pty.write(ptyId, d),
        data,
      ).catch((err) => console.error('[wmux:onData] chunk write failed:', err));

      if (data === '\r' || data === '\n') {
        const cmd = inputBuffer.trim();
        if (cmd.length > 1) {
          useStore.getState().addRecentCommand(cmd);
        }
        inputBuffer = '';
      } else if (data === '\x7f' || data === '\b') {
        // Backspace
        inputBuffer = inputBuffer.slice(0, -1);
      } else if (data.length === 1 && data.charCodeAt(0) >= 32) {
        // Printable character
        inputBuffer += data;
      } else if (data.length > 1 && !data.startsWith('\x1b')) {
        // Pasted text (not escape sequence)
        inputBuffer += data;
      }
    });

    // Deferred PTY listener references — connected after scrollback restore
    let removeDataListener: (() => void) | null = null;
    let removeExitListener: (() => void) | null = null;
    // Phase A — A6 cold-start race fix (codex review P2 #2, session
    // 019e2af8). When `.txt` restore lands before daemon mode flips, the
    // race-cancel guard inside scrollback.load().then() does nothing
    // (`isDaemonModeActive()` is still false). The stale `.txt` content
    // is then written into the terminal and a subsequent daemon connect
    // would replay the daemon RingBuffer on top, recreating the composed
    // scrollback corruption A6 is meant to prevent.
    //
    // Track whether `.txt` content was actually written, and if so listen
    // for `daemon:connected` — when it fires, clear + reset the terminal
    // before SessionPipe replay arrives, so the daemon flush lands on a
    // fresh xterm with no stale prefix.
    let didRestoreTxt = false;
    let removeDaemonConnectedForRestore: (() => void) | null = null;
    // Flush-marker reset gating (see docs/internal/scrollback-restore-design.md).
    // The previous unconditional `terminal.reset()` on `daemon.onConnected`
    // wiped the .txt-cache replay even when the daemon then sent zero bytes
    // (cap-skipped session or fresh create). Two flags coordinate the new
    // gate: `pendingFlushReset` means "daemon connected after .txt was
    // restored — we owe a verdict once flush bytes are known";
    // `lastFlushRecoveredBytes` caches the verdict for the inverse race
    // (flush arrives before daemon.onConnected fires).
    let pendingFlushReset = false;
    let lastFlushRecoveredBytes: number | null = null;
    let removeFlushListener: (() => void) | null = null;
    let firstDataFired = false;
    const fireFirstData = () => {
      if (!firstDataFired) {
        firstDataFired = true;
        onFirstDataRef.current?.();
      }
    };
    // X6 ②: the resume pill becomes clickable only on LIVE PTY data — NOT on
    // restored scrollback (which also calls fireFirstData to hide overlays).
    // Marking ready on a restore write would let the pill paste before the
    // recovered pipe is confirmed writable (CodeRabbit #3 / eng review EI6).
    const markPaneLive = () => useStore.getState().markPtyReady(ptyId);

    // Restore scrollback from previous session, then connect PTY data listener.
    // Scrollback must be written BEFORE PTY data listener is connected so new
    // output appends after restored content rather than interleaving.
    const connectPty = () => {
      removeDataListener = window.electronAPI.pty.onData((id, data) => {
        if (id === ptyId) {
          terminal.write(data);
          glyphRepaint.onData(data.length);
          fireFirstData();
          markPaneLive();
        }
      });

      removeExitListener = window.electronAPI.pty.onExit((id, exitCode) => {
        if (id === ptyId) {
          terminal.writeln(`\r\n${t('terminal.exitedBracket', { code: exitCode })}`);
        }
      });
    };

    if (scrollbackFile) {
      // Register PTY listeners immediately to avoid data loss during scrollback load.
      // scrollback.load() is async (IPC round-trip). If PTY sends data before it
      // resolves, connectPty() would not yet be called and data would be lost.
      // Instead, buffer incoming data and flush after scrollback is written.
      const pendingData: string[] = [];
      let scrollbackLoaded = false;

      removeDataListener = window.electronAPI.pty.onData((id, data) => {
        if (id !== ptyId) return;
        if (!scrollbackLoaded) {
          pendingData.push(data);
          return;
        }
        terminal.write(data);
        glyphRepaint.onData(data.length);
        fireFirstData();
        markPaneLive();
      });

      removeExitListener = window.electronAPI.pty.onExit((id, exitCode) => {
        if (id === ptyId) {
          terminal.writeln(`\r\n${t('terminal.exitedBracket', { code: exitCode })}`);
        }
      });

      // Listen for the daemon's flush-complete signal. Two-way race:
      //  - Flush arrives first: cache `recoveredBytes`; the
      //    `daemon.onConnected` callback below reads it when it fires.
      //  - Flush arrives second: the callback set `pendingFlushReset=true`;
      //    we apply the verdict now.
      removeFlushListener = window.electronAPI.pty.onFlushComplete((id, recoveredBytes) => {
        if (id !== ptyId) return;
        if (terminalRef.current !== terminal) return;
        lastFlushRecoveredBytes = recoveredBytes;
        if (pendingFlushReset) {
          pendingFlushReset = false;
          if (recoveredBytes > 0) terminal.reset();
        }
      });

      // Fix 0 (round 3) — all listeners (pty.onData, pty.onFlushComplete,
      // pty.onExit) are now wired, which is the precondition for triggering
      // pty.reconnect (the replay must land on registered listeners, never
      // before mount as AppLayout.reconcile used to do).
      // Fix D (2026-05-30) — the actual reattach moved to the dedicated
      // daemon-mode effect below so it fires whether daemon mode is active at
      // mount OR connects later (the fresh-daemon-spawn startup race that left
      // panes blank with no replay). That effect runs after this mount effect,
      // so the listeners above are already registered when it reconnects.

      window.electronAPI.scrollback.load(scrollbackFile).then((content) => {
        // Skip the entire branch if the terminal was disposed during the
        // async IPC round-trip. Without this, the pendingData flush below
        // would write into a torn-down terminal on fast unmount + remount
        // (e.g. workspace switch mid-restore).
        if (terminalRef.current !== terminal) return;
        // Phase A — A6. Race cancel: if daemon mode activated between the
        // scrollback.load() call and now, discard the .txt content. The
        // daemon SessionPipe replay will provide authoritative scrollback
        // and writing the stale .txt here would compose it with that
        // replay (via the divider below), producing visibly broken output.
        // Pending PTY data still flushes through unchanged.
        const restored = isDaemonModeActive() ? null : content;
        if (restored) {
          terminal.write(restored);
          // Whitespace + ANSI reset boundary so restored scrollback doesn't
          // visually fuse with the fresh PTY prompt drawn moments later.
          // \x1b[0m closes any attribute left open by restored content; the
          // surrounding \r\n pair guards cursor placement when restored
          // content doesn't end on a newline and gives the new prompt one
          // blank line of headroom. No text label — Search/copy/vi-copy
          // would otherwise treat a localized divider string as real shell
          // output.
          terminal.write('\r\n\x1b[0m\r\n');
          fireFirstData();
          didRestoreTxt = true;
          // Arm the late-connect clear. If daemon mode activates after this
          // moment, the reset only fires when the daemon actually has
          // authoritative scrollback to replay (recoveredBytes > 0).
          // Two race outcomes are handled:
          //   1. Flush already arrived (lastFlushRecoveredBytes != null):
          //      apply its verdict immediately.
          //   2. Flush hasn't arrived: set pendingFlushReset so the
          //      flush-complete listener applies the verdict later.
          // recoveredBytes=0 (cap-skipped session or fresh create) leaves
          // the .txt cache on screen — degraded gracefully instead of
          // wiping to a blank prompt.
          removeDaemonConnectedForRestore = window.electronAPI.daemon.onConnected(() => {
            if (!didRestoreTxt) return;
            if (terminalRef.current !== terminal) return;
            didRestoreTxt = false;
            if (lastFlushRecoveredBytes !== null) {
              if (lastFlushRecoveredBytes > 0) terminal.reset();
            } else {
              pendingFlushReset = true;
            }
          });
        }
        scrollbackLoaded = true;
        for (const data of pendingData) {
          terminal.write(data);
        }
        if (pendingData.length > 0) { fireFirstData(); markPaneLive(); }
        pendingData.length = 0;
        // Register with the scrollback autosave only after restore
        // completes. Setting it synchronously before the async load lets
        // the 5s autosave tick dump an empty/partial buffer over the
        // previous scrollback file on disk.
        registerTerminal(ptyId, terminal);
      }).catch((err) => {
        // Instrumentation: surface the real failure reason. Previously this
        // catch silently swallowed errors, including "No handler registered
        // for 'scrollback:load'" rejections that occur during the main-side
        // IPC handler swap window (daemon connect, src/main/index.ts).
        // Without this log, a failed restore is indistinguishable from a
        // legitimately empty scrollback file, and the next 5s autosave
        // overwrites the previous (intact) file on disk with the fresh PTY
        // prompt — destroying the user's prior session output. The renderer
        // console.error is mirrored into the main-side log file by the
        // webContents `console-message` listener in src/main/index.ts.
        const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        // eslint-disable-next-line no-console
        console.error(`[useTerminal] scrollback.load FAILED surfaceFile=${scrollbackFile} ptyId=${ptyId} err=${msg}`);
        if (terminalRef.current !== terminal) return;
        scrollbackLoaded = true;
        for (const data of pendingData) {
          terminal.write(data);
        }
        if (pendingData.length > 0) { fireFirstData(); markPaneLive(); }
        pendingData.length = 0;
        registerTerminal(ptyId, terminal);
      });
    } else {
      connectPty();
      // No scrollback to restore — register immediately for fresh terminals.
      registerTerminal(ptyId, terminal);
      // Fix D — daemon (re)attach is owned by the daemon-mode effect below
      // (fires at mount if active, or on a later daemon:connected). connectPty
      // above has already registered pty.onData/onExit, so replay lands safely.
    }

    // Resize PTY on initial fit — only when we actually have valid dimensions.
    const { cols, rows } = terminal;
    if (cols > 0 && rows > 0) {
      lastSentCols = cols;
      lastSentRows = rows;
      sendResize(ptyId, cols, rows);
    }

    // Terminal registry registration is now per-branch above:
    //   - scrollback branch: after restore completes (Race B guard)
    //   - fresh branch: immediately after connectPty()

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;

    // ResizeObserver for auto-fit — preserves user scroll position across resize.
    // IMPORTANT: skip when the container has zero dimensions (display:none workspace).
    // Fitting a hidden terminal produces 0 cols/rows, which corrupts the PTY buffer
    // and manifests as "infinite content duplication" when switching back to it.
    const resizeObserver = new ResizeObserver(() => {
      if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer);
      resizeDebounceTimer = setTimeout(() => {
        resizeDebounceTimer = null;
        requestAnimationFrame(() => {
          try {
            const term = terminalRef.current;
            if (!term) return;

            if (container.offsetWidth === 0 || container.offsetHeight === 0) return;

            // Selection-preservation guard: xterm's SelectionService clears
            // the active selection on any rowsChanged event from fit().
            // While the user is dragging out a selection (or while a
            // selection is live waiting to be copied) skip this fit and let
            // the next ResizeObserver tick handle the resize once the
            // selection is released.
            if (!shouldFitWhilePreservingSelection(term)) {
              console.debug('[Terminal] resize fit skipped — active selection');
              return;
            }

            const prevYBase = term.buffer.active.baseY;
            const prevYDisp = term.buffer.active.viewportY;
            const wasScrolledUp = prevYDisp < prevYBase;
            const distFromBottom = prevYBase - prevYDisp;

            fitAddon.fit();

            if (wasScrolledUp) {
              const newYBase = term.buffer.active.baseY;
              const targetYDisp = Math.max(0, newYBase - distFromBottom);
              term.scrollToLine(targetYDisp);
            }

            const { cols, rows } = term;
            const currentPtyId = ptyIdRef.current;
            if (currentPtyId && cols > 0 && rows > 0 && (cols !== lastSentCols || rows !== lastSentRows)) {
              lastSentCols = cols;
              lastSentRows = rows;
              sendResize(currentPtyId, cols, rows);
            }
          } catch {
            // ignore fit errors during unmount
          }
        });
      }, 100);
    });
    resizeObserver.observe(container);

    return () => {
      if (resizeDebounceTimer) clearTimeout(resizeDebounceTimer);
      terminal.textarea?.removeEventListener('focus', onTextareaFocus);
      glyphRepaint.dispose();
      glyphRepaintRef.current = null;
      imeResidueGuard?.dispose();
      imeStormGuard.dispose();
      autoCopy.dispose();
      selectionDisposable.dispose();
      pathLinkDisposable.dispose();
      resizeObserver.disconnect();
      removeDataListener?.();
      removeExitListener?.();
      removeDaemonConnectedForRestore?.();
      removeFlushListener?.();
      terminalRegistry.delete(ptyId);
      if (webglDisposeTimerRef.current) {
        clearTimeout(webglDisposeTimerRef.current);
        webglDisposeTimerRef.current = null;
      }
      // Release our pool slot (disposes the addon if we held a context) so the
      // budget frees for other terminals. The backstop teardown covers the
      // unlikely case of an addon created outside a pool grant (e.g. the
      // fonts.ready atlas rebuild firing during teardown) — it must loseContext
      // too, not just dispose, or unmount churn leaks zombie contexts (#191 / #197).
      webglContextPool.release(webglTokenRef.current);
      if (webglAddonRef.current) {
        teardownWebglAddon(webglAddonRef.current);
        webglAddonRef.current = null;
      }
      loadWebglRef.current = null;
      disposeWebglRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    };
  }, [ptyId, containerRef]);

  // Fix D (2026-05-30 blank-terminal-on-restore): own the daemon session
  // (re)attach here instead of as a one-shot `if (daemonModeAtMount)` gate
  // inside the mount effect. When wmux spawns a fresh daemon, its connect
  // signal can land AFTER this terminal mounts — the renderer reconciles and
  // opens the pane gate before main finishes bootstrapping a cold daemon that
  // is recovering a large session set. The mount-time snapshot was then false,
  // so the pane kept a valid ptyId but never called pty.reconnect: the daemon
  // never attached a SessionPipe, no RingBuffer replay arrived, and the
  // terminal sat blank (the exact dogfood symptom — 20 live sessions, zero
  // daemon-side attachSession). This effect reattaches when daemon mode is
  // active at mount OR when `daemon:connected` fires later (also self-heals a
  // mid-session daemon respawn). The mount effect has already wired
  // pty.onData/onExit/onFlushComplete by the time this runs, so replay lands on
  // registered listeners (the Fix 0 invariant). The effect re-runs (and its
  // local in-flight guard resets) when ptyId changes.
  useEffect(() => {
    const id = ptyId;
    if (!id) return;
    // In-flight guard local to THIS ptyId: collapse a near-simultaneous
    // active-at-mount + daemon:connected into a single reconnect so the daemon
    // RingBuffer replay isn't doubled (scrollback duplication). It is NOT a
    // permanent latch — once an attempt settles, a later connect/respawn
    // reattaches again. Lives in the effect-run closure so it resets per ptyId.
    let inFlight = false;
    const reattach = (reason: string) => {
      if (inFlight) return;
      inFlight = true;
      console.log(`[useTerminal] daemon reattach ptyId=${id} (${reason})`);
      void reconnectPtyWithRetry(id, () => ptyIdRef.current === id && terminalRef.current !== null)
        .finally(() => { inFlight = false; });
    };
    // Daemon already connected when we mounted: its daemon:connected fired before
    // the renderer could listen, so we reattach now off the module flag (set by
    // AppLayout's serialized startup before the pane gate opens).
    if (isDaemonModeActive()) reattach('active-at-mount');
    // Every LATER connect/respawn reattaches to the new daemon generation.
    // Codex P2: do NOT gate this on isDaemonModeActive() and do NOT latch it —
    // (a) our listener can run before AppLayout's flips the module flag true, so
    // gating here would drop the only reattach for that generation; (b) a latch
    // would skip every generation after the first (a respawn would leave the
    // pane attached to a dead session). The event itself is the connect signal.
    const off = window.electronAPI.daemon.onConnected(() => reattach('daemon:connected'));
    // X8 — a supervised restart re-created THIS session under the same id with a
    // fresh PTY. The daemon:connected reattach trigger above does NOT fire (the
    // daemon never disconnected), so PTY_RESTARTED is the dedicated signal:
    //   (1) print an in-pane marker, style-matched to the exit marker (leading
    //       \r\n + bracketed line, no colour), so the user sees visual
    //       continuity (exit line → restart line → fresh output) plus the
    //       Ctrl+C escape-hatch hint (decision ⑨); and
    //   (2) drive the SAME reconnect path the daemon:connected effect uses, so
    //       attach + SessionPipe + pid-map re-anchor all happen.
    // onExit only prints (no "dead" UI state to clear), so a restart needs no
    // extra teardown reversal — just the marker + reattach.
    const offRestarted = window.electronAPI.pty.onRestarted((payload) => {
      if (payload.ptyId !== id) return;
      const term = terminalRef.current;
      if (term && ptyIdRef.current === id) {
        const line = payload.exitCode !== null
          ? t('terminal.supervisedRestartExit', { count: payload.restartCount, code: payload.exitCode })
          : t('terminal.supervisedRestart', { count: payload.restartCount });
        term.writeln(`\r\n${line}`);
      }
      reattach('pty:restarted');
    });
    return () => { if (off) off(); offRestarted(); };
  }, [ptyId]);

  // Apply font/theme changes at runtime without recreating the terminal instance.
  // This preserves the scrollback buffer when the user tweaks visual settings.
  useEffect(() => {
    if (!terminalRef.current) return;
    terminalRef.current.options.fontSize = terminalFontSize;
    terminalRef.current.options.fontFamily = terminalFontFamilyCss(terminalFontFamily);
    terminalRef.current.options.theme = xtermTheme;
    terminalRef.current.options.minimumContrastRatio = minimumContrastRatio;
    // Keep the container backdrop in sync with the new theme background (see the
    // create effect). Done before the selection/visibility fit guards so the
    // colour tracks the theme even when a fit is skipped mid-selection.
    if (containerRef.current) {
      containerRef.current.style.backgroundColor = xtermTheme.background ?? '';
    }
    // Selection-preservation guard — see ResizeObserver above.
    if (!shouldFitWhilePreservingSelection(terminalRef.current)) {
      console.debug('[Terminal] font/theme fit skipped — active selection');
      return;
    }
    // Visibility guard — when the workspace tab containing this terminal is
    // hidden (display:none) the container has zero dimensions and fit() will
    // collapse cols to a tiny value. That reflows the in-memory buffer to
    // one or two characters per physical row; the next scrollback dump
    // persists that garbled state to disk and on the next launch the user
    // sees an "empty / column-of-chars" terminal. The other fit() sites in
    // this hook (initial mount, ResizeObserver, fonts.ready, visibility
    // watcher, `fit` callback) already have this guard — font/theme was
    // the last unguarded site.
    const container = containerRef.current;
    if (!container || container.offsetWidth === 0 || container.offsetHeight === 0) {
      console.debug('[Terminal] font/theme fit skipped — container has zero dimensions');
      return;
    }
    fitAddonRef.current?.fit();
  }, [terminalFontSize, terminalFontFamily, xtermTheme, minimumContrastRatio, containerRef]);

  // Manage WebGL lifecycle based on visibility.
  // Load WebGL when visible (GPU-accelerated rendering), dispose when hidden
  // to free the WebGL context for other terminals.  Also re-fit so a terminal
  // that was initialized while hidden displays at the correct size.
  useEffect(() => {
    const token = webglTokenRef.current;
    if (isVisible) {
      // Cancel any pending deferred release — the terminal is visible again
      // (fast workspace switch / multiview<->single toggle), so keep our slot
      // instead of freeing and rebuilding it. This is the de-thrash that
      // removes the view-switch lag.
      if (webglDisposeTimerRef.current) {
        clearTimeout(webglDisposeTimerRef.current);
        webglDisposeTimerRef.current = null;
      }
      // Ask the shared pool for a context. Under budget → granted immediately;
      // at budget → the pool evicts the least-recently-shown terminal (it drops
      // to the DOM renderer) and grants us. This hard-bounds the live context
      // count below Chromium's cap, so no terminal is ever force-evicted into a
      // blank pane. Idempotent if we already hold one (just bumps our LRU rank).
      if (loadWebglRef.current && disposeWebglRef.current) {
        webglContextPool.acquire(token, loadWebglRef.current, disposeWebglRef.current);
      }
      // Defer fit to allow CSS display change to take effect before measuring.
      // Selection-preservation guard — workspace/tab switch then immediate
      // selection + Ctrl+C used to wipe the selection because this fit had
      // no guard (unlike ResizeObserver and font/theme paths). The next
      // ResizeObserver tick (after selection is released) handles the
      // deferred resize naturally.
      const id = requestAnimationFrame(() => {
        // Issue #166 — repaint BEFORE the selection guard: refresh() does not
        // touch the selection, and a stale pane must repair on view-switch-back
        // even while a selection is live. This matters most on a fast switch
        // where the pool kept the old (possibly stale) context alive instead of
        // rebuilding it.
        glyphRepaintRef.current?.onVisible();
        if (!shouldFitWhilePreservingSelection(terminalRef.current)) {
          console.debug('[Terminal] visibility fit skipped — active selection');
          return;
        }
        fit();
      });
      return () => cancelAnimationFrame(id);
    } else {
      // DEFER the pool release rather than freeing the instant the terminal is
      // hidden (see WEBGL_HIDDEN_DISPOSE_DELAY_MS). A hidden terminal usually
      // reappears within seconds; releasing immediately is the view-switch lag.
      // If another terminal needs the budget sooner, the pool evicts us anyway
      // (we are the least-recently-shown), so this timer is only the no-pressure
      // cleanup that frees the slot when nothing else is contending for it.
      if (!webglDisposeTimerRef.current) {
        webglDisposeTimerRef.current = setTimeout(() => {
          webglDisposeTimerRef.current = null;
          webglContextPool.release(token);
        }, WEBGL_HIDDEN_DISPOSE_DELAY_MS);
      }
    }
  }, [isVisible, fit]);

  const getSearchDecorations = useCallback(() => {
    const y = getComputedStyle(document.documentElement).getPropertyValue('--accent-yellow').trim();
    return {
      matchBackground: y + '40',
      matchBorder: y,
      matchOverviewRuler: y,
      activeMatchBackground: y + '80',
      activeMatchBorder: y,
      activeMatchColorOverviewRuler: y,
    };
  }, []);

  const findNext = useCallback((text: string, useRegex = false) => {
    searchAddonRef.current?.findNext(text, { decorations: getSearchDecorations(), regex: useRegex });
  }, [getSearchDecorations]);

  const findPrevious = useCallback((text: string, useRegex = false) => {
    searchAddonRef.current?.findPrevious(text, { decorations: getSearchDecorations(), regex: useRegex });
  }, [getSearchDecorations]);

  const clearSearch = useCallback(() => {
    searchAddonRef.current?.clearDecorations();
  }, []);

  /** Returns the current absolute scroll position: baseY + viewportY */
  const getScrollPosition = useCallback((): number => {
    const term = terminalRef.current;
    if (!term) return 0;
    return term.buffer.active.baseY + term.buffer.active.viewportY;
  }, []);

  /** Scrolls the terminal to the given absolute line number */
  const scrollToLine = useCallback((line: number) => {
    terminalRef.current?.scrollToLine(line);
  }, []);

  return { terminal: terminalRef, fit, searchAddonRef, findNext, findPrevious, clearSearch, getScrollPosition, scrollToLine };
}
