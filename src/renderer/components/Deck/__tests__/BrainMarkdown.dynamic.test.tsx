// @vitest-environment jsdom
//
// Render tests for the dep-free orchestrator-prose markdown subset: fenced
// code, headings, bullet/numbered lists, inline bold/italic/code/links —
// and the CommanderView wiring (assistant = markdown, user = literal).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderBrainMarkdown, MAX_QUOTE_DEPTH, MAX_BLOCKS } from '../BrainMarkdown';
import { CommanderViewContent, type CommanderViewContentProps } from '../CommanderView';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(source: string): void {
  act(() => {
    root.render(createElement('div', null, renderBrainMarkdown(source)));
  });
}

describe('renderBrainMarkdown', () => {
  const gh = (src: string) => act(() => {
    root.render(createElement('div', null, renderBrainMarkdown(src, { links: true, githubHtml: true })));
  });

  it('GitHub HTML: a CodeRabbit-style comment renders comments hidden, details collapsed, tags as text', () => {
    gh([
      '<!-- This is an auto-generated comment: summarize by coderabbit.ai -->',
      '> [!WARNING]',
      '> ## Review limit reached',
      '<details>',
      '<summary>View limit details</summary>',
      '',
      '**Limit details:** You used <b>all 2</b> reviews.<br>Next one in 15 minutes.',
      '<img src="https://x/y.png" alt="rabbit"> <a href="https://coderabbit.ai/usage">usage</a> <a href="javascript:alert(1)">bad</a>',
      '</details>',
      '<!-- tips_start -->',
      'Thanks &amp; enjoy &lt;3',
    ].join('\n'));
    expect(container.textContent).not.toContain('auto-generated');
    expect(container.textContent).not.toContain('tips_start');
    expect(container.textContent).not.toMatch(/<\/?(details|summary|b|img|a)\b/);
    const d = container.querySelector('details[data-brain-md-details]') as HTMLDetailsElement;
    expect(d.open).toBe(false);
    expect(d.querySelector('summary')?.textContent).toBe('View limit details');
    expect(d.querySelector('strong')?.textContent).toBe('Limit details:');
    expect(d.textContent).toContain('You used all 2 reviews.');
    expect(d.textContent).toContain('Next one in 15 minutes.');
    expect(d.textContent).toContain('rabbit');
    const links = [...d.querySelectorAll('a')].map((x) => x.getAttribute('href'));
    expect(links).toEqual(['https://coderabbit.ai/usage']);
    expect(d.textContent).toContain('bad');
    expect(container.textContent).toContain('Thanks & enjoy <3');
  });

  it('GitHub HTML: nested details, each with its own summary', () => {
    gh('<details><summary>Outer</summary>\nouter body\n<details>\n<summary>Inner</summary>\ninner body\n</details>\n</details>\nafter');
    const outer = container.querySelector('details[data-brain-md-details]')!;
    expect(outer.querySelector(':scope > summary')?.textContent).toBe('Outer');
    const inner = outer.querySelector('details[data-brain-md-details]')!;
    expect(inner.querySelector(':scope > summary')?.textContent).toBe('Inner');
    expect(inner.textContent).toContain('inner body');
    expect(outer.textContent).toContain('outer body');
    expect(container.lastElementChild?.textContent).toContain('after');
  });

  it('GitHub HTML: script and style are dropped and never run; details nesting is capped', () => {
    gh('a<script>window.__md = 1</script>b\n<style>body{display:none}</style>\n' + '<details><summary>x</summary>\n'.repeat(50) + 'deep' + '\n</details>'.repeat(50));
    expect(container.querySelector('script, style')).toBeNull();
    expect(container.textContent).not.toContain('window.__md');
    expect(container.textContent).not.toContain('display:none');
    expect((window as unknown as { __md?: unknown }).__md).toBeUndefined();
    expect(container.textContent).toContain('ab');
    let depth = 0;
    let d = container.querySelector('details[data-brain-md-details]');
    while (d) { depth++; d = d.querySelector('details[data-brain-md-details]'); }
    expect(depth).toBe(MAX_QUOTE_DEPTH);
    expect(container.textContent).toContain('deep');
  });

  it('GitHub HTML stays out of code: fences and spans keep their tags', () => {
    gh('use `<div>` here\n```\n<!-- keep -->\n<br>\n```');
    expect(container.querySelector('[data-brain-md-code-inline]')?.textContent).toBe('<div>');
    expect(container.querySelector('[data-brain-md-code]')?.textContent).toBe('<!-- keep -->\n<br>');
  });

  it('without the GitHub option, HTML stays literal text (the deck)', () => {
    render('<details><summary>x</summary></details>');
    expect(container.querySelector('details')).toBeNull();
    expect(container.textContent).toContain('<details>');
  });

  it('a body of 16000 > does not overflow: quotes stop nesting at the cap and the rest is text', () => {
    expect(() => render('>'.repeat(16000))).not.toThrow();
    let depth = 0;
    let q = container.querySelector('[data-brain-md-quote]');
    while (q) {
      depth++;
      q = q.querySelector('[data-brain-md-quote]');
    }
    expect(depth).toBe(MAX_QUOTE_DEPTH);
    expect(container.textContent).toContain('>'.repeat(100));
  });

  it('caps the blocks drawn for a huge body', () => {
    expect(() => render('line\n'.repeat(MAX_BLOCKS * 3))).not.toThrow();
    expect(container.querySelectorAll('[data-brain-md-p]').length).toBeLessThanOrEqual(MAX_BLOCKS);
    expect(container.querySelector('[data-brain-md-cut]')).not.toBeNull();
  });

  it('renders consecutive > lines as one blockquote, markdown inside', () => {
    render('before\n> ## Limit\n> **bold** text\n>\n> - item\nafter');
    const q = container.querySelectorAll('[data-brain-md-quote]');
    expect(q).toHaveLength(1);
    expect(q[0].querySelector('[data-brain-md-heading]')?.textContent).toBe('Limit');
    expect(q[0].querySelector('strong')?.textContent).toBe('bold');
    expect(q[0].querySelector('[data-brain-md-li]')?.textContent).toContain('item');
    expect(container.textContent).not.toContain('>');
  });

  it('keeps links inert by default (the deck never navigates)', () => {
    render('see [docs](https://example.com) and https://example.com/x');
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toContain('https://example.com/x');
  });

  it('with links on: http(s) links and bare URLs are real links opened through window.open', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    try {
      act(() => {
        root.render(createElement('div', null, renderBrainMarkdown(
          'see [docs](https://example.com/a), https://example.com/b. and [bad](javascript:alert(1))',
          { links: true },
        )));
      });
      const links = [...container.querySelectorAll('a')];
      expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com/a', 'https://example.com/b']);
      expect(links[0].textContent).toBe('docs');
      expect(links[0].getAttribute('rel')).toBe('noopener noreferrer');
      // A non-http link stays an inert span.
      expect(container.textContent).toContain('bad');
      expect(container.querySelector('a[href^="javascript"]')).toBeNull();
      const click = new MouseEvent('click', { bubbles: true, cancelable: true });
      act(() => { links[1].dispatchEvent(click); });
      expect(click.defaultPrevented).toBe(true);
      expect(open).toHaveBeenCalledWith('https://example.com/b', '_blank');
    } finally {
      open.mockRestore();
    }
  });

  it('renders task-list items as read-only checkboxes', () => {
    render('- [ ] todo\n- [x] done\n- plain');
    const boxes = [...container.querySelectorAll('[data-brain-md-task] input[type="checkbox"]')] as HTMLInputElement[];
    expect(boxes.map((b) => [b.checked, b.disabled])).toEqual([[false, true], [true, true]]);
    expect(container.querySelectorAll('[data-brain-md-task]')[1].textContent).toBe('done');
    expect(container.querySelectorAll('[data-brain-md-li]')).toHaveLength(1);
  });

  it('renders a GFM table: header, body rows, alignment, inline markup, in its own scroll box', () => {
    render([
      'Seen in CI:',
      '| Test | Runner | Count |',
      '|:---|:---:|---:|',
      '| `a.test.ts` › **times out** | Windows | 3 |',
      '| b \\| c | macOS |',
      'after',
    ].join('\n'));
    const box = container.querySelector('[data-brain-md-table]') as HTMLElement;
    expect(box.className).toContain('overflow-x-auto');
    const table = box.querySelector('table')!;
    expect([...table.querySelectorAll('th')].map((th) => th.textContent)).toEqual(['Test', 'Runner', 'Count']);
    const rows = [...table.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(2);
    const first = [...rows[0].querySelectorAll('td')];
    expect(first[0].querySelector('code')?.textContent).toBe('a.test.ts');
    expect(first[0].querySelector('strong')?.textContent).toBe('times out');
    expect((table.querySelectorAll('th')[1] as HTMLElement).style.textAlign).toBe('center');
    expect((first[2] as HTMLElement).style.textAlign).toBe('right');
    // An escaped pipe stays in its cell; a short row is padded to the header.
    const second = [...rows[1].querySelectorAll('td')].map((td) => td.textContent);
    expect(second).toEqual(['b | c', 'macOS', '']);
    expect(container.textContent).toContain('Seen in CI:');
    expect(container.textContent).toContain('after');
    expect(container.textContent).not.toContain('|---');
  });

  it('keeps table cells as text: no HTML from a cell reaches the DOM', () => {
    render('| a | b |\n|---|---|\n| <script>window.__md = 1</script> | <img src=x onerror="window.__md = 2"> |');
    const table = container.querySelector('table')!;
    expect(table.querySelector('script, img')).toBeNull();
    expect(table.textContent).toContain('<script>window.__md = 1</script>');
    expect((window as unknown as { __md?: unknown }).__md).toBeUndefined();
  });

  it('leaves pipe text without a delimiter row as a paragraph', () => {
    render('a | b\nc | d');
    expect(container.querySelector('table')).toBeNull();
    expect(container.querySelectorAll('[data-brain-md-p]')).toHaveLength(2);
  });

  it('renders fenced code blocks as <pre>, literal content preserved', () => {
    render('before\n```ts\nconst a = 1;\n**not bold in code**\n```\nafter');
    const pre = container.querySelector('[data-brain-md-code]');
    expect(pre?.textContent).toBe('const a = 1;\n**not bold in code**');
    expect(pre?.querySelector('strong')).toBeNull();
    expect(container.textContent).toContain('before');
    expect(container.textContent).toContain('after');
  });

  it('an unclosed fence (mid-stream) swallows to the end as code', () => {
    render('streaming:\n```\nhalf of a block');
    expect(container.querySelector('[data-brain-md-code]')?.textContent).toBe('half of a block');
  });

  it('renders headings, bold, italic, and inline code', () => {
    render('## Status\nAll **good**, *mostly* — run `npm test`.');
    const h = container.querySelector('[data-brain-md-heading]');
    expect(h?.textContent).toBe('Status');
    expect(container.querySelector('strong')?.textContent).toBe('good');
    expect(container.querySelector('em')?.textContent).toBe('mostly');
    expect(container.querySelector('code')?.textContent).toBe('npm test');
    // DESIGN.md amber diet: inline code is machine evidence (mono on a faint
    // surface), not an attention point. It used to render in --accent, and a
    // single reply can carry dozens of them — enough on its own to blow the
    // 5±2 warm-meaning-point budget for the screen.
    const inlineCode = container.querySelector('[data-brain-md-code-inline]') as HTMLElement;
    expect(inlineCode).not.toBeNull();
    expect(inlineCode.className).toContain('font-mono');
    expect(inlineCode.className).toContain('--text-sub');
    expect(inlineCode.className).not.toContain('--accent');
  });

  it('renders bullet and numbered lists with markers', () => {
    render('- first\n  - nested\n1. one\n2) two');
    const items = container.querySelectorAll('[data-brain-md-li]');
    expect(items).toHaveLength(4);
    // The marker/body gap is CSS margin, so textContent concatenates.
    expect(items[0].textContent).toBe('•first');
    expect(items[1].textContent).toBe('•nested');
    expect((items[1] as HTMLElement).style.paddingLeft).not.toBe(
      (items[0] as HTMLElement).style.paddingLeft,
    );
    expect(items[2].textContent).toBe('1.one');
    expect(items[3].textContent).toBe('2.two');
  });

  it('renders links as inert spans with the URL on title (no navigation)', () => {
    render('see [the PR](https://example.com/pr/1)');
    const link = container.querySelector('span[title="https://example.com/pr/1"]');
    expect(link?.textContent).toBe('the PR');
    expect(container.querySelector('a')).toBeNull();
  });

  it('never injects HTML — markup in prose stays literal text', () => {
    render('evil <img src=x onerror=alert(1)> text');
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('CommanderView brain bubble markdown wiring', () => {
  function mount(props: Partial<CommanderViewContentProps>): void {
    const full: CommanderViewContentProps = {
      threads: [],
      brainMessages: [],
      brainBusy: false,
      onInterrupt: vi.fn(),
      mentionCandidates: [],
      onSubmit: vi.fn(async () => ({ ok: true })),
      onJumpToPane: vi.fn(),
      resolvePtyPane: () => null,
      workspaceName: () => undefined,
      t: (k: string) => k,
      ...props,
    };
    act(() => {
      root.render(createElement(CommanderViewContent, full));
    });
  }

  it('assistant prose renders markdown; the user message stays literal', () => {
    mount({
      brainMessages: [
        { id: 'u1', role: 'user', text: 'give me **status**' },
        { id: 'a1', role: 'assistant', text: '## Report\n- pane `w1-1` is **done**', status: 'done', tools: [] },
      ],
    });
    const bubbles = container.querySelectorAll('[data-commander-brain-text]');
    expect(bubbles).toHaveLength(2);
    // User bubble: the asterisks are literal.
    expect(bubbles[0].textContent).toBe('give me **status**');
    expect(bubbles[0].querySelector('strong')).toBeNull();
    // Assistant bubble: heading + list + inline formatting rendered.
    expect(bubbles[1].querySelector('[data-brain-md-heading]')?.textContent).toBe('Report');
    expect(bubbles[1].querySelector('[data-brain-md-li]')).not.toBeNull();
    expect(bubbles[1].querySelector('strong')?.textContent).toBe('done');
    expect(bubbles[1].querySelector('code')?.textContent).toBe('w1-1');
  });
});
