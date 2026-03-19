import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';

interface UseTerminalOptions {
  ptyId: string | null;
}

export function useTerminal(containerRef: React.RefObject<HTMLDivElement | null>, options: UseTerminalOptions) {
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const { ptyId } = options;

  const fit = useCallback(() => {
    if (fitAddonRef.current && terminalRef.current) {
      try {
        fitAddonRef.current.fit();
        if (ptyId) {
          const { cols, rows } = terminalRef.current;
          window.electronAPI.pty.resize(ptyId, cols, rows);
        }
      } catch {
        // ignore fit errors during unmount
      }
    }
  }, [ptyId]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !ptyId) return;

    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      scrollback: 10000,
      scrollOnUserInput: false,
      fontFamily: "'Cascadia Code', 'Consolas', 'Courier New', monospace",
      theme: {
        background: '#1e1e2e',
        foreground: '#cdd6f4',
        cursor: '#f5e0dc',
        selectionBackground: '#585b70',
        black: '#45475a',
        red: '#f38ba8',
        green: '#a6e3a1',
        yellow: '#f9e2af',
        blue: '#89b4fa',
        magenta: '#f5c2e7',
        cyan: '#94e2d5',
        white: '#bac2de',
        brightBlack: '#585b70',
        brightRed: '#f38ba8',
        brightGreen: '#a6e3a1',
        brightYellow: '#f9e2af',
        brightBlue: '#89b4fa',
        brightMagenta: '#f5c2e7',
        brightCyan: '#94e2d5',
        brightWhite: '#a6adc8',
      },
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

    fitAddon.fit();

    // Clipboard handling
    terminal.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;

      // Ctrl+C: copy if selection exists, otherwise send SIGINT
      if (e.ctrlKey && !e.shiftKey && e.key === 'c') {
        const sel = terminal.getSelection();
        console.log('[wmux:clipboard] Ctrl+C sel=', sel ? `"${sel.slice(0, 50)}..."` : 'none');
        if (sel) {
          void window.clipboardAPI.writeText(sel);
          terminal.clearSelection();
          return false;
        }
        return true; // no selection → SIGINT
      }

      // Ctrl+V: paste from clipboard
      if (e.ctrlKey && !e.shiftKey && e.key === 'v') {
        void window.clipboardAPI.readText().then((text) => {
          console.log('[wmux:clipboard] Ctrl+V len=', text?.length ?? 0);
          if (text) window.electronAPI.pty.write(ptyId, text);
        }).catch((err) => console.error('[wmux:clipboard] Ctrl+V error:', err));
        return false;
      }

      // Ctrl+Shift+C/V still work as fallback
      if (e.ctrlKey && e.shiftKey && e.key === 'C') {
        const sel = terminal.getSelection();
        console.log('[wmux:clipboard] Ctrl+Shift+C sel=', sel ? `"${sel.slice(0, 50)}..."` : 'none');
        if (sel) void window.clipboardAPI.writeText(sel);
        return false;
      }
      if (e.ctrlKey && e.shiftKey && e.key === 'V') {
        void window.clipboardAPI.readText().then((text) => {
          console.log('[wmux:clipboard] Ctrl+Shift+V len=', text?.length ?? 0);
          if (text) window.electronAPI.pty.write(ptyId, text);
        }).catch((err) => console.error('[wmux:clipboard] Ctrl+Shift+V error:', err));
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
        terminal.writeln(`\r\n[Process exited with code ${exitCode}]`);
      }
    });

    // Resize PTY on initial fit
    const { cols, rows } = terminal;
    window.electronAPI.pty.resize(ptyId, cols, rows);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;

    // ResizeObserver for auto-fit — preserves user scroll position across resize
    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        try {
          const term = terminalRef.current;
          if (!term) return;

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
          window.electronAPI.pty.resize(ptyId, cols, rows);
        } catch {
          // ignore fit errors during unmount
        }
      });
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      removeDataListener();
      removeExitListener();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    };
  }, [ptyId, containerRef]);

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
