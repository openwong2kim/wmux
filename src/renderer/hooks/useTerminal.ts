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
import { resolveMinimumContrastRatio } from '../tailwindPalette';
import { isDaemonModeActive } from '../daemon/daemonMode';
import { pastePtyChunked, chunkOnDataIfNeeded } from '../utils/clipboardChunk';
import { openTerminalUrl } from '../utils/browserPaneActions';
import { runCopyWithFeedback } from '../utils/copyWithFeedback';
import { shouldFitWhilePreservingSelection } from '../utils/fitGuard';
import { createAutoSelectionCopy } from '../utils/autoSelectionCopy';
import { decodeOsc52Write } from '../utils/osc52Clipboard';
import { terminalFontFamilyCss } from '../utils/terminalFont';
import { createPathLinkProvider } from '../terminal/pathLinkProvider';
import { resolveNewlineKeyByte } from '../terminal/newlineKeys';
import { attachImeResidueGuard } from '../terminal/imeResidueGuard';
import { attachImeStormGuard } from '../terminal/imeStormGuard';
import { webglContextPool } from '../terminal/webglContextPool';
import { teardownWebglAddon } from '../terminal/webglTeardown';
import { createGlyphRepaintScheduler, type GlyphRepaintScheduler } from '../terminal/glyphRepaint';
import { createDeadInputWatchdog } from '../terminal/deadInputWatchdog';
import { STALE_REPLAY_INPUT_MODE_RESETS } from '../terminal/staleReplayModeReset';
import {
  writeTerminalOutput,
  flushTerminalOutput,
  noteTerminalInput,
  discardTerminalOutput,
  isTerminalDirty,
  isTerminalRetained,
  markTerminalDirty,
  markTerminalClean,
  getQueuedCharCount,
  promoteTerminalToPriorityDrain,
} from '../terminal/terminalOutputScheduler';
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

// === P0-3: single-dispatch PTY event fan-out ================================
// Each mounted terminal used to register its own GLOBAL pty.onData / onExit /
// onFlushComplete IPC listener, so every event ran O(N panes) callbacks each
// doing an `id === ptyId` compare. One module-level IPC listener per channel
// plus a per-ptyId registration Set makes dispatch O(1) in pane count.
// A Set (not a single slot) because a fast unmount→remount briefly runs two
// instances on one ptyId (see the webglTokenSeq note below) — instance A's
// late cleanup must remove only its OWN handler, never instance B's.
type PtyEventDispatcher<T> = {
  register: (ptyId: string, handler: (payload: T) => void) => () => void;
  reset: () => void;
};
// Exported for unit tests (dual-mount overlap ordering); production code uses
// only the three module-level instances below.
export function createPtyDispatcher<T>(
  attach: (cb: (id: string, payload: T) => void) => () => void,
): PtyEventDispatcher<T> {
  const handlers = new Map<string, Set<(payload: T) => void>>();
  let detach: (() => void) | null = null;
  return {
    register(ptyId, handler) {
      if (!detach) {
        // Lazy attach: window.electronAPI is only touched at first use so the
        // module can be imported in non-preload test environments.
        detach = attach((id, payload) => {
          const set = handlers.get(id);
          if (!set) return;
          for (const h of [...set]) h(payload);
        });
      }
      let set = handlers.get(ptyId);
      if (!set) { set = new Set(); handlers.set(ptyId, set); }
      set.add(handler);
      return () => {
        const s = handlers.get(ptyId);
        if (!s || !s.delete(handler)) {
          // Guarded removal declined (already gone / foreign registration) —
          // log once per occurrence: this is the dual-mount overlap window.
          console.log(`[useTerminal] dispatcher: stale unsubscribe ignored ptyId=${ptyId}`);
          return;
        }
        if (s.size === 0) handlers.delete(ptyId);
      };
    },
    reset() {
      handlers.clear();
      if (detach) { detach(); detach = null; }
    },
  };
}
const ptyDataDispatcher = createPtyDispatcher<string>((cb) =>
  window.electronAPI.pty.onData(cb));
const ptyExitDispatcher = createPtyDispatcher<number>((cb) =>
  window.electronAPI.pty.onExit(cb));
const ptyFlushDispatcher = createPtyDispatcher<number>((cb) =>
  window.electronAPI.pty.onFlushComplete(cb));
/** Test seam: detach the global IPC listeners and drop all registrations so
 *  per-test electronAPI mocks don't leak across cases. */
export function __resetPtyDispatchersForTests(): void {
  ptyDataDispatcher.reset();
  ptyExitDispatcher.reset();
  ptyFlushDispatcher.reset();
}

// === P0-5: per-pane freshness state for the UI ==============================
// 'syncing'  — a daemon resync is in flight (reveal/read of a dirty pane).
// 'stale'    — a resync degraded; the screen may be missing output until the
//              cooldown expires and a later reveal/read retries.
// null       — fresh/normal.
export type PaneSyncUiState = 'syncing' | 'stale' | null;
const paneSyncUiStates = new Map<string, PaneSyncUiState>();
const paneSyncUiListeners = new Map<string, Set<(s: PaneSyncUiState) => void>>();
function setPaneSyncUi(ptyId: string, state: PaneSyncUiState): void {
  if (!ptyId) return;
  if ((paneSyncUiStates.get(ptyId) ?? null) === state) return;
  if (state === null) paneSyncUiStates.delete(ptyId); else paneSyncUiStates.set(ptyId, state);
  const set = paneSyncUiListeners.get(ptyId);
  if (set) for (const l of [...set]) l(state);
}
export function getPaneSyncUi(ptyId: string): PaneSyncUiState {
  return paneSyncUiStates.get(ptyId) ?? null;
}
export function subscribePaneSyncUi(ptyId: string, listener: (s: PaneSyncUiState) => void): () => void {
  let set = paneSyncUiListeners.get(ptyId);
  if (!set) { set = new Set(); paneSyncUiListeners.set(ptyId, set); }
  set.add(listener);
  return () => {
    const s = paneSyncUiListeners.get(ptyId);
    if (!s) return;
    s.delete(listener);
    if (s.size === 0) paneSyncUiListeners.delete(ptyId);
  };
}

