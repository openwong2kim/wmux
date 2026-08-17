/**
 * Keyboard decisions for a remote-attach mirror.
 *
 * A mirror forwards keystrokes to a pane on another machine, so its default is
 * the opposite of a local pane's: every key belongs to the remote app, and
 * anything this side keeps is a deliberate exception. #895 is the list of
 * exceptions users noticed were missing — the editing conveniences that are not
 * the remote app's business at all, because the selection and the clipboard
 * they operate on are local.
 *
 * Only those. App shortcuts, terminal zoom, and custom keybindings still reach
 * the remote pane rather than being intercepted here; a mirror has no local
 * pane to act on, so stealing them would trade a working remote key for a
 * local no-op.
 *
 * Pure on purpose. The component owns the clipboard, the socket, and the
 * terminal; this file owns only the branching, so the table can be tested
 * without xterm, Electron, or a DOM — the same split `mirrorFit.ts` and
 * `newlineKeys.ts` already use.
 */

import { resolveNewlineKeyByte, type NewlineKeyEventLike } from '../../terminal/newlineKeys';

export interface MirrorKeyEventLike extends NewlineKeyEventLike {
  /** Only `keydown` decides anything; keyup/keypress always pass. */
  type: string;
  /** True for the auto-repeat keydowns a held key produces. */
  repeat?: boolean;
}

export interface MirrorKeyOptions {
  isMac: boolean;
  /** Whether the mirror currently holds a non-empty selection. */
  hasSelection: boolean;
  /** The remote host was started without `--allow-input`. */
  readOnly: boolean;
  /** The user bound Ctrl+J themselves — see newlineKeys.ts. */
  hasCustomCtrlJBinding?: boolean;
  /**
   * The remote app asked for kitty CSI-u key encodings (observed in its own
   * output — see keyboardProtocol.ts). Defaults to false, which is the
   * conservative side: an app that never negotiated gets what xterm would
   * have encoded.
   */
  remoteAcceptsCsiU?: boolean;
}

export type MirrorKeyDecision =
  /** Let xterm encode it; the bytes leave through `onData` → `paneWrite`. */
  | { kind: 'pass' }
  /** Consumed here. Nothing reaches the remote and nothing is written locally. */
  | { kind: 'swallow' }
  /** Send these exact bytes to the remote, bypassing xterm's encoder. */
  | { kind: 'write'; data: string }
  /** Copy the current selection to the local clipboard. */
  | { kind: 'copy' }
  /** Paste the local clipboard into the remote pane. */
  | { kind: 'paste' };

/**
 * A key chord's meaning matched by BOTH `key` and physical `code`.
 *
 * Under a CJK IME `key` is a composed jamo or the literal 'Process', so a
 * `key`-only test silently stops matching — the exact failure `useTerminal.ts`
 * documents for its own Ctrl+C branch, and the reason every clipboard chord
 * here carries a `code` fallback.
 */
function isLetter(e: MirrorKeyEventLike, lower: string, code: string): boolean {
  return e.key === lower || e.key === lower.toUpperCase() || e.code === code;
}

