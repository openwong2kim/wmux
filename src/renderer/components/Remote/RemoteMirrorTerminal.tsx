import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { useT } from '../../hooks/useT';
import { sanitizeTitle } from '../../../main/pty/titleDetect';
import { applyUnicodeWidthModel } from '../../../shared/terminalUnicode';
import { computeMirrorFontSize, mirrorFitKey, MAX_FIT_PASSES } from './mirrorFit';
import { decideMirrorKeyWithRepeat } from './mirrorInput';
import { foldRemoteKeyboardState, acceptsCsiU, INITIAL_REMOTE_KEYBOARD_STATE } from './keyboardProtocol';
import { useStore } from '../../stores';
import { terminalFontFamilyCss } from '../../utils/terminalFont';
import { createAutoSelectionCopy } from '../../utils/autoSelectionCopy';
import { pastePtyChunked } from '../../utils/clipboardChunk';
import { copySelectionWithFeedback } from '../../hooks/useTerminal';
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
  /** #1086/#1091 — fired, already run through {@link sanitizeTitle}, whenever
   *  the remote shell sets its window title via OSC 0/2 (e.g. a `rename`
   *  command) — xterm's own parser extracts the OSC payload; this component
   *  sanitizes it the same way PTYBridge does for a local pane before handing
   *  it up. Optional: RemoteWorkspaceView's mirror-grid cells have no
   *  per-surface title to update and pass nothing. */
  onTitleChange?: (title: string) => void;
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
 * Answers xterm generates BY ITSELF in response to a device query, which it
 * delivers through the same `onData` a user's keystrokes come out of.
 *
 * A mirror must never answer: the machine that owns the pane has its own
 * terminal, that one is the authoritative responder, and a second answer is a
 * line of garbage typed into a live remote shell. (HeadlessSnapshot avoids the
 * whole problem by never wiring `onData` at all — a mirror cannot, because it
 * also has to carry real typing.)
 *
 * Matching by SHAPE is what makes this safe to apply to the live stream and not
 * just to a replay: no key or key combination xterm encodes produces any of
 * these. Arrows and function keys end in `A`–`H`, `~`, or an uppercase letter;
 * a reply ends in lowercase `c`, `n`, `y`, `t`, or the specific `R` of a cursor
 * report, and the DCS/OSC forms have no keyboard analogue at all.
 *
 * The stronger fix is upstream: neutralise the QUERIES so no reply is ever
 * generated (xterm's `parser.registerCsiHandler` can swallow DA/DSR/DECRQM
 * before the default handler answers), or have the daemon strip them from the
 * bytes it fans out. Both are larger than this pane and out of scope here.
 */
// eslint-disable-next-line no-control-regex
const DEVICE_REPLY_RE = new RegExp(
  '^(?:' +
    // Device attributes (DA1/DA2/DA3) and device status / cursor position.
    '\\x1b\\[[?>=]?[0-9;]*[cnR]' +
    // DECRPM — "mode Ps is currently Pm".
    '|\\x1b\\[\\?[0-9;]*\\$y' +
    // Window / text-area reports (CSI 8 ; rows ; cols t and friends).
    '|\\x1b\\[[0-9;]+t' +
    // DCS replies: DECRQSS, XTVERSION, DA3.
    '|\\x1bP[^\\x1b]*\\x1b\\\\' +
    // OSC colour reports (`rgb:....` under BEL or ST).
    '|\\x1b\\][0-9;]*;?rgb:[^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)' +
    ')$',
);

export function isDeviceReply(data: string): boolean {
  return DEVICE_REPLY_RE.test(data);
}

/** Trailing debounce for box-size-driven fits. A divider drag emits a resize
 *  every frame; restyling the font that often re-measures the character and
 *  clears xterm's width cache, once per mirror, six mirrors deep. */
const FIT_DEBOUNCE_MS = 150;

