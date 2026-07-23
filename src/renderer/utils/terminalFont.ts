/**
 * Terminal font-family helpers.
 *
 * The terminal font name is user-controlled: it can be typed freely in the
 * Settings font picker, OR arrive from a (possibly hand-edited) session.json.
 * That string is injected into the xterm `fontFamily` option, which xterm sets
 * directly as a CSS `font-family` value on the terminal DOM element. A raw
 * value containing a quote, semicolon, or brace could therefore break out of
 * the font-family declaration and inject arbitrary CSS:
 *
 *     fontFamily = "'<NAME>', 'Consolas', …"
 *                     ▲ NAME = "x'; } body { background: url(…)"  ← CSS escape
 *
 * So every font name is sanitized before it is stored (uiSlice setter) AND the
 * CSS string is always built through `terminalFontFamilyCss`, which sanitizes
 * again as a defense-in-depth guard for values that were persisted before this
 * code existed. The two entry points are deliberately redundant — sanitize on
 * write keeps the store clean, sanitize on render keeps stale/hostile session
 * files safe.
 */

// Characters that could break out of the single-quoted CSS font-family token
// or inject additional declarations: quotes (' " backtick), the
// statement/selector terminators ; { }, the CSS escape backslash, and any
// C0/C1 control char (NUL, CR, LF, etc.). Stripped, not rejected, so a
// near-correct name like  My "Cool" Font  still resolves to  My Cool Font
// instead of silently falling back to the default.
// eslint-disable-next-line no-control-regex
const UNSAFE_FONT_CHARS = /['"`;{}\\\x00-\x1f\x7f-\x9f]/g;

// Upper bound on a stored font name. CSS family names are short; anything
// longer is either a paste accident or an attempt to bloat the style string.
const MAX_FONT_NAME_LENGTH = 128;

/**
 * Strip CSS-injection-unsafe characters from a user-supplied font name and
 * collapse surrounding/duplicate whitespace. Returns a trimmed, bounded
 * string safe to embed in a quoted CSS font-family token. May return '' when
 * the input was empty or entirely unsafe — callers treat '' as "use default".
 */
export function sanitizeFontFamily(input: string): string {
  if (typeof input !== 'string') return '';
  return input
    .replace(UNSAFE_FONT_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FONT_NAME_LENGTH);
}

// Fallback chain appended after the user's font. Cross-platform:
// mac monospace (Menlo/SF Mono/Monaco) → win monospace (Consolas/Courier New)
// → CJK fallback (mac: Apple SD Gothic Neo, win: Malgun Gothic — proportional CJK) →
// generic `monospace`. Fonts missing on a platform are skipped harmlessly by CSS.
const FONT_FALLBACK_CHAIN =
  "'Menlo', 'SF Mono', 'Monaco', 'Consolas', 'Courier New', 'Apple SD Gothic Neo', 'Malgun Gothic', monospace";

/**
 * Build the xterm/CSS `font-family` string for a user-chosen font, sanitized
 * and wrapped with the standard fallback chain. When the sanitized name is
 * empty, the chain alone is returned (still valid, monospace-safe).
 */
export function terminalFontFamilyCss(family: string): string {
  const safe = sanitizeFontFamily(family);
  return safe ? `'${safe}', ${FONT_FALLBACK_CHAIN}` : FONT_FALLBACK_CHAIN;
}
