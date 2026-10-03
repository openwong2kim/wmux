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
 *   - Shift+Enter → protocol-aware (see encodeShiftEnter): kitty CSI-u,
 *     win32-input-mode (`?9001h`, Codex on Windows — #1152), modifyOtherKeys,
 *     or LF when the local pane never negotiated. CSI-u without a kitty push
 *     is Escape + `[13;2u` to Claude Code inside wmux (TERM_PROGRAM=wmux is
 *     not on Claude's kitty whitelist), which is why Shift+Enter submitted
 *     after #1228 (#1152 follow-up). LF is the same byte Ctrl+J already sends.
 *   - Codex on a Windows host → the win32 Shift+Enter record for all three
 *     keys (see `win32RecordNewline`, #1694).
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

/**
 * What the pane's app asked the terminal to send for modified keys.
 *
 * Folded from the pane's own output (keyboardProtocol.ts). Unknown fields
 * are treated as "not negotiated."
 */
export interface KeyboardProtocolHint {
  kitty?: boolean;
  win32Input?: boolean;
  modifyOtherKeys?: 0 | 1 | 2;
}

/**
 * When no keyboard protocol is negotiated:
 *   - `'lf'` — local pane. Send the same newline byte as Ctrl+J. Claude Code
 *     inside wmux never pushes kitty (`TERM_PROGRAM=wmux` is not on its
 *     whitelist) and does not treat unsolicited CSI-u as newline.
 *   - `'csi-u'` — opt into the historical kitty byte even without a push.
 *   - `'xterm'` — mirror / web viewer. Return null so xterm encodes the
 *     legacy CR. CSI-u without a push is Escape + garbage on the far side.
 */
export type ShiftEnterFallback = 'lf' | 'csi-u' | 'xterm';

export interface NewlineKeyOptions {
  /**
   * Whether the user has bound Ctrl+J to a custom keybinding. When true we
   * decline to take Ctrl+J over so an explicit user binding is never shadowed
   * by the implicit newline. (Under a CJK IME `useKeyboard` can't match that
   * binding either — `key` is mangled to 'Process' — so it stays broken there,
   * but we must not actively override it with an LF.)
   */
  hasCustomCtrlJBinding?: boolean;
  /** Observed keyboard-protocol negotiation. Absent = nothing observed. */
  protocol?: KeyboardProtocolHint;
  /**
   * What to send for Shift+Enter when `protocol` names no encoding.
   * Defaults to `'lf'` (local pane). Remote/web pass `'xterm'`.
   */
  shiftEnterFallback?: ShiftEnterFallback;
  /**
   * The pane runs Codex on a Windows host (#1694). Shift+Enter, Ctrl+Enter
   * and Ctrl+J all send the win32 Shift+Enter record instead of LF.
   *
   * The protocol flag cannot say this on Windows: every ConPTY session emits
   * `?9001h` itself, so the fold ignores it there (#1363) and `win32Input`
   * never arms. Codex reads key records through the console API, and ConPTY
   * turns a bare LF into Ctrl+Enter, which Codex does not take as a newline.
   * The record keeps VK_RETURN + SHIFT, which it does. Claude Code panes and
   * plain shells never set this, so they keep LF.
   */
  win32RecordNewline?: boolean;
}

/** Kitty CSI-u Shift+Enter. Only meaningful after the pane pushed kitty. */
export const SHIFT_ENTER_CSI_U = '\x1b[13;2u';

/** Bare LF. Claude Code / readline "insert newline, do not submit" (Ctrl+J). */
export const SHIFT_ENTER_LF = '\n';

/**
 * win32-input-mode Shift+Enter (`CSI Vk;Sc;Uc;Kd;Cs;Rc _`).
 *
 * VK_RETURN=13, scan 0x1C=28, Unicode LF=10, key-down, SHIFT_PRESSED=0x10,
 * repeat 1 — then the matching key-up (Unicode 0, key-down 0). Codex on
 * Windows negotiates `?9001h` and does not understand CSI-u (#1152).
 *
 * The Unicode field carries LF, not CR: ConPTY hands the client the record's
 * character and the SHIFT modifier does not survive that trip, so `Uc=13` is
 * read as a plain Enter and the TUI submits. Measured 2026-09-17 against a
 * live Claude Code pane on Windows — `Uc=13` submitted, `Uc=10` inserted a
 * newline, same as the literal `\n` Ctrl+J sends (#1363).
 */
export const SHIFT_ENTER_WIN32 =
  '\x1b[13;28;10;1;16;1_\x1b[13;28;0;0;16;1_';

/** xterm modifyOtherKeys mode 2: CSI 27 ; 2 ; 13 ~ */
export const SHIFT_ENTER_MODIFY_OTHER_KEYS = '\x1b[27;2;13~';

/**
 * Encode Shift+Enter for the protocol the pane actually asked for.
 *
 * Win32-input-mode wins over kitty: Codex on Windows requests `?9001h` and
 * will misread CSI-u as Escape + `[13;2u`. modifyOtherKeys mode 2 is the
 * other non-CSI-u encoding we know how to produce. Everything else follows
 * `fallback`.
 */
export function encodeShiftEnter(
  protocol: KeyboardProtocolHint | undefined,
  fallback: ShiftEnterFallback,
): string | null {
  if (protocol?.win32Input) return SHIFT_ENTER_WIN32;
  if (protocol?.kitty) return SHIFT_ENTER_CSI_U;
  if (protocol?.modifyOtherKeys === 2) return SHIFT_ENTER_MODIFY_OTHER_KEYS;
  if (fallback === 'csi-u') return SHIFT_ENTER_CSI_U;
  if (fallback === 'lf') return SHIFT_ENTER_LF;
  return null;
}

/**
 * Whether a pane gets `win32RecordNewline` (#1694): Codex, hosted on Windows.
 * `hostPlatform` is the pane's host (the daemon's OS in the browser build),
 * `agentSlug` the pane's detected agent — both read per keystroke, since the
 * agent changes as the user starts and exits programs.
 */
export function wantsWin32RecordNewline(
  hostPlatform: string | null | undefined,
  agentSlug: string | undefined,
): boolean {
  return hostPlatform === 'win32' && agentSlug === 'codex';
}

/** Enter / NumpadEnter, including an IME that mangled `key` to 'Process'. */
function isEnterKey(e: NewlineKeyEventLike): boolean {
  return e.key === 'Enter' || e.code === 'Enter' || e.code === 'NumpadEnter';
}

export function resolveNewlineKeyByte(
  e: NewlineKeyEventLike,
  opts?: NewlineKeyOptions,
): string | null {
  // Shift+Enter. Encoding depends on what the pane negotiated (kitty CSI-u,
  // win32-input-mode, modifyOtherKeys). Match physical `code` so a CJK IME
  // that reports `key === 'Process'` still takes this path — otherwise xterm
  // encodes a bare CR and the TUI submits (#1152). metaKey is intentionally
  // not constrained — preserves the original inline handler's exact predicate.
  // `!isComposing` defers to an open IME preedit, same as Ctrl+J / Ctrl+Enter.
  if (
    isEnterKey(e) &&
    e.shiftKey &&
    !e.ctrlKey &&
    !e.altKey &&
    !e.isComposing
  ) {
    if (opts?.win32RecordNewline) return SHIFT_ENTER_WIN32;
    return encodeShiftEnter(opts?.protocol, opts?.shiftEnterFallback ?? 'lf');
  }

  // Ctrl+Enter → LF, same intent as Ctrl+J: insert a newline without
  // submitting. xterm has no extended keyboard protocol enabled, so it sends a
  // bare CR (\r) for Ctrl+Enter — indistinguishable from plain Enter — and an
  // in-pane TUI (Claude Code, codex) submits instead of adding a line. Emitting
  // LF ourselves gives the editor the "newline, don't submit" byte it expects.
  // Keyed on Enter / NumpadEnter (and physical `code` under an IME). The other
  // modifiers are excluded so only the pure Ctrl+Enter chord matches, and
  // `!isComposing` defers to an active IME preedit exactly like Ctrl+J.
  if (
    isEnterKey(e) &&
    e.ctrlKey &&
    !e.shiftKey &&
    !e.altKey &&
    !e.metaKey &&
    !e.isComposing
  ) {
    return opts?.win32RecordNewline ? SHIFT_ENTER_WIN32 : '\n';
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
    return opts?.win32RecordNewline ? SHIFT_ENTER_WIN32 : '\n';
  }

  return null;
}
