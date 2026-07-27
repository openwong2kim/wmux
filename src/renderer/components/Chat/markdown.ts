// Minimal Markdown subset for Chat View prose — pure, no React, no dependency.
//
// The whole pitch of this surface is "the conversation, minus the noise", but
// raw `**bold**` / `` `code` `` / `- item` markers made it read NOISIER than the
// terminal underneath, which renders the same turn properly. This module parses
// the small subset an agent actually writes in prose and nothing else:
//
//   bold · italic · inline code · unordered/ordered lists · headings ·
//   links (kept as TEXT, never navigable) · blockquotes
//
// Deliberately NOT supported: fenced code blocks (the daemon projector already
// extracts those into `CodeBlockRef` markers, which stay chips — the "zero <pre>
// in the initial chat DOM" invariant depends on it), tables, images, HTML.
//
// Safety contract: this produces a NODE TREE, never a string of markup. The
// renderer builds React elements from it, so transcript prose — which is
// untrusted input, an agent or a tool result can contain anything — cannot
// inject markup. A link's href is carried for display only; nothing consumes it
// as a URL. Any unmatched or partial marker degrades to literal text: a stray
// `**` must never swallow the rest of a message.

/** Projector marker standing in for a fenced block: `\0code:<n>\0`. */
const CODE_REF = /^\u0000code:(\d+)\u0000/;

/** `[label](target)` — no whitespace or nesting in the target. */
const LINK = /^\[([^\][\n]*)\]\(([^()\s]*)\)/;

/** Emphasis nesting cap. Adversarial input must not drive unbounded recursion. */
const MAX_INLINE_DEPTH = 4;

export type InlineNode =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: InlineNode[] }
  | { type: 'em'; children: InlineNode[] }
  /** Rendered as plain text with the target on the title only. Never an <a>. */
  | { type: 'link'; text: string; href: string }
  /** A projector code-block handle; `literal` is the fallback rendition. */
  | { type: 'codeRef'; n: number; literal: string };

export interface ListItem {
  /** Indent level, 0-2. Rendered as padding, not as nested lists. */
  depth: number;
  children: InlineNode[];
}

export type Block =
  | { type: 'paragraph'; children: InlineNode[] }
  | { type: 'heading'; level: number; children: InlineNode[] }
  | { type: 'list'; ordered: boolean; items: ListItem[] }
  | { type: 'quote'; children: InlineNode[] };

const isWordChar = (ch: string | undefined): boolean =>
  ch !== undefined && /[A-Za-z0-9]/.test(ch);

const isSpace = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);

/**
 * Closing delimiter for an emphasis run opened at `from`, or -1 when there is
 * none (→ the opener is literal text).
 */
function findEmphasisClose(src: string, from: number, marker: string): number {
  const len = marker.length;
  const ch = marker[0];
  for (let i = from; i <= src.length - len; i += 1) {
    if (!src.startsWith(marker, i)) continue;
    // A lone `*` that sits inside a `**` run belongs to the strong delimiter.
    if (len === 1 && (src[i + 1] === ch || src[i - 1] === ch)) continue;
    // "a * b" is arithmetic, not emphasis: a closer follows non-space content.
    if (i === from || isSpace(src[i - 1])) continue;
    // `snake_case_name` must survive intact.
    if (ch === '_' && isWordChar(src[i + len])) continue;
    return i;
  }
  return -1;
}

/** Backtick-delimited code span opened at `i`, or -1 when unclosed. */
function findCodeClose(src: string, from: number, fence: string): number {
  const at = src.indexOf(fence, from);
  if (at === -1) return -1;
  // ```` ``x`` ```` style: the closer must not be a longer run than the opener.
  if (src[at + fence.length] === '`') return -1;
  return at;
}

