// Adapted from MonoCode (hardbeat920/monocode@6bd432ca, src/features/sessions/ui/AgentTranscript.tsx), MIT License, Copyright (c) 2026 Nick
import { Fragment, useState } from 'react';
import { t } from '../../i18n';
import { closesFence, fenceOpenLength } from '../../../shared/markdownFence';

// ─── Command Deck — orchestrator prose markdown (dep-free subset) ────────────
//
// The orchestrator's replies are model prose — headings, lists, code fences,
// bold — and rendering them as raw text made every reply read like a diff.
// This is a deliberately tiny, dependency-free markdown SUBSET renderer for
// the brain bubble: fenced code blocks, #/##/### headings, bullet + numbered
// lists (with read-only task checkboxes), blockquotes, GFM tables, and
// inline bold / italic / `code` / [links]. Anything else stays
// literal text — no HTML injection surface (everything renders through React
// text nodes, never dangerouslySetInnerHTML).
//
// Precedent: FileTreePanel ships the same idea for .md previews. This one is
// separate on purpose — the bubble's type scale (13px chat prose on
// bg-mantle) differs from the file preview's (11px on bg-surface), and links
// follow the same inert-span convention (title shows the URL; the deck never
// navigates).
//
// Streaming note: the bubble re-renders on every text-delta, so a fence that
// hasn't closed YET renders as a code block to the end of the text — the
// right transient look while code streams in.

export interface MarkdownOptions {
  /** Make http(s) links real links (opened through the app's external-link
   *  handler) and turn bare http(s) URLs into links. Off: links stay inert,
   *  as the deck never navigates. */
  links?: boolean;
  /** GitHub bodies: HTML comments and script/style vanish, <details> blocks
   *  become disclosures, other tags reduce to their text (<br> a line break,
   *  <img> its alt, <a> a link only when http(s)), entities decode. Never raw
   *  HTML: everything still renders as React text nodes. */
  githubHtml?: boolean;
  /** Code blocks as the Bots chat draws them: a fill and no border (the one
   *  boundary), a muted language label, a Copy that shows on hover or focus,
   *  and a 320px cap that scrolls inside. Off: the plain block. */
  richCode?: boolean;
  /** Draw a link as something else (the Bots chat's PR and issue chips);
   *  null keeps the plain link. Only with `links`. */
  linkChip?: (url: string, label: string | null) => React.ReactNode | null;
  /** Draw `@Name` mentions in plain text as something else (the Bots chat's
   *  bot marks). `pattern` matches the whole mention, group 1 the name. */
  mention?: { pattern: RegExp; render: (name: string, key: string) => React.ReactNode };
  /** `*` and `**` emphasis only at word boundaries: no emphasis where the
   *  delimiter sits between two ASCII letters or digits (CommonMark's rule
   *  for `_`, applied to `*`), and none whose delimiter touches a space on
   *  its inner side. Code-like text (`2**31`, `a*b*c`) stays as written;
   *  bold followed by a Korean particle (`**파일**을`) is still bold. */
  strictEmphasis?: boolean;
}

const ASCII_ALNUM = /[A-Za-z0-9]/;

/** Whether an emphasis match (`**x**` or `*x*` at `index` in `text`) may
 *  open and close under `strictEmphasis`. */
function emphasisAtBoundaries(text: string, index: number, m: string): boolean {
  const n = m.startsWith('**') ? 2 : 1;
  const before = text[index - 1] ?? '';
  const after = text[index + m.length] ?? '';
  const first = m[n];
  const last = m[m.length - n - 1];
  const between = (a: string, b: string) => ASCII_ALNUM.test(a) && ASCII_ALNUM.test(b);
  if (before === '*' || after === '*') return false;
  if (/\s/.test(first) || between(before, first)) return false;
  if (/\s/.test(last) || between(last, after)) return false;
  return true;
}

