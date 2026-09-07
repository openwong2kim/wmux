/**
 * Layout-correct Ctrl+<letter> encoding for the terminal input path.
 *
 * xterm.js derives Ctrl+A…Ctrl+Z from the deprecated `KeyboardEvent.keyCode`
 * (it looks for 65–90 and emits `String.fromCharCode(keyCode - 64)`). keyCode
 * is the physical QWERTY position, so on Dvorak the logical C key is physical
 * I: xterm emits Ctrl+I (0x09) instead of SIGINT (0x03). That is #1227 —
 * "Ctrl+C does not interrupt Claude until I switch back to QWERTY."
 *
 * The rest of wmux already matches *logical* `event.key` for Enter and the
 * *physical* `event.code` as an IME fallback (Hangul / Pinyin report
 * `key === 'Process'` / a jamo, while `code` stays `KeyC`). This helper
 * applies that same split to control letters:
 *
 *   1. A Latin `key` (`a`–`z`) wins. Dvorak/Colemak get the letter they typed.
 *   2. Otherwise, a `KeyA`–`KeyZ` `code` is the IME fallback. Physical C on
 *      Dvorak is the letter J, but that path is not taken — `key` is already
 *      Latin, so step 1 fires.
 *
 * Returns `null` when the event is not a bare Ctrl+letter (other modifiers,
 * composition, non-letter keys). Callers then defer to xterm or to a more
 * specific handler (copy, app shortcut, …).
 */

export interface CtrlLetterEventLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing: boolean;
}

const LATIN = /^[a-z]$/;
const PHYSICAL_LETTER = /^Key([A-Z])$/;

function ctrlByteForLetter(letter: string): string {
  // 'a' → 0x01, 'c' → 0x03, 'z' → 0x1a. Same formula xterm uses on keyCode.
  return String.fromCharCode(letter.toUpperCase().charCodeAt(0) - 64);
}

export function resolveCtrlLetterByte(e: CtrlLetterEventLike): string | null {
  if (!e.ctrlKey || e.shiftKey || e.altKey || e.metaKey || e.isComposing) return null;

  const latin = e.key.length === 1 ? e.key.toLowerCase() : '';
  if (LATIN.test(latin)) return ctrlByteForLetter(latin);

  const physical = PHYSICAL_LETTER.exec(e.code);
  if (physical) return ctrlByteForLetter(physical[1]);

  return null;
}
