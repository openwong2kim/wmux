import { lazy, Suspense, useRef, useEffect, useState, useCallback, useMemo, useSyncExternalStore } from 'react';
import { useTerminal, copySelectionWithFeedback, getPaneSyncUi, subscribePaneSyncUi, type ContextMenuEvent, type PaneSyncUiState } from '../../hooks/useTerminal';
import { handoffTargetForPty, isOurHandoffDrag, takeHandoffDrop } from '../Git/handoffDrag';
import { useStore } from '../../stores';
import { t } from '../../i18n';
import { useIpc } from '../../hooks/useIpc';
import { pastePtyChunked } from '../../utils/clipboardChunk';
import { pasteClipboardImage } from '../../utils/imagePaste';
import { openTerminalUrl } from '../../utils/browserPaneActions';
import { terminalFontFamilyCss } from '../../utils/terminalFont';
import { isFileDrag } from '../../../shared/dragDrop';
import type { FixedGeometry } from '../../terminal/fixedGeometryFit';
import { findLeafBySurfaceId } from '../../../shared/paneUtils';
import { ptyLifecycle, TERMINAL_INSTANCE_KEY_PREFIX } from '../../hooks/ptyLifecycle';
import { surfaceCreate, surfaceHoldsPty } from '../../hooks/surfacePtyCreate';
import { isSurfaceShown, resumesOnStart } from '../../stores/selectors/surfaceShown';
import type { DeadPaneRecovery } from '../../../shared/ptyRecovery';
import ViCopyMode from './ViCopyMode';
import SearchBar from './SearchBar';
import BookmarkIndicator from './BookmarkIndicator';
import ContextMenu from './ContextMenu';
import ScrollToBottomButton from './ScrollToBottomButton';
import { paneTagDropText } from '../../utils/paneTagDrag';
import { getPaneLinkNotice, notePaneUserInput, subscribeDaemonLinkNotice } from '../../daemon/daemonLinkNotice';
import DaemonLinkNotice from './DaemonLinkNotice';
import { PaneDictationChip } from '../Dictation/PaneDictationChip';
import { dictationAvailable } from '../Dictation/DictationButton';
import '@xterm/xterm/css/xterm.css';

const ChatView = lazy(() => import('../Chat/ChatView'));

const EMPTY_BOOKMARKS: number[] = [];

interface TerminalProps {
  chatView?: boolean;
  ptyId?: string;
  shell?: string;
  cwd?: string;
  onPtyCreated?: (ptyId: string) => void;
  /** True when this surface tab is the selected tab inside its pane (drives
   *  keyboard focus, vi-copy mode, search bar). */
  isActive?: boolean;
  /** True when this surface should be RENDERED (display:flex) regardless of
   *  focus. The terminal+browser split shows both sides at once, so visibility
   *  is decoupled from `isActive`. Defaults to `isActive` (stacked/tab case:
   *  only the active tab renders). */
  visible?: boolean;
  /** True when the parent workspace is the currently visible workspace.
   *  False when the workspace is hidden via display:none in AppLayout.
   *  Defaults to true so callers that don't use the all-workspaces rendering
   *  pattern continue to work without changes. */
  isWorkspaceVisible?: boolean;
  /** If set, scrollback content will be restored from this file on mount */
  scrollbackFile?: string;
  /** ID of the workspace this terminal belongs to. Used at PTY-create time
   *  so the spawned shell gets the correct WMUX_WORKSPACE_ID env (Codex
   *  review 2026-05-24 P1: previously read global activeWorkspaceId which
   *  is wrong during boot reconcile + multiview). */
  workspaceId?: string;
  /** ID of the surface this terminal occupies. Sent as WMUX_SURFACE_ID. */
  surfaceId?: string;
  /** The surface's staged dead-session recovery (`surface.pendingRecovery`):
   *  present when this blank surface replaces a session the daemon confirmed
   *  dead, so the create asks for that session's cwd/target instead. */
  pendingRecovery?: DeadPaneRecovery;
  /** Grid owned elsewhere — see useTerminal's `fixedGeometry`. Only the
   *  browser build (wmux web) sets it; the desktop never does. */
  fixedGeometry?: FixedGeometry | null;
}

