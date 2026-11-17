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

/** An opening paste tag as Claude Code writes it: a hex id. */
const PASTE_OPEN_RE = /<pasted_content id="([0-9a-f]{1,32})">/g;

/**
 * `text` with each paste Claude Code recorded unwrapped, for display (the
 * transcript's `user_text`): only a matched pair is removed, an opening tag
 * and a later closing tag with the same id, together with at most one line
 * break (`\n` or `\r\n`) right inside each tag, which Claude Code adds. The
 * text between them is kept byte for byte. An unmatched tag, or one with an
 * id Claude Code does not write, stays as it is. `pasted`: a pair was found.
 */
export function unwrapPastedContent(text: string): { text: string; pasted: boolean } {
  if (!text.includes('<pasted_content')) return { text, pasted: false };
  let out = '';
  let from = 0;
  let pasted = false;
  const open = new RegExp(PASTE_OPEN_RE.source, 'g');
  for (let m = open.exec(text); m; m = open.exec(text)) {
    const close = `</pasted_content id="${m[1]}">`;
    const innerStart = m.index + m[0].length;
    const closeAt = text.indexOf(close, innerStart);
    if (closeAt < 0) continue;
    let a = innerStart;
    if (text.startsWith('\r\n', a)) a += 2;
    else if (text[a] === '\n') a += 1;
    let b = closeAt;
    if (b - a >= 2 && text.slice(b - 2, b) === '\r\n') b -= 2;
    else if (b > a && text[b - 1] === '\n') b -= 1;
    out += text.slice(from, m.index) + text.slice(a, b);
    from = closeAt + close.length;
    open.lastIndex = from;
    pasted = true;
  }
  return pasted ? { text: out + text.slice(from), pasted } : { text, pasted: false };
}
