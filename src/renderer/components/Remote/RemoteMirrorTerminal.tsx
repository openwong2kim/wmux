import { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { useT } from '../../hooks/useT';
import { applyUnicodeWidthModel } from '../../../shared/terminalUnicode';
import { useStore } from '../../stores';
import { terminalFontFamilyCss } from '../../utils/terminalFont';
import { XTERM_THEMES, extractXtermColors, type BuiltinThemeId, type ThemeId } from '../../themes';
import { resolveMinimumContrastRatio } from '../../tailwindPalette';

export interface RemoteMirrorTerminalProps {
  /** null while the pane attach is still in flight. */
  attachId: string | null;
  /** Set when the attach itself failed (e.g. a rejected paneAttach). */
  error?: string;
  /** True when the remote host was started without --allow-input — writes
   *  must be swallowed locally rather than silently dropped server-side. */
  readOnly?: boolean;
}

/** Decode a base64 payload into raw bytes and hand it to xterm as-is — the
 *  same pattern useTerminal.ts uses for its dead-snapshot repaint
 *  (`Uint8Array.from(atob(b64), c => c.charCodeAt(0))`), so multi-byte UTF-8
 *  sequences split across the wire boundary decode correctly via xterm's own
 *  parser instead of a lossy JS string round-trip. */
function decodeBase64Bytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/**
 * One @xterm/xterm mirror of a single remote pane. Read-mostly: the remote's
 * own geometry events (meta on attach, resize afterwards) are the ONLY thing
 * that drives `term.resize()` — this component never calls a resize API back
 * toward the remote (geometry has a single owner, the remote daemon). A
 * container/remote aspect mismatch is letterboxed by the parent's CSS, not by
 * resizing the terminal.
 */
export default function RemoteMirrorTerminal({ attachId, error, readOnly }: RemoteMirrorTerminalProps) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [exited, setExited] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  // Read via ref inside the attach-lifecycle effect below so a readOnly
  // flip (allowInput probe resolving after mount) doesn't tear down and
  // re-subscribe the whole attach — only paneWrite needs the live value.
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;

  /**
   * True while a snapshot/repaint is being fed to the parser, to keep xterm's
   * automatic REPLIES off the remote pane's stdin.
   *
   * xterm answers device queries itself — DA1 (`ESC[c`), DSR/CPR (`ESC[6n`),
   * DECRPM — and it delivers those answers through the SAME `onData` this
   * component forwards to `remote.paneWrite`. A replayed snapshot contains
   * whatever queries the remote app sent, so replaying it made the mirror type
   * phantom responses into the remote pane. The remote's own GUI terminal is
   * the authoritative responder; a mirror must never answer. This is the same
   * reason HeadlessSnapshot states in its header that "no onData handler is
   * ever wired" to its offscreen terminal.
   *
   * A repaint cannot distinguish a parser reply from a keystroke the user
   * raced into the same window, so the gate suppresses `paneWrite` outright.
   * Repaint windows are milliseconds; losing a keystroke to one is far cheaper
   * than injecting query answers into a live remote shell.
   */
  const repaintingRef = useRef(false);

  /**
   * The same visual settings a local pane gets.
   *
   * A mirror is still one of this app's terminals, and it sits in the sidebar
   * next to local ones. Constructing it bare left it on xterm's own defaults —
   * `monospace` at 15px against a black background — so it rendered in a
   * different face, one pixel larger, and outside the theme's ANSI palette
   * (DESIGN.md: terminal content owns that palette). Visible as "why is this
   * pane slightly bolder and bigger", which is exactly what it was.
   */
  const terminalFontSize = useStore((s) => s.terminalFontSize);
  const terminalFontFamily = useStore((s) => s.terminalFontFamily);
  const theme = useStore((s) => s.theme) as ThemeId;
  const customThemeColors = useStore((s) => s.customThemeColors);
  // Memoised on identity, not just value. `extractXtermColors` builds a new
  // object every call, so a custom theme would hand the settings effect below a
  // dep that never compares equal — re-assigning `options.theme` on every
  // parent render, and with it an xterm ColorSet rebuild, a glyph-atlas clear
  // and a full refresh. Builtin themes come from a module constant and were
  // already stable; this makes custom ones behave the same.
  const xtermTheme = useMemo(
    () => (theme === 'custom' && customThemeColors
      ? extractXtermColors(customThemeColors)
      : XTERM_THEMES[theme as BuiltinThemeId] ?? XTERM_THEMES['catppuccin-mocha']),
    [theme, customThemeColors],
  );
  // True-colour foregrounds from remote TUIs land here the same way they do
  // locally, so the same contrast floor applies — see useTerminal.ts for why
  // dark themes get a lower one.
  const minimumContrastRatio = useMemo(
    () => resolveMinimumContrastRatio(xtermTheme.background),
    [xtermTheme],
  );

  // Read inside the mount effect without joining its deps — same discipline as
  // `readOnlyRef` above. The effect must stay `[]`-keyed (see below), but it
  // still needs the CURRENT settings at construction so the first paint is
  // already correct rather than flashing xterm's defaults.
  const terminalFontSizeRef = useRef(terminalFontSize);
  terminalFontSizeRef.current = terminalFontSize;
  const terminalFontFamilyRef = useRef(terminalFontFamily);
  terminalFontFamilyRef.current = terminalFontFamily;
  const xtermThemeRef = useRef(xtermTheme);
  xtermThemeRef.current = xtermTheme;
  const minimumContrastRatioRef = useRef(minimumContrastRatio);
  minimumContrastRatioRef.current = minimumContrastRatio;

  // Mount the xterm instance once, for the lifetime of this component.
  //
  // Settings are passed at construction AND kept in sync by the effect below,
  // rather than listed in this effect's deps: re-creating the terminal on a
  // font change would drop the mirrored scrollback, and the remote only
  // repaints on a fresh attach.
  useEffect(() => {
    if (!containerRef.current) return;
    const term = new Terminal({
      convertEol: false,
      scrollback: 2000,
      disableStdin: false,
      fontSize: terminalFontSizeRef.current,
      fontFamily: terminalFontFamilyCss(terminalFontFamilyRef.current),
      theme: xtermThemeRef.current,
      minimumContrastRatio: minimumContrastRatioRef.current,
      // REQUIRED by the width model below. `Unicode11Addon.activate` reads
      // `term.unicode`, which xterm gates behind this flag and throws without
      // it — synchronously, inside a mount effect, where the nearest boundary
      // is the one wrapping the whole main area. One attached remote workspace
      // would take the entire local pane grid down with it.
      allowProposedApi: true,
    });
    // The width model, BEFORE open() — same order as the local pane.
    //
    // `terminalUnicode.ts` exists because two grids that must agree will drift
    // silently if each names its own addon: "the daemon wraps a row at a
    // different column than the screen does, and everything after it sits one
    // or more cells off." A mirror is exactly that situation — the remote
    // daemon computed the grid, this terminal re-renders it — and it was the
    // one terminal not going through the helper. On CJK text, where every
    // character is double-width, the drift is visible as torn, interleaved
    // rows rather than a subtle offset.
    // Registered BEFORE the addon and open(). If either throws, the cleanup
    // below still runs against a terminal this ref knows about, instead of
    // leaking the instance (DOM, listeners, buffers) on every mount attempt.
    termRef.current = term;
    applyUnicodeWidthModel(term);
    term.open(containerRef.current);
    containerRef.current.style.backgroundColor = xtermThemeRef.current.background ?? '';
    return () => {
      term.dispose();
      termRef.current = null;
    };
  }, []);

  // Apply visual settings at runtime without recreating the terminal, so
  // tweaking the font does not wipe what the remote has already sent. Mirrors
  // the local pane's own settings effect.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = terminalFontSize;
    term.options.fontFamily = terminalFontFamilyCss(terminalFontFamily);
    term.options.theme = xtermTheme;
    term.options.minimumContrastRatio = minimumContrastRatio;
    if (containerRef.current) {
      containerRef.current.style.backgroundColor = xtermTheme.background ?? '';
    }
  }, [terminalFontSize, terminalFontFamily, xtermTheme, minimumContrastRatio]);

  // Subscribe/attach lifecycle keyed on attachId. Every onPaneMeta (fresh
  // attach OR reconnect) means "reset terminal, resize, repaint", never a
  // delta; a later geometry change comes through onPaneResize instead.
  useEffect(() => {
    if (!attachId) return;
    setExited(false);
    setDisconnected(false);
    const remote = window.electronAPI?.remote;
    if (!remote) return;

    const offMeta = remote.onPaneMeta((e) => {
      if (e.attachId !== attachId) return;
      const term = termRef.current;
      if (!term) return;
      term.reset();
      term.resize(e.cols, e.rows);
      repaintingRef.current = true;
      term.write(decodeBase64Bytes(e.snapshotB64), () => {
        repaintingRef.current = false;
      });
    });
    // A resize on the machine that owns the pane. Geometry only: no reset and
    // no repaint, so the mirrored scrollback and the user's scroll position
    // survive someone dragging a divider on the other machine. The remote app
    // repaints itself on SIGWINCH; those bytes arrive through onPaneData.
    const offResize = remote.onPaneResize((e) => {
      if (e.attachId !== attachId) return;
      termRef.current?.resize(e.cols, e.rows);
    });
    const offData = remote.onPaneData((e) => {
      if (e.attachId !== attachId) return;
      const term = termRef.current;
      if (!term) return;
      term.write(decodeBase64Bytes(e.dataB64));
    });
    const offExit = remote.onPaneExit((e) => {
      if (e.attachId !== attachId) return;
      setExited(true);
    });
    const offError = remote.onPaneError((e) => {
      if (e.attachId !== attachId) return;
      setDisconnected(true);
    });
    const dataDisposable = termRef.current?.onData((data) => {
      if (readOnlyRef.current) return; // read-only host — swallow locally, don't POST a write that'll be rejected
      if (repaintingRef.current) return; // parser reply to a replayed query — see repaintingRef
      remote.paneWrite(attachId, data);
    });

    return () => {
      offMeta();
      offResize();
      offData();
      offExit();
      offError();
      dataDisposable?.dispose();
      remote.paneDetach(attachId).catch(() => { /* best-effort teardown — nothing for the caller to act on */ });
    };
  }, [attachId]);

  return (
    // `overflow-hidden` is the letterboxing this component's header describes
    // ("letterboxed by the parent's CSS, not by resizing the terminal") and
    // that nothing in the chain actually applied — not here, not PaneCell, not
    // WorkspaceCenter. Geometry has a single owner, the remote daemon, so a
    // remote pane with more rows than this cell can show renders an element
    // TALLER than its box; with nothing clipping it, the overflow painted over
    // the composer and the sidebar.
    <div className="relative w-full h-full min-h-0 min-w-0 overflow-hidden">
      <div ref={containerRef} className="absolute inset-0 overflow-hidden" />
      {error && (
        <div
          className="absolute inset-0 flex items-center justify-center text-[11px] font-mono px-2 text-center"
          style={{ color: 'var(--accent-red)', background: 'var(--bg-base)' }}
        >
          {error}
        </div>
      )}
      {exited && (
        <div
          className="absolute bottom-0 left-0 right-0 px-2 py-1 text-[10px] font-mono"
          style={{ color: 'var(--text-muted)', background: 'rgba(0,0,0,0.55)' }}
        >
          {t('remote.exited')}
        </div>
      )}
      {disconnected && (
        <div
          className="absolute bottom-0 left-0 right-0 px-2 py-1 text-[10px] font-mono"
          style={{ color: 'var(--accent-red)', background: 'rgba(0,0,0,0.55)' }}
        >
          {t('remote.disconnected')}
        </div>
      )}
    </div>
  );
}
