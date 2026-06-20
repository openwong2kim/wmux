/**
 * Deterministic newline-key encoding for the terminal input path.
 *
 * Why this exists:
 *   xterm.js derives the bytes for Ctrl+<letter> from the *deprecated*
 *   `KeyboardEvent.keyCode` (it looks for keyCode 65-90 and emits
 *   `String.fromCharCode(keyCode - 64)`). Under a CJK IME (Microsoft Pinyin,
 *   Japanese, Korean, …) a keydown frequently reports `keyCode === 229`
 *   ("Process") and `key !== 'j'`, so xterm's branch never matches and
 *   Ctrl+J is silently dropped — no LF reaches the PTY. The user-visible
 *   symptom is "Ctrl+J newline sometimes fails" inside in-pane TUIs
 *   (codex, Claude Code): it works with the IME off and breaks with it on.
 *
 *   The rest of wmux already side-steps this by matching the *physical*
 *   `event.code` (see the split-shortcut allowlists in `useTerminal` and
 *   `useKeyboard`, added for Hangul/non-Latin layouts). This module applies
 *   the same approach to the newline keys so the encoding is deterministic
 *   regardless of IME state.
 *
 * Returned byte:
 *   - Shift+Enter → CSI u (`ESC [ 13 ; 2 u`): Claude Code / kitty-protocol
 *     apps insert a newline instead of submitting. (Pre-existing behavior,
 *     moved here verbatim.)
 *   - Ctrl+Enter → LF (`\n`): same intent as Ctrl+J. With no extended keyboard
 *     protocol enabled, xterm sends a bare CR for Ctrl+Enter — byte-identical
 *     to plain Enter — so an in-pane TUI submits instead of inserting a
 *     newline. Many users reach for Ctrl+Enter expecting a newline; we emit LF
 *     so it behaves like Ctrl+J / Shift+Enter.
 *   - Ctrl+J → LF (`\n`, U+000A): the canonical "insert newline, do not
 *     submit" byte that codex / Claude Code / readline editors expect. This
 *     is exactly what xterm would emit in its legacy path — we just emit it
 *     ourselves so an IME can't suppress it.
 *
 * Returns `null` when the event is not a deterministic newline key (or when a
 * guard declines to take it over), in which case the caller defers to xterm's
 * normal handling.
 */
export interface NewlineKeyEventLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  /** True between compositionstart and compositionend (IME preedit active). */
  isComposing: boolean;
}

export interface NewlineKeyOptions {
  /**
   * Whether the user has bound Ctrl+J to a custom keybinding. When true we
   * decline to take Ctrl+J over so an explicit user binding is never shadowed
   * by the implicit newline. (Under a CJK IME `useKeyboard` can't match that
   * binding either — `key` is mangled to 'Process' — so it stays broken there,
   * but we must not actively override it with an LF.)
   */
  hasCustomCtrlJBinding?: boolean;
}

export function resolveNewlineKeyByte(
  e: NewlineKeyEventLike,
  opts?: NewlineKeyOptions,
): string | null {
  // Shift+Enter → CSI u so Claude Code inserts a newline instead of submitting.
  // Kitty keyboard protocol: ESC [ 13 ; 2 u. (metaKey intentionally not
  // constrained — preserves the original inline handler's exact predicate.)
  if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey) {
    return '\x1b[13;2u';
  }

  // Ctrl+Enter → LF, same intent as Ctrl+J: insert a newline without
  // submitting. xterm has no extended keyboard protocol enabled, so it sends a
  // bare CR (\r) for Ctrl+Enter — indistinguishable from plain Enter — and an
  // in-pane TUI (Claude Code, codex) submits instead of adding a line. Emitting
  // LF ourselves gives the editor the "newline, don't submit" byte it expects.
  // Keyed on `key === 'Enter'` to mirror the Shift+Enter predicate above
  // (NumpadEnter also reports key 'Enter'). The other modifiers are excluded so
  // only the pure Ctrl+Enter chord matches, and `!isComposing` defers to an
  // active IME preedit exactly like the Ctrl+J path below.
  if (
    e.key === 'Enter' &&
    e.ctrlKey &&
    !e.shiftKey &&
    !e.altKey &&
    !e.metaKey &&
    !e.isComposing
  ) {
    return '\n';
  }

  // Ctrl+J → LF. Match the physical key so it survives a CJK IME where
  // `key`/`keyCode` are mangled to the IME "Process" value and xterm's
  // keyCode-based Ctrl+<letter> path would otherwise drop the keystroke.
  //
  // Two guards keep the override from firing when it shouldn't:
  //   • !isComposing — never inject an LF into the middle of an active IME
  //     preedit; let xterm finalize the composition first. The reported bug
  //     is Ctrl+J while the IME is idle (no preedit), where isComposing is
  //     false, so the fix still applies there.
  //   • !hasCustomCtrlJBinding — an explicit user binding for Ctrl+J wins.
  //
  // NOTE: keyed on the *physical* KeyJ, matching every other wmux shortcut
  // (split = KeyD, …). On Dvorak/Colemak the key that prints "j" may sit
  // elsewhere; physical KeyJ is the deliberate, consistent choice.
  if (
    !e.isComposing &&
    !opts?.hasCustomCtrlJBinding &&
    e.code === 'KeyJ' &&
    e.ctrlKey &&
    !e.shiftKey &&
    !e.altKey &&
    !e.metaKey
  ) {
    return '\n';
  }

  return null;
}
