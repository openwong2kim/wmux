// The Chat View markdown subset (markdown.ts) — pure, no DOM.
//
// Two things are being pinned here: that the subset an agent actually writes
// gets STRUCTURE, and that everything else degrades to LITERAL TEXT. The second
// half is the safety half: transcript prose is untrusted, and a stray marker
// must never swallow the rest of a message.

import { describe, it, expect } from 'vitest';
import { parseMarkdown, parseInline, type Block, type InlineNode } from '../markdown';

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

// ─── GFM pipe tables (2026-07-28) ───────────────────────────────────────────
//
// Detection is anchored on the DELIMITER row, which is what keeps ordinary
// prose full of pipes from being swallowed by a table it never asked for.

describe('parseMarkdown — tables', () => {
  /** The visible text of a table, row by row (header first). */
  function grid(block: Block): string[][] {
    if (block.type !== 'table') throw new Error(`expected a table, got ${block.type}`);
    return [block.header, ...block.rows].map((row) => row.map(plain));
  }

  it('parses a basic table into a header and body rows', () => {
    const blocks = parseMarkdown('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(blocks.map((b) => b.type)).toEqual(['table']);
    expect(grid(blocks[0])).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('reads alignment off the delimiter row', () => {
    const blocks = parseMarkdown(
      '| l | c | r | d |\n| :--- | :---: | ---: | --- |\n| 1 | 2 | 3 | 4 |',
    );
    expect(blocks[0].type === 'table' && blocks[0].align).toEqual(['left', 'center', 'right', null]);
  });

  it('tolerates spaces in the delimiter row', () => {
    const blocks = parseMarkdown('| a | b |\n|  :---  |  ---:  |\n| 1 | 2 |');
    expect(blocks[0].type === 'table' && blocks[0].align).toEqual(['left', 'right']);
  });

  it('accepts tables with no outer pipes', () => {
    const blocks = parseMarkdown('a | b\n--- | ---\n1 | 2');
    expect(grid(blocks[0])).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps an escaped pipe inside its cell, as a literal pipe', () => {
    const blocks = parseMarkdown('| pattern | note |\n|---|---|\n| a \\| b | alternation |');
    expect(grid(blocks[0])[1]).toEqual(['a | b', 'alternation']);
  });

  it('pads a short row and truncates a long one (GFM)', () => {
    const blocks = parseMarkdown('| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | 4 |');
    expect(grid(blocks[0])).toEqual([
      ['a', 'b', 'c'],
      ['1', '', ''],
      ['1', '2', '3'],
    ]);
  });

  it('parses inline markdown inside cells, including projector code refs', () => {
    const blocks = parseMarkdown(
      '| what | where |\n|---|---|\n| **bold** `code()` | \u0000code:3\u0000 |',
    );
    if (blocks[0].type !== 'table') throw new Error('expected a table');
    const [what, where] = blocks[0].rows[0];
    expect(what.map((n) => n.type)).toEqual(['strong', 'text', 'code']);
    expect(plain(what)).toBe('bold code()');
    expect(where[0]).toEqual({ type: 'codeRef', n: 3, literal: 'code:3' });
  });

  it('renders a link inside a cell as text, never as a target', () => {
    const blocks = parseMarkdown('| doc |\n|---|\n| [readme](./README.md) |');
    if (blocks[0].type !== 'table') throw new Error('expected a table');
    expect(blocks[0].rows[0][0][0]).toEqual({
      type: 'link',
      text: 'readme',
      href: './README.md',
    });
  });

  it('leaves pipe-containing prose alone when there is no delimiter row', () => {
    const blocks = parseMarkdown('run a | b | c and then\nsomething else | here');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph']);
    expect(blocks[0].type === 'paragraph' && plain(blocks[0].children)).toBe(
      'run a | b | c and then\nsomething else | here',
    );
  });

  it('is not a table when the delimiter width disagrees with the header', () => {
    expect(parseMarkdown('| a | b | c |\n|---|---|').map((b) => b.type)).toEqual(['paragraph']);
  });

  it('is not a table when the delimiter row is not made of dashes', () => {
    expect(parseMarkdown('| a | b |\n| x | y |').map((b) => b.type)).toEqual(['paragraph']);
  });

  it('sits between other blocks without eating them', () => {
    const blocks = parseMarkdown(
      '## Results\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nAnd that is the summary.',
    );
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'table', 'paragraph']);
    expect(blocks[2].type === 'paragraph' && plain(blocks[2].children)).toBe(
      'And that is the summary.',
    );
  });

  it('ends at the first pipe-less line, so a trailing paragraph survives', () => {
    const blocks = parseMarkdown('| a |\n|---|\n| 1 |\nplain trailing prose');
    expect(blocks.map((b) => b.type)).toEqual(['table', 'paragraph']);
    expect(blocks[1].type === 'paragraph' && plain(blocks[1].children)).toBe(
      'plain trailing prose',
    );
  });

  it('interrupts a paragraph and closes an open list', () => {
    expect(parseMarkdown('intro line\n| a | b |\n|---|---|\n| 1 | 2 |').map((b) => b.type)).toEqual(
      ['paragraph', 'table'],
    );
    expect(parseMarkdown('- item\n| a | b |\n|---|---|\n| 1 | 2 |').map((b) => b.type)).toEqual([
      'list',
      'table',
    ]);
  });

  it('parses a table that is the last block with no trailing newline', () => {
    const blocks = parseMarkdown('text\n\n| a | b |\n|---|---|\n| 1 | 2 |');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'table']);
    expect(grid(blocks[1])[1]).toEqual(['1', '2']);
  });

  it('accepts a header-only table with no body rows', () => {
    const blocks = parseMarkdown('| a | b |\n|---|---|');
    expect(blocks[0].type === 'table' && blocks[0].rows).toEqual([]);
  });

  it('never throws on adversarial pipe soup', () => {
    for (const src of ['|', '||', '|\n|', '|---|', '\\|', '| a |\n|-|\n|', '|:|\n|:|']) {
      expect(() => parseMarkdown(src)).not.toThrow();
    }
  });
});
