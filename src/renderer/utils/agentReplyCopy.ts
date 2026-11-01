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
  const needle = selectionKey(selection);
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
  return projection.slice(map[at], map[at + needle.length - 1] + 1);
}

// What the selection holds besides the reply's own text, as Claude Code 2.1.316
// draws it: the reply marker at the start of the reply's first row, and the bar
// it puts in place of a blockquote's `>` (on every row, wrapped rows too).
const DECORATION = /^[^\S\n]*(?:⏺|▎)/gmu;

function selectionKey(selection: string): string {
  return selection.replace(DECORATION, '').replace(/\s+/gu, '');
}

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

/** Inline markdown on one line: code spans keep their content as it is, the
 *  rest loses the emphasis markers and shows a link as `text (url)`. */
function projectInline(line: string): string {
  let out = '';
  let last = 0;
  for (const m of line.matchAll(/(`+)([^`]|[^`].*?[^`])\1(?!`)/gu)) {
    out += projectText(line.slice(last, m.index)) + m[2];
    last = m.index + m[0].length;
  }
  return out + projectText(line.slice(last));
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
