/**
 * Protocol-aware Escape encoding for the terminal input path.
 *
 * xterm.js emits a bare ESC (`\x1b`) for the Escape key. That is correct
 * until the pane has negotiated an extended keyboard protocol: kitty CSI-u
 * wants `CSI 27 u`, and win32-input-mode (`?9001h`) wants a KEY_EVENT_RECORD
 * pair. Sending the bare byte into a protocol the app asked for leaves the
 * app waiting for the rest of a CSI sequence — Escape then appears to do
 * nothing for the rest of the turn (#1152 follow-up).
 *
 * The local pane writes this byte itself and bypasses xterm, the same way
 * newlineKeys does for Shift+Enter. That also covers the IME keyCode-229
 * drop: xterm's CompositionHelper swallows every 229 keydown, so a CJK IME
 * (or a TSF desync during a streaming TUI) would otherwise eat Escape.
 */
import type { KeyboardProtocolHint } from './newlineKeys';

/** Kitty CSI-u Escape. Functional key 27; modifier 1 is the default and omitted. */
export const ESCAPE_CSI_U = '\x1b[27u';

/**
 * win32-input-mode Escape (`CSI Vk;Sc;Uc;Kd;Cs;Rc _`).
 *
 * VK_ESCAPE=27, scan 0x01=1, Unicode ESC=27, key-down, no modifiers, repeat 1
 * — then the matching key-up (Unicode 0, key-down 0). Codex on Windows
 * negotiates `?9001h` and does not understand a bare ESC while that mode is
 * armed (#1152).
 */
export const ESCAPE_WIN32 =
  '\x1b[27;1;27;1;0;1_\x1b[27;1;0;0;0;1_';

const BARE_ESC = '\x1b';

/**
 * Encode Escape for the protocol the pane actually asked for.
 *
 * Win32-input-mode wins over kitty, matching encodeShiftEnter: Codex on
 * Windows requests `?9001h` and will misread CSI-u. modifyOtherKeys does
 * not re-encode unmodified Escape, so it falls through to the bare byte.
 */
export function encodeEscape(protocol: KeyboardProtocolHint | undefined): string {
  if (protocol?.win32Input) return ESCAPE_WIN32;
  if (protocol?.kitty) return ESCAPE_CSI_U;
  return BARE_ESC;
}

export interface EscapeKeyEventLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
}

/**
 * Whether this keydown is a bare Escape we should encode ourselves.
 *
 * `code` is the IME-safe match (key becomes 'Process' under a CJK IME).
 * `key === 'Escape'` covers the empty-code case. Modifiers and an open
 * IME preedit are left to the caller / IME — Escape then cancels the
 * candidate window instead of the foreground app.
 */
export function isBareEscape(e: EscapeKeyEventLike): boolean {
  if (e.isComposing || e.ctrlKey || e.shiftKey || e.altKey || e.metaKey) return false;
  return e.code === 'Escape' || e.key === 'Escape';
}