export function decideMirrorKey(
  e: MirrorKeyEventLike,
  opts: MirrorKeyOptions,
): MirrorKeyDecision {
  if (e.type !== 'keydown') return { kind: 'pass' };

  // Shift+Enter / Ctrl+Enter / Ctrl+J. Same resolver the local pane uses, so a
  // remote Claude Code gets the same newline byte a local one does instead of
  // whatever xterm's legacy keyCode path happens to produce under an IME.
  const newlineByte = resolveNewlineKeyByte(e, {
    hasCustomCtrlJBinding: opts.hasCustomCtrlJBinding,
  });
  if (newlineByte !== null) {
    // A read-only host takes no bytes at all, negotiated or not — decided here
    // rather than left to the write path so the table says so.
    if (opts.readOnly) return { kind: 'swallow' };
    // The CSI-u byte only means "newline" to an app that asked for kitty
    // encodings. A local pane can send it blind because it and the TUI share
    // this xterm; a mirror is talking to an app it never negotiated with, and
    // there `\x1b[13;2u` reads as Escape followed by normal-mode input — in
    // vim's insert mode that leaves insert and runs the rest as commands.
    // Un-negotiated, hand the key back to xterm and let it encode the legacy
    // CR: what the mirror did before it had a key table at all.
    //
    // Ctrl+Enter and Ctrl+J are unaffected — a bare LF needs no negotiation.
    const isCsiU = newlineByte.startsWith('\x1b');
    if (isCsiU && !opts.remoteAcceptsCsiU) return { kind: 'pass' };
    return { kind: 'write', data: newlineByte };
  }

  const { isMac } = opts;
  const bareMeta = e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
  // `!e.altKey` is load-bearing, not symmetry for its own sake. Windows reports
  // AltGr as Ctrl+Alt, so without it the European layouts that map a character
  // onto AltGr+C / AltGr+V (Polish ć, among others) cannot type that character
  // into the remote at all — it would be read as copy/paste. It also keeps
  // emacs' C-M-v (scroll-other-window) from being taken as a paste.
  const bareCtrl = e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey;
  const ctrlShift = e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey;

  // macOS: ⌘C copies and ⌘V pastes, so Ctrl+C stays SIGINT unconditionally and
  // Ctrl+V stays readline's quoted-insert. Both fall through to the remote.
  if (isMac && bareMeta && isLetter(e, 'c', 'KeyC')) {
    // No selection: hand ⌘C back to the OS rather than swallowing it.
    return opts.hasSelection ? { kind: 'copy' } : { kind: 'pass' };
  }
  if (isMac && bareMeta && isLetter(e, 'v', 'KeyV')) {
    return opts.readOnly ? { kind: 'swallow' } : { kind: 'paste' };
  }

  // Windows/Linux: Ctrl+C copies ONLY when there is something to copy. With an
  // empty selection it must still interrupt the remote process — that is the
  // whole point of the key, and #895 asks for the selection case, not for
  // SIGINT to be taken away.
  if (!isMac && bareCtrl && isLetter(e, 'c', 'KeyC')) {
    return opts.hasSelection ? { kind: 'copy' } : { kind: 'pass' };
  }
  if (!isMac && bareCtrl && isLetter(e, 'v', 'KeyV')) {
    return opts.readOnly ? { kind: 'swallow' } : { kind: 'paste' };
  }

  // Ctrl+Shift+C / Ctrl+Shift+V — the explicit forms, on every platform.
  if (ctrlShift && isLetter(e, 'c', 'KeyC')) {
    return opts.hasSelection ? { kind: 'copy' } : { kind: 'swallow' };
  }
  if (ctrlShift && isLetter(e, 'v', 'KeyV')) {
    return opts.readOnly ? { kind: 'swallow' } : { kind: 'paste' };
  }

  return { kind: 'pass' };
}

/**
 * `decideMirrorKey`, with auto-repeat suppressed for the clipboard actions.
 *
 * A held Ctrl+V repeats about every 30ms once the OS starts repeating, and
 * each repeat is a fresh clipboard read written into a LIVE remote shell —
 * the clipboard arriving a dozen times is not what holding a key means.
 *
 * Applied AFTER the decision, not before, so it only touches the branches that
 * act: holding Ctrl+C with no selection still repeats SIGINT, which is a thing
 * people do on purpose, and every pass-through key keeps repeating normally.
 */
export function decideMirrorKeyWithRepeat(
  e: MirrorKeyEventLike,
  opts: MirrorKeyOptions,
): MirrorKeyDecision {
  const decision = decideMirrorKey(e, opts);
  if (e.repeat && (decision.kind === 'copy' || decision.kind === 'paste')) {
    return { kind: 'swallow' };
  }
  return decision;
}
