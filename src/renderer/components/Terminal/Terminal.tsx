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
  isActive?: boolean;
}

export default function TerminalComponent({ ptyId: externalPtyId, shell, cwd, onPtyCreated, isActive = true }: TerminalProps) {
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
    });

    return () => { cancelled = true; };
  }, [externalPtyId, shell, cwd]); // onPtyCreated 제거 (stale closure 방지)

  const { terminal: terminalRef, findNext, findPrevious, clearSearch } = useTerminal(containerRef, { ptyId });

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
