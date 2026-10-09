/**
 * Kitty keyboard protocol for local panes (xterm.js 6.1 `vtExtensions.kittyKeyboard`).
 *
 * With the extension on, xterm answers `CSI ? u`, so an app that checks for the
 * protocol (Claude Code) pushes its flags, and xterm then encodes keys itself.
 * wmux used to hand-encode Shift+Enter, Escape and Ctrl+letters because xterm
 * could not. Once a pane has pushed flags those keys go back to xterm, so
 * press, repeat and release all come from the encoder the app negotiated with.
 * A pane that never pushed keeps wmux's own encoding exactly as before.
 */

/** What decides whether this terminal turns the extension on. */
export interface KittyHost {
  /** The machine running the renderer (`window.electronAPI.platform`). */
  platform: string;
  /** Present only in the browser build, which is a second viewer of a pane. */
  hostPlatform?: unknown;
}

/**
 * Only the desktop window, and not on Windows.
 *
 * - The browser build is a second viewer of the same PTY. If it answered too,
 *   the app would get two replies to one query; the desktop is the answerer.
 * - Windows panes run behind ConPTY, which owns the console input encoding,
 *   and the kitty push / query has not been verified through it. Windows
 *   keeps today's behaviour until it has been.
 */
export function kittyKeyboardForHost(host: KittyHost): boolean {
  if (typeof host.hostPlatform === 'function') return false;
  return host.platform !== 'win32';
}

/** Private xterm 6.1 state wmux reads and resets (common/Types.ts
 *  IKittyKeyboardState): the active flags, the flags parked for the other
 *  screen, and one push stack per screen. */
interface XtermKittyState {
  flags: number;
  mainFlags: number;
  altFlags: number;
  mainStack: number[];
  altStack: number[];
}

interface XtermKittyInternals {
  _core?: { coreService?: { kittyKeyboard?: Partial<XtermKittyState> } };
}

function kittyState(term: object): XtermKittyState | undefined {
  const s = (term as XtermKittyInternals)._core?.coreService?.kittyKeyboard;
  if (!s || typeof s.flags !== 'number' || typeof s.mainFlags !== 'number' || typeof s.altFlags !== 'number'
    || !Array.isArray(s.mainStack) || !Array.isArray(s.altStack)) return undefined;
  return s as XtermKittyState;
}

/**
 * The kitty flags xterm is encoding with, or undefined if the internals moved.
 *
 * Read from xterm rather than from wmux's own fold of the pane output because
 * the two differ after a reattach: the fold skips replayed bytes (#1363), but
 * xterm parses them, so a pane whose app pushed flags before a reload has
 * them in xterm and not in the fold. What matters for every decision here is
 * what xterm's encoder will do. There is no public getter; the shape is
 * locked by kittyKeyboard.test.ts against the installed xterm.
 */
export function xtermKittyFlags(term: object): number | undefined {
  return kittyState(term)?.flags;
}

/** Pops every pushed flag set on the current screen (flags end at 0). The
 *  fallback reset when xterm's state cannot be reached directly. */
export const KITTY_FLAGS_RESET = '\x1b[<99u';

interface ResettableTerminal {
  write(data: string): void;
}

/**
 * Forget every kitty flag xterm holds, on both screens, right now.
 *
 * Synchronous on purpose: called from inside the parser (a prompt mark), a
 * reset written with `write()` would queue behind the rest of the chunk and
 * wipe a push that came after the mark (a replay that runs on into a live
 * app, a shell that pushes its own flags after drawing the prompt). Both
 * screens, because xterm parks the alt screen's flags and stack separately
 * and would bring a dead app's flags back on the next alt-screen entry. When
 * the internals cannot be reached, falls back to popping the current
 * screen's stack through the parser.
 */
export function resetXtermKitty(term: ResettableTerminal): void {
  const s = kittyState(term);
  if (!s) {
    term.write(KITTY_FLAGS_RESET);
    return;
  }
  s.flags = 0;
  s.mainFlags = 0;
  s.altFlags = 0;
  s.mainStack.length = 0;
  s.altStack.length = 0;
}

interface PromptHookTerminal extends ResettableTerminal {
  parser: { registerOscHandler(ident: number, callback: (data: string) => boolean): { dispose(): void } };
}

const promptResetInstalled = new WeakSet<object>();

/**
 * Drop the kitty flags at every shell prompt (OSC 133;A), in stream order.
 *
 * wmux's own record of the negotiation (foldRemoteKeyboardState) already
 * resets on that mark: the shell owns the pane again, so whatever the last
 * app pushed is stale. xterm keeps the flags of an app that died without
 * popping them, and would go on encoding the shell's keys as CSI u. This puts
 * xterm back in step with the record. Once per terminal; the handler lives as
 * long as the terminal (an adopted terminal keeps it).
 */
