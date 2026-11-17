/**
 * Recognising text wmux typed into an agent when the agent's transcript (or a
 * hook) reports it back.
 *
 * Claude Code treats a long or multi-line write as a paste and stores it
 * wrapped in these markers, with line breaks around them that can fall
 * mid-word (measured on Claude Code 2.1.289: "…blo\n</pasted_content id=\"bc9f\">\n\ncked…";
 * 2.1.326 stores a whole prompt as "\n\n<pasted_content id=\"3de0\">\n…\n</pasted_content id=\"3de0\">\n").
 */
const PASTE_MARKER_RE = /<\/?pasted_content(?:\s[^>]*)?>/g;

/** `text` without Claude Code's paste markers; everything else as it was. */
export function stripPasteMarkers(text: string): string {
  return text.replace(PASTE_MARKER_RE, '');
}

/**
 * The form both sides are compared in: paste markers and ALL whitespace
 * removed, since the TUI inserts breaks inside words around a paste. Two texts
 * that differ only in spacing read alike; a caller that can tell them apart
 * another way (an exact match first) should.
 */
export function normalizeForPromptMatch(text: string): string {
  return stripPasteMarkers(text).replace(/\s+/g, '');
}
