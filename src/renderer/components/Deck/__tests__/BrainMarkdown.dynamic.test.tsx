// @vitest-environment jsdom
//
// Render tests for the dep-free orchestrator-prose markdown subset: fenced
// code, headings, bullet/numbered lists, inline bold/italic/code/links —
// and the CommanderView wiring (assistant = markdown, user = literal).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderBrainMarkdown } from '../BrainMarkdown';
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
