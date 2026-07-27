// The Chat View markdown subset (markdown.ts) — pure, no DOM.
//
// Two things are being pinned here: that the subset an agent actually writes
// gets STRUCTURE, and that everything else degrades to LITERAL TEXT. The second
// half is the safety half: transcript prose is untrusted, and a stray marker
// must never swallow the rest of a message.

import { describe, it, expect } from 'vitest';
import { parseMarkdown, parseInline, type InlineNode } from '../markdown';

/** Flatten a node tree back to the text a reader would see. */
function plain(nodes: InlineNode[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case 'text':
        case 'code':
          return n.text;
        case 'link':
          return n.text;
        case 'codeRef':
          return n.literal;
        default:
          return plain(n.children);
      }
    })
    .join('');
}

describe('parseInline', () => {
  it('renders bold, italic and inline code as structure, not as markers', () => {
    const nodes = parseInline('**bold** and *soft* and `code()`');
    expect(nodes.map((n) => n.type)).toEqual(['strong', 'text', 'em', 'text', 'code']);
    expect(plain(nodes)).toBe('bold and soft and code()');
  });

  it('handles the live regression: **`calculator.html`**', () => {
    const nodes = parseInline('open **`calculator.html`** now');
    const strong = nodes.find((n) => n.type === 'strong')!;
    expect(strong).toBeDefined();
    expect(strong.type === 'strong' && strong.children[0].type).toBe('code');
    expect(plain(nodes)).toBe('open calculator.html now');
  });

  it('leaves an UNMATCHED bold marker as literal text and keeps the rest', () => {
    const nodes = parseInline('a ** dangling marker and more prose');
    expect(nodes.every((n) => n.type === 'text')).toBe(true);
    expect(plain(nodes)).toBe('a ** dangling marker and more prose');
  });

  it('leaves a stray backtick literal instead of eating the tail', () => {
    const nodes = parseInline('cost is 3 ` and the rest survives');
    expect(nodes.every((n) => n.type === 'text')).toBe(true);
    expect(plain(nodes)).toBe('cost is 3 ` and the rest survives');
  });

  it('does not mangle snake_case or arithmetic', () => {
    expect(plain(parseInline('call some_var_name here'))).toBe('call some_var_name here');
    expect(parseInline('call some_var_name here').every((n) => n.type === 'text')).toBe(true);
    expect(parseInline('2 * 3 * 4').every((n) => n.type === 'text')).toBe(true);
  });

  it('keeps a link as text, carrying the target for display only', () => {
    const nodes = parseInline('see [the docs](https://example.test/x) for more');
    const link = nodes.find((n) => n.type === 'link')!;
    expect(link).toEqual({ type: 'link', text: 'the docs', href: 'https://example.test/x' });
    expect(plain(nodes)).toBe('see the docs for more');
  });

  it('keeps the projector code marker as its own node', () => {
    const nodes = parseInline('before \u0000code:3\u0000 after');
    expect(nodes[1]).toEqual({ type: 'codeRef', n: 3, literal: 'code:3' });
  });

  it('bounds emphasis nesting instead of recursing on adversarial input', () => {
    const nested = `${'*'.repeat(40)}x${'*'.repeat(40)}`;
    expect(() => parseInline(nested)).not.toThrow();
    expect(plain(parseInline(nested))).toContain('x');
  });

  it('never produces a node type that could carry markup', () => {
    const nodes = parseInline('<script>alert(1)</script> **<img onerror=x>**');
    const types = new Set<string>();
    const walk = (ns: InlineNode[]): void => {
      for (const n of ns) {
        types.add(n.type);
        if (n.type === 'strong' || n.type === 'em') walk(n.children);
      }
    };
    walk(nodes);
    expect([...types].every((tp) => ['text', 'code', 'strong', 'em', 'link', 'codeRef'].includes(tp))).toBe(true);
    // The angle brackets are ordinary characters in the tree; nothing parses them.
    expect(plain(nodes)).toBe('<script>alert(1)</script> <img onerror=x>');
  });
});

describe('parseMarkdown', () => {
  it('turns "- item" lines into a list instead of printing the hyphens', () => {
    const blocks = parseMarkdown('Plan:\n- read the file\n- patch it\n- run the gate');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'list']);
    const list = blocks[1];
    expect(list.type === 'list' && list.ordered).toBe(false);
    expect(list.type === 'list' && list.items.map((i) => plain(i.children))).toEqual([
      'read the file',
      'patch it',
      'run the gate',
    ]);
  });

  it('parses an ordered list and keeps it separate from a bullet list', () => {
    const blocks = parseMarkdown('1. first\n2. second\n\n- bullet');
    expect(blocks.map((b) => b.type)).toEqual(['list', 'list']);
    expect(blocks[0].type === 'list' && blocks[0].ordered).toBe(true);
    expect(blocks[1].type === 'list' && blocks[1].ordered).toBe(false);
  });

  it('indents a nested item by depth rather than nesting lists', () => {
    const blocks = parseMarkdown('- top\n  - nested');
    expect(blocks[0].type === 'list' && blocks[0].items.map((i) => i.depth)).toEqual([0, 1]);
  });

  it('parses headings by level and blockquotes', () => {
    const blocks = parseMarkdown('## Summary\n\n> quoted line\n\nbody');
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'quote', 'paragraph']);
    expect(blocks[0].type === 'heading' && blocks[0].level).toBe(2);
    expect(blocks[1].type === 'quote' && plain(blocks[1].children)).toBe('quoted line');
  });

  it('leaves a bare hyphen rule and a hash-without-space as literal prose', () => {
    const blocks = parseMarkdown('---\n#hashtag');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph']);
    expect(blocks[0].type === 'paragraph' && plain(blocks[0].children)).toBe('---\n#hashtag');
  });

  it('preserves soft line breaks inside a paragraph', () => {
    const blocks = parseMarkdown('line one\nline two');
    expect(blocks[0].type === 'paragraph' && plain(blocks[0].children)).toBe('line one\nline two');
  });

  it('returns nothing for empty prose', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('\n\n')).toEqual([]);
  });
});