export default function TerminalComponent({ chatView = false, ptyId: externalPtyId, shell, cwd, onPtyCreated, isActive = true, visible, isWorkspaceVisible = true, scrollbackFile, workspaceId: ownerWorkspaceId, surfaceId: ownerSurfaceId, pendingRecovery: deadPaneRecovery, fixedGeometry }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ptyId, setPtyId] = useState<string | null>(externalPtyId || null);
  // #2398 — the key this surface's own create runs under (hooks/ptyLifecycle).
  // A Terminal with no surface (never self-creating in practice) gets a key of
  // its own instance.
  const instanceKeyRef = useRef<string | null>(null);
  if (instanceKeyRef.current === null) instanceKeyRef.current = `${TERMINAL_INSTANCE_KEY_PREFIX}${Math.random().toString(36).slice(2)}`;
  const lifecycleKey = ownerSurfaceId ?? instanceKeyRef.current;
  const createAttempt = useStore((s) => s.ptyCreateByKey?.[lifecycleKey]);
  // A refused create shows its alert (below), gated on the surface binding:
  // a pane whose binding was cleared still holds its old id locally until a
  // replacement binds.
  const createRefused = !externalPtyId && createAttempt?.state === 'createFailed';
  // #2398 — a blank surface starts its shell only once it is shown (see
  // stores/selectors/surfaceShown.ts); until then it stays deferred and says
  // so. A Terminal outside a workspace surface (the floating pane, the deck's
  // embed) has nothing to wait for.
  const surfaceShown = useStore((s) => !ownerSurfaceId || !ownerWorkspaceId || isSurfaceShown(s, ownerWorkspaceId, ownerSurfaceId));
  // Bound to a suspended session left suspended while hidden: not started either.
  const sessionDeferred = useStore((s) => (externalPtyId ? Boolean(s.ptyDeferredById?.[externalPtyId]) : false));
  const notStarted = !surfaceShown && (externalPtyId ? sessionDeferred : !createAttempt);
  // The create effect's input: constant while bound, so a bound pane's
  // visibility changes never re-run it.
  const startAllowed = !!externalPtyId || surfaceShown;
  // Starts (or, with retry, restarts) this surface's create; null while bound.
  const selfCreateRef = useRef<((retry: boolean) => void) | null>(null);
  const [restoring, setRestoring] = useState(!!scrollbackFile);

  const viCopyModeActive = useStore((s) => s.viCopyModeActive);
  const setViCopyModeActive = useStore((s) => s.setViCopyModeActive);
  const searchBarVisible = useStore((s) => s.searchBarVisible);
  const setSearchBarVisible = useStore((s) => s.setSearchBarVisible);
  const bookmarks = useStore((s) => (ptyId ? s.terminalBookmarks[ptyId] : undefined)) ?? EMPTY_BOOKMARKS;
  const { invoke: ipcInvoke } = useIpc();
  // Keep the invoker stable across re-renders without re-triggering the PTY
  // creation effect below.
  const ipcInvokeRef = useRef(ipcInvoke);
  ipcInvokeRef.current = ipcInvoke;

  const [ctxMenu, setCtxMenu] = useState<ContextMenuEvent | null>(null);

  // X8 — this surface's supervision status (armed → "Stop supervision" item;
  // stopped → "Rearm supervision" item). Undefined for unsupervised panes,
  // which omit both items entirely.
  const supervisionStatus = useStore((s) =>
    ptyId ? s.supervisionByPtyId[ptyId]?.status : undefined,
  );

  // P0-5 freshness chip: 'syncing' while a daemon resync is in flight,
  // 'stale' after a degraded resync (screen may lag until the retry).
  // Silent stale display failed the app-weight review's DX gate — the pane
  // must identify itself whenever its content is not current.
  const [syncState, setSyncState] = useState<PaneSyncUiState>(null);
  // #2398 — a binding kept although it could not be checked (failed startup
  // reconcile, exhausted reattach): the pane says so until it attaches.
  const unconfirmed = useStore((s) => (ptyId ? Boolean(s.ptyUnconfirmedById?.[ptyId]) : false));
  useEffect(() => {
    if (!ptyId) { setSyncState(null); return; }
    setSyncState(getPaneSyncUi(ptyId));
    return subscribePaneSyncUi(ptyId, setSyncState);
  }, [ptyId]);

  // Daemon link notice: this pane lost its daemon connection (reconnecting /
  // reconnected / gave up), and whether input typed meanwhile may be lost.
  const linkNotice = useSyncExternalStore(subscribeDaemonLinkNotice, () => getPaneLinkNotice(ownerSurfaceId));

  // Hide restoring overlay when first data arrives
  const handleFirstData = useCallback(() => setRestoring(false), []);

  // Fallback: hide restoring overlay after 3 seconds even if no data arrives
  useEffect(() => {
    if (!restoring) return;
    const timer = setTimeout(() => setRestoring(false), 3000);
    return () => clearTimeout(timer);
  }, [restoring]);

  useEffect(() => {
    console.log(`[Terminal] useEffect: externalPtyId=${externalPtyId}, scrollbackFile=${scrollbackFile}`);
    if (externalPtyId) {
      console.log(`[Terminal] Using existing ptyId: ${externalPtyId}`);
      setPtyId(externalPtyId);
      selfCreateRef.current = null;
      // Another path bound this surface while its own create was in flight:
      // that create is replaced and must never bind (a no-op otherwise). A
      // refusal from before is over too (cancel forgets it): once bound, a
      // later clear creates.
      ptyLifecycle.cancel(lifecycleKey, ownerSurfaceId);
      return;
    }

    const start = (retry: boolean) => {
      // Estimate initial terminal size from container so the shell banner
      // is formatted for the actual viewport, preventing cursor misalignment.
      const container = containerRef.current;
      let cols: number | undefined;
      let rows: number | undefined;
      if (container && container.offsetWidth > 0 && container.offsetHeight > 0) {
        const fontSize = useStore.getState().terminalFontSize || 13;
        const fontFamily = useStore.getState().terminalFontFamily || 'Cascadia Code';
        const padding = 8;

        // Measure actual character dimensions using a canvas probe instead of
        // hardcoded ratios, so CJK fonts and varying DPI are handled correctly.
        let charWidth: number;
        let lineHeight: number;
        try {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d')!;
          ctx.font = `${fontSize}px ${terminalFontFamilyCss(fontFamily)}`;
          charWidth = ctx.measureText('W').width;
          lineHeight = fontSize * 1.2;
        } catch {
          charWidth = fontSize * 0.6;
          lineHeight = fontSize * 1.2;
        }

        cols = Math.max(2, Math.floor((container.offsetWidth - padding) / charWidth));
        rows = Math.max(2, Math.floor((container.offsetHeight - padding) / lineHeight));
      }

      // Owner identity, not global active. Codex P1 fix 2026-05-24: the
      // previous `useStore.getState().activeWorkspaceId` read produced wrong
      // env on workspace boot reconcile (all PTYs got the workspace that
      // happened to be active at restore time) and during multiview rendering
      // (every tile saw the focused tile's workspace). The owner prop is
      // threaded down from Pane → Terminal so the correct identity reaches
      // the daemon at PTY-create time.
      const workspaceId = ownerWorkspaceId ?? useStore.getState().activeWorkspaceId;
      const surfaceId = ownerSurfaceId;
      const { create, heal } = surfaceCreate({ workspaceId, surfaceId, shell, cwd, pendingRecovery: deadPaneRecovery, cols, rows },
        (call) => ipcInvokeRef.current(call));
      // #2398 — one create per surface, shared by every mount of it: a remount
      // or a re-run of this effect joins the attempt in flight instead of
      // cancelling it and starting another, and a refused create (toast
      // surfaced by useIpc) stays refused until the pane's Retry.
      void ptyLifecycle.ensure(lifecycleKey, {
        retry,
        create,
        bind: (created) => {
          // Closed, or bound to another pty since the create began: not ours to keep.
          if (surfaceId && !surfaceHoldsPty(surfaceId, '')) return false;
          onPtyCreated?.(created.id);
          // onPtyCreated binds by pane; a surface that moved out from under it
          // was not bound, and an unbound pty would be leaked.
          if (surfaceId && onPtyCreated && !surfaceHoldsPty(surfaceId, created.id)) return false;
          setPtyId(created.id);
          heal(created);
          return true;
        },
      });
    };
    selfCreateRef.current = start;
    // #2398 — a hidden surface waits until it is first shown: on a cold start
    // with many restored workspaces, a shell per blank pane nobody opened is
    // what ran the machine out of memory. Owner decision §6-2: a hidden pane
    // replacing a dead Claude Code or Codex session still starts now when
    // resume-on-start is on (read here, not subscribed, as the auto-resume does).
    if (startAllowed || resumesOnStart(deadPaneRecovery, useStore.getState().claudeResumeOnStart)) {
      start(false);
    } else {
      console.log(`[Terminal] surface ${ownerSurfaceId} hidden — deferring its shell until it is first shown`);
    }

    return () => {
      // #1305 / #2398 — only closing the surface ends its create (ptyLifecycle
      // asks main to drop it before it spawns, and disposes one that already
      // did). A remount, a re-render, a dependency change or the surface going
      // out of view keeps it running for the next mount to join.
      if (!ownerSurfaceId || !surfaceHoldsPty(ownerSurfaceId, undefined)) {
        ptyLifecycle.cancel(lifecycleKey, ownerSurfaceId);
      }
    };
  }, [externalPtyId, shell, cwd, deadPaneRecovery, startAllowed]); // onPtyCreated 제거 (stale closure 방지)

  // isVisible = workspace is shown AND this surface tab is the active one.
  // useTerminal uses this to skip fit() when the container is display:none.
  const handleContextMenu = useCallback((e: ContextMenuEvent) => {
    setCtxMenu(e);
  }, []);

  // `visible` decouples render (display) from focus (`isActive`): the
  // terminal+browser split shows both sides at once, so a visible-but-unfocused
  // terminal must still render AND fit (else xterm stays blank). Falls back to
  // `isActive` for the stacked/tab case (one tab visible at a time).
  const shown = visible ?? isActive;
  const isVisible = isWorkspaceVisible && shown;
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  // #1305 — the failure Retry cannot clear: the pane's WSL directory is gone,
  // so every attempt reopens the same missing directory. Tracked separately
  // from the message because it is what decides whether a second action exists,
  // and the message is agent/distro text that must never be parsed for it.
  const [recoveryCwdMissing, setRecoveryCwdMissing] = useState(false);
  const [retryingRecovery, setRetryingRecovery] = useState(false);
  useEffect(() => { setRecoveryError(null); setRecoveryCwdMissing(false); }, [ptyId]);
  const handleRecoveryError = useCallback((message: string | null, info?: { cwdMissing?: boolean }) => {
    setRecoveryError(message);
    setRecoveryCwdMissing(message !== null && info?.cwdMissing === true);
  }, []);
  const retryRecovery = async () => {
    if (!ptyId || retryingRecovery) return;
    setRetryingRecovery(true);
    try {
      // Reuse the hook's full attach path, including geometry and unmuting.
      await retryConnection();
    } catch (error) { setRecoveryError(String(error)); }
    finally { setRetryingRecovery(false); }
  };
  /**
   * #1305 — the explicit way out: promote the SAME pane (same id, same
   * scrollback) in the home directory, without resuming the conversation that
   * belonged to the directory that is gone. Never automatic — landing in home
   * silently would resume an unrelated project's conversation.
   */
  const startFreshRecovery = async () => {
    if (!ptyId || retryingRecovery) return;
    setRetryingRecovery(true);
    try {
      const promoted = await window.electronAPI.pty.promote(ptyId, { fresh: true });
      if (!promoted.success) {
        setRecoveryError(promoted.error || 'Could not start a fresh session in the home directory.');
        return;
      }
      // The pane exists again under its own id; attach to it the way Retry
      // does, which is also what clears this banner on success.
      await retryConnection();
    } catch (error) { setRecoveryError(String(error)); }
    finally { setRetryingRecovery(false); }
  };
  const { terminal: terminalRef, terminalInstance, findNext, findPrevious, clearSearch, retryConnection } = useTerminal(containerRef, { onRecoveryError: handleRecoveryError, ptyId, isVisible, scrollbackFile, onFirstData: scrollbackFile ? handleFirstData : undefined, onContextMenu: handleContextMenu,
    // Only the pane-surface terminal owns ⌘G / Ctrl+G: useComposeShortcut
    // acts on the active leaf's pty, which is what this component renders.
    // FloatingPane and Deck's BrainTerminalEmbed deliberately do NOT opt in —
    // there the key stays a pane byte rather than dying between the two
    // gates (#1280 review).
    ownsComposeShortcut: true,
    fixedGeometry,
    // #2398 — a hidden pane's reattach leaves a suspended session suspended;
    // the first show promotes it.
    surfaceShown });

  // terminalInstance (state, #1256) — not terminalRef.current (a render-time
  // snapshot): the ref is populated after this render ran, so a snapshot read
  // here sees null until an unrelated re-render happens.
  const showViCopyMode = !chatView && viCopyModeActive && isActive && terminalInstance !== null;
  // #1266 — `isActive` means "selected tab INSIDE this pane", not "this pane
  // has focus". `searchBarVisible` is a single global flag, so gating on
  // `isActive` alone put a search bar in every pane at once and meant the bar
  // never unmounted when the user moved to another pane: the abandoned pane
  // kept its cached term and went on re-creating highlight decorations on
  // every later chunk of output, at coordinates that no longer matched
  // anything. Gate on real pane focus so exactly one bar is up and leaving a
  // pane genuinely ends its search.
  const isPaneFocused = useStore((s) => {
    if (!ownerSurfaceId) return true;
    const ws = s.workspaces.find((w) => w.id === (ownerWorkspaceId ?? s.activeWorkspaceId));
    if (!ws) return true;
    const leaf = findLeafBySurfaceId(ws.rootPane, ownerSurfaceId);
    // Surfaces we cannot place (stashed panes, transitional trees) keep the
    // previous behaviour rather than losing their search bar.
    return leaf ? leaf.id === ws.activePaneId : true;
  });
  const showSearchBar = !chatView && searchBarVisible && isActive && isPaneFocused;

  const handleCloseSearch = () => {
    clearSearch();
    setSearchBarVisible(false);
  };

  // #1266 — the bar can go away without handleCloseSearch ever running:
  // toggling it off globally, switching to another surface in this pane, or
  // (with the focus gate above) moving to another pane. In every one of
  // those the addon would otherwise keep its cached term and its
  // onWriteParsed hook, re-creating highlight decorations on every later
  // chunk of output with no UI left to dismiss them. Tear them down whenever
  // the bar goes away, for any reason.
  useEffect(() => {
    if (showSearchBar) return;
    clearSearch();
  }, [showSearchBar, clearSearch]);

  const handleCopy = useCallback(() => {
    if (ctxMenu?.selectedText) {
      // main may throw on failure (size / lock / invalid type); the helper
      // surfaces an error toast and keeps the selection so the user can
      // retry rather than silently losing the copy attempt.
      void copySelectionWithFeedback(terminalRef.current, ctxMenu.selectedText, { ptyId: ptyId ?? undefined });
    }
  }, [ctxMenu, terminalRef, ptyId]);

  const handlePaste = useCallback(() => {
    if (!ptyId) return;
    void (async () => {
      const terminal = terminalRef.current;
      const modes = (terminal as unknown as { modes?: { bracketedPasteMode?: boolean } })?.modes;

      // Text first, image fallback — matches the Ctrl+V handler's preference.
      // Browsers populate the clipboard with BOTH text/plain and a
      // selection-screenshot image when the user copies a paragraph. Image-
      // first would silently throw away the text in that case and paste a
      // PNG path instead — almost never what the user wanted. Image-only
      // clipboards (Snipping Tool, PrtSc, image editors) go to
      // pasteClipboardImage, which routes them to the agent's own image-paste
      // key or to the temp-PNG path (#1196).
      const text = await window.clipboardAPI.readText();
      notePaneUserInput(ptyId);
      if (text) {
        // Async chunked write: paces the IPC queue so the conpty input
        // pipe drains between chunks, normalizes line endings to \r so
        // PowerShell does not execute mid-paste, and keeps surrogate
        // pairs whole across chunk boundaries.
        await pastePtyChunked((d) => window.electronAPI.pty.write(ptyId, d), text, modes ?? null);
        return;
      }

      await pasteClipboardImage({
        ptyId,
        write: (d) => window.electronAPI.pty.write(ptyId, d),
        bracketedPasteMode: !!modes?.bracketedPasteMode,
        screenIsAlternate: terminal?.buffer.active.type === 'alternate',
      });
    })();
  }, [ptyId, terminalRef]);

  // Accept text/plain drops only from wmux-owned drag sources (workspace/pane
  // markdown from sidebar + tabs, file paths from the file tree) and route
  // them through the same chunked paste path the clipboard handler uses.
  // DataTransfer text from external apps or embedded web pages is untrusted:
  // a benign visible drag label can hide shell commands in text/plain, and
  // pastePtyChunked normalizes newlines to Enter for non-bracketed prompts.
  // The in-memory store flag below is set during wmux dragstart and is never
  // exposed through DataTransfer, so Terminal remains an internal-only text
  // drop target while native file drags stay owned by AppLayout.onFileDrop.
  const handleTerminalDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!ptyId) return;
    if (isFileDrag(e.dataTransfer)) return;
    // An issue / PR from the Git page: this pane's agent takes it, after a
    // confirm step. Its text is never pasted from the drag.
    if (isOurHandoffDrag(e.dataTransfer)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      return;
    }
    if (!useStore.getState().terminalTextDropDragActive) return;
    if (!e.dataTransfer.types.includes('text/plain')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, [ptyId]);

  const handleTerminalDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!ptyId) return;
    if (isFileDrag(e.dataTransfer)) return;
    if (isOurHandoffDrag(e.dataTransfer)) {
      e.preventDefault();
      const taken = takeHandoffDrop(e.dataTransfer);
      const st = useStore.getState();
      const target = taken ? handoffTargetForPty(st, ptyId) : null;
      if (taken && target) {
        st.setGitHandoff({ item: taken.item, target, repo: taken.repo, anchor: { x: e.clientX, y: e.clientY } });
      }
      return;
    }
    if (!useStore.getState().terminalTextDropDragActive) return;
    const text = e.dataTransfer.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    const terminal = terminalRef.current;
    const modes = (terminal as unknown as { modes?: { bracketedPasteMode?: boolean } })?.modes;
    notePaneUserInput(ptyId);
    // A pane header dropped here types its tag (`#w1-2 `), not its markdown.
    void pastePtyChunked(
      (d) => window.electronAPI.pty.write(ptyId, d),
      paneTagDropText(text) ?? text,
      modes ?? null,
    ).catch((err) => console.error('[wmux:terminal-drop] paste failed:', err));
  }, [ptyId, terminalRef]);

  const handleOpenLink = useCallback((url: string) => {
    // Smart routing: localhost → browser pane, external → system browser.
    // The owning workspace is passed explicitly — in multiview this terminal
    // may live in a non-active tile where activeWorkspaceId would lie.
    openTerminalUrl(url, { workspaceId: ownerWorkspaceId, ptyId: ptyId ?? undefined });
  }, [ownerWorkspaceId, ptyId]);

  const handleCopyLink = useCallback((url: string) => {
    void window.clipboardAPI.writeText(url);
  }, []);

  // X8 — pane-menu supervision controls. Both resolve { ok } (false in local
  // mode or for an unknown id). On failure, surface the standard error toast;
  // the live status flip arrives via pty.onSupervisionChanged (AppLayout
  // subscription), so there's nothing to optimistically set here.
  const handleSupervisionStop = useCallback(() => {
    if (!ptyId) return;
    void window.electronAPI.supervise.stop(ptyId).then((r) => {
      if (!r.ok) useStore.getState().pushToast({ message: t('supervision.actionFailed'), level: 'error' });
    }).catch(() => {
      useStore.getState().pushToast({ message: t('supervision.actionFailed'), level: 'error' });
    });
  }, [ptyId]);

  const handleSupervisionRearm = useCallback(() => {
    if (!ptyId) return;
    void window.electronAPI.supervise.rearm(ptyId).then((r) => {
      if (!r.ok) useStore.getState().pushToast({ message: t('supervision.actionFailed'), level: 'error' });
    }).catch(() => {
      useStore.getState().pushToast({ message: t('supervision.actionFailed'), level: 'error' });
    });
  }, [ptyId]);

  return (
    <div
      style={{
        display: shown ? 'flex' : 'none',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        position: 'relative',
      }}
    >
      {chatView && shown && isWorkspaceVisible && (
        <div className="absolute inset-0 z-10 bg-[var(--bg-base)]" data-chat-surface>
          <Suspense fallback={<div className="wmux-chat-empty">{t('chat.loading')}</div>}>
            {ptyId ? <ChatView ptyId={ptyId} active={isWorkspaceVisible && shown}
              onTerminal={() => { if (ownerSurfaceId) useStore.getState().setSurfaceViewMode(ownerSurfaceId, 'terminal'); }} />
              : <div className="wmux-chat-empty" role="status">{t('chat.loading')}</div>}
          </Suspense>
        </div>
      )}
      {recoveryError && (
        <div role="alert" className="absolute inset-x-2 top-2 z-20 rounded border border-[var(--border)] bg-[var(--bg-base)] p-3 text-sm text-[var(--text-primary)]">
          <p className="break-words">{recoveryError}</p>
          <p className="mt-1 text-[var(--text-muted)]">Your session and saved scrollback are retained.</p>
          {/* Two neutral actions, never an accent one: the banner is already an
              alert, and a filled warm button here would spend the surface's one
              primary on the riskier of the two (DESIGN.md — amber diet, one
              filled button per surface). Order carries the hierarchy instead:
              Retry is the default, starting fresh is the deliberate second. */}
          <div className="mt-2 flex gap-2">
            <button type="button" disabled={retryingRecovery} onClick={() => void retryRecovery()}
              className="rounded border border-[var(--border)] px-3 py-1 disabled:opacity-50">
              {retryingRecovery ? 'Reconnecting…' : 'Retry connection'}
            </button>
            {recoveryCwdMissing && (
              <button type="button" disabled={retryingRecovery} onClick={() => void startFreshRecovery()}
                title="Reopen this pane in your home directory, without resuming the recorded conversation"
                className="rounded border border-[var(--border)] px-3 py-1 text-[var(--text-muted)] disabled:opacity-50">
                Start fresh in home
              </button>
            )}
          </div>
        </div>
      )}
      {/* #2398 — a refused create: the reason and the one way to try again.
          Same alert shape as the recovery banner above; a refused create
          never fires again by itself. */}
      {createRefused && createAttempt?.state === 'createFailed' && (
        <div role="alert" className="absolute inset-x-2 top-2 z-20 rounded border border-[var(--border)] bg-[var(--bg-base)] p-3 text-sm text-[var(--text-primary)]">
          <p className="break-words">{t('terminal.createFailed')}</p>
          <p className="mt-1 break-words text-[var(--text-muted)]">{createAttempt.error}</p>
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => selfCreateRef.current?.(true)}
              className="rounded border border-[var(--border)] px-3 py-1">
              {t('terminal.retryCreate')}
            </button>
          </div>
        </div>
      )}
      {/* Daemon link notice; the recovery alert and the refused-create alert
          above win when both apply (they carry the actions, and share its
          place). */}
      {!recoveryError && !createRefused && linkNotice && ownerSurfaceId && <DaemonLinkNotice notice={linkNotice} surfaceId={ownerSurfaceId} />}
      {/* #2398 — a hidden blank surface whose shell has not started: one muted
          line, the same shape as the restore overlay (no wash — DESIGN.md). */}
      {notStarted && !restoring && (
        <div role="status" className="absolute inset-0 flex items-center justify-center text-[var(--text-muted)] text-sm font-mono z-10 pointer-events-none">
          {t('terminal.notStarted')}
        </div>
      )}
      {/* Session restore overlay */}
      {restoring && (
        <div className="absolute inset-0 flex items-center justify-center text-[var(--text-muted)] text-sm font-mono z-10 pointer-events-none">
          Restoring session...
        </div>
      )}

      {/* P0-5 freshness chip — non-blocking corner badge while the pane is
          catching up from the daemon, or after a degraded resync left it
          potentially stale. Muted per the color grammar (status, not action).
          #2398: the same chip says "reattaching…" while the binding is
          unconfirmed; once the reattach gives up, the banner above (with
          Retry) says it instead. */}
      {(syncState || (unconfirmed && !recoveryError)) && (
        <div className="absolute top-1 right-2 z-10 pointer-events-none px-1.5 py-0.5 rounded text-[10px] font-mono bg-[var(--bg-secondary)] text-[var(--text-muted)] border border-[var(--border)] opacity-90">
          {syncState === 'syncing' ? t('terminal.catchingUp') : syncState ? t('terminal.staleScreen') : t('terminal.reattaching')}
        </div>
      )}

      {/* xterm mount point. draggable={false} is explicit: xterm's selection
          handler must own pointer events here, otherwise a long-press on
          selected text could be interpreted as a native drag start and
          clash with the SurfaceTabs drag-export feature.
          content-box with calc(): FitAddon sizes the grid from this element's
          computed width/height and subtracts only the .xterm element's own
          padding. Under border-box those values include this 4px padding, so
          the fit got 8px of height it did not have and the last row was cut
          off whenever the cell height fit into that extra 8px. */}
      <div
        ref={containerRef}
        inert={chatView}
        aria-hidden={chatView || undefined}
        draggable={false}
        onDragOver={handleTerminalDragOver}
        onDrop={handleTerminalDrop}
        style={{ boxSizing: 'content-box', width: 'calc(100% - 8px)', height: 'calc(100% - 8px)', padding: '4px', visibility: chatView ? 'hidden' : undefined }}
      />

      {/* Scrollback bookmark markers on the left edge. #1256: bound to the
          state-published instance — a render-time terminalRef.current snapshot
          goes null/stale when the mount effect swaps the terminal without a
          re-render (fresh creation, adoption). */}
      <BookmarkIndicator
        terminal={terminalInstance}
        bookmarks={bookmarks}
        containerRef={containerRef}
      />

      {/* Floating scroll-to-bottom button — appears only when scrolled up.
          #1256: same live-instance binding as BookmarkIndicator above; the
          button's subscriptions and click handler must track the real
          terminal or scrolling/clicking silently no-ops. */}
      <ScrollToBottomButton terminal={terminalInstance} />

      {/* Dictating into this pane: a corner chip over the terminal (no layout row). */}
      {ptyId && dictationAvailable() && <PaneDictationChip ptyId={ptyId} />}

      {/* Search bar overlay */}
      {showSearchBar && (
        <SearchBar
          onFindNext={findNext}
          onFindPrevious={findPrevious}
          onClose={handleCloseSearch}
        />
      )}

      {/* Context menu */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          hasSelection={ctxMenu.hasSelection}
          selectedText={ctxMenu.selectedText}
          linkUrl={ctxMenu.linkUrl}
          onCopy={handleCopy}
          onPaste={handlePaste}
          onOpenLink={handleOpenLink}
          onCopyLink={handleCopyLink}
          supervisionStatus={supervisionStatus}
          onSupervisionStop={handleSupervisionStop}
          onSupervisionRearm={handleSupervisionRearm}
          onClose={() => setCtxMenu(null)}
        />
      )}

      {/* Vi Copy Mode overlay — rendered inside the relative wrapper */}
      {showViCopyMode && terminalRef.current && (
        <ViCopyMode
          terminal={terminalRef.current}
          onExit={() => setViCopyModeActive(false)}
        />
      )}
    </div>
  );
}
