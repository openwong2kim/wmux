import { stripBidi } from './a2aSpawnPrompt';

// Control (Cc) characters and the line/paragraph separators U+2028/U+2029
// become spaces, so a name can never forge a prompt line. Zero-width format
// (Cf) characters are dropped outright, so `re<zwsp>lease` reads exactly like
// `release`. Bidi marks are removed separately by stripBidi (which also covers
// U+061C, U+200E, U+200F, U+202A–U+202E and U+2066–U+2069), so these classes
// need no literal bidi characters.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\p{Cc}\u2028\u2029]/gu;
// eslint-disable-next-line no-misleading-character-class
const FORMAT_CHARS = /\p{Cf}/gu;

/** Flatten a name the same way before any comparison, check or embedding:
 *  bidi and zero-width format characters are dropped, controls/separators
 *  become spaces, then collapse. */
export function flattenName(text: string): string {
  return stripBidi(text).replace(CONTROL_CHARS, ' ').replace(FORMAT_CHARS, '').replace(/\s+/g, ' ').trim();
}
