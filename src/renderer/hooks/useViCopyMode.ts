import { useState, useCallback, useRef, useEffect } from 'react';
import type { Terminal } from '@xterm/xterm';

export interface CursorPosition {
  row: number;
  col: number;
}

export interface UseViCopyModeOptions {
  terminal: Terminal | null;
  isActive: boolean;
}

export interface UseViCopyModeReturn {
  cursorRow: number;
  cursorCol: number;
  selectionStart: CursorPosition | null;
  selectionEnd: CursorPosition | null;
  isVisual: boolean;
  handleKey: (key: string, ctrlKey?: boolean) => void;
  exit: () => void;
  copySelection: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// Buffer helpers
// ---------------------------------------------------------------------------

function getLineText(terminal: Terminal, row: number): string {
  const line = terminal.buffer.active.getLine(row);
  if (!line) return '';
  return line.translateToString(true);
}

function totalRows(terminal: Terminal): number {
  return terminal.buffer.active.length;
}

function clampRow(row: number, terminal: Terminal): number {
  return Math.max(0, Math.min(totalRows(terminal) - 1, row));
}

function clampCol(col: number, text: string): number {
  const max = Math.max(0, text.length - 1);
  return Math.max(0, Math.min(max, col));
}

function nextWordStart(text: string, col: number): number {
  let i = col + 1;
  while (i < text.length && text[i] !== ' ') i++;
  while (i < text.length && text[i] === ' ') i++;
  return Math.max(0, Math.min(i, text.length - 1));
}

function prevWordStart(text: string, col: number): number {
  let i = col - 1;
  while (i > 0 && text[i] === ' ') i--;
  while (i > 0 && text[i - 1] !== ' ') i--;
  return Math.max(0, i);
}

function linearOffset(terminal: Terminal, row: number, col: number): number {
  let off = 0;
  for (let r = 0; r < row; r++) off += getLineText(terminal, r).length + 1;
  return off + col;
}

function normalizeRange(
  terminal: Terminal,
  a: CursorPosition,
  b: CursorPosition,
): [CursorPosition, CursorPosition] {
  if (linearOffset(terminal, a.row, a.col) <= linearOffset(terminal, b.row, b.col)) {
    return [a, b];
  }
  return [b, a];
}

function buildSelectionText(
  terminal: Terminal,
  start: CursorPosition,
  end: CursorPosition,
): string {
  const [s, e] = normalizeRange(terminal, start, end);
  const lines: string[] = [];
  for (let r = s.row; r <= e.row; r++) {
    const text = getLineText(terminal, r);
    if (r === s.row && r === e.row) {
      lines.push(text.slice(s.col, e.col + 1));
    } else if (r === s.row) {
      lines.push(text.slice(s.col));
    } else if (r === e.row) {
      lines.push(text.slice(0, e.col + 1));
    } else {
      lines.push(text);
    }
  }
  return lines.join('\n');
}

function applyXtermSelection(
  terminal: Terminal,
  start: CursorPosition,
  end: CursorPosition,
): void {
  const [s, e] = normalizeRange(terminal, start, end);
  if (s.row === e.row) {
    terminal.select(s.col, s.row, e.col - s.col + 1);
    return;
  }
  const startText = getLineText(terminal, s.row);
  let length = startText.length - s.col + 1; // +1 for implicit newline
  for (let r = s.row + 1; r < e.row; r++) {
    length += getLineText(terminal, r).length + 1;
  }
  length += e.col + 1;
  terminal.select(s.col, s.row, length);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useViCopyMode(
  options: UseViCopyModeOptions,
  onExit: () => void,
): UseViCopyModeReturn {
  const { terminal, isActive } = options;

  const [cursor, setCursor] = useState<CursorPosition>({ row: 0, col: 0 });
  const [isVisual, setIsVisual] = useState(false);
  const [visualStart, setVisualStart] = useState<CursorPosition | null>(null);

  // Pending 'g' for 'gg' sequence
  const ggPending = useRef(false);

  // Stable refs so callbacks don't stale-close over state
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;
  const isVisualRef = useRef(isVisual);
  isVisualRef.current = isVisual;
  const visualStartRef = useRef(visualStart);
  visualStartRef.current = visualStart;

  // Initialize cursor when copy mode becomes active
  useEffect(() => {
    if (!isActive || !terminal) return;
    const buf = terminal.buffer.active;
    const row = clampRow(buf.viewportY + buf.cursorY, terminal);
    const col = Math.max(0, buf.cursorX);
    setCursor({ row, col });
    setIsVisual(false);
    setVisualStart(null);
    ggPending.current = false;
    terminal.clearSelection();
  }, [isActive, terminal]);

  const exit = useCallback(() => {
    if (terminal) terminal.clearSelection();
    setIsVisual(false);
    setVisualStart(null);
    ggPending.current = false;
    onExit();
  }, [terminal, onExit]);

  const copySelection = useCallback(async () => {
    if (!terminal) return;
    const text = terminal.getSelection() || getLineText(terminal, cursorRef.current.row);
    if (text) await navigator.clipboard.writeText(text);
    exit();
  }, [terminal, exit]);

  const handleKey = useCallback(
    (key: string, ctrlKey = false) => {
      if (!terminal || !isActive) return;

      const viewportRows = terminal.rows;

      // ESC / q always exit
      if (!ctrlKey && (key === 'Escape' || key === 'q')) {
        exit();
        return;
      }

      // y: yank then exit
      if (!ctrlKey && key === 'y') {
        const cur = cursorRef.current;
        const vs = visualStartRef.current;
        const iv = isVisualRef.current;
        let text: string;
        if (iv && vs) {
          text = buildSelectionText(terminal, vs, cur);
        } else {
          text = getLineText(terminal, cur.row);
        }
        navigator.clipboard.writeText(text).then(() => exit());
        return;
      }

      // v: toggle visual mode
      if (!ctrlKey && key === 'v') {
        if (isVisualRef.current) {
          terminal.clearSelection();
          setIsVisual(false);
          setVisualStart(null);
        } else {
          setIsVisual(true);
          setVisualStart({ ...cursorRef.current });
        }
        ggPending.current = false;
        return;
      }

      setCursor((prev) => {
        let { row, col } = prev;

        if (ctrlKey) {
          if (key === 'u') row = clampRow(row - Math.floor(viewportRows / 2), terminal);
          else if (key === 'd') row = clampRow(row + Math.floor(viewportRows / 2), terminal);
          else return prev;

          const lt = getLineText(terminal, row);
          col = clampCol(col, lt);
          terminal.scrollToLine(row);
          const next = { row, col };
          if (isVisualRef.current && visualStartRef.current) {
            applyXtermSelection(terminal, visualStartRef.current, next);
          }
          ggPending.current = false;
          return next;
        }

        const lineText = getLineText(terminal, row);

        switch (key) {
          case 'h': {
            col = Math.max(0, col - 1);
            break;
          }
          case 'l': {
            col = Math.min(Math.max(0, lineText.length - 1), col + 1);
            break;
          }
          case 'j': {
            row = clampRow(row + 1, terminal);
            col = clampCol(col, getLineText(terminal, row));
            terminal.scrollToLine(row);
            break;
          }
          case 'k': {
            row = clampRow(row - 1, terminal);
            col = clampCol(col, getLineText(terminal, row));
            terminal.scrollToLine(row);
            break;
          }
          case 'w': {
            col = nextWordStart(lineText, col);
            break;
          }
          case 'b': {
            col = prevWordStart(lineText, col);
            break;
          }
          case '0': {
            col = 0;
            break;
          }
          case '$': {
            col = Math.max(0, lineText.length - 1);
            break;
          }
          case 'g': {
            if (ggPending.current) {
              // gg: go to buffer start
              row = 0;
              col = 0;
              terminal.scrollToLine(0);
              ggPending.current = false;
            } else {
              ggPending.current = true;
              return prev; // wait for second g
            }
            break;
          }
          case 'G': {
            row = clampRow(totalRows(terminal) - 1, terminal);
            col = Math.max(0, getLineText(terminal, row).length - 1);
            terminal.scrollToLine(row);
            ggPending.current = false;
            break;
          }
          default: {
            if (key !== 'g') ggPending.current = false;
            return prev;
          }
        }

        if (key !== 'g') ggPending.current = false;

        const next = { row, col };
        if (isVisualRef.current && visualStartRef.current) {
          applyXtermSelection(terminal, visualStartRef.current, next);
        }
        return next;
      });
    },
    [terminal, isActive, exit],
  );

  return {
    cursorRow: cursor.row,
    cursorCol: cursor.col,
    selectionStart: isVisual ? visualStart : null,
    selectionEnd: isVisual ? cursor : null,
    isVisual,
    handleKey,
    exit,
    copySelection,
  };
}