/** Parse one run of prose into inline nodes. Total order is preserved. */
export function parseInline(src: string, depth = 0): InlineNode[] {
  const out: InlineNode[] = [];
  let buf = '';
  const flush = (): void => {
    if (buf !== '') {
      out.push({ type: 'text', text: buf });
      buf = '';
    }
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i];

    if (ch === '\u0000') {
      const m = CODE_REF.exec(src.slice(i));
      if (m) {
        flush();
        // `literal` is what the row shows when the ref turns out to be unknown:
        // a marker whose block is missing must never make text disappear.
        out.push({ type: 'codeRef', n: Number(m[1]), literal: m[0].split('\u0000').join('') });
        i += m[0].length;
        continue;
      }
      // A bare NUL is not prose the user needs to see; drop it.
      i += 1;
      continue;
    }

    if (ch === '`') {
      let n = 0;
      while (src[i + n] === '`') n += 1;
      const fence = '`'.repeat(n);
      const close = findCodeClose(src, i + n, fence);
      if (close !== -1 && close > i + n) {
        flush();
        out.push({ type: 'code', text: src.slice(i + n, close) });
        i = close + n;
        continue;
      }
      buf += fence;
      i += n;
      continue;
    }

    if ((ch === '*' || ch === '_') && depth < MAX_INLINE_DEPTH) {
      const double = src[i + 1] === ch;
      const marker = double ? ch + ch : ch;
      const openerOk =
        !isSpace(src[i + marker.length]) &&
        // `snake_case` again, from the opening side.
        !(ch === '_' && isWordChar(src[i - 1]));
      if (openerOk) {
        const close = findEmphasisClose(src, i + marker.length, marker);
        if (close !== -1) {
          flush();
          out.push({
            type: double ? 'strong' : 'em',
            children: parseInline(src.slice(i + marker.length, close), depth + 1),
          });
          i = close + marker.length;
          continue;
        }
      }
      buf += marker;
      i += marker.length;
      continue;
    }

    if (ch === '[') {
      const m = LINK.exec(src.slice(i));
      if (m) {
        flush();
        out.push({ type: 'link', text: m[1] || m[2], href: m[2] });
        i += m[0].length;
        continue;
      }
      buf += ch;
      i += 1;
      continue;
    }

    buf += ch;
    i += 1;
  }

  flush();
  return out;
}

const HEADING = /^ {0,3}(#{1,6})\s+(.*)$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.+)$/;
const ORDERED = /^(\s*)\d{1,9}[.)]\s+(.+)$/;

const indentDepth = (indent: string): number => Math.min(2, Math.floor(indent.length / 2));

/**
 * Parse prose into blocks. Anything unrecognized stays a paragraph, so no input
 * can be "invalid" — the worst case is that a line renders exactly as written.
 */
export function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = [];
  const lines = text.split('\n');

  let para: string[] = [];
  const flushPara = (): void => {
    if (para.length === 0) return;
    // Soft line breaks inside a paragraph are preserved (the renderer keeps
    // `white-space: pre-wrap`) — an agent's line wrapping is often meaningful.
    const joined = para.join('\n');
    para = [];
    if (joined.trim() === '') return;
    blocks.push({ type: 'paragraph', children: parseInline(joined) });
  };

  let list: { ordered: boolean; items: ListItem[] } | null = null;
  const flushList = (): void => {
    if (!list) return;
    blocks.push({ type: 'list', ordered: list.ordered, items: list.items });
    list = null;
  };

  let quote: string[] = [];
  const flushQuote = (): void => {
    if (quote.length === 0) return;
    const joined = quote.join('\n');
    quote = [];
    blocks.push({ type: 'quote', children: parseInline(joined) });
  };

  for (const line of lines) {
    if (line.trim() === '') {
      flushPara();
      flushList();
      flushQuote();
      continue;
    }

    const quoted = QUOTE.exec(line);
    if (quoted) {
      flushPara();
      flushList();
      quote.push(quoted[1]);
      continue;
    }
    flushQuote();

    const heading = HEADING.exec(line);
    if (heading) {
      flushPara();
      flushList();
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        children: parseInline(heading[2]),
      });
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    if (bullet || ordered) {
      flushPara();
      const m = (bullet ?? ordered) as RegExpExecArray;
      const isOrdered = ordered !== null;
      if (list && list.ordered !== isOrdered) flushList();
      if (!list) list = { ordered: isOrdered, items: [] };
      list.items.push({ depth: indentDepth(m[1]), children: parseInline(m[2]) });
      continue;
    }

    // A plain line right under a list item is that item's continuation.
    if (list) {
      const item = list.items[list.items.length - 1];
      item.children = [...item.children, { type: 'text', text: '\n' }, ...parseInline(line.trim())];
      continue;
    }

    para.push(line);
  }

  flushPara();
  flushList();
  flushQuote();
  return blocks;
}

export default parseMarkdown;