/**
 * One @xterm/xterm mirror of a single remote pane. Read-mostly: the remote's
 * own geometry events (meta on attach, resize afterwards) are the ONLY thing
 * that drives `term.resize()` — this component never calls a resize API back
 * toward the remote (geometry has a single owner, the remote daemon). A
 * container/remote aspect mismatch is letterboxed by the parent's CSS, not by
 * resizing the terminal.
 */
export default function RemoteMirrorTerminal({ attachId, error, readOnly, onTitleChange }: RemoteMirrorTerminalProps) {
  const t = useT();
  // Ref, same reason as readOnlyRef below: the title subscription is wired
  // once inside the mount-only effect, and a parent re-render passing a new
  // closure must not tear down and re-attach the whole terminal.
  const onTitleChangeRef = useRef(onTitleChange);
  onTitleChangeRef.current = onTitleChange;
  /** The clipping box. Its content size is what the remote grid must fit in. */
  const boxRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [exited, setExited] = useState(false);
  const [disconnected, setDisconnected] = useState(false);
  // Read via ref inside the attach-lifecycle effect below so a readOnly
  // flip (allowInput probe resolving after mount) doesn't tear down and
  // re-subscribe the whole attach — only paneWrite needs the live value.
  const readOnlyRef = useRef(readOnly);
  /**
   * What the remote app has asked for in the way of key encodings, folded from
   * its own output. A ref, not state: the key handler reads it synchronously
   * and nothing renders from it.
   */
  const remoteKeyboardRef = useRef(INITIAL_REMOTE_KEYBOARD_STATE);
  readOnlyRef.current = readOnly;
  // Same reason: the key handler is installed once, at mount, and needs the
  // CURRENT attach to write to. Listing `attachId` in that effect's deps would
  // re-create the terminal on every reconnect and drop the mirrored scrollback.
  const attachIdRef = useRef(attachId);
  attachIdRef.current = attachId;

  /**
   * How many snapshot repaints are currently being fed to the parser. Second
   * line of defence behind {@link isDeviceReply}: a reply shape that list does
   * not know about still cannot escape during a replay, which is where a
   * snapshot's worth of queries arrives at once.
   *
   * A COUNT, not a flag. xterm parses a large write in ~12 ms slices, so a
   * second repaint can start while the first is still being consumed — and with
   * a boolean the first callback would open the gate while the second snapshot
   * was still parsing.
   *
   * A repaint cannot distinguish a reply from a keystroke the user raced into
   * the same window, so the gate suppresses `paneWrite` outright. Repaint
   * windows are milliseconds; losing a keystroke to one is far cheaper than
   * injecting query answers into a live remote shell.
   */
  const repaintDepthRef = useRef(0);

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
  const terminalCursorStyle = useStore((s) => s.terminalCursorStyle);
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
  const terminalCursorStyleRef = useRef(terminalCursorStyle);
  terminalCursorStyleRef.current = terminalCursorStyle;
  const xtermThemeRef = useRef(xtermTheme);
  xtermThemeRef.current = xtermTheme;
  const minimumContrastRatioRef = useRef(minimumContrastRatio);
  minimumContrastRatioRef.current = minimumContrastRatio;

  /**
   * Fit bookkeeping, per box size.
   *
   * `boxKey` is every input the answer depends on. When it changes the fit
   * starts over — that is how a mirror that shrank for a narrow window grows
   * back when the window widens. While it is unchanged, `settled` forbids
   * growing (see mirrorFit.ts: the cell-metric staircase oscillates without
   * that rule) and `passes` caps the measure→apply loop.
   */
  const fitStateRef = useRef({ boxKey: '', settled: undefined as number | undefined, passes: 0 });
  const fitFrameRef = useRef<number | null>(null);
  const fitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** When the pending timer is due. A later request never postpones it. */
  const fitDueAtRef = useRef(0);
  /** The user's terminal font size is the fit's UPPER BOUND, not its output —
   *  read through a ref so the fit callback can stay identity-stable. */
  const maxFontSizeRef = useRef(terminalFontSize);
  maxFontSizeRef.current = terminalFontSize;

  /**
   * One measure→decide→apply pass, run from an animation frame so it lands
   * after layout rather than in the middle of an observer callback. It is NOT
   * a read/write batcher: each mirror still reads its own box and then writes
   * its own font. The debounce below is what keeps that cost off the drag path.
   */
  const runFit = useCallback(() => {
    const term = termRef.current;
    const box = boxRef.current;
    if (!term || !box) return;
    // `.xterm-screen` is the only element carrying the grid's natural size —
    // xterm gives it explicit px dimensions, while `.xterm` is a block and
    // simply takes the container's width. offsetWidth/Height are LAYOUT values,
    // so unlike getBoundingClientRect they cannot feed back into themselves.
    const screen = term.element?.querySelector('.xterm-screen') as HTMLElement | null;
    if (!screen) return;

    const boxWidth = box.clientWidth;
    const boxHeight = box.clientHeight;
    const state = fitStateRef.current;
    const boxKey = mirrorFitKey({
      boxWidth,
      boxHeight,
      cols: term.cols,
      rows: term.rows,
      maxFontSize: maxFontSizeRef.current,
      fontFamily: terminalFontFamilyRef.current,
    });
    if (boxKey !== state.boxKey) {
      state.boxKey = boxKey;
      state.settled = undefined;
      state.passes = 0;
    } else if (state.passes >= MAX_FIT_PASSES) {
      return;
    }
    state.passes += 1;

    const currentFontSize = term.options.fontSize ?? maxFontSizeRef.current;
    const { fontSize } = computeMirrorFontSize({
      boxWidth,
      boxHeight,
      cols: term.cols,
      rows: term.rows,
      renderedWidth: screen.offsetWidth,
      renderedHeight: screen.offsetHeight,
      currentFontSize,
      maxFontSize: maxFontSizeRef.current,
      settledFontSize: state.settled,
    });
    if (fontSize === null) return;
    // Answer accepted even when it changes nothing: recording it is what arms
    // the shrink-only guard for the next pass. Without this the "already the
    // right size" pass leaves the guard unset, and the staircase is free to
    // walk back up on the pass after it.
    if (fontSize === currentFontSize) {
      state.settled = fontSize;
      return;
    }

    state.settled = fontSize;
    term.options.fontSize = fontSize;
    // xterm re-measures the character on the next render, so the number this
    // pass predicted is only confirmed by the NEXT measurement. Schedule it.
    scheduleFit();
  }, []);

  /**
   * Coalesce to one pass per frame. `delayMs` debounces the continuous case (a
   * divider drag) so the font — and with it xterm's char measurement and width
   * cache — is not restyled on every frame of the drag.
   *
   * A pending request is never pushed BACK: a discrete event asking for an
   * immediate fit (a remote resize, a settings change) would otherwise be
   * delayed to the tail of whatever stream of observer callbacks happens to be
   * running, leaving the cropped frame on screen for the whole of it.
   */
  const scheduleFit = useCallback((delayMs = 0) => {
    const dueAt = Date.now() + delayMs;
    if (fitTimerRef.current !== null) {
      if (dueAt >= fitDueAtRef.current) return; // already scheduled at least this soon
      clearTimeout(fitTimerRef.current);
    }
    // A frame already queued by an earlier request would fire outside this
    // debounce window and run an extra pass.
    if (fitFrameRef.current !== null) {
      cancelAnimationFrame(fitFrameRef.current);
      fitFrameRef.current = null;
    }
    fitDueAtRef.current = dueAt;
    fitTimerRef.current = setTimeout(() => {
      fitTimerRef.current = null;
      fitFrameRef.current = requestAnimationFrame(() => {
        fitFrameRef.current = null;
        runFit();
      });
    }, delayMs);
  }, [runFit]);

  // Re-fit when the box changes size. A mirror in a non-active workspace lives
  // inside `display:none` (WorkspaceCenter's hidden-but-alive rule), where every
  // measurement is 0 and computeMirrorFontSize declines to decide — this
  // observer's 0 → real transition when the workspace is selected is what makes
  // the deferred fit happen.
  useEffect(() => {
    const box = boxRef.current;
    if (!box || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => scheduleFit(FIT_DEBOUNCE_MS));
    ro.observe(box);
    return () => ro.disconnect();
  }, [scheduleFit]);

  // Cancel in-flight fit work on unmount — a timer or frame firing against a
  // disposed terminal would throw inside a callback with no boundary above it.
  useEffect(() => () => {
    if (fitTimerRef.current !== null) clearTimeout(fitTimerRef.current);
    if (fitFrameRef.current !== null) cancelAnimationFrame(fitFrameRef.current);
  }, []);

  // Reached through a ref by the attach lifecycle below. That effect is keyed
  // on `attachId` alone on purpose — listing a callback in its deps means the
  // day that callback stops being identity-stable, every render tears down the
  // SSE stream and re-attaches it. Same discipline as `readOnlyRef`.
  const scheduleFitRef = useRef(scheduleFit);
  scheduleFitRef.current = scheduleFit;

  // Mount the xterm instance once, for the lifetime of this component.
  //
  // Settings are passed at construction AND kept in sync by the effect below,
  // rather than listed in this effect's deps: re-creating the terminal on a
  // font change would drop the mirrored scrollback, and the remote only
  // repaints on a fresh attach.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const term = new Terminal({
      convertEol: false,
      scrollback: 2000,
      disableStdin: false,
      fontSize: terminalFontSizeRef.current,
      fontFamily: terminalFontFamilyCss(terminalFontFamilyRef.current),
      cursorBlink: true,
      cursorStyle: terminalCursorStyleRef.current,
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
    term.open(container);

    // ---- Local editing conveniences (#895) --------------------------------
    //
    // Everything below acts on the LOCAL selection and the LOCAL clipboard, so
    // none of it is the remote app's business — which is why a mirror can have
    // it without becoming a second owner of anything. See mirrorInput.ts for
    // the chord table and for what is deliberately still forwarded raw.

    const isMac = window.electronAPI?.platform === 'darwin';

    /** Bytes straight to the remote pane, bypassing xterm's encoder.
     *  Read-only hosts are checked here as well as in the decision table: this
     *  is the only function that can reach `paneWrite`, so the gate belongs on
     *  it rather than only on its callers. */
    const writeToRemote = (data: string): void => {
      const id = attachIdRef.current;
      if (!id || readOnlyRef.current) return;
      window.electronAPI?.remote?.paneWrite(id, data);
    };

    // macOS only, and for the same reason useTerminal.ts registers it (see the
    // long note there): ⌘V arrives as an NSMenu key equivalent that
    // `preventDefault()` cannot suppress, so xterm's own native paste listener
    // would race the async clipboard read below and both would write. The
    // window keeps menu-bar Edit>Paste and synthetic paste events — which never
    // run the keydown handler — working through xterm's own pipeline.
    let lastPasteKeydownAt = 0;
    const NATIVE_PASTE_RACE_WINDOW_MS = 300;
    const blockNativePaste = (ev: Event): void => {
      if (Date.now() - lastPasteKeydownAt > NATIVE_PASTE_RACE_WINDOW_MS) return;
      ev.preventDefault();
      ev.stopPropagation();
    };
    if (isMac) container.addEventListener('paste', blockNativePaste, true);

    // Auto-copy on selection, debounced exactly like a local pane's. Silent on
    // failure: the explicit Ctrl+C path surfaces its own error when retried.
    const autoCopy = createAutoSelectionCopy({
      write: (text) => window.clipboardAPI.writeText(text),
    });
    const selectionDisposable = term.onSelectionChange(() => {
      autoCopy.onSelection(term.getSelection());
    });

    // #1086/#1091 — xterm's own parser already extracts the OSC 0/2 payload
    // (icon title / window title); sanitize it exactly like PTYBridge does
    // for a local pane before handing it to the surface-title callback.
    const titleDisposable = term.onTitleChange((raw) => {
      const title = sanitizeTitle(raw);
      if (title) onTitleChangeRef.current?.(title);
    });

    term.attachCustomKeyEventHandler((ev) => {
      const decision = decideMirrorKeyWithRepeat(ev, {
        isMac,
        hasSelection: term.hasSelection(),
        readOnly: readOnlyRef.current === true,
        remoteAcceptsCsiU: acceptsCsiU(remoteKeyboardRef.current),
        hasCustomCtrlJBinding: useStore.getState().customKeybindings.some(
          (kb) => kb.key === 'Ctrl+J',
        ),
      });
      switch (decision.kind) {
        case 'pass':
          return true;
        case 'copy':
          // preventDefault like every other acting branch: returning false only
          // stops xterm, and the browser's own copy would still fire off any
          // DOM selection, racing this write for the clipboard.
          ev.preventDefault();
          void copySelectionWithFeedback(term, term.getSelection());
          return false;
        case 'write':
          ev.preventDefault();
          writeToRemote(decision.data);
          return false;
        case 'paste':
          ev.preventDefault();
          if (isMac) lastPasteKeydownAt = Date.now();
          void (async () => {
            const text = await window.clipboardAPI.readText();
            if (!text) return;
            // Text only. A local pane also pastes an image by writing the temp
            // file's PATH, and that path names a file on THIS machine — on the
            // other end of an attach it resolves to nothing, so the mirror
            // stays quiet rather than typing a broken path into a live shell.
            //
            // `modes` is the mirror's own parse of the remote app's DECSET
            // 2004, so bracketed paste is bracketed for the app that asked.
            const modes = (term as unknown as { modes?: { bracketedPasteMode?: boolean } }).modes;
            await pastePtyChunked((d) => writeToRemote(d), text, modes);
          })().catch(() => { /* clipboard unavailable — nothing to recover */ });
          return false;
        case 'swallow':
        default:
          ev.preventDefault();
          return false;
      }
    });

    // Painted on the BOX, not on the container xterm opened into. Once the fit
    // shrinks the grid below its cell, the container no longer covers the cell
    // and the letterbox margin would show `--bg-base` next to the terminal's
    // own background — two backgrounds in one pane.
    if (boxRef.current) boxRef.current.style.backgroundColor = xtermThemeRef.current.background ?? '';
    // Through the ref, so this effect can stay `[]`-keyed: re-running it would
    // dispose the terminal and drop everything the remote has already sent.
    scheduleFitRef.current();
    return () => {
      if (isMac) container.removeEventListener('paste', blockNativePaste, true);
      selectionDisposable.dispose();
      titleDisposable.dispose();
      // Cancels a debounced write that would otherwise fire against a disposed
      // terminal's last selection.
      autoCopy.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, []);

  // Apply visual settings at runtime without recreating the terminal, so
  // tweaking the font does not wipe what the remote has already sent. Mirrors
  // the local pane's own settings effect.
  //
  // `fontSize` is deliberately NOT assigned here. It has exactly one writer,
  // `runFit` — the user's setting reaches the terminal as the fit's upper
  // bound (`maxFontSizeRef`), not as a direct assignment. Two writers on one
  // field is how the fit would be undone: this effect re-runs on any settings
  // change and would put the full-size font back, re-overflowing the box.
  // Changing the setting still takes effect immediately, via the re-fit below.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = terminalFontFamilyCss(terminalFontFamily);
    term.options.cursorStyle = terminalCursorStyle;
    term.options.theme = xtermTheme;
    term.options.minimumContrastRatio = minimumContrastRatio;
    if (boxRef.current) {
      boxRef.current.style.backgroundColor = xtermTheme.background ?? '';
    }
    // The font FAMILY changes cell metrics too, so this covers both inputs.
    scheduleFit();
  }, [terminalFontSize, terminalFontFamily, terminalCursorStyle, xtermTheme, minimumContrastRatio, scheduleFit]);

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
      repaintDepthRef.current += 1;
      try {
        const snapshot = decodeBase64Bytes(e.snapshotB64);
        // A re-attach replays the pane's screen, negotiation included — reset
        // first so a protocol the app turned off before we attached does not
        // survive as a stale `true`.
        remoteKeyboardRef.current = foldRemoteKeyboardState(INITIAL_REMOTE_KEYBOARD_STATE, snapshot);
        term.write(snapshot, () => {
          repaintDepthRef.current = Math.max(0, repaintDepthRef.current - 1);
        });
      } catch {
        // `write` can throw before it ever queues the callback (xterm's
        // WriteBuffer refuses past DISCARD_WATERMARK). Not decrementing here
        // would latch the gate for the rest of the pane's life and silently
        // swallow every keystroke — a far worse outcome than a lost repaint,
        // which the next attach or reconnect replaces anyway.
        repaintDepthRef.current = Math.max(0, repaintDepthRef.current - 1);
      }
      // New grid, new natural size. No debounce — a meta is a discrete event,
      // and waiting would leave the pre-fit (cropped) frame on screen.
      scheduleFitRef.current();
    });
    // A resize on the machine that owns the pane. Geometry only: no reset and
    // no repaint, so the mirrored scrollback and the user's scroll position
    // survive someone dragging a divider on the other machine. The remote app
    // repaints itself on SIGWINCH; those bytes arrive through onPaneData.
    const offResize = remote.onPaneResize((e) => {
      if (e.attachId !== attachId) return;
      termRef.current?.resize(e.cols, e.rows);
      scheduleFitRef.current();
    });
    const offData = remote.onPaneData((e) => {
      if (e.attachId !== attachId) return;
      const term = termRef.current;
      if (!term) return;
      const data = decodeBase64Bytes(e.dataB64);
      // Watch the remote's own output for a keyboard-protocol negotiation, the
      // same way the paste path reads xterm's parse of DECSET 2004. xterm
      // exposes nothing for this one, and without it the mirror cannot tell an
      // app that wants CSI-u from one that would read it as Escape + garbage.
      remoteKeyboardRef.current = foldRemoteKeyboardState(remoteKeyboardRef.current, data);
      term.write(data);
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
      // A query answer xterm produced on its own, from a replayed snapshot OR
      // from live output — the remote app sends `ESC[6n` mid-session too, and
      // gating only the repaint left that path answering. See isDeviceReply.
      if (isDeviceReply(data)) return;
      if (repaintDepthRef.current > 0) return;
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
    // `overflow-hidden` is the last line of defence, NOT the fit. Geometry has a
    // single owner, the remote daemon, so a remote pane with more rows than this
    // cell can show renders an element taller than its box; with nothing
    // clipping it, the overflow painted over the composer and the sidebar.
    //
    // Clipping alone was still wrong — it turned the overflow into a top-left
    // crop, and a TUI keeps its input box on the last rows, so the crop removed
    // exactly the prompt the user was typing into. `runFit` shrinks the font
    // until the grid fits; what remains here absorbs the sub-cell residue and
    // the single frame between a remote resize and the fit that answers it.
    <div ref={boxRef} className="relative w-full h-full min-h-0 min-w-0 overflow-hidden">
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
          style={{ color: 'var(--text-muted)', background: 'var(--bg-overlay-scrim, rgba(0, 0, 0, 0.55))' }}
        >
          {t('remote.exited')}
        </div>
      )}
      {disconnected && (
        <div
          className="absolute bottom-0 left-0 right-0 px-2 py-1 text-[10px] font-mono"
          style={{ color: 'var(--accent-red)', background: 'var(--bg-overlay-scrim, rgba(0, 0, 0, 0.55))' }}
        >
          {t('remote.disconnected')}
        </div>
      )}
    </div>
  );
}
