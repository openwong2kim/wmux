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
}

export default function TerminalComponent({ ptyId: externalPtyId, shell, cwd, onPtyCreated, isActive = true, isWorkspaceVisible = true }: TerminalProps) {
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
    window.electronAPI.pty.create({ shell, cwd }).then((result: { id: string }) => {
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
  const { terminal: terminalRef, findNext, findPrevious, clearSearch } = useTerminal(containerRef, { ptyId, isVisible });

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