// === Phase 3: hidden-pane retention (PR-A) ==================================
// When enabled (settings toggle, daemon mode only), hidden panes' PTY output
// is queued by the scheduler but never parsed. A pane whose backlog overflowed
// is DIRTY — its xterm buffer is stale — and must be re-synchronized before it
// is shown (reveal) or read (MCP pane.search / input.readScreen). PR-A resyncs
// via the existing raw reconnect replay; PR-B swaps the replay payload for a
// daemon-side parsed snapshot without touching this protocol.

/** Retention applies only to daemon-backed sessions: dirtiness is recoverable
 *  precisely because the daemon RingBuffer retains the authoritative bytes. */
function hiddenRetentionActive(): boolean {
  return isDaemonModeActive() && useStore.getState().hiddenPaneRetentionEnabled;
}

/** Reveal-time flush cap (GPU repaint-burst fix, 2026-07-21). A retained
 *  backlog handed to xterm in one shot on reveal is a single giant parse that
 *  dirties the whole viewport and rasters it across many consecutive frames —
 *  the measured workspace-switch burst. Above this size we discard the backlog
 *  and re-synchronize a bounded screen snapshot from the daemon instead, which
 *  is cheaper than parsing to reconstruct a screen the daemon can serialize in
 *  a few KB (one clean repaint vs. a multi-frame raster storm).
 *
 *  Threshold: xterm parses ~5–35 MB/s (xterm.js flow-control docs), so 256 KB
 *  is ~7–50 ms of parse — the point where a reveal starts spanning multiple
 *  frames and the raster becomes perceptible. This is the SOFT (perf) cap;
 *  MAX_QUEUE_CHARS (2 MB, scheduler) is the HARD (memory) cap that force-
 *  discards. Both use the identical discard→dirty→resync mechanism and safety;
 *  they differ only in trigger (perceptible parse vs. unbounded memory). */
const REVEAL_FLUSH_MAX_CHARS = 256 * 1024;

/** One-shot diagnostic latch: logged at the first data event that arrives for
 *  a HIDDEN pane (the earliest moment the retention decision matters), with
 *  every gate input — the dogfood answer to "why is retention (not) engaging
 *  in this session". Mirrored into the main log. */
let retentionGateLogged = false;
function logRetentionGateOnce(retain: boolean): void {
  if (retentionGateLogged) return;
  retentionGateLogged = true;
  console.log(`[wmux:hidden-retention] first hidden-pane data event: retain=${retain} daemonMode=${isDaemonModeActive()} settingsFlag=${useStore.getState().hiddenPaneRetentionEnabled}`);
}

/** Resync must settle within this budget or we degrade to the stale screen
 *  (never a stuck pane, never a cleared ptyId). */
const RESYNC_TIMEOUT_MS = 8_000;
/** Hard cap on bytes buffered while a resync replay is in flight (the ring is
 *  ≤8MB; anything past this means the flush marker is not coming). */
const RESYNC_BUFFER_MAX_CHARS = 32 * 1024 * 1024;

interface ResyncState {
  pending: boolean;
  /** pty:data received while the resync replay is in flight — held out of
   *  xterm so the reset below cannot race half-parsed replay bytes. */
  buffer: string[];
  bufferedChars: number;
  resolvers: Array<() => void>;
  timer: ReturnType<typeof setTimeout> | null;
  /** P0-2: a degraded (failed) resync leaves the pane DIRTY so the next
   *  reveal/read retries, but retries are suppressed until this timestamp so
   *  a polling agent cannot storm a struggling daemon with back-to-back
   *  resync attempts. */
  degradedUntil: number;
  /** P0-5: the in-flight resync fell back from pty.resync to the raw
   *  pty.reconnect path — the settlement log must report
   *  mechanism=dirty-raw-fallback, not dirty-snapshot, or doctor's counters
   *  mask fallback regressions (codex, PR #470). */
  viaRawFallback: boolean;
}

/** Cooldown between resync retries after a degrade. Long enough to ride out a
 *  daemon restart, short enough that the next deliberate workspace switch
 *  usually retries. */
const RESYNC_DEGRADED_COOLDOWN_MS = 30_000;

