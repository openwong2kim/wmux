// ─── Clean copy from a terminal agent's reply ────────────────────────────────
//
// A terminal agent's TUI prints its reply with a margin, its own hard wraps
// at the pane width and padding, so a selection copied from the terminal
// carries all three (a wrapped URL breaks, a code block keeps the margin).
// The transcript holds the reply as the agent wrote it. When a selection is
// exactly one span of one reply, the copy is that span as the user sees it:
// no margin, wraps or padding, no markdown markers the TUI hides (**, `,
// fences), and code block bodies verbatim. Anything uncertain copies the
// selection as it is. Pure; utils/cleanCopyResolve.ts feeds it the replies.

/** One part of a reply, in order: prose as the agent wrote it (markdown), or
 *  one fenced code block's body. */
export type ReplyPart =
  | { kind: 'prose'; text: string }
  | { kind: 'code'; body: string; lang?: string };

/** One agent reply as the transcript recorded it. */
export type AgentReply = readonly ReplyPart[];

/**
 * The text to copy for `selection` (xterm's selection text in the pane whose
 * agent wrote `replies`, oldest first), or null when the selection is not
 * exactly one span of one reply: no match, more than one, a partial overlap
 * with other output, or markdown this module does not know how the TUI shows.
 * Null means "copy the selection as it is".
 */
export function cleanCopyText(selection: string, replies: readonly AgentReply[]): string | null {
  const shown = selection.replace(DECORATION, '');
  const { key: needle, map: shownMap } = whitespaceFreeKey(shown);
  if (needle === '') return null;
  let found: { projection: string; map: readonly number[]; at: number } | null = null;
  for (const reply of replies) {
    const projection = projectReply(reply);
    const { key, map } = whitespaceFreeKey(projection);
    for (let at = key.indexOf(needle); at !== -1; at = key.indexOf(needle, at + 1)) {
      if (found) return null;
      found = { projection, map, at };
    }
  }
  if (!found) return null;
  const { projection, map, at } = found;
  const spanMap = map.slice(at, at + needle.length);
  if (!sameSpacing(projection, spanMap, shown, shownMap)) return null;
  // A selection begun left of an indented line (from the margin) takes the
  // line's own indentation, so a code span keeps its relative indentation.
  let start = spanMap[0];
  const lineStart = projection.lastIndexOf('\n', start - 1) + 1;
  if (/^[^\S\n]+$/u.test(projection.slice(lineStart, start)) && /^[^\S\n]/u.test(shown)) start = lineStart;
  return projection.slice(start, spanMap[spanMap.length - 1] + 1);
}

/** Whether `selection` is already its own clean copy: one row with nothing
 *  the TUI adds at either end (a margin, padding, a reply marker). By the
 *  spacing rule a match could not change it, so it needs no transcript. */
export function cleanAsIs(selection: string): boolean {
  return !selection.includes('\n') && selection === selection.trim() && selection.replace(DECORATION, '') === selection;
}

/** Whether the selection spaces the matched characters as the reply does,
 *  given that the TUI only adds line breaks and margins (its wraps): every
 *  break and space of the reply shows in the selection, and the selection
 *  shows no space where the reply has none. So `npm test` on screen is not the
 *  reply's `npm` and `test` on two lines. */
function sameSpacing(projection: string, spanMap: readonly number[], shown: string, shownMap: readonly number[]): boolean {
  const breaks = (gap: string): number => gap.split('\n').length - 1;
  for (let k = 0; k + 1 < spanMap.length; k++) {
    const reply = projection.slice(spanMap[k] + 1, spanMap[k + 1]);
    const seen = shown.slice(shownMap[k] + 1, shownMap[k + 1]);
    if (breaks(seen) < breaks(reply)) return false;
    if (reply !== '' && seen === '') return false;
    if (reply === '' && seen !== '' && breaks(seen) === 0) return false;
  }
  return true;
}

// What the selection holds besides the reply's own text, as Claude Code 2.1.316
// draws it: the reply marker at the start of the reply's first row (⏺ on
// macOS; ● elsewhere, as the repo's other Claude screen readers accept), and
// the bar it puts in place of a blockquote's `>` (on every row, wrapped rows
// too).
const DECORATION = /^[^\S\n]*(?:⏺|●|▎)/gmu;

/** `text` without whitespace, and where each of its characters sits in `text`. */
function whitespaceFreeKey(text: string): { key: string; map: number[] } {
  let key = '';
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (/\s/u.test(text[i])) continue;
    key += text[i];
    map.push(i);
  }
  return { key, map };
}

/** The reply as the TUI shows it: parts in order, one blank line apart. */
function projectReply(reply: AgentReply): string {
  return reply
    .map((part) => (part.kind === 'code' ? part.body : projectProse(part.text)).replace(/^\n+|\n+$/gu, ''))
    .join('\n\n');
}

// Prose as the TUI shows it, mirroring only what captures of it show: headings
// lose their `#`, a blockquote its `>`, emphasis and code spans their markers,
// and a link reads `text (url)`. Bullets, top-level numbers and rules show as
// written. Tables (redrawn with box borders) and nested numbered lists
// (renumbered a., b.) have no rule, so a selection across them never matches.
function projectProse(text: string): string {
  return text
    .split('\n')
    .map((line) => projectInline(line.replace(/^ {0,3}#{1,6}[^\S\n]+/u, '').replace(/^ {0,3}>[^\S\n]?/u, '')))
    .join('\n');
}

const CODE_SPAN = /(`+)([^`]|[^`].*?[^`])\1(?!`)/gu;
// One placeholder character per code span (supplementary private use), so
// emphasis around a code span (**`npm test`**) loses its markers too.
const SPAN_BASE = 0xf0000;
const HAS_SPAN_CHAR = /[\u{F0000}-\u{FFFFD}]/u;

/** Inline markdown on one line: code spans keep their content as it is, the
 *  rest loses the emphasis markers and shows a link as `text (url)`. */
function projectInline(line: string): string {
  if (HAS_SPAN_CHAR.test(line)) {
    // The line already holds a placeholder character: span by span instead.
    let out = '';
    let last = 0;
    for (const m of line.matchAll(CODE_SPAN)) {
      out += projectText(line.slice(last, m.index)) + m[2];
      last = m.index + m[0].length;
    }
    return out + projectText(line.slice(last));
  }
  const spans: string[] = [];
  const held = line.replace(CODE_SPAN, (_m, _ticks: string, body: string) => String.fromCodePoint(SPAN_BASE + spans.push(body) - 1));
  return [...projectText(held)].map((ch) => {
    const i = (ch.codePointAt(0) ?? 0) - SPAN_BASE;
    return i >= 0 && i < spans.length ? spans[i] : ch;
  }).join('');
}

function projectText(text: string): string {
  return text
    .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/gu, '$1 ($2)')
    .replace(/<((?:https?|mailto):[^>\s]+)>/gu, '$1')
    .replace(/\*\*(?=\S)(.+?)(?<=\S)\*\*/gu, '$1')
    .replace(/\*(?=\S)(.+?)(?<=\S)\*/gu, '$1')
    .replace(/(?<![\p{L}\p{N}_])__(?=\S)(.+?)(?<=\S)__(?![\p{L}\p{N}_])/gu, '$1')
    .replace(/(?<![\p{L}\p{N}_])_(?=\S)(.+?)(?<=\S)_(?![\p{L}\p{N}_])/gu, '$1');
}
