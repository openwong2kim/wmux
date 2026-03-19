import { useEffect, useCallback } from 'react';
import type { Terminal } from '@xterm/xterm';
import { useViCopyMode } from '../../hooks/useViCopyMode';

interface ViCopyModeProps {
  terminal: Terminal;
  onExit: () => void;
}

export default function ViCopyMode({ terminal, onExit }: ViCopyModeProps) {
  const {
    cursorRow,
    cursorCol,
    isVisual,
    handleKey,
    exit,
    copySelection,
  } = useViCopyMode({ terminal, isActive: true }, onExit);

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Let the overlay consume all keystrokes so they don't reach the PTY
      e.preventDefault();
      e.stopPropagation();

      const { key, ctrlKey } = e;

      // y with visual selection triggers copy
      if (!ctrlKey && key === 'y') {
        copySelection();
        return;
      }

      handleKey(key, ctrlKey);
    },
    [handleKey, copySelection],
  );

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown, true); // capture phase
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onKeyDown]);

  // Calculate cursor pixel position relative to the xterm viewport.
  // xterm renders each cell at roughly (fontSize * charWidth) dimensions.
  // We use CSS variables / approximate values here.
  const cellWidth = 8.4;  // approximate character width in px at 14px font size
  const cellHeight = 17;  // approximate line height in px at 14px font size

  // The row offset relative to the current viewport
  const viewportY = terminal.buffer.active.viewportY;
  const relativeRow = cursorRow - viewportY;

  const cursorStyle: React.CSSProperties = {
    position: 'absolute',
    left: `calc(${cursorCol} * ${cellWidth}px + 4px)`, // 4px matches container padding
    top: `calc(${relativeRow} * ${cellHeight}px + 4px)`,
    width: `${cellWidth}px`,
    height: `${cellHeight}px`,
    backgroundColor: 'rgba(249, 226, 175, 0.7)', // catppuccin yellow, semi-transparent
    mixBlendMode: 'screen',
    pointerEvents: 'none',
    zIndex: 10,
  };

  return (
    <>
      {/* Invisible full-size overlay that blocks mouse interaction with terminal */}
      <div
        className="absolute inset-0"
        style={{ zIndex: 9, cursor: 'text' }}
        onClick={() => exit()}
      />

      {/* Cursor highlight block */}
      <div style={cursorStyle} aria-hidden="true" />

      {/* Status bar */}
      <div
        className="absolute bottom-0 left-0 right-0 flex items-center justify-between px-3 py-0.5 text-xs font-mono select-none"
        style={{
          zIndex: 20,
          backgroundColor: 'rgba(30, 30, 46, 0.92)',
          borderTop: '1px solid rgba(137, 180, 250, 0.4)',
          color: '#89b4fa', // catppuccin blue
          backdropFilter: 'blur(4px)',
        }}
      >
        <span className="font-semibold tracking-widest">
          {isVisual ? '-- VISUAL --' : '-- COPY MODE --'}
        </span>
        <span className="text-[#6c7086]">
          {cursorRow}:{cursorCol}
          &nbsp;&nbsp;
          <span className="text-[#a6adc8]">
            h/j/k/l &nbsp; w/b &nbsp; v &nbsp; y &nbsp; ESC
          </span>
        </span>
      </div>
    </>
  );
}
