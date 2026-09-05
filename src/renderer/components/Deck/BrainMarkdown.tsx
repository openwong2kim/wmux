// ─── Command Deck — orchestrator prose markdown (dep-free subset) ────────────
//
// The orchestrator's replies are model prose — headings, lists, code fences,
// bold — and rendering them as raw text made every reply read like a diff.
// This is a deliberately tiny, dependency-free markdown SUBSET renderer for
// the brain bubble: fenced code blocks, #/##/### headings, bullet + numbered
// lists, and inline bold / italic / `code` / [links]. Anything else stays
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

/** Inline subset: `code`, **bold**, *italic*, [label](url). Bold before
 *  italic so ** never half-matches. */
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const regex = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\n]+\))/g;
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
          className="px-1 rounded font-mono text-[12px] bg-[color-mix(in_srgb,var(--bg-surface)_65%,transparent)] text-[var(--text-sub)]"
        >
          {m.slice(1, -1)}
        </code>,
      );
    } else if (m.startsWith('**')) {
      parts.push(
        <strong key={`${keyPrefix}b${match.index}`} className="font-semibold text-[var(--text-main)]">
          {renderInline(m.slice(2, -2), `${keyPrefix}b${match.index}-`)}
        </strong>,
      );
    } else if (m.startsWith('*')) {
      parts.push(
        <em key={`${keyPrefix}i${match.index}`} className="italic">
          {m.slice(1, -1)}
        </em>,
      );
    } else {
      const link = m.match(/\[([^\]]+)\]\(([^)]+)\)/);
      if (link) {
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

/** Render orchestrator prose as chat-bubble markdown. Pure — safe to call on
 *  every streaming re-render. */
export function renderBrainMarkdown(source: string): React.ReactNode[] {
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
          className="my-1 px-2 py-1.5 rounded overflow-x-auto font-mono text-[12px] leading-relaxed whitespace-pre bg-[var(--bg-surface)] text-[var(--text-sub)]"
        >
          {codeLines.join('\n')}
        </pre>,
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
          {renderInline(heading[2], `h${out.length}-`)}
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
      out.push(
        <div
          key={out.length}
          data-brain-md-li
          className="flex leading-relaxed"
          style={{ paddingLeft: `${indent * 12 + 2}px` }}
        >
          <span className="mr-1.5 shrink-0 text-[var(--text-sub)]">{marker}</span>
          <span className="min-w-0 break-words">{renderInline(body, `li${out.length}-`)}</span>
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
        {renderInline(line, `p${out.length}-`)}
      </div>,
    );
    i++;
  }
  return out;
}