export function installKittyPromptReset(term: PromptHookTerminal): void {
  if (promptResetInstalled.has(term)) return;
  promptResetInstalled.add(term);
  term.parser.registerOscHandler(133, (data) => {
    if (data === 'A' || data.startsWith('A;')) resetXtermKitty(term);
    return false;
  });
}

export interface KittyKeyEventLike {
  type: string;
  key: string;
  keyCode: number;
  isComposing: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** The IME owns this event: a preedit is open, or Chromium reports the IME's
 *  placeholder keyCode 229. */
function imeOwns(e: KittyKeyEventLike): boolean {
  return e.isComposing || e.keyCode === 229;
}

/**
 * Whether a key wmux would otherwise encode itself should be left to xterm's
 * kitty encoder.
 *
 * Only on a pane that pushed flags, and only for a key xterm can name: an
 * event the IME owns, or one whose `key` is not ASCII (a jamo under a Korean
 * layout), keeps wmux's IME-safe path, which resolves the key from its
 * physical `code`. xterm's encoder would have nothing sensible to send for
 * those.
 */
export function xtermEncodesKey(e: KittyKeyEventLike, negotiated: boolean): boolean {
  if (!negotiated || imeOwns(e)) return false;
  if (e.key.length === 1) return e.key.charCodeAt(0) < 0x80;
  return /^[A-Z][A-Za-z]+$/.test(e.key);
}

/**
 * Whether xterm must not see this key event at all on a pane that pushed
 * flags (xtermjs/xterm.js#6112).
 *
 * Inside an IME composition Chromium still delivers the keys the IME uses
 * (the space or digit that picks a candidate) as keydowns marked
 * `isComposing`, and suppresses their keypress. xterm's legacy path relied on
 * that suppression and stayed silent; its kitty encoder reports every keydown,
 * so the candidate key reached the app next to the committed text. The commit
 * itself still arrives through compositionend. The release of a key pressed
 * inside the composition is dropped for the same reason (flag 2 reports
 * releases); only `isComposing`, so xterm still sees every other keyup.
 *
 * This mirrors the upstream fix proposed in xtermjs/xterm.js#6186 and can go
 * once xterm ships it.
 */
export function imeKeyLeaksUnderKitty(e: KittyKeyEventLike, negotiated: boolean): boolean {
  if (!negotiated) return false;
  if (e.type === 'keyup') return e.isComposing;
  if (e.type !== 'keydown') return false;
  return e.isComposing && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey;
}

/**
 * The kitty form of a Ctrl+letter wmux resolved itself (from the physical key,
 * because an IME left `key` as a jamo or 'Process'): `CSI <codepoint> ; 5 u`,
 * e.g. Ctrl+C becomes `CSI 99;5u`, which is what xterm's encoder would have
 * sent for the same key. Anything that is not a C0 letter byte is unchanged.
 */
export function kittyCtrlLetter(byte: string): string {
  const code = byte.length === 1 ? byte.charCodeAt(0) : 0;
  if (code < 1 || code > 26) return byte;
  return `\x1b[${code + 96};5u`;
}

/**
 * Releases xterm must not report because xterm never reported the press.
 *
 * With flag 2 (Codex pushes 7) xterm sends a release for every keyup it sees.
 * A keydown that never reached xterm's encoder still has its keyup go to
 * xterm, and the app gets a release with no press: a key wmux encoded or
 * swallowed itself, a shortcut or prefix key the window-level handler took
 * before xterm saw it, an IME key (the candidate key's keyup even arrives
 * after compositionend, so `isComposing` no longer marks it). So the filter
 * pairs from the other side: it remembers the physical key of every keydown
 * xterm's encoder did see, and on a negotiated pane lets a keyup through only
 * for one of those. Cleared when the terminal loses focus.
 */
export class UnpairedReleaseFilter {
  private readonly pressed = new Set<string>();

  /** A keydown and whether it went on to xterm's encoder. */
  noteKeydown(e: { code: string; keyCode: number; isComposing: boolean }, reachedXterm: boolean): void {
    if (reachedXterm && e.code && e.keyCode !== 229 && !e.isComposing) this.pressed.add(e.code);
  }

  /** Whether xterm must not see this keyup; forgets its keydown either way. */
  swallowsKeyup(e: { code: string }, negotiated: boolean): boolean {
    if (!e.code) return false;
    const paired = this.pressed.delete(e.code);
    return negotiated && !paired;
  }

  clear(): void {
    this.pressed.clear();
  }
}
