/**
 * The one neutraliser for a name someone else chose (a sender's label, a PC
 * name, a channel name, a task or PR title) before wmux puts it on a line it
 * types into a pane. Whatever reads the line, a model or (by mistake) a shell,
 * the name stays a run of words: letters, digits, marks, space, `.`, `_` and
 * `-`. Everything else (controls, escapes, invisible and direction marks,
 * quotes, brackets, `$`, backticks, `;`, `&`, `|`, `<`, `>`, `!`, `#`, `@`,
 * `/`, `\`, `*`, `?`) becomes `_`; runs collapse and the length is capped.
 */

/** Longest name on a typed line, in characters. */
export const TYPED_NAME_MAX = 64;
/** Longest title on a typed line, in characters. */
export const TYPED_TITLE_MAX = 80;

// Whole escape sequences first (OSC, DCS/SOS/PM/APC, CSI, 8-bit CSI, any
// other ESC pair), so their parameters do not survive as text.
// eslint-disable-next-line no-control-regex -- stripping controls is the point
const ESCAPES = /\x1b\][\s\S]*?(?:\x07|\x1b\\|$)|\x1b[PX^_][\s\S]*?(?:\x1b\\|$)|\x1b\[[0-?]*[ -/]*[@-~]?|\x9b[0-?]*[ -/]*[@-~]?|\x1b[\s\S]?/g;
const OUTSIDE = /[^\p{L}\p{M}\p{N} ._-]+/gu;

export function neutralName(raw: unknown, max: number = TYPED_NAME_MAX): string {
  const flat = String(raw ?? '')
    .replace(ESCAPES, '')
    // Full-width and compatibility forms fold to the characters the filter knows.
    .normalize('NFKC')
    .replace(OUTSIDE, '_')
    .replace(/ {2,}/g, ' ')
    .replace(/_{2,}/g, '_')
    .trim();
  const capped = [...flat].slice(0, Math.max(1, max)).join('').trim();
  return capped || '_';
}