/** Plain text, with its mentions drawn by `opts.mention` when given. */
function plainText(text: string, key: string, opts: MarkdownOptions): React.ReactNode[] {
  const m = opts.mention;
  if (!m || !text.includes('@')) return [text];
  const re = new RegExp(m.pattern.source, m.pattern.flags.includes('g') ? m.pattern.flags : `${m.pattern.flags}g`);
  const out: React.ReactNode[] = [];
  let last = 0;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(text)) !== null) {
    if (hit[0].length === 0) { re.lastIndex++; continue; }
    if (hit.index > last) out.push(text.slice(last, hit.index));
    out.push(<Fragment key={`${key}m${hit.index}`}>{m.render(hit[1] ?? hit[0], `${key}m${hit.index}`)}</Fragment>);
    last = hit.index + hit[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A fenced code block with its language label and Copy (richCode). */
function RichCodeBlock({ code, lang }: { code: string; lang: string }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  return (
    <div data-brain-md-code data-brain-md-code-rich className="group relative my-1">
      <div className="pointer-events-none absolute right-1.5 top-1 flex items-center gap-1.5">
        {lang && <span data-brain-md-code-lang className="text-[11px] text-[var(--text-muted)]">{lang}</span>}
        <button
          type="button"
          data-brain-md-code-copy
          aria-label={t('botsPage.chat.copyCode')}
          title={t('botsPage.chat.copyCode')}
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(() => setCopied(true)).catch(() => undefined);
          }}
          onBlur={() => setCopied(false)}
          className="pointer-events-auto h-[22px] rounded-[6px] px-1.5 text-[11px] text-[var(--text-sub)] opacity-0 hover:bg-[var(--hover-fill)] focus-visible:opacity-100 group-hover:opacity-100"
        >
          {copied ? t('botsPage.chat.copied') : t('botsPage.chat.copyCode')}
        </button>
      </div>
      <pre className="max-h-[320px] overflow-auto rounded-lg px-3 py-2 pr-20 font-mono text-[12px] leading-relaxed whitespace-pre bg-[color-mix(in_srgb,var(--text-main)_5%,transparent)] text-[var(--text-sub)]">
        {code}
      </pre>
    </div>
  );
}

const HTTP_URL = /^https?:\/\//i;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

/** Decode the common named entities and numeric ones, for display as text. */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

const attr = (tag: string, name: string) => tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
const attrValue = (m: RegExpMatchArray | null) => (m ? (m[1] ?? m[2] ?? m[3] ?? '') : '');

/** `s.replace(/<[^>]*>/g, '')` in one pass: that regex rescans the rest of
 *  the text from every `<` that has no `>` after it. */
function stripTags(s: string): string {
  let out = '';
  let pos = 0;
  for (;;) {
    const lt = s.indexOf('<', pos);
    const gt = lt < 0 ? -1 : s.indexOf('>', lt);
    if (gt < 0) return out + s.slice(pos);
    out += s.slice(pos, lt);
    pos = gt + 1;
  }
}

/** One line of GitHub text with its inline HTML reduced to text (code spans
 *  kept as written): <img> → alt, <a href> → a markdown link when http(s),
 *  every other tag dropped, entities decoded. */
export function reduceInlineHtml(text: string): string {
  return text.split(/(`[^`\n]+`)/).map((part, i) => {
    if (i % 2 === 1) return part;
    let t = part.replace(/<img\b[^<>]*>/gi, (tag) => decodeEntities(attrValue(attr(tag, 'alt'))));
    t = t.replace(/<a\b([^<>]*)>((?:(?!<a\b)[\s\S])*?)<\/a\s*>/gi, (_m, attrs: string, inner: string) => {
      const label = decodeEntities(stripTags(inner)).replace(/[[\]]/g, '').trim();
      const href = decodeEntities(attrValue(attr(`<a${attrs}>`, 'href'))).trim();
      if (label && HTTP_URL.test(href) && !/[\s()]/.test(href)) return `[${label}](${href})`;
      return label;
    });
    t = t.replace(/<\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?\/?>/g, '');
    return decodeEntities(t);
  }).join('');
}

/** The whole body, outside code fences: comments and script/style elements
 *  dropped, <br> as a line break. */
function preprocessGithubHtml(source: string): string {
  const lines = source.split('\n');
  const out: string[] = [];
  let chunk: string[] = [];
  let fence = 0;
  const flush = () => {
    if (chunk.length === 0) return;
    const text = chunk.join('\n')
      // One left-to-right pass, so whichever starts first wins: a code span
      // keeps a `<script>` or comment opener written as code (which would
      // otherwise swallow the rest of the document), and a real comment or
      // script keeps the backticks inside it. \x21 is '!': this file is
      // inlined into the web client's page, whose build refuses a bundle
      // containing a literal comment opener.
      .replace(
        /(`[^`\n]+`)|<\x21--[\s\S]*?(?:-->|$)|<(script|style)\b[^<>]*>[\s\S]*?(?:<\/\2\s*>|$)/gi,
        (_m, code: string | undefined) => code ?? '',
      )
      .replace(/<br\s*\/?>/gi, '\n');
    // A loop, not push(...spread): a long run of short lines would pass
    // one argument per line and overflow the call stack.
    for (const l of text.split('\n')) out.push(l);
    chunk = [];
  };
  for (const line of lines) {
    if (fence === 0 && fenceOpenLength(line) > 0) {
      flush();
      fence = fenceOpenLength(line);
      out.push(line);
    } else if (fence > 0) {
      if (closesFence(line, fence)) fence = 0;
      out.push(line);
    } else {
      chunk.push(line);
    }
  }
  flush();
  return out.join('\n');
}

