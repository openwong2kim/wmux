import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { SearchAddon } from '@xterm/addon-search';
import { useStore } from '../stores';
import { t } from '../i18n';
import { XTERM_THEMES, extractXtermColors, type ThemeId, type BuiltinThemeId } from '../themes';

// Module-level terminal registry for scrollback persistence
const terminalRegistry = new Map<string, Terminal>();
export { terminalRegistry };

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
  /** If set, load scrollback content from this file (surfaceId) before connecting PTY data */
  scrollbackFile?: string;
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
  const { ptyId, isVisible = true, scrollbackFile } = options;
  const ptyIdRef = useRef(ptyId);
  ptyIdRef.current = ptyId;
  const terminalFontSize = useStore((s) => s.terminalFontSize);
  const terminalFontFamily = useStore((s) => s.terminalFontFamily);
  const scrollbackLines = useStore((s) => s.scrollbackLines);
  const theme = useStore((s) => s.theme) as ThemeId;
  const customThemeColors = useStore((s) => s.customThemeColors);
  const xtermTheme = theme === 'custom' && customThemeColors
    ? extractXtermColors(customThemeColors)
    : XTERM_THEMES[theme as BuiltinThemeId] ?? XTERM_THEMES['catppuccin-mocha'];

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
          window.electronAPI.pty.resize(currentPtyId, cols, rows);
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

    // WebGL addon loading — only called for visible terminals.
    // Chromium limits simultaneous WebGL contexts (~8–16). Exceeding the limit
    // causes context-loss on the oldest context, killing that terminal's renderer.
    // We therefore load WebGL lazily (via the visibility effect) and dispose it
    // when the terminal is hidden, keeping the active context count low.
    function loadWebgl() {
      if (webglAddonRef.current) return; // already loaded
      try {
        const addon = new WebglAddon();
        addon.onContextLoss(() => {
          console.warn('[Terminal] WebGL context lost — falling back to canvas');
          addon.dispose();
          webglAddonRef.current = null;
          try {
            terminal.refresh(0, terminal.rows - 1);
          } catch {
            // terminal may already be disposed
          }
        });
        terminal.loadAddon(addon);
        webglAddonRef.current = addon;
      } catch {
        console.warn('WebGL addon failed, using canvas renderer');
        webglAddonRef.current = null;
      }
    }
    loadWebglRef.current = loadWebgl;

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
        webglAddonRef.current.dispose();
        webglAddonRef.current = null;
        loadWebgl();
      }
      fitAddon.fit();
      terminal.refresh(0, terminal.rows - 1);
    });

    // Track last sent dimensions to avoid redundant resizes
    let lastSentCols = 0;
    let lastSentRows = 0;
    let resizeDebounceTimer: ReturnType<typeof setTimeout> | null = null;

    // Clipboard + shortcut handling
    terminal.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown') return true;

      // Shift+Enter → send CSI u sequence so Claude Code inserts a newline
      // instead of submitting. Kitty keyboard protocol: ESC [ 13 ; 2 u
      if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        window.electronAPI.pty.write(ptyId, '\x1b[13;2u');
        return false;
      }

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
        void (async () => {
          // Try text first
          const text = await window.clipboardAPI.readText();
          if (text) {
            window.electronAPI.pty.write(ptyId, text);
            return;
          }
          // No text — check for image, save to temp file, paste path
          const imagePath = await window.clipboardAPI.readImage();
          if (imagePath) {
            const quoted = imagePath.includes(' ') ? `"${imagePath}"` : imagePath;
            window.electronAPI.pty.write(ptyId, quoted);
          }
        })().catch(() => {});
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
        void (async () => {
          const text = await window.clipboardAPI.readText();
          if (text) {
            window.electronAPI.pty.write(ptyId, text);
            return;
          }
          const imagePath = await window.clipboardAPI.readImage();
          if (imagePath) {
            const quoted = imagePath.includes(' ') ? `"${imagePath}"` : imagePath;
            window.electronAPI.pty.write(ptyId, quoted);
          }
        })().catch(() => {});
        return false;
      }

      return true;
    });

    // Right-click: always paste
    terminal.element?.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      void (async () => {
        const text = await window.clipboardAPI.readText();
        console.log('[wmux:clipboard] right-click paste len=', text?.length ?? 0);
        if (text) {
          window.electronAPI.pty.write(ptyId, text);
          return;
        }
        const imagePath = await window.clipboardAPI.readImage();
        if (imagePath) {
          const quoted = imagePath.includes(' ') ? `"${imagePath}"` : imagePath;
          window.electronAPI.pty.write(ptyId, quoted);
        }
      })().catch((err) => console.error('[wmux:clipboard] right-click error:', err));
    });

    // Drag-and-drop is handled globally in preload via webUtils.getPathForFile()

    // Forward user input to PTY
    terminal.onData((data) => {
      window.electronAPI.pty.write(ptyId, data);
    });

    // Deferred PTY listener references — connected after scrollback restore
    let removeDataListener: (() => void) | null = null;
    let removeExitListener: (() => void) | null = null;

    // Restore scrollback from previous session, then connect PTY data listener.
    // Scrollback must be written BEFORE PTY data listener is connected so new
    // output appends after restored content rather than interleaving.
    const connectPty = () => {
      removeDataListener = window.electronAPI.pty.onData((id, data) => {
        if (id === ptyId) {
          terminal.write(data);
        }
      });

      removeExitListener = window.electronAPI.pty.onExit((id, exitCode) => {
        if (id === ptyId) {
          terminal.writeln(`\r\n${t('terminal.exitedBracket', { code: exitCode })}`);
        }
      });
    };

    if (scrollbackFile) {
      // Register PTY listeners immediately to avoid data loss during scrollback load.
      // scrollback.load() is async (IPC round-trip). If PTY sends data before it
      // resolves, connectPty() would not yet be called and data would be lost.
      // Instead, buffer incoming data and flush after scrollback is written.
      const pendingData: string[] = [];
      let scrollbackLoaded = false;

      removeDataListener = window.electronAPI.pty.onData((id, data) => {
        if (id !== ptyId) return;
        if (!scrollbackLoaded) {
          pendingData.push(data);
          return;
        }
        terminal.write(data);
      });

      removeExitListener = window.electronAPI.pty.onExit((id, exitCode) => {
        if (id === ptyId) {
          terminal.writeln(`\r\n${t('terminal.exitedBracket', { code: exitCode })}`);
        }
      });

      window.electronAPI.scrollback.load(scrollbackFile).then((content) => {
        if (content && terminalRef.current === terminal) {
          terminal.write(content);
        }
        scrollbackLoaded = true;
        for (const data of pendingData) {
          terminal.write(data);
        }
        pendingData.length = 0;
      }).catch(() => {
        scrollbackLoaded = true;
        for (const data of pendingData) {
          terminal.write(data);
        }
        pendingData.length = 0;
      });
    } else {
      connectPty();
    }

    // Resize PTY on initial fit — only when we actually have valid dimensions.
    const { cols, rows } = terminal;
    if (cols > 0 && rows > 0) {
      lastSentCols = cols;
      lastSentRows = rows;
      window.electronAPI.pty.resize(ptyId, cols, rows);
    }

    // Register in terminal registry for scrollback persistence
    terminalRegistry.set(ptyId, terminal);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    searchAddonRef.current = searchAddon;

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
              window.electronAPI.pty.resize(currentPtyId, cols, rows);
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
      resizeObserver.disconnect();
      removeDataListener?.();
      removeExitListener?.();
      terminalRegistry.delete(ptyId);
      webglAddonRef.current?.dispose();
      webglAddonRef.current = null;
      loadWebglRef.current = null;
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
    };
  }, [ptyId, containerRef]);

  // Apply font/theme changes at runtime without recreating the terminal instance.
  // This preserves the scrollback buffer when the user tweaks visual settings.
  useEffect(() => {
    if (!terminalRef.current) return;
    terminalRef.current.options.fontSize = terminalFontSize;
    terminalRef.current.options.fontFamily = `'${terminalFontFamily}', 'Consolas', 'Courier New', monospace`;
    terminalRef.current.options.theme = xtermTheme;
    fitAddonRef.current?.fit();
  }, [terminalFontSize, terminalFontFamily, xtermTheme]);

  // Manage WebGL lifecycle based on visibility.
  // Load WebGL when visible (GPU-accelerated rendering), dispose when hidden
  // to free the WebGL context for other terminals.  Also re-fit so a terminal
  // that was initialized while hidden displays at the correct size.
  useEffect(() => {
    if (isVisible) {
      // Load WebGL for this terminal if not already loaded
      if (!webglAddonRef.current && loadWebglRef.current) {
        loadWebglRef.current();
      }
      // Defer fit to allow CSS display change to take effect before measuring
      const id = requestAnimationFrame(() => {
        fit();
      });
      return () => cancelAnimationFrame(id);
    } else {
      // Dispose WebGL when hidden — free the context for other terminals
      if (webglAddonRef.current) {
        webglAddonRef.current.dispose();
        webglAddonRef.current = null;
      }
    }
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