// Read-path hydration (MCP pane.search / input.readScreen): a dirty hidden
// pane must be re-synced before its buffer is scanned, or agents silently read
// stale output. Keyed by ptyId; registered per mounted terminal.
const hydrateRegistry = new Map<string, () => Promise<void>>();
export async function hydrateTerminalForRead(ptyId: string): Promise<void> {
  const fn = hydrateRegistry.get(ptyId);
  if (fn) await fn();
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
// 2026-07 perf pass (TASK-8): 10s → 5s. 10s effectively pinned contexts on
// hidden panes long enough that >12-pane fleets leaned on LRU eviction (the
// expensive path) instead of this cheap timer. 5s still covers the common
// quick switch-back; if rapid workspace cycling ever shows blank-pane thrash,
// revert toward 7s.
export const WEBGL_HIDDEN_DISPOSE_DELAY_MS = 5_000;

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
// this, Ctrl+clicking (mac: Cmd+clicking) an .exe (blocked main-side) or a missing file
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
  // Apps that emit true-color RGB foreground text (e.g. Claude Code, some
  // TUI tools) bypass our indexed ANSI palette mapping entirely — the color
  // renders exactly as specified, in BOTH directions: literal white on a
  // light theme's cream background (#74), and literal near-black on a dark
  // theme's near-black background (2026-07-15 dogfood report — "text turns
  // black while using Claude" on Amber). xterm's minimumContrastRatio nudges
  // just the offending cell's foreground until it clears the floor; see
  // resolveMinimumContrastRatio for why dark themes get a lower (2.5, not
  // 4.5) floor — it rescues genuinely-invisible text without forcing every
  // dark theme's intentionally-muted secondary text up to full AA.
  const minimumContrastRatio = resolveMinimumContrastRatio(xtermTheme.background);

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

  // Phase 3 resync state — shared between the mount effect (pty listeners),
  // the visibility effect (dirty reveal) and the hydrate registry entry.
  const resyncRef = useRef<ResyncState>({
    pending: false, buffer: [], bufferedChars: 0, resolvers: [], timer: null,
    degradedUntil: 0, viaRawFallback: false,
  });

  /** Degrade: release whatever was buffered as-is (no reset — no replay came).
   *  P0-2 (app-weight review): the pane STAYS DIRTY — a failed resync must not
   *  bless a stale screen as clean, or reveals/reads silently return
   *  incomplete output forever. The dirty flag makes the next reveal or
   *  hydrate-read retry; `degradedUntil` rate-limits those retries. The screen
   *  is stale-but-live (visible-pane writes bypass the dirty gate), never
   *  stuck, and the ptyId is never cleared. */
  const abortResync = useCallback((why: string) => {
    const st = resyncRef.current;
    if (!st.pending) return;
    st.pending = false;
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    st.degradedUntil = Date.now() + RESYNC_DEGRADED_COOLDOWN_MS;
    console.warn(`[wmux:reveal] ptyId=${ptyIdRef.current} mechanism=resync-degraded reason=${why} (stays dirty, retry after cooldown)`);
    const term = terminalRef.current;
    if (term) {
      try {
        for (const chunk of st.buffer) term.write(chunk);
      } catch { /* disposed mid-abort — teardown owns cleanup */ }
    }
    setPaneSyncUi(ptyIdRef.current ?? '', 'stale');
    st.buffer.length = 0;
    st.bufferedChars = 0;
    st.resolvers.splice(0).forEach((r) => r());
  }, []);

  /** Silent cancel for teardown/ptyId swap: no writes into a dying terminal.
   *  Takes the effect's CAPTURED ptyId — `ptyIdRef.current` may already hold
   *  the NEW pane's id when the previous effect's cleanup runs, which would
   *  clear the new pane's badge and strand the old one (CodeRabbit, PR #470). */
  const cancelResync = useCallback((cancelledPtyId: string | null) => {
    const st = resyncRef.current;
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    st.pending = false;
    st.buffer.length = 0;
    st.bufferedChars = 0;
    st.degradedUntil = 0;
    st.viaRawFallback = false;
    setPaneSyncUi(cancelledPtyId ?? '', null);
    st.resolvers.splice(0).forEach((r) => r());
  }, []);

  /** PR-B: paint a dead session's serialized last screen. There is no flush
   *  marker coming (the payload rode the control RPC, not the session pipe),
   *  so this settles the resync state itself, mirroring the flush-complete
   *  contract: discard stale backlog → reset → write → clean. The dead
   *  process cannot own input-reporting modes, so the stale-replay resets are
   *  always appended (same rationale as staleReplayModeReset.ts, without the
   *  resumeAgent round-trip — dead is dead). */
  const paintDeadSnapshot = useCallback((payloadBase64: string) => {
    const st = resyncRef.current;
    if (!st.pending) return; // timed out or cancelled while the RPC ran
    st.pending = false;
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    st.degradedUntil = 0;
    setPaneSyncUi(ptyIdRef.current ?? '', null);
    const term = terminalRef.current;
    if (term) {
      try {
        const bytes = Uint8Array.from(atob(payloadBase64), (c) => c.charCodeAt(0));
        console.log(`[wmux:reveal] ptyId=${ptyIdRef.current} mechanism=dead-snapshot payload=${bytes.length}`);
        discardTerminalOutput(term);
        term.reset();
        term.write(bytes);
        term.write(STALE_REPLAY_INPUT_MODE_RESETS);
        for (const chunk of st.buffer) term.write(chunk);
        markTerminalClean(term);
      } catch { /* disposed mid-paint — teardown owns cleanup */ }
    }
    st.buffer.length = 0;
    st.bufferedChars = 0;
    st.resolvers.splice(0).forEach((r) => r());
  }, []);

  /** Re-synchronize a dirty pane's full screen state from the daemon while
   *  holding incoming bytes out of xterm; the flush-complete handler then
   *  resets the stale buffer and writes the replay onto the clean one.
   *  Resolves when the resync settles (replayed OR degraded). Never clears
   *  the ptyId — a dead session's last screen must survive reveal (unlike
   *  reconnectPtyWithRetry).
   *
   *  PR-B ladder: live-pipe snapshot reflush (pty.resync — no socket
   *  teardown, no input dead-zone) → legacy reconnect (raw replay over a
   *  fresh socket, PR-A behavior) → degrade to the stale-but-unstuck screen.
   *  Dead sessions short-circuit to a read-only serialized snapshot. */
  const startResync = useCallback((reason: string): Promise<void> => {
    const term = terminalRef.current;
    const id = ptyIdRef.current;
    const st = resyncRef.current;
    if (!term || !id) return Promise.resolve();
    const done = new Promise<void>((resolve) => st.resolvers.push(resolve));
    if (st.pending) return done; // in flight — piggyback on its settlement
    // P0-2 cooldown: a recent degrade means the daemon just failed us — do not
    // storm it with retries from polling reads. The pane stays dirty + marked
    // stale; the first trigger after the cooldown retries for real.
    if (Date.now() < st.degradedUntil) {
      console.log(`[wmux:reveal] ptyId=${id} mechanism=resync-degraded (cooldown, trigger=${reason})`);
      st.resolvers.splice(0).forEach((r) => r());
      return done;
    }
    st.pending = true;
    st.buffer.length = 0;
    st.bufferedChars = 0;
    st.viaRawFallback = false;
    setPaneSyncUi(id, 'syncing');
    console.log(`[useTerminal] hidden-pane resync ptyId=${id} (${reason})`);
    // Timeout with bounded re-arm: the daemon serializes snapshot work behind
    // a global slot, so under concurrent dirty-pane reveals this pane's RPC
    // can legitimately wait several budgets before its replay even starts. A
    // fixed timer would abort mid-queue and the late replay would then arrive
    // on a settled pane (Codex P2). While the RPC is still in flight the
    // daemon is alive and working — re-arm instead of aborting, up to a hard
    // cap; a truly wedged daemon is caught by the RPC's own timeout, which
    // settles the promise and stops the re-arms.
    let rpcSettled = false;
    let timerRearms = 0;
    const armResyncTimer = () => {
      st.timer = setTimeout(() => {
        if (!rpcSettled && timerRearms < 3) {
          timerRearms++;
          armResyncTimer();
          return;
        }
        abortResync('timeout');
      }, RESYNC_TIMEOUT_MS);
    };
    armResyncTimer();
    const fallbackReconnect = () => {
      // The reconnect path never waits on the daemon's snapshot slot — stop
      // the timer re-arms so a hung reconnect aborts on the normal window.
      // No reveal-mechanism log here — a successful reconnect still settles
      // via completeResyncFromFlush, which emits exactly ONE mechanism event
      // (dirty-raw-fallback via the flag) so doctor never double-counts.
      rpcSettled = true;
      st.viaRawFallback = true;
      window.electronAPI.pty.reconnect(id).then((res) => {
        if (!res?.success) abortResync(`reconnect-failed${res?.code ? `:${res.code}` : ''}`);
      }).catch((err: unknown) => {
        abortResync(`reconnect-error:${err instanceof Error ? err.message : String(err)}`);
      });
    };
    // Optional-chain style guard: a stale preload (packaged app updated under
    // a running renderer) may not expose resync yet.
    if (typeof window.electronAPI.pty.resync !== 'function') {
      fallbackReconnect();
      return done;
    }
    window.electronAPI.pty.resync(id, { scrollback: scrollbackLines }).then((res) => {
      rpcSettled = true;
      if (res?.success && res.mode === 'dead-snapshot') {
        paintDeadSnapshot(res.payloadBase64);
        return;
      }
      if (res?.success) {
        // snapshot | raw — the replay is in flight on the live pipe; the
        // flush-complete handler settles the resync (timeout still armed).
        return;
      }
      const code = res && !res.success ? res.code : 'no-response';
      if (code === 'legacy-daemon' || code === 'pipe-not-writable' || code === 'rpc-error' || code === 'local-mode') {
        console.log(`[wmux:hidden-retention] resync fallback to reconnect ptyId=${id} code=${code}`);
        fallbackReconnect();
        return;
      }
      // session-gone / serialize-unavailable: nothing better than the current
      // screen exists — degrade in place (status quo, never stuck).
      abortResync(`resync-failed:${code}`);
    }).catch(() => {
      rpcSettled = true;
      fallbackReconnect();
    });
    return done;
  }, [abortResync, paintDeadSnapshot, scrollbackLines]);

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

    // OSC 52 clipboard-write bridge. Full-screen TUI apps (Claude Code, vim,
    // tmux, neovim) grab the mouse, so a drag no longer leaves an xterm-native
    // selection; when the user copies, the app emits OSC 52 asking the terminal
    // to set the clipboard. xterm disables OSC 52 by default (its read half
    // leaks clipboard contents), so without this the request is silently dropped
    // — the app says "copied" but the system clipboard never changes. We open
    // the WRITE half only (decodeOsc52Write refuses reads/clears/oversize) and
    // route through the existing clipboard IPC (1 MB cap + lock handling).
    const osc52Disposable = terminal.parser.registerOscHandler(52, (payload) => {
      const text = decodeOsc52Write(payload);
      // Consume the sequence either way (return true): a refused read/clear must
      // not fall through to another handler. Only a decoded write is forwarded.
      if (text !== null) {
        void window.clipboardAPI.writeText(text).catch(() => {
          // OSC 52 is fire-and-forget from the app's view (it already drew its
          // own "copied" UI); a size-cap/lock rejection has no app-visible
          // channel, so swallow it rather than surfacing a wmux toast the user
          // didn't trigger.
        });
      }
      return true;
    });
    // Activate Unicode 11 width tables — required for correct CJK / emoji
    // width. Without this, xterm defaults to v6 and TUI apps that use cursor
    // positioning (Claude Code, vim, etc.) collide frames over Korean text.
    terminal.unicode.activeVersion = '11';
    terminal.open(container);

    // xterm 자체 네이티브 'paste' 리스너(terminal.element/textarea에 직접 붙어있음)가
    // 아래 Cmd+V/Ctrl+V/Ctrl+Shift+V 핸들러와 겹칠 때만 캡처 단계에서 차단한다. wmux는
    // Menu.setApplicationMenu()를 호출하지 않아 Electron 기본 메뉴가 깔리는데, macOS는
    // Cmd+V가 NSMenu key equivalent로 처리되어 keydown의 preventDefault()로도 못 막는다
    // — 그 결과 xterm 자체 paste 경로와 아래 커스텀 비동기 IPC 경로가 같은 pty에 동시에
    // 써서 붙여넣기 앞부분이 유실/손상되는 레이스가 생긴다. 이 레이스는 macOS 한정이다:
    // 독립 리서치 2패스(Electron/Chromium 소스·공식 문서·GitHub 이슈 1차 출처)로 확인.
    // Windows/Linux는 액셀러레이터 디스패치가 렌더러 우선이라 preventDefault로 억제되고,
    // Electron 기본 paste role이 registerAccelerator:false(Electron 소스 lib/browser/api/
    // menu-item-roles.ts)라 Ctrl+V 라벨이 OS 단축키로 등록조차 안 된다 → 여기서 레이스할
    // 두 번째 네이티브 writer 자체가 존재하지 않는다(이전 주석의 "이론상 플랫폼 무관하게
    // 방어" 추정은 오답이었다). 오히려 Linux에서 이 가드를 켜두면 X11 middle-click
    // PRIMARY-selection 붙여넣기(Chromium이 진짜 DOM 'paste'를 쏨)를 CLIPBOARD paste와
    // 구분 못 해 300ms 창 안에서 잘못 취소하는 오검출 위험이 생긴다(clipboardChunk.ts도
    // middle-click은 xterm onData로 무방해 통과한다고 가정). 그래서 아래 등록을 isMac으로
    // 게이트한다. 또 macOS에서도 무조건 차단하면 안 된다 — 메뉴바 Edit>Paste를 마우스로
    // 클릭하거나 VoiceOver/UI 자동화가 keydown 없이 합성 paste 이벤트만 보내는 경로는 아래
    // keydown 핸들러가 전혀 안 돌기 때문에 xterm 자체 파이프라인이 유일한 처리 경로다
    // (팀 리뷰 발견: 무조건 차단하면 그 경로가 조용히 무동작해진다). 그래서 keydown 핸들러가
    // 막 시작한 직후(NATIVE_PASTE_RACE_WINDOW_MS 이내)에만 "레이스 중"으로 보고 차단하고,
    // 그 밖의 native paste는 그대로 흘려보내 xterm 자체 처리에 맡긴다. 윈도우 크기는 이
    // 파일의 기존 RIGHT_CLICK_PASTE_SUPPRESS_MS와 동일한 관례(최근 이벤트 판별용 300ms)를 따른다.
    const isMac = window.electronAPI?.platform === 'darwin';
    let lastPasteKeydownAt = 0;
    const NATIVE_PASTE_RACE_WINDOW_MS = 300;
    const blockNativePaste = (e: Event): void => {
      if (Date.now() - lastPasteKeydownAt > NATIVE_PASTE_RACE_WINDOW_MS) return;
      e.preventDefault();
      e.stopPropagation();
    };
    // macOS 한정 게이트: 레이스(NSMenu key equivalent)는 여기서만 발생한다. Windows/Linux엔
    // 레이스할 두 번째 네이티브 writer가 없고(Electron paste role registerAccelerator:false),
    // Linux는 middle-click PRIMARY-selection paste 오검출 위험까지 있어 등록에서 제외한다.
    if (isMac) { container.addEventListener('paste', blockNativePaste, true); }

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

    // Diagnostic-only dead-input watchdog for the intermittent "typing dead
    // until remount (multiview toggle)" field bug. It attempts NO recovery — it
    // logs the discriminating evidence the next time input dies in the wild so
    // the machine/IME-dependent cause can be confirmed from a user log instead
    // of a local repro that has never triggered. keyCodes all 229 => IME claim
    // storm; activeElement tells orphaned-focus (body/other) apart from an
    // IME-layer death (focus still on the xterm textarea). console.warn is
    // mirrored into the main-side log by src/main/index.ts's console-message
    // listener, so it lands in the file the user can share.
    const deadInputWatchdog = createDeadInputWatchdog({
      report: ({ keydownCount, keyCodes, codes, spanMs }) => {
        const active = document.activeElement;
        const activeDesc = active
          ? `${active.tagName.toLowerCase()}.${(active.className || '').toString().slice(0, 40)}`
          : 'null';
        // ptyIdRef.current, not the captured ptyId, so a reconnect that swaps
        // the pty still attributes the log to the live session.
        console.warn(
          `[wmux:dead-input] pty=${ptyIdRef.current} ${keydownCount} keys in ${spanMs}ms reached no onData ` +
          `keyCodes=[${keyCodes.join(',')}] codes=[${codes.join(',')}] activeElement=${activeDesc}`,
        );
      },
    });
    const onWatchdogKeyDown = (e: Event): void => {
      const ke = e as KeyboardEvent;
      deadInputWatchdog.onKeyDown({ keyCode: ke.keyCode, isComposing: ke.isComposing, code: ke.code });
    };
    terminal.textarea?.addEventListener('keydown', onWatchdogKeyDown);

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
          // Diagnostic (#318): lets a future reporter log distinguish "flush
          // fired but didn't repair" from "flush never fired". console.debug
          // maps to the Verbose level (hidden by default, dropped when DevTools
          // is closed). Remove once #318 is confirmed fixed in the reporter's
          // environment.
          console.debug('[wmux:glyph-repaint]', reason);
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
        deadInputWatchdog.onData(); // direct write bypasses terminal.onData
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
        deadInputWatchdog.onData(); // direct write bypasses terminal.onData
        return false;
      }

      // Pass app shortcuts through to useKeyboard (don't let xterm consume them).
      // 'd' is the Ctrl+D split-right shortcut — without it xterm sends EOT (0x04)
      // to the PTY and PowerShell echoes it back as `^D` instead of triggering split.
      //
      // macOS: useKeyboard가 cmdOrCtrl=metaKey로 매칭하므로 Cmd 계열 액션(,/d/k/i/
      // n/t/`)의 Ctrl 조합은 앱 액션이 아니다 — 삼키면 Ctrl+D(EOF)·Ctrl+I(Tab)·
      // Ctrl+K(kill-line) 등 readline 컨트롤 문자가 PTY에도 못 가고 죽는다
      // (owner-reported 2026-07-19). mac에서는 literal-Ctrl 바인딩만(b=프리픽스,
      // m=북마크, Ctrl+Arrow) 버블시키고 나머지는 xterm→PTY로 통과.
      const bubbleKeys = isMac
        ? ['b', 'm', 'ArrowUp', 'ArrowDown']
        : [',', 'b', 'd', 'k', 'i', 'n', 't', 'm', 'ArrowUp', 'ArrowDown', '`'];
      const bubbleCodes = isMac
        ? ['KeyB', 'KeyM', 'ArrowUp', 'ArrowDown']
        : ['KeyB', 'KeyD', 'KeyK', 'KeyI', 'KeyN', 'KeyT', 'KeyM', 'Comma', 'ArrowUp', 'ArrowDown'];
      if (e.ctrlKey && !e.shiftKey && bubbleKeys.includes(e.key)) {
        return false; // let DOM bubble to useKeyboard
      }
      // Cross-layout / IME-safe fallback: when a Hangul or other non-Latin layout
      // is active, e.key is the composed letter (e.g. 'ㅇ') or 'Process', and the
      // allowlist above misses. Match by physical key code so the split shortcut
      // still works under any layout/IME state.
      if (e.ctrlKey && !e.shiftKey && bubbleCodes.includes(e.code)) {
        return false;
      }
      // Ctrl+` by code (cross-layout) — mac은 Cmd+`가 액션이므로 Ctrl+`(NUL)는 PTY로.
      if (!isMac && e.ctrlKey && !e.shiftKey && e.code === 'Backquote') {
        return false;
      }
      // Terminal font zoom: Ctrl+= / Ctrl+- / Ctrl+0 (#171). Let these bubble to
      // useKeyboard instead of feeding '=' / '-' / '0' bytes to the PTY. Match by
      // physical code as well so zoom survives a Hangul / non-Latin IME. The
      // Ctrl++ (Shift+=) and numpad variants are already covered: the Ctrl+Shift
      // catch-all below bubbles the former, and useKeyboard maps NumpadAdd etc.
      // mac 줌은 Cmd+=/-/0 — Ctrl 조합은 앱 액션이 아니므로 xterm/PTY로 통과.
      if (!isMac && e.ctrlKey && !e.shiftKey && (
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
        lastPasteKeydownAt = Date.now(); // blockNativePaste 위: 곧 같이 뜰 native paste를 레이스로 잡는다
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
      // macOS는 복사가 Cmd+C 전담(위 분기)이므로 Ctrl+C는 항상 SIGINT — 선택영역이
      // 남아 있어도 인터럽트를 가로채지 않는다(owner-reported 2026-07-19).
      if (!isMac && e.ctrlKey && !e.shiftKey && (e.key === 'c' || e.code === 'KeyC')) {
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
      // mac은 Cmd+V가 붙여넣기 전담(위 분기) — Ctrl+V는 readline quoted-insert
      // (verbatim)이므로 PTY로 통과시킨다.
      if (!isMac && e.ctrlKey && !e.shiftKey && (e.key === 'v' || e.code === 'KeyV')) {
        e.preventDefault();
        // isMac 게이트: blockNativePaste 리스너가 비-macOS에선 등록조차 안 되므로(위 참고)
        // 스탬프도 macOS에서만 찍는다 — 안 그러면 나중에 등록 게이트를 넓힐 때 값이 이미
        // 차 있어 X11 middle-click 오검출 위험이 조용히 되살아난다(review-team GLM 발견).
        if (isMac) lastPasteKeydownAt = Date.now();
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
        if (isMac) lastPasteKeydownAt = Date.now(); // isMac 게이트 이유는 Ctrl+V 분기 주석 참고
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
        // Real user input reached the app — clear the dead-input watchdog.
        deadInputWatchdog.onData();
        // Open the interactive window so this terminal's imminent echo / redraw
        // takes the zero-latency direct-write path in the output scheduler.
        // (Focus reports above are excluded — they are not user input.)
        noteTerminalInput(terminal);
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
    // Stale-replay mode reset (see ../terminal/staleReplayModeReset.ts): a
    // recovered session's ring replay re-executes the dead agent's DECSET
    // arming (mouse/focus/paste reporting) into xterm, so the fresh shell's
    // pane emits mouse reports that both dismiss the resume pill (onData
    // "user typed" heuristic) and land in the shell as junk input. After a
    // replaying flush, ask the daemon whether this pane is a recovered agent
    // shell (`resumeAgent` — set ONLY for sessions recovered this boot whose
    // agent has NOT been re-detected) and if so disable the leaked modes,
    // terminal-side only. The pty.list round-trip doubles as ordering: by the
    // time it resolves, the replay bytes are already queued into xterm, so
    // the resets always land after the sequences they cancel. Gating on the
    // daemon (not the renderer's resumeHint slice) avoids the boot race where
    // the flush completes before AppLayout has hydrated the hint.
    const resetStaleReplayModes = (recoveredBytes: number) => {
      if (recoveredBytes <= 0) return;
      void window.electronAPI.pty.list().then((sessions) => {
        if (terminalRef.current !== terminal) return;
        if (sessions.find((s) => s.id === ptyId)?.resumeAgent) {
          terminal.write(STALE_REPLAY_INPUT_MODE_RESETS);
        }
      }).catch(() => { /* best-effort — a transient list failure just skips the reset */ });
    };
    // Phase 3: settle an in-flight resync when its replay flush completes.
    // reset() runs FIRST — synchronous, and the replay bytes were held in the
    // resync buffer (never handed to xterm), so nothing can parse ahead of it
    // — then the held replay lands on the clean buffer. Returns true when the
    // flush belonged to a resync (callers skip their normal verdict logic).
    const completeResyncFromFlush = (recoveredBytes: number): boolean => {
      const st = resyncRef.current;
      if (!st.pending) return false;
      st.pending = false;
      if (st.timer) { clearTimeout(st.timer); st.timer = null; }
      st.degradedUntil = 0;
      setPaneSyncUi(ptyId, null);
      // One settlement event per resync, labelled by the path that actually
      // delivered it: 'dirty-raw-fallback' when pty.resync fell back to the
      // raw pty.reconnect replay, 'dirty-snapshot' otherwise.
      const mechanism = st.viaRawFallback ? 'dirty-raw-fallback' : 'dirty-snapshot';
      st.viaRawFallback = false;
      console.log(`[wmux:reveal] ptyId=${ptyId} mechanism=${mechanism} recoveredBytes=${recoveredBytes} buffered=${st.bufferedChars} chunks=${st.buffer.length}`);
      discardTerminalOutput(terminal); // stale retained backlog + dirty flag
      terminal.reset();
      for (const chunk of st.buffer) terminal.write(chunk);
      st.buffer.length = 0;
      st.bufferedChars = 0;
      resetStaleReplayModes(recoveredBytes);
      st.resolvers.splice(0).forEach((r) => r());
      return true;
    };
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
    // Phase 3: route one pty:data event. While a resync replay is in flight
    // the bytes are held out of xterm entirely (the flush-complete handler
    // resets the stale buffer FIRST, then writes them onto the clean one — a
    // direct write here could parse ahead of that reset and be wiped).
    const routePtyData = (data: string) => {
      const st = resyncRef.current;
      if (st.pending) {
        st.buffer.push(data);
        st.bufferedChars += data.length;
        if (st.bufferedChars > RESYNC_BUFFER_MAX_CHARS) abortResync('buffer-overflow');
        return;
      }
      // Output scheduler (multi-workspace stutter fix): visible panes write
      // directly (old path, zero added latency); hidden panes are batched —
      // or, with retention on (daemon sessions), queued without ever being
      // parsed. glyphRepaint counts bytes at actual hand-off (its contract is
      // "terminal.write was CALLED"), not at IPC receipt.
      const retain = hiddenRetentionActive();
      if (!isVisibleRef.current) logRetentionGateOnce(retain);
      writeTerminalOutput(terminal, data, {
        foreground: isVisibleRef.current,
        retainWhenHidden: retain,
        onWritten: (chars) => glyphRepaint.onData(chars),
      });
    };

    const connectPty = () => {
      // Sidebar idle badge: stamp "this surface produced output" at most once
      // per 30 s. Plain-shell output never trips the daemon ActivityMonitor's
      // 2000-bytes/3s 'running' gate, so without this a shell-only workspace
      // would read as idle-forever. Throttled with a closure timestamp so the
      // zustand write (and its subscriber re-renders) stays off the hot path.
      let lastOutputStampAt = 0;
      removeDataListener = ptyDataDispatcher.register(ptyId, (data) => {
        routePtyData(data);
        fireFirstData();
        markPaneLive();
        const now = Date.now();
        if (now - lastOutputStampAt >= 30_000) {
          lastOutputStampAt = now;
          useStore.getState().stampSurfaceOutput(ptyId);
        }
      });

      removeExitListener = ptyExitDispatcher.register(ptyId, (exitCode) => {
        // Through the scheduler so the exit marker cannot overtake output
        // still queued for this (possibly hidden) pane.
        writeTerminalOutput(terminal, `\r\n${t('terminal.exitedBracket', { code: exitCode })}\r\n`, {
          foreground: isVisibleRef.current,
          retainWhenHidden: hiddenRetentionActive(),
        });
      });
    };

    if (scrollbackFile) {
      // Register PTY listeners immediately to avoid data loss during scrollback load.
      // scrollback.load() is async (IPC round-trip). If PTY sends data before it
      // resolves, connectPty() would not yet be called and data would be lost.
      // Instead, buffer incoming data and flush after scrollback is written.
      const pendingData: string[] = [];
      let scrollbackLoaded = false;

      removeDataListener = ptyDataDispatcher.register(ptyId, (data) => {
        if (!scrollbackLoaded) {
          pendingData.push(data);
          return;
        }
        // Same routing as connectPty (resync hold-out + scheduler).
        routePtyData(data);
        fireFirstData();
        markPaneLive();
      });

      removeExitListener = ptyExitDispatcher.register(ptyId, (exitCode) => {
        writeTerminalOutput(terminal, `\r\n${t('terminal.exitedBracket', { code: exitCode })}\r\n`, {
          foreground: isVisibleRef.current,
          retainWhenHidden: hiddenRetentionActive(),
        });
      });

      // Listen for the daemon's flush-complete signal. Two-way race:
      //  - Flush arrives first: cache `recoveredBytes`; the
      //    `daemon.onConnected` callback below reads it when it fires.
      //  - Flush arrives second: the callback set `pendingFlushReset=true`;
      //    we apply the verdict now.
      removeFlushListener = ptyFlushDispatcher.register(ptyId, (recoveredBytes) => {
        if (terminalRef.current !== terminal) return;
        if (completeResyncFromFlush(recoveredBytes)) return;
        // Phase 3 deferral: hidden + retention means the replay just rode
        // pty.onData into the retained queue — flushing it here is exactly
        // the boot flood retention exists to remove. recoveredBytes>0 →
        // discard + dirty (the reveal resync replays a clean copy over a
        // reset buffer, which also subsumes the .txt verdict below);
        // recoveredBytes=0 → nothing replayed, nothing to do until reveal.
        if (!isVisibleRef.current && hiddenRetentionActive()) {
          lastFlushRecoveredBytes = recoveredBytes;
          pendingFlushReset = false;
          if (recoveredBytes > 0) markTerminalDirty(terminal);
          return;
        }
        // Restore the pre-scheduler precondition: replay bytes that arrived
        // via pty.onData may still sit in the output scheduler (hidden pane).
        // reset()/resetStaleReplayModes assume they were already handed to
        // xterm — hand them over now, in order, exactly as the old direct
        // write path did.
        flushTerminalOutput(terminal);
        lastFlushRecoveredBytes = recoveredBytes;
        if (pendingFlushReset) {
          pendingFlushReset = false;
          if (recoveredBytes > 0) terminal.reset();
        }
        resetStaleReplayModes(recoveredBytes);
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
              // Same parity flush as onFlushComplete: hand any scheduler-queued
              // bytes to xterm before reset() so the byte order xterm sees is
              // identical to the old direct-write path.
              flushTerminalOutput(terminal);
              if (lastFlushRecoveredBytes > 0) terminal.reset();
            } else {
              pendingFlushReset = true;
            }
          });
        }
        scrollbackLoaded = true;
        // P0-1 (app-weight review, Codex Eng #1): route the buffered boot
        // bytes through routePtyData — NOT terminal.write — so a hidden
        // boot-restored pane obeys retention (queue, don't parse) and a
        // resync in flight keeps its hold-out ordering. Visible panes write
        // through the scheduler's foreground path, same order as before.
        for (const data of pendingData) {
          routePtyData(data);
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
        // Same retention-aware routing as the success path above (P0-1).
        for (const data of pendingData) {
          routePtyData(data);
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
      // The daemon flush replays the ring buffer even when there is no .txt to
      // restore (scrollback-restore toggle off), so the stale-mode reset must
      // listen here too — the leaked DECSET arming rides the replay, not the
      // .txt cache.
      removeFlushListener = ptyFlushDispatcher.register(ptyId, (recoveredBytes) => {
        if (terminalRef.current !== terminal) return;
        if (completeResyncFromFlush(recoveredBytes)) return;
        // Phase 3 deferral — see the scrollback-branch handler above.
        if (!isVisibleRef.current && hiddenRetentionActive()) {
          if (recoveredBytes > 0) markTerminalDirty(terminal);
          return;
        }
        // Parity flush — see the scrollback-branch onFlushComplete above.
        flushTerminalOutput(terminal);
        resetStaleReplayModes(recoveredBytes);
      });
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

    // Phase 3 hydrate-before-read: MCP buffer reads (pane.search /
    // input.readScreen) must not scan a stale hidden pane. Dirty → full
    // daemon resync; otherwise hand over any retained backlog. The trailing
    // empty write is a parse barrier — its callback runs only after xterm
    // has parsed everything handed above, so the caller reads a settled
    // buffer.
    const hydrateForRead = async (): Promise<void> => {
      if (terminalRef.current !== terminal) return;
      if (isTerminalDirty(terminal)) {
        await startResync('hydrate-read');
      } else {
        flushTerminalOutput(terminal);
      }
      await new Promise<void>((resolve) => {
        try { terminal.write('', resolve); } catch { resolve(); }
      });
    };
    if (ptyId) hydrateRegistry.set(ptyId, hydrateForRead);

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
      if (isMac) { container.removeEventListener('paste', blockNativePaste, true); }
      terminal.textarea?.removeEventListener('focus', onTextareaFocus);
      terminal.textarea?.removeEventListener('keydown', onWatchdogKeyDown);
      glyphRepaint.dispose();
      glyphRepaintRef.current = null;
      imeResidueGuard?.dispose();
      imeStormGuard.dispose();
      deadInputWatchdog.dispose();
      autoCopy.dispose();
      selectionDisposable.dispose();
      pathLinkDisposable.dispose();
      osc52Disposable.dispose();
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
      // Phase 3: silence any in-flight resync (its buffered bytes die with
      // the terminal) and drop this mount's hydrate entry — a remount on the
      // same ptyId registers its own. Pass the effect's captured ptyId, not
      // the ref (which may already point at the swapped-in pane).
      cancelResync(ptyId);
      if (ptyId && hydrateRegistry.get(ptyId) === hydrateForRead) {
        hydrateRegistry.delete(ptyId);
      }
      // Drop any output still queued in the shared scheduler — the terminal
      // is being disposed, parsing the backlog would be wasted work and a
      // post-dispose drain write would throw.
      discardTerminalOutput(terminal);
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
      // Reveal catch-up: hand over any output batched while this pane was
      // hidden BEFORE the repaint/fit below — the reveal repaint must paint
      // the pane's current state, not a stale frame with bytes still queued.
      // Phase 3: a DIRTY pane (retained backlog overflowed / replay deferred)
      // has nothing valid to flush — re-synchronize the full screen from the
      // daemon instead. The stale frame stays up until the resync's reset +
      // replay lands (sub-second), which beats parsing a discarded backlog.
      if (terminalRef.current) {
        if (isTerminalDirty(terminalRef.current)) {
          void startResync('dirty-reveal');
        } else {
          // P0-5 mechanism codes: `live` reveals (nothing queued) stay silent
          // to keep the main log usable; anything that had retained backlog
          // logs the catch-up size.
          const queued = getQueuedCharCount(terminalRef.current);
          // Reveal-backlog-cap: a large RETAINED backlog handed to xterm in one
          // shot is the workspace-switch raster burst. Above the cap, discard it
          // and re-synchronize a bounded snapshot from the daemon — identical
          // mechanism and safety to the retention overflow→dirty path, just at a
          // lower (perf, not memory) threshold.
          //
          // Two-part gate (review-team 2026-07-21):
          //  - isTerminalRetained (per-pane): a retained entry is only ever
          //    produced by the retainWhenHidden write path, so its bytes came
          //    from the daemon and are in the RingBuffer. A non-retained backlog
          //    (background drain / a local pane) is NEVER capped — discarding it
          //    could lose the pane's only copy (GLM+Codex round-1 P1).
          //  - isDaemonModeActive (current reachability): `retained` is
          //    historical — the daemon could have disconnected AFTER the bytes
          //    were retained. Without this the reveal would discard the only
          //    copy while resync fails with local-mode/session-gone (Codex
          //    round-2 P1). Requiring the daemon to be live NOW means resync can
          //    actually replace what we discard; on resync failure the pane
          //    stays dirty and retries, and the daemon still holds the bytes.
          // Caveat: a renderer-only exit marker (terminal.exitedBracket) in the
          // backlog is dropped — the same tradeoff as the overflow path, now
          // more frequent at the 256KB cap; the daemon resync replays the PTY's
          // real final screen, which conveys the exit, just not the localized
          // bracket.
          if (
            queued > REVEAL_FLUSH_MAX_CHARS &&
            isTerminalRetained(terminalRef.current) &&
            isDaemonModeActive()
          ) {
            console.log(`[wmux:reveal] ptyId=${ptyIdRef.current} mechanism=reveal-backlog-cap queuedChars=${queued}`);
            markTerminalDirty(terminalRef.current);
            void startResync('reveal-backlog-cap');
          } else if (queued > REVEAL_FLUSH_MAX_CHARS) {
            // Large but NON-retained (or daemon down): we can't discard it (the
            // queue is the only copy), but flushing it inline would burst. Hand
            // it to the budgeted priority drain so it catches up over frames
            // instead of one giant parse — data-loss-safe, order preserved.
            console.log(`[wmux:reveal] ptyId=${ptyIdRef.current} mechanism=reveal-budgeted-catchup queuedChars=${queued}`);
            promoteTerminalToPriorityDrain(terminalRef.current);
          } else {
            if (queued > 0) {
              console.log(`[wmux:reveal] ptyId=${ptyIdRef.current} mechanism=retained-catchup queuedChars=${queued}`);
            }
            flushTerminalOutput(terminalRef.current);
          }
        }
      }
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
  }, [isVisible, fit, startResync]);

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