/** A link that opens outside the app: window.open goes through the main
 *  window's open handler, which hands http(s) to the system browser only. */
function ExternalLink({ url, children }: { url: string; children: React.ReactNode }): React.ReactElement {
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      title={url}
      data-brain-md-link
      className="text-[var(--accent-blue)] underline"
      onClick={(e) => {
        e.preventDefault();
        window.open(url, '_blank');
      }}
    >
      {children}
    </a>
  );
}

/** Inline subset: `code`, **bold**, *italic*, [label](url), and with links on
 *  bare http(s) URLs. Bold before italic so ** never half-matches. */
function renderInline(raw: string, keyPrefix: string, opts: MarkdownOptions = {}): React.ReactNode[] {
  // GitHub HTML is reduced once, at the outer call; nested calls get plain text.
  const text = opts.githubHtml ? reduceInlineHtml(raw) : raw;
  if (opts.githubHtml) opts = { ...opts, githubHtml: false };
  const parts: React.ReactNode[] = [];
  const regex = opts.links
    ? /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^[\]\n]+\]\([^()\n]+\))|(https?:\/\/[^\s<>()[\]]*[^\s<>()[\].,;:!?'"])/g
    : /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^[\]\n]+\]\([^()\n]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const m = match[0];
    if (opts.strictEmphasis && m.startsWith('*') && !emphasisAtBoundaries(text, match.index, m)) {
      // Not emphasis: the whole `*` run stays text (in the next plain
      // slice), and the scan goes on after it (a later run may still open).
      let run = 1;
      while (text[match.index + run] === '*') run++;
      regex.lastIndex = match.index + run;
      continue;
    }
    // Appended one by one: a spread passes every node as an argument, and a
    // long run of mentions would exceed the call stack.
    if (match.index > lastIndex) for (const n of plainText(text.slice(lastIndex, match.index), `${keyPrefix}p${lastIndex}`, opts)) parts.push(n);
    if (m.startsWith('`')) {
      parts.push(
        // Mono on a faint surface, no accent: inline code is a machine token
        // inside prose, not a "needs you" point. Amber is budgeted at 5±2
        // meaning-points per screen (DESIGN.md Color) and a transcript can
        // carry dozens of these in one reply, which alone blew the budget.
        <code
          key={`${keyPrefix}c${match.index}`}
          data-brain-md-code-inline
          className="px-1 rounded font-mono text-[12px] bg-[var(--selection)] text-[var(--text-sub)]"
        >
          {m.slice(1, -1)}
        </code>,
      );
    } else if (m.startsWith('**')) {
      parts.push(
        <strong key={`${keyPrefix}b${match.index}`} className="font-semibold text-[var(--text-main)]">
          {renderInline(m.slice(2, -2), `${keyPrefix}b${match.index}-`, opts)}
        </strong>,
      );
    } else if (m.startsWith('*')) {
      parts.push(
        <em key={`${keyPrefix}i${match.index}`} className="italic">
          {m.slice(1, -1)}
        </em>,
      );
    } else if (opts.links && HTTP_URL.test(m)) {
      const chip = opts.linkChip?.(m, null);
      parts.push(chip ? <Fragment key={`${keyPrefix}u${match.index}`}>{chip}</Fragment> : <ExternalLink key={`${keyPrefix}u${match.index}`} url={m}>{m}</ExternalLink>);
    } else {
      const link = m.match(/\[([^\]]+)\]\(([^)]+)\)/);
      if (link && opts.links && HTTP_URL.test(link[2].trim())) {
        const chip = opts.linkChip?.(link[2].trim(), link[1]);
        parts.push(chip ? <Fragment key={`${keyPrefix}l${match.index}`}>{chip}</Fragment> : <ExternalLink key={`${keyPrefix}l${match.index}`} url={link[2].trim()}>{link[1]}</ExternalLink>);
      } else if (link) {
        // Inert by convention (FileTreePanel does the same): the URL shows on
        // hover, and the deck never navigates on click.
        parts.push(
          <span
            key={`${keyPrefix}l${match.index}`}
            className="text-[var(--accent-blue)] underline"
            title={link[2]}
          >
            {link[1]}
          </span>,
        );
      } else {
        parts.push(m);
      }
    }
    lastIndex = match.index + m.length;
  }
  if (lastIndex < text.length) for (const n of plainText(text.slice(lastIndex), `${keyPrefix}p${lastIndex}`, opts)) parts.push(n);
  return parts.length > 0 ? parts : plainText(text, `${keyPrefix}p0`, opts);
}

