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
}

export interface MirrorKeyOptions {
  isMac: boolean;
  /** Whether the mirror currently holds a non-empty selection. */
  hasSelection: boolean;
  /** The remote host was started without `--allow-input`. */
  readOnly: boolean;
  /** The user bound Ctrl+J themselves — see newlineKeys.ts. */
  hasCustomCtrlJBinding?: boolean;
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
    return opts.readOnly ? { kind: 'swallow' } : { kind: 'write', data: newlineByte };
  }

  const { isMac } = opts;
  const bareMeta = e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey;
  const bareCtrl = e.ctrlKey && !e.shiftKey;

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
  if (e.ctrlKey && e.shiftKey && isLetter(e, 'c', 'KeyC')) {
    return opts.hasSelection ? { kind: 'copy' } : { kind: 'swallow' };
  }
  if (e.ctrlKey && e.shiftKey && isLetter(e, 'v', 'KeyV')) {
    return opts.readOnly ? { kind: 'swallow' } : { kind: 'paste' };
  }

  return { kind: 'pass' };
}
