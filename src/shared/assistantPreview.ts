/**
 * Shared by the phone server (`/api/sessions` list rows) and main's turn-boundary
 * metadata (Fleet rows), so desktop and phone cut an agent's closing message
 * the same way.
 */

/**
 * Grapheme budget for `lastAssistantText` in `/api/sessions`. A list row shows
 * a line or two; the full message is one `/turns` call away for a device that
 * opened the pane. Counted in graphemes, not code units, so a Hangul or emoji
 * line is cut where a reader would see 140 characters.
 */
export const LAST_ASSISTANT_GRAPHEMES = 140;

/**
 * One list row's worth of an agent's last message, or null when there is
 * nothing left to show.
 *
 * The input is AGENT-AUTHORED TEXT — the same trust class as `screenTail` — so
 * it is flattened before it goes anywhere: C0/C1 control codes (which carry the
 * escape byte, and with it cursor moves and OSC sequences) become spaces, then
 * every whitespace run collapses to one. A list row is a single line; newlines
 * in it are noise at best and terminal control at worst.
 *
 * The invisibles go too. Zero-width spaces and the bidi overrides
 * (U+202A–U+202E, U+2066–U+2069) let a message reorder how it renders without
 * changing what it says — the classic trick for making one string read as
 * another in a list. U+200D (ZWJ) is deliberately KEPT: it is not decoration,
 * it is what holds a family emoji or a flag sequence together, and stripping it
 * would shatter one grapheme into several.
 *
 * Cut by GRAPHEME, and from the END. `readLastAssistantMessage` already keeps
 * the last 600 characters of a long message for the same reason this keeps the
 * last 140 of those: an agent's ask — the question, the conclusion, the "shall
 * I?" — is at the end of what it wrote, and a head-cut preview reliably shows
 * the recap and drops the point. The leading `…` says the front was dropped.
 * Graphemes, not code units, because slicing at 140 UTF-16 units can land
 * inside a surrogate pair or a Hangul jamo sequence and end the row in a
 * replacement character.
 */
export function assistantPreview(raw: string): string | null {
  const flattened = flattenAgentText(raw);
  if (!flattened) return null;
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const graphemes = [...segmenter.segment(flattened)].map((s) => s.segment);
  if (graphemes.length <= LAST_ASSISTANT_GRAPHEMES) return flattened;
  // The ellipsis counts against the budget, so the result is never longer than
  // an untruncated one — a consumer sizing a row off the constant is not
  // surprised by the truncated case being the wider one.
  return `…${graphemes.slice(-(LAST_ASSISTANT_GRAPHEMES - 1)).join('')}`;
}

/**
 * The flatten step of `assistantPreview` on its own, with no length cut: C0/C1
 * controls become spaces, zero-width and bidi-override characters are removed
 * (ZWJ kept), whitespace runs collapse to one space, and the ends are trimmed.
 * For agent-authored text shown on one line at its full length, such as a
 * pending question.
 */
export function flattenAgentText(raw: string): string {
  return raw
    .replace(/\p{Cc}/gu, ' ')
    .replace(/[\u200B\u200C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