/** A GFM table delimiter row: `| --- | :--: |`, at least one pipe. */
// No two whitespace runs touch, so a long line that is not a separator fails
// in linear time (an editor file can be a megabyte).
const TABLE_SEPARATOR = /^\s*(?:\|\s*)?:?-+:?\s*(?:\|\s*:?-+:?\s*)*(?:\|\s*)?$/;

/** A table row's cells: outer pipes dropped, split on pipes not escaped as `\|`. */
function tableCells(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '');
  return body.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function tableAlign(cell: string): 'left' | 'center' | 'right' | undefined {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  return left && right ? 'center' : right ? 'right' : left ? 'left' : undefined;
}

/** Render orchestrator prose as chat-bubble markdown. Pure — safe to call on
 *  every streaming re-render. */
export function renderBrainMarkdown(source: string, opts: MarkdownOptions = {}): React.ReactNode[] {
  return renderBlocks(opts.githubHtml ? preprocessGithubHtml(source) : source, opts, 0, { left: MAX_BLOCKS });
}

/** renderBrainMarkdown, or null when the source runs past MAX_BLOCKS and
 *  the render would be cut short. For callers that must show the whole
 *  document (the editor's View mode falls back to raw text). */
export function renderBrainMarkdownWhole(source: string, opts: MarkdownOptions = {}): React.ReactNode[] | null {
  const budget: BlockBudget = { left: MAX_BLOCKS };
  const nodes = renderBlocks(opts.githubHtml ? preprocessGithubHtml(source) : source, opts, 0, budget);
  return budget.cut ? null : nodes;
}

/** Quotes nest this deep; a deeper `>` renders as text. Untrusted text (an
 *  issue body) could otherwise nest thousands deep and overflow the stack. */
export const MAX_QUOTE_DEPTH = 4;
/** Blocks drawn per render, every quote level together; the rest is cut. */
export const MAX_BLOCKS = 2000;
/** Table cells drawn per render, every table and header row together; the rest is cut. */
export const MAX_TABLE_CELLS = 5000;
/** Lines put back into the stream per splice call (see the <details> branch). */
const SPLICE_CHUNK = 8192;

/** Blocks left to draw; `cut` is set once a render ran out of them. */
interface BlockBudget { left: number; cut?: boolean; cells?: number }

