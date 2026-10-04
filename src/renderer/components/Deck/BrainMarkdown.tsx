// Adapted from MonoCode (hardbeat920/monocode@6bd432ca, src/features/sessions/ui/AgentTranscript.tsx), MIT License, Copyright (c) 2026 Nick
// ─── Command Deck — orchestrator prose markdown (dep-free subset) ────────────
//
// The orchestrator's replies are model prose — headings, lists, code fences,
// bold — and rendering them as raw text made every reply read like a diff.
// This is a deliberately tiny, dependency-free markdown SUBSET renderer for
// the brain bubble: fenced code blocks, #/##/### headings, bullet + numbered
// lists (with read-only task checkboxes), GFM tables, and inline bold /
// italic / `code` / [links]. Anything else stays
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
}

const HTTP_URL = /^https?:\/\//i;

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
function renderInline(text: string, keyPrefix: string, opts: MarkdownOptions = {}): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const regex = opts.links
    ? /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\n]+\))|(https?:\/\/[^\s<>()[\]]*[^\s<>()[\].,;:!?'"])/g
    : /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\n]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    const m = match[0];
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
      parts.push(<ExternalLink key={`${keyPrefix}u${match.index}`} url={m}>{m}</ExternalLink>);
    } else {
      const link = m.match(/\[([^\]]+)\]\(([^)]+)\)/);
      if (link && opts.links && HTTP_URL.test(link[2].trim())) {
        parts.push(<ExternalLink key={`${keyPrefix}l${match.index}`} url={link[2].trim()}>{link[1]}</ExternalLink>);
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
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts.length > 0 ? parts : [text];
}

/** A GFM table delimiter row: `| --- | :--: |`, at least one pipe. */
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

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
  const lines = source.split('\n');
  const out: React.ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block (an unclosed fence swallows to the end — streaming).
    if (line.trimStart().startsWith('```')) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip the closing fence (or run past the end)
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
      const head = tableCells(line);
      const align = tableCells(lines[i + 1]).map(tableAlign);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(tableCells(lines[i]));
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
