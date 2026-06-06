import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { useTerminal, copySelectionWithFeedback, type ContextMenuEvent } from '../../hooks/useTerminal';
import { useStore } from '../../stores';
import { useIpc } from '../../hooks/useIpc';
import { withDefaultShell, withWorkspaceProfile } from '../../utils/ptyCreateOptions';
import { pastePtyChunked } from '../../utils/clipboardChunk';
import { isFileDrag } from '../../../shared/dragDrop';
import ViCopyMode from './ViCopyMode';
import SearchBar from './SearchBar';
import BookmarkIndicator from './BookmarkIndicator';
import ContextMenu from './ContextMenu';
import '@xterm/xterm/css/xterm.css';

const EMPTY_BOOKMARKS: number[] = [];

interface TerminalProps {
  ptyId?: string;
  shell?: string;
  cwd?: string;
  onPtyCreated?: (ptyId: string) => void;
  /** True when this surface tab is the selected tab inside its pane. */
  isActive?: boolean;
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
}

export default function TerminalComponent({ ptyId: externalPtyId, shell, cwd, onPtyCreated, isActive = true, isWorkspaceVisible = true, scrollbackFile, workspaceId: ownerWorkspaceId, surfaceId: ownerSurfaceId }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ptyId, setPtyId] = useState<string | null>(externalPtyId || null);
  const creatingRef = useRef(false);
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
      return;
    }

    if (creatingRef.current) return;
    creatingRef.current = true;

    let cancelled = false;

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
        ctx.font = `${fontSize}px '${fontFamily}', Consolas, 'Courier New', 'Malgun Gothic', monospace`;
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
    const defaultShell = useStore.getState().defaultShell;
    // Owning workspace's profile (env + startup command) for this new pane.
    const profile = useStore.getState().workspaces.find((w) => w.id === workspaceId)?.profile;
    console.log(`[Terminal] Creating new PTY: shell=${shell}, cwd=${cwd}, cols=${cols}, rows=${rows}, ws=${workspaceId}, surface=${surfaceId ?? '-'}`);
    void ipcInvokeRef.current<{ id: string }>(() =>
      window.electronAPI.pty.create(withWorkspaceProfile(withDefaultShell({ shell, cwd, cols, rows, workspaceId, surfaceId }, defaultShell), profile))
    ).then((result) => {
      if (!result.ok) {
        // Toast surfaced by useIpc (e.g. DAEMON_DISCONNECTED). Nothing to do.
        return;
      }
      if (cancelled) {
        // 이미 unmount됨 — PTY 정리
        window.electronAPI.pty.dispose(result.data.id);
        return;
      }
      setPtyId(result.data.id);
      onPtyCreated?.(result.data.id);
    });

    return () => { cancelled = true; };
  }, [externalPtyId, shell, cwd]); // onPtyCreated 제거 (stale closure 방지)

  // isVisible = workspace is shown AND this surface tab is the active one.
  // useTerminal uses this to skip fit() when the container is display:none.
  const handleContextMenu = useCallback((e: ContextMenuEvent) => {
    setCtxMenu(e);
  }, []);

  const isVisible = isWorkspaceVisible && isActive;
  const { terminal: terminalRef, findNext, findPrevious, clearSearch } = useTerminal(containerRef, { ptyId, isVisible, scrollbackFile, onFirstData: scrollbackFile ? handleFirstData : undefined, onContextMenu: handleContextMenu });

  const showViCopyMode = viCopyModeActive && isActive && terminalRef.current !== null;
  const showSearchBar = searchBarVisible && isActive;

  const handleCloseSearch = () => {
    clearSearch();
    setSearchBarVisible(false);
  };

  const handleCopy = useCallback(() => {
    if (ctxMenu?.selectedText) {
      // main may throw on failure (size / lock / invalid type); the helper
      // surfaces an error toast and keeps the selection so the user can
      // retry rather than silently losing the copy attempt.
      void copySelectionWithFeedback(terminalRef.current, ctxMenu.selectedText);
    }
  }, [ctxMenu, terminalRef]);

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
      // clipboards (Snipping Tool, PrtSc, image editors) still work via
      // the fallback below. readImage() saves the bitmap to a PNG temp file
      // and returns its path — quoted on spaces and wrapped in bracketed-
      // paste sequences so apps like Claude Code see it as a single paste.
      const text = await window.clipboardAPI.readText();
      if (text) {
        // Async chunked write: paces the IPC queue so the conpty input
        // pipe drains between chunks, normalizes line endings to \r so
        // PowerShell does not execute mid-paste, and keeps surrogate
        // pairs whole across chunk boundaries.
        await pastePtyChunked((d) => window.electronAPI.pty.write(ptyId, d), text, modes ?? null);
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
    if (!useStore.getState().terminalTextDropDragActive) return;
    if (!e.dataTransfer.types.includes('text/plain')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, [ptyId]);

  const handleTerminalDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (!ptyId) return;
    if (isFileDrag(e.dataTransfer)) return;
    if (!useStore.getState().terminalTextDropDragActive) return;
    const text = e.dataTransfer.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    const terminal = terminalRef.current;
    const modes = (terminal as unknown as { modes?: { bracketedPasteMode?: boolean } })?.modes;
    void pastePtyChunked(
      (d) => window.electronAPI.pty.write(ptyId, d),
      text,
      modes ?? null,
    ).catch((err) => console.error('[wmux:terminal-drop] paste failed:', err));
  }, [ptyId, terminalRef]);

  const handleOpenLink = useCallback((url: string) => {
    window.electronAPI.shell.openExternal(url);
  }, []);

  const handleCopyLink = useCallback((url: string) => {
    void window.clipboardAPI.writeText(url);
  }, []);

  return (
    <div
      style={{
        display: isActive ? 'flex' : 'none',
        flexDirection: 'column',
        width: '100%',
        height: '100%',
        position: 'relative',
      }}
    >
      {/* Session restore overlay */}
      {restoring && (
        <div className="absolute inset-0 flex items-center justify-center text-[var(--text-muted)] text-sm font-mono z-10 pointer-events-none">
          Restoring session...
        </div>
      )}

      {/* xterm mount point. draggable={false} is explicit: xterm's selection
          handler must own pointer events here, otherwise a long-press on
          selected text could be interpreted as a native drag start and
          clash with the SurfaceTabs drag-export feature. */}
      <div
        ref={containerRef}
        draggable={false}
        onDragOver={handleTerminalDragOver}
        onDrop={handleTerminalDrop}
        style={{ width: '100%', height: '100%', padding: '4px' }}
      />

      {/* Scrollback bookmark markers on the left edge */}
      <BookmarkIndicator
        terminal={terminalRef.current}
        bookmarks={bookmarks}
        containerRef={containerRef}
      />

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