function renderBlocks(source: string, opts: MarkdownOptions, depth: number, budget: BlockBudget): React.ReactNode[] {
  const lines = source.split('\n');
  const out: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    if (budget.left <= 0) {
      budget.cut = true;
      out.push(<div key={out.length} data-brain-md-cut className="text-[var(--text-muted)]">…</div>);
      break;
    }
    budget.left--;
    const line = lines[i];

    // Fenced code block (an unclosed fence swallows to the end — streaming).
    // It closes on a backtick run at least as long as the one it opened with.
    const open = fenceOpenLength(line);
    if (open > 0) {
      const codeLines: string[] = [];
      const lang = line.trimStart().slice(open).trim().split(/\s+/)[0]?.slice(0, 24) ?? '';
      i++;
      while (i < lines.length && !closesFence(lines[i], open)) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip the closing fence (or run past the end)
      if (opts.richCode) {
        out.push(<RichCodeBlock key={out.length} code={codeLines.join('\n')} lang={lang} />);
        continue;
      }
      out.push(
        <pre
          key={out.length}
          data-brain-md-code
          className="my-1 px-3 py-2 rounded-lg border border-[var(--line)] overflow-x-auto font-mono text-[12px] leading-relaxed whitespace-pre bg-[color-mix(in_srgb,var(--text-main)_3%,transparent)] text-[var(--text-sub)]"
        >
          {codeLines.join('\n')}
        </pre>,
      );
      continue;
    }

    // GFM table: a header row with a pipe, then a delimiter row, then body
    // rows until a line without a pipe. Cells are inline text like any line,
    // and a wide table scrolls inside its own box.
    if (line.includes('|') && i + 1 < lines.length && lines[i + 1].includes('|') && TABLE_SEPARATOR.test(lines[i + 1])) {
      const allHead = tableCells(line);
      // The cell allowance is shared by every table in the render.
      const cellsLeft = budget.cells ?? MAX_TABLE_CELLS;
      const head = allHead.slice(0, cellsLeft);
      const align = tableCells(lines[i + 1]).map(tableAlign);
      const rows: string[][] = [];
      // Every body row draws the header's width, so the cells, not the
      // source, set the cost: past MAX_TABLE_CELLS the rest is cut.
      const maxRows = Math.max(0, Math.floor(cellsLeft / Math.max(1, head.length)) - 1);
      let cut = head.length < allHead.length;
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        if (rows.length < maxRows) rows.push(tableCells(lines[i]));
        else cut = true;
        i++;
      }
      const key = out.length;
      out.push(
        <div key={key} data-brain-md-table className="my-1 max-w-full overflow-x-auto">
          <table className="border-collapse text-[12px] leading-snug">
            <thead>
              <tr>
                {head.map((c, ci) => (
                  <th
                    key={ci}
                    style={{ textAlign: align[ci] }}
                    className="px-2 py-1 font-semibold text-left text-[var(--text-main)] border-b border-[var(--line)] whitespace-nowrap"
                  >
                    {renderInline(c, `t${key}h${ci}-`, opts)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className="border-b border-[var(--border-soft)]">
                  {head.map((_, ci) => (
                    <td key={ci} style={{ textAlign: align[ci] }} className="px-2 py-1 align-top">
                      {renderInline(r[ci] ?? '', `t${key}r${ri}c${ci}-`, opts)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      budget.cells = Math.max(0, cellsLeft - head.length * (rows.length + 1));
      if (cut) {
        budget.cut = true;
        out.push(<div key={out.length} data-brain-md-cut className="text-[var(--text-muted)]">…</div>);
      }
      continue;
    }

    // GitHub <details>: up to its matching </details>, a disclosure whose
    // label is the <summary> and whose body renders with this same subset.
    // Shares the quote nesting cap; deeper, the tags reduce to text.
    if (opts.githubHtml && depth < MAX_QUOTE_DEPTH && /^\s*<details\b/i.test(line)) {
      const buf: string[] = [];
      let level = 0;
      while (i < lines.length) {
        const l = lines[i];
        level += (l.match(/<details\b/gi) ?? []).length;
        level -= (l.match(/<\/details\s*>/gi) ?? []).length;
        buf.push(l);
        i++;
        if (level <= 0) break;
      }
      let body = buf.join('\n').replace(/^\s*<details\b[^>]*>/i, '');
      // The last closing tag, found in one pass (a lookahead for "no later
      // one" rescans the rest of the body at every candidate).
      let close = -1;
      for (const m of body.matchAll(/<\/details\s*>/gi)) close = m.index ?? close;
      if (close >= 0) {
        const rest = body.slice(body.indexOf('>', close) + 1);
        body = body.slice(0, close);
        // Text after the closing tag goes back into the stream, in slices: a
        // spread of every line at once would exceed the call stack.
        if (rest.trim()) {
          const back = rest.split('\n');
          for (let k = 0; k < back.length; k += SPLICE_CHUNK) lines.splice(i + k, 0, ...back.slice(k, k + SPLICE_CHUNK));
        }
      }
      // This level's summary: the first one before any nested <details>,
      // with the first closing tag after it (indexes, not a lazy regex scan
      // retried at every opener).
      const nested = body.search(/<details\b/i);
      const head = nested >= 0 ? body.slice(0, nested) : body;
      const sOpen = head.search(/<summary\b/i);
      const sGt = sOpen >= 0 ? head.indexOf('>', sOpen) : -1;
      const sClose = sGt >= 0 ? head.slice(sGt + 1).search(/<\/summary\s*>/i) : -1;
      let label = '';
      if (sClose >= 0) {
        const inner = head.slice(sGt + 1, sGt + 1 + sClose);
        const end = head.indexOf('>', sGt + 1 + sClose) + 1;
        body = body.slice(0, sOpen) + body.slice(end);
        label = inner.replace(/\s+/g, ' ').trim();
      }
      out.push(
        <details key={out.length} data-brain-md-details className="my-1">
          <summary className="cursor-pointer select-none text-[var(--text-sub)]">
            {label ? renderInline(label, `ds${out.length}-`, opts) : 'Details'}
          </summary>
          <div className="pl-3 border-l-2 border-[var(--line)]">
            {renderBlocks(body, opts, depth + 1, budget)}
          </div>
        </details>,
      );
      continue;
    }

    // Blockquote: consecutive `>` lines, rendered (recursively) inside a quiet bar.
    if (depth < MAX_QUOTE_DEPTH && /^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      out.push(
        <blockquote
          key={out.length}
          data-brain-md-quote
          className="my-1 pl-3 border-l-2 border-[var(--line)] text-[var(--text-sub)]"
        >
          {renderBlocks(quoted.join('\n'), opts, depth + 1, budget)}
        </blockquote>,
      );
      continue;
    }

    // Heading (# .. ###; deeper levels read fine as bold text).
    const heading = line.match(/^(#{1,3})\s+(.+)/);
    if (heading) {
      const level = heading[1].length;
      const sizes = ['text-[14px] font-bold', 'text-[13.5px] font-bold', 'text-[13px] font-semibold'];
      out.push(
        <div key={out.length} data-brain-md-heading className={`${sizes[level - 1]} text-[var(--text-main)] mt-1.5 mb-0.5`}>
          {renderInline(heading[2], `h${out.length}-`, opts)}
        </div>,
      );
      i++;
      continue;
    }

    // List item — bullets (- *) and numbered (1. / 1)).
    const bullet = line.match(/^(\s*)[-*]\s+(.+)/);
    const numbered = bullet ? null : line.match(/^(\s*)(\d{1,3})[.)]\s+(.+)/);
    if (bullet || numbered) {
      const indentStr = (bullet ? bullet[1] : numbered![1]) ?? '';
      const indent = Math.floor(indentStr.length / 2);
      const marker = bullet ? '•' : `${numbered![2]}.`;
      const body = bullet ? bullet[2] : numbered![3];
      // Task-list item (- [ ] / - [x]): a read-only checkbox, labelled by its text.
      const task = bullet ? body.match(/^\[([ xX])\]\s+(.*)$/) : null;
      if (task) {
        out.push(
          <label
            key={out.length}
            data-brain-md-task
            className="flex items-start gap-1.5 leading-relaxed"
            style={{ paddingLeft: `${indent * 12 + 2}px` }}
          >
            <input type="checkbox" checked={task[1] !== ' '} disabled readOnly className="mt-[3px] shrink-0" />
            <span className="min-w-0 break-words">{renderInline(task[2], `tk${out.length}-`, opts)}</span>
          </label>,
        );
        i++;
        continue;
      }
      out.push(
        <div
          key={out.length}
          data-brain-md-li
          className="flex leading-relaxed"
          style={{ paddingLeft: `${indent * 12 + 2}px` }}
        >
          <span className="mr-1.5 shrink-0 text-[var(--text-sub)]">{marker}</span>
          <span className="min-w-0 break-words">{renderInline(body, `li${out.length}-`, opts)}</span>
        </div>,
      );
      i++;
      continue;
    }

    // Blank line → small vertical gap.
    if (line.trim() === '') {
      out.push(<div key={out.length} className="h-1.5" />);
      i++;
      continue;
    }

    // A line that was only markup (a lone <p>, <div>, </summary>) is a gap.
    if (opts.githubHtml && reduceInlineHtml(line).trim() === '') {
      out.push(<div key={out.length} className="h-1.5" />);
      i++;
      continue;
    }

    // Paragraph line.
    out.push(
      <div key={out.length} data-brain-md-p className="leading-relaxed break-words">
        {renderInline(line, `p${out.length}-`, opts)}
      </div>,
    );
    i++;
  }
  return out;
}
