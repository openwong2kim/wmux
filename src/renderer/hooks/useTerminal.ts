import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';
import { useStore } from '../stores';
import { t } from '../i18n';
import { XTERM_THEMES, type ThemeId } from '../themes';

// Lightweight copy feedback toast — injects/removes a DOM element
let copyToastTimer: ReturnType<typeof setTimeout> | null = null;
function showCopyToast() {
  let el = document.getElementById('wmux-copy-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'wmux-copy-toast';
    el.style.cssText = 'position:fixed;bottom:28px;left:50%;transform:translateX(-50%);background:#a6e3a1;color:#1e1e2e;font-family:monospace;font-size:11px;font-weight:600;padding:3px 12px;border-radius:4px;z-index:9999;pointer-events:none;opacity:0;transition:opacity 0.2s';
    document.body.appendChild(el);
  }
  el.textContent = t('terminal.copied');
  el.style.opacity = '1';
  if (copyToastTimer) clearTimeout(copyToastTimer);
  copyToastTimer = setTimeout(() => { el!.style.opacity = '0'; }, 1200);
}

interface UseTerminalOptions {
  ptyId: string | null;
  /** Combined visibility flag: true only when the terminal's workspace AND surface tab are both active.
   *  When false the terminal DOM container may be hidden (display:none / zero-size). */
  isVisible?: boolean;
}

