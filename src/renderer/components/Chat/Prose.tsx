// Renders the Chat View markdown subset (see markdown.ts) as React elements.
//
// React elements ONLY — there is no `dangerouslySetInnerHTML` here and there
// must never be one: transcript prose is untrusted input (an agent, or a tool
// result an agent pasted, can contain anything), so every string lands as a
// React text child and is escaped by construction.
//
// DESIGN.md: prose in sans, logs in mono → inline code is the one mono run
// inside a sentence. Every colour is a token or a color-mix on one, so light
// themes inherit. Headings stay on the 13/14px scale — this is a chat row, not
// a document.

import React from 'react';
import { parseMarkdown, type Block, type InlineNode } from './markdown';

export interface ProseProps {
  text: string;
  /**
   * Renders a projector code-block marker. Absent (or returning null) → the
   * marker shows as literal text rather than deleting the run it stands in.
   */
  renderCodeRef?: (n: number) => React.ReactNode;
  /** Applied to the root; carries the row's size/colour treatment. */
  className?: string;
}

const INLINE_CODE_STYLE: React.CSSProperties = {
  background: 'color-mix(in srgb, var(--text-main) 8%, transparent)',
  color: 'var(--text-sub)',
};

const QUOTE_STYLE: React.CSSProperties = {
  borderLeft: '2px solid color-mix(in srgb, var(--text-main) 14%, transparent)',
};

// DESIGN.md: a table is machine-ish evidence living in prose, so it stays
// quiet — 1px hairlines, NO fills anywhere (the header row is differentiated by
// weight alone, per the no-wash rule), tabular figures so numeric columns line
// up. Every colour is a color-mix on a token, so light themes inherit.
const TABLE_STYLE: React.CSSProperties = {
  borderCollapse: 'collapse',
  fontVariantNumeric: 'tabular-nums',
};

const TABLE_CELL_STYLE: React.CSSProperties = {
  border: '1px solid color-mix(in srgb, var(--text-main) 12%, transparent)',
};

/**
 * Layout containment. A chat pane can be narrow and a table's minimum width is
 * the sum of its columns' min-content widths — which can exceed the row. The
 * table scrolls INSIDE this box; `maxWidth: 100%` is what stops it widening the
 * row (and, through it, the pane), so the page never scrolls sideways.
 */
const TABLE_SCROLL_STYLE: React.CSSProperties = {
  maxWidth: '100%',
  overflowX: 'auto',
  minWidth: 0,
};

function renderInline(
  nodes: InlineNode[],
  keyPrefix: string,
  renderCodeRef?: (n: number) => React.ReactNode,
): React.ReactNode[] {
  return nodes.map((node, i) => {
    const key = `${keyPrefix}.${i}`;
    switch (node.type) {
      case 'text':
        return <React.Fragment key={key}>{node.text}</React.Fragment>;
      case 'code':
        return (
          <code
            key={key}
            data-chat-inline-code
            className="font-mono text-[0.92em] rounded-[4px] px-1 py-px break-words"
            style={INLINE_CODE_STYLE}
          >
            {node.text}
          </code>
        );
      case 'strong':
        return (
          <strong key={key} className="font-semibold text-[var(--text-main)]">
            {renderInline(node.children, key, renderCodeRef)}
          </strong>
        );
      case 'em':
        return (
          <em key={key} className="italic">
            {renderInline(node.children, key, renderCodeRef)}
          </em>
        );
      case 'link':
        // Text, not navigation: Chat View never opens anything a transcript
        // asked it to. The target is visible on hover and nowhere else.
        return (
          <span
            key={key}
            data-chat-link
            title={node.href}
            className="underline decoration-dotted underline-offset-2 decoration-[color-mix(in_srgb,var(--text-main)_35%,transparent)]"
          >
            {node.text}
          </span>
        );
      case 'codeRef': {
        const chip = renderCodeRef?.(node.n);
        if (chip) return <React.Fragment key={key}>{chip}</React.Fragment>;
        return <React.Fragment key={key}>{node.literal}</React.Fragment>;
      }
      default:
        return null;
    }
  });
}

function renderBlock(
  block: Block,
  key: string,
  renderCodeRef?: (n: number) => React.ReactNode,
): React.ReactElement {
  switch (block.type) {
    case 'heading':
      return (
        <div
          key={key}
          role="heading"
          aria-level={block.level}
          data-chat-md="heading"
          className={`font-semibold text-[var(--text-main)] ${
            block.level <= 2 ? 'text-[14px]' : 'text-[13px]'
          }`}
        >
          {renderInline(block.children, key, renderCodeRef)}
        </div>
      );
    case 'list':
      return (
        <ul
          key={key}
          data-chat-md={block.ordered ? 'ordered-list' : 'list'}
          className="flex flex-col gap-0.5 list-none"
        >
          {block.items.map((item, i) => (
            <li
              key={`${key}.${i}`}
              className="flex gap-1.5"
              style={{ paddingLeft: item.depth * 12 }}
            >
              <span className="select-none text-[var(--text-muted)]" aria-hidden="true">
                {block.ordered ? `${i + 1}.` : '•'}
              </span>
              <span className="flex-1 min-w-0 whitespace-pre-wrap break-words">
                {renderInline(item.children, `${key}.${i}`, renderCodeRef)}
              </span>
            </li>
          ))}
        </ul>
      );
    case 'table':
      return (
        <div key={key} data-chat-md="table-scroll" style={TABLE_SCROLL_STYLE}>
          <table data-chat-md="table" style={TABLE_STYLE}>
            <thead>
              <tr>
                {block.header.map((cell, c) => (
                  <th
                    key={`${key}.h${c}`}
                    scope="col"
                    className="px-2 py-1 align-top font-semibold text-[var(--text-main)] break-words"
                    style={{ ...TABLE_CELL_STYLE, textAlign: block.align[c] ?? 'left' }}
                  >
                    {renderInline(cell, `${key}.h${c}`, renderCodeRef)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={`${key}.r${r}`}>
                  {row.map((cell, c) => (
                    <td
                      key={`${key}.r${r}.${c}`}
                      className="px-2 py-1 align-top break-words"
                      style={{ ...TABLE_CELL_STYLE, textAlign: block.align[c] ?? 'left' }}
                    >
                      {renderInline(cell, `${key}.r${r}.${c}`, renderCodeRef)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'quote':
      return (
        <blockquote
          key={key}
          data-chat-md="quote"
          className="pl-2 text-[var(--text-sub)] whitespace-pre-wrap break-words"
          style={QUOTE_STYLE}
        >
          {renderInline(block.children, key, renderCodeRef)}
        </blockquote>
      );
    default:
      return (
        <p key={key} data-chat-md="paragraph" className="whitespace-pre-wrap break-words">
          {renderInline(block.children, key, renderCodeRef)}
        </p>
      );
  }
}

/** One prose body: the markdown subset, rendered as elements. */
export function Prose({ text, renderCodeRef, className }: ProseProps): React.ReactElement {
  const blocks = React.useMemo(() => parseMarkdown(text), [text]);
  return (
    // `min-w-0`: a table's min-content width must never be able to push the
    // prose column (and with it the pane) wider than its container.
    <div className={`flex flex-col gap-1.5 min-w-0 ${className ?? ''}`} data-chat-text>
      {blocks.map((block, i) => renderBlock(block, `b${i}`, renderCodeRef))}
    </div>
  );
}

export default Prose;
