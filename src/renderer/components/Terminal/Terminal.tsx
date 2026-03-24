import { useRef, useEffect, useState } from 'react';
import { useTerminal } from '../../hooks/useTerminal';
import { useStore } from '../../stores';
import ViCopyMode from './ViCopyMode';
import SearchBar from './SearchBar';
import '@xterm/xterm/css/xterm.css';

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
}

export default function TerminalComponent({ ptyId: externalPtyId, shell, cwd, onPtyCreated, isActive = true, isWorkspaceVisible = true, scrollbackFile }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ptyId, setPtyId] = useState<string | null>(externalPtyId || null);
  const creatingRef = useRef(false);

  const viCopyModeActive = useStore((s) => s.viCopyModeActive);
  const setViCopyModeActive = useStore((s) => s.setViCopyModeActive);
  const searchBarVisible = useStore((s) => s.searchBarVisible);
  const setSearchBarVisible = useStore((s) => s.setSearchBarVisible);

  useEffect(() => {
    if (externalPtyId) {
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
      const charWidth = fontSize * 0.6;
      const lineHeight = fontSize * 1.2;
      const padding = 8;
      cols = Math.max(2, Math.floor((container.offsetWidth - padding) / charWidth));
      rows = Math.max(2, Math.floor((container.offsetHeight - padding) / lineHeight));
    }

    window.electronAPI.pty.create({ shell, cwd, cols, rows }).then((result: { id: string }) => {
      if (cancelled) {
        // 이미 unmount됨 — PTY 정리
        window.electronAPI.pty.dispose(result.id);
        return;
      }
      setPtyId(result.id);
      onPtyCreated?.(result.id);
    }).catch((err: unknown) => {
      console.error('Failed to create PTY:', err);
    });

    return () => { cancelled = true; };
  }, [externalPtyId, shell, cwd]); // onPtyCreated 제거 (stale closure 방지)

  // isVisible = workspace is shown AND this surface tab is the active one.
  // useTerminal uses this to skip fit() when the container is display:none.
  const isVisible = isWorkspaceVisible && isActive;
  const { terminal: terminalRef, findNext, findPrevious, clearSearch } = useTerminal(containerRef, { ptyId, isVisible, scrollbackFile });

  const showViCopyMode = viCopyModeActive && isActive && terminalRef.current !== null;
  const showSearchBar = searchBarVisible && isActive;

  const handleCloseSearch = () => {
    clearSearch();
    setSearchBarVisible(false);
  };

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
      {/* xterm mount point */}
      <div
        ref={containerRef}
        style={{ width: '100%', height: '100%', padding: '4px' }}
      />

      {/* Search bar overlay */}
      {showSearchBar && (
        <SearchBar
          onFindNext={findNext}
          onFindPrevious={findPrevious}
          onClose={handleCloseSearch}
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