export function useTerminal(containerRef: React.RefObject<HTMLDivElement | null>, options: UseTerminalOptions) {
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const { ptyId, isVisible = true } = options;
  const terminalFontSize = useStore((s) => s.terminalFontSize);
  const terminalFontFamily = useStore((s) => s.terminalFontFamily);
  const scrollbackLines = useStore((s) => s.scrollbackLines);
  const theme = useStore((s) => s.theme) as ThemeId;
  const xtermTheme = XTERM_THEMES[theme] ?? XTERM_THEMES.catppuccin;

  const fit = useCallback(() => {
    const container = containerRef.current;
    if (!fitAddonRef.current || !terminalRef.current || !container) return;
    // Guard: skip fit entirely when the container is hidden (zero dimensions).
    // Calling fit() on a display:none element produces 0 cols/rows which
    // corrupts the xterm buffer and causes the "infinite copy downward" bug.
    if (container.offsetWidth === 0 || container.offsetHeight === 0) return;
    try {
      fitAddonRef.current.fit();
      if (ptyId) {
        const { cols, rows } = terminalRef.current;
        // Never send 0-size resize to PTY — that corrupts the terminal buffer.
        if (cols > 0 && rows > 0) {
          window.electronAPI.pty.resize(ptyId, cols, rows);
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
      fontFamily: `'${terminalFontFamily}', 'Consolas', 'Courier New', monospace`,
      theme: xtermTheme,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    terminal.open(container);

    // Try WebGL, fall back to canvas
    try {
      const webglAddon = new WebglAddon();
      webglAddon.onContextLoss(() => {
        webglAddon.dispose();
      });
      terminal.loadAddon(webglAddon);
    } catch {
      console.warn('WebGL addon failed, using canvas renderer');
    }

    // Only fit immediately if the container is actually visible (non-zero size).
    // If the workspace starts hidden (display:none), skip the initial fit so we
    // don't corrupt the terminal with 0 cols/rows. The visibility-watcher effect
    // below will trigger a proper fit when the workspace is shown.
    if (container.offsetWidth > 0 && container.offsetHeight > 0) {
      fitAddon.fit();
    }

    // Clipboard + shortcut handling
    terminal.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;

      // Pass app shortcuts through to useKeyboard (don't let xterm consume them)
      if (e.ctrlKey && !e.shiftKey && [',', 'b', 'k', 'i', 'n', 't'].includes(e.key)) {
        return false; // let DOM bubble to useKeyboard
      }
      if (e.ctrlKey && e.shiftKey) {
        return false; // all Ctrl+Shift combos → app shortcuts
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

      // Ctrl+C: copy if selection exists, otherwise send SIGINT
      if (e.ctrlKey && !e.shiftKey && e.key === 'c') {
        const sel = terminal.getSelection();
        if (sel) {
          void window.clipboardAPI.writeText(sel);
          terminal.clearSelection();
          showCopyToast();
          return false;
        }
        return true; // no selection → SIGINT
      }

      // Ctrl+V: paste from clipboard (use our IPC clipboard, block event
      // so xterm doesn't also paste via browser's native paste event)
      if (e.ctrlKey && !e.shiftKey && e.key === 'v') {
        e.preventDefault();
        void window.clipboardAPI.readText().then((text) => {
          if (text) window.electronAPI.pty.write(ptyId, text);
        }).catch(() => {});
        return false;
      }

      // Ctrl+Shift+C: copy fallback
      if (e.ctrlKey && e.shiftKey && e.key === 'C') {
        const sel = terminal.getSelection();
        if (sel) {
          void window.clipboardAPI.writeText(sel);
          showCopyToast();
        }
        return false;
      }
      // Ctrl+Shift+V: paste fallback
      if (e.ctrlKey && e.shiftKey && e.key === 'V') {
        e.preventDefault();
        void window.clipboardAPI.readText().then((text) => {
          if (text) window.electronAPI.pty.write(ptyId, text);
        }).catch(() => {});
        return false;
      }

      return true;
    });

    // Right-click: always paste
    terminal.element?.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      void window.clipboardAPI.readText().then((text) => {
        console.log('[wmux:clipboard] right-click paste len=', text?.length ?? 0);
        if (text) window.electronAPI.pty.write(ptyId, text);
      }).catch((err) => console.error('[wmux:clipboard] right-click error:', err));
    });

    // Drag-and-drop: paste file paths into terminal
    // Use the xterm element + capture phase — xterm's internal canvas blocks
    // normal event propagation on the container div.
    const xtermEl = terminal.element;
    const handleDragOver = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const de = e as DragEvent;
      if (de.dataTransfer) de.dataTransfer.dropEffect = 'copy';
    };
    const handleDrop = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const de = e as DragEvent;
      const files = de.dataTransfer?.files;
      if (!files || files.length === 0) return;
      const paths: string[] = [];
      for (let i = 0; i < files.length; i++) {
        paths.push((files[i] as File & { path: string }).path);
      }
      const text = paths.map((p) => (p.includes(' ') ? `"${p}"` : p)).join(' ');
      window.electronAPI.pty.write(ptyId, text);
    };
    if (xtermEl) {
      xtermEl.addEventListener('dragenter', handleDragOver, true);
      xtermEl.addEventListener('dragover', handleDragOver, true);
      xtermEl.addEventListener('drop', handleDrop, true);
    }
    // Also on container as fallback
    container.addEventListener('dragenter', handleDragOver, true);
    container.addEventListener('dragover', handleDragOver, true);
    container.addEventListener('drop', handleDrop, true);

    // Forward user input to PTY
    terminal.onData((data) => {
      window.electronAPI.pty.write(ptyId, data);
    });

    // Receive PTY output
    const removeDataListener = window.electronAPI.pty.onData((id, data) => {
      if (id === ptyId) {
        terminal.write(data);
      }
    });

    // Handle PTY exit
    const removeExitListener = window.electronAPI.pty.onExit((id, exitCode) => {
      if (id === ptyId) {
        terminal.writeln(`\r\n${t('terminal.exitedBracket', { code: exitCode })}`);
      }
    });

    // Resize PTY on initial fit — only when we actually have valid dimensions.
    const { cols, rows } = terminal;
    if (cols > 0 && rows > 0) {
      window.electronAPI.pty.resize(ptyId, cols, rows);
    }

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;

    // ResizeObserver for auto-fit — preserves user scroll position across resize.
    // IMPORTANT: skip when the container has zero dimensions (display:none workspace).
    // Fitting a hidden terminal produces 0 cols/rows, which corrupts the PTY buffer
    // and manifests as "infinite content duplication" when switching back to it.
    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        try {
          const term = terminalRef.current;
          if (!term) return;

          // Skip entirely if container is hidden/zero-size
          if (container.offsetWidth === 0 || container.offsetHeight === 0) return;

          // Snapshot scroll state before fit() reflows the buffer
          const prevYBase = term.buffer.active.baseY;
          const prevYDisp = term.buffer.active.viewportY;
          const wasScrolledUp = prevYDisp < prevYBase;
          // How many lines from the bottom was the user?
          const distFromBottom = prevYBase - prevYDisp;

          fitAddon.fit();

          // Restore scroll position if user was not at the bottom
          if (wasScrolledUp) {
            const newYBase = term.buffer.active.baseY;
            const targetYDisp = Math.max(0, newYBase - distFromBottom);
            term.scrollToLine(targetYDisp);
          }

          const { cols, rows } = term;
          // Never send 0-size resize to PTY
          if (cols > 0 && rows > 0) {
            window.electronAPI.pty.resize(ptyId, cols, rows);
          }
        } catch {
          // ignore fit errors during unmount
        }
      });
    });
    resizeObserver.observe(container);

    return () => {
      if (xtermEl) {
        xtermEl.removeEventListener('dragenter', handleDragOver, true);
        xtermEl.removeEventListener('dragover', handleDragOver, true);
        xtermEl.removeEventListener('drop', handleDrop, true);
      }
      container.removeEventListener('dragenter', handleDragOver, true);
      container.removeEventListener('dragover', handleDragOver, true);
      container.removeEventListener('drop', handleDrop, true);
      resizeObserver.disconnect();
      removeDataListener();
      removeExitListener();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    };
  }, [ptyId, containerRef, terminalFontSize, terminalFontFamily, scrollbackLines, xtermTheme]);

  // Re-fit when the terminal becomes visible (workspace switch or surface tab switch).
  // Without this, a terminal that was initialized while hidden (0-size) will display
  // at the wrong size until the next manual resize.
  useEffect(() => {
    if (!isVisible) return;
    // Defer slightly to allow the CSS display change to take effect before measuring
    const id = requestAnimationFrame(() => {
      fit();
    });
    return () => cancelAnimationFrame(id);
  }, [isVisible, fit]);

  const findNext = useCallback((text: string) => {
    searchAddonRef.current?.findNext(text, {
      decorations: {
        matchBackground: '#f9e2af40',
        matchBorder: '#f9e2af',
        matchOverviewRuler: '#f9e2af',
        activeMatchBackground: '#f9e2af80',
        activeMatchBorder: '#f9e2af',
        activeMatchColorOverviewRuler: '#f9e2af',
      },
    });
  }, []);

  const findPrevious = useCallback((text: string) => {
    searchAddonRef.current?.findPrevious(text, {
      decorations: {
        matchBackground: '#f9e2af40',
        matchBorder: '#f9e2af',
        matchOverviewRuler: '#f9e2af',
        activeMatchBackground: '#f9e2af80',
        activeMatchBorder: '#f9e2af',
        activeMatchColorOverviewRuler: '#f9e2af',
      },
    });
  }, []);

  const clearSearch = useCallback(() => {
    searchAddonRef.current?.clearDecorations();
  }, []);

  return { terminal: terminalRef, fit, searchAddonRef, findNext, findPrevious, clearSearch };
}
