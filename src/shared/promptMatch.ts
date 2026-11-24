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

/**
 * An opening paste tag as Claude Code writes it: a hex id. Narrower than
 * PASTE_MARKER_RE on purpose: that one only has to make two texts compare
 * alike, this one decides what a client is shown.
 */
const PASTE_OPEN_SOURCE = '<pasted_content id="([0-9a-f]{1,32})">';

/** One stretch of a message: the text of a paste Claude Code recorded, or text outside any. */
export interface PasteSegment { text: string; pasted: boolean }

/**
 * The first paste Claude Code recorded at or after `from`: a matched pair, an
 * opening tag and the later closing tag with the same id. `inner` is the text
 * between them less the one `\n` Claude Code writes right inside each tag,
 * byte for byte otherwise (a `\r` the user typed stays). An unmatched tag, or
 * one with an id Claude Code does not write, is not a paste.
 */
export function findPaste(text: string, from = 0): { start: number; end: number; inner: string } | null {
  const open = new RegExp(PASTE_OPEN_SOURCE, 'g');
  open.lastIndex = from;
  for (let m = open.exec(text); m; m = open.exec(text)) {
    const close = `</pasted_content id="${m[1]}">`;
    const innerStart = m.index + m[0].length;
    const closeAt = text.indexOf(close, innerStart);
    if (closeAt < 0) continue;
    const a = text[innerStart] === '\n' ? innerStart + 1 : innerStart;
    const b = closeAt > a && text[closeAt - 1] === '\n' ? closeAt - 1 : closeAt;
    return { start: m.index, end: closeAt + close.length, inner: text.slice(a, b) };
  }
  return null;
}

/** `text` cut into the pastes Claude Code recorded (findPaste) and the text around them. */
export function pasteSegments(text: string): PasteSegment[] {
  if (!text.includes('<pasted_content')) return [{ text, pasted: false }];
  const segments: PasteSegment[] = [];
  let from = 0;
  for (let p = findPaste(text, from); p; p = findPaste(text, from)) {
    if (p.start > from) segments.push({ text: text.slice(from, p.start), pasted: false });
    segments.push({ text: p.inner, pasted: true });
    from = p.end;
  }
  if (segments.length === 0) return [{ text, pasted: false }];
  if (from < text.length) segments.push({ text: text.slice(from), pasted: false });
  return segments;
}

/** `text` with each recorded paste unwrapped (pasteSegments). `pasted`: a pair was found. */
export function unwrapPastedContent(text: string): { text: string; pasted: boolean } {
  const segments = pasteSegments(text);
  return { text: segments.map((x) => x.text).join(''), pasted: segments.some((x) => x.pasted) };
}
