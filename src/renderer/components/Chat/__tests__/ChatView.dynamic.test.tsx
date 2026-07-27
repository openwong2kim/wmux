// @vitest-environment jsdom
//
// Rendering contract for Chat View (plan PR-7, PRD §4.2 / G1).
//
// The literal G1 assertion — "코드 일절 안 보이고" — is that the initial DOM
// contains ZERO <pre> elements: every code block is a chip until the operator
// asks for it. Diff-shaped output is a chip too, and never inline.
//
// Mounts the REAL ChatView against the REAL store (chatSlice, PR-5). The
// preload `chat` channel is deliberately absent, proving the surface renders
// before the integration wave wires IPC.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import ChatView from '../ChatView';
import { useStore } from '../../../stores';
import type { TurnEvent } from '../../../../shared/transcript/turnEvents';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PTY = 'pty-chat';

/** Explicit no-op (an empty arrow body is an ESLint error in this repo). */
const noop = (): void => undefined;

let container: HTMLDivElement;
let root: Root;

function seed(events: TurnEvent[]): void {
  useStore.getState().applyChatAppend(PTY, {
    seq: 1,
    reset: true,
    events,
    cursor: { headOffset: 0, tailOffset: 500, fileSize: 500, mtimeMs: 1 },
  });
  useStore.getState().setChatStatus(PTY, {
    available: true,
    reason: 'ok',
    transcriptBasename: '920b9112.jsonl',
  });
}

function mount(props: Partial<React.ComponentProps<typeof ChatView>> = {}): void {
  act(() => {
    root.render(
      React.createElement(ChatView, {
        ptyId: PTY,
        surfaceId: 'surf-1',
        workspaceId: 'ws-1',
        isActive: true,
        onJumpToTerminal: noop,
        ...props,
      }),
    );
  });
}

describe('ChatView', () => {
  beforeEach(() => {
    useStore.getState().clearChatSurface(PTY);
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      pty: { write: noop },
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useStore.getState().clearChatSurface(PTY);
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    vi.restoreAllMocks();
  });

  it('renders ZERO <pre> elements initially, even with code blocks in the turn', () => {
    seed([
      { id: 'u1', kind: 'user_text', text: 'refactor the reader' },
      {
        id: 'a1',
        kind: 'assistant_text',
        text: 'Here it is: \u0000code:1\u0000 — done.',
        codeBlocks: [{ n: 1, lang: 'ts', lines: 42, path: 'src/readTail.ts' }],
      },
    ]);
    mount();
    expect(container.querySelectorAll('pre')).toHaveLength(0);
    // …and the code is present as a chip that names its shape.
    const chip = container.querySelector('[data-chat-code-chip]')!;
    expect(chip.textContent).toContain('42 lines');
    expect(chip.textContent).toContain('src/readTail.ts');
  });

  it('expands a code block into a <pre> only when asked, via onFetchBody', async () => {
    seed([
      {
        id: 'a1',
        kind: 'assistant_text',
        text: 'see \u0000code:1\u0000',
        codeBlocks: [{ n: 1, lines: 3 }],
      },
    ]);
    const onFetchBody = vi.fn(async () => 'line1\nline2\nline3');
    mount({ onFetchBody });
    const btn = container.querySelector<HTMLButtonElement>('[data-chat-code-chip] button')!;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onFetchBody).toHaveBeenCalledWith('a1', 1);
    const pre = container.querySelector('pre')!;
    expect(pre.textContent).toBe('line1\nline2\nline3');
  });

  // The backtick marker form is REJECTED. It used to be accepted "for delimiter
  // tolerance", but backticks are ordinary prose: that made assistant-authored
  // text able to drive the marker parser, which is a forgery primitive in a view
  // whose whole job is to show the user what the agent actually said.
  it('ignores the backtick marker form — prose cannot forge a code chip', () => {
    seed([
      {
        id: 'a1',
        kind: 'assistant_text',
        text: 'patch: `code:2` applied',
        codeBlocks: [{ n: 2, lines: 7 }],
      },
    ]);
    mount();
    // No chip is minted from the prose…
    expect(container.querySelector('[data-chat-text] [data-chat-code-chip="2"]')).toBeNull();
    // …the run stays visible as what it is, an inline code span (the markdown
    // subset renders the backticks; it does not let them address the projector)…
    const inline = container.querySelector('[data-chat-inline-code]')!;
    expect(inline.textContent).toBe('code:2');
    expect(container.querySelector('[data-chat-text]')!.textContent).toBe('patch: code:2 applied');
    // …and the real block is still reachable, as an unreferenced one.
    expect(container.querySelector('[data-chat-code-chip="2"]')).not.toBeNull();
  });

  it('cannot be made to HIDE prose with a forged marker for a block that does not exist', () => {
    seed([
      {
        id: 'a1',
        kind: 'assistant_text',
        text: 'ignore this: `code:9` and this too',
      },
    ]);
    mount();
    const text = container.querySelector('[data-chat-text]')!.textContent;
    // Every word survives (the backticks become an inline code span, not a chip).
    expect(text).toBe('ignore this: code:9 and this too');
    expect(container.querySelector('[data-chat-code-chip="9"]')).toBeNull();
  });

  it('renders an UNKNOWN NUL marker as literal text instead of dropping it', () => {
    // A real projector marker whose block did not survive (truncated page,
    // rotated file). Silently deleting the run would remove content the user is
    // reading with no sign anything was there.
    seed([
      {
        id: 'a1',
        kind: 'assistant_text',
        text: 'before \u0000code:4\u0000 after',
        codeBlocks: [{ n: 1, lines: 2 }],
      },
    ]);
    mount();
    const text = container.querySelector('[data-chat-text]')!.textContent!;
    expect(text).toContain('before');
    expect(text).toContain('after');
    expect(text).toContain('code:4');
    expect(container.querySelector('[data-chat-code-chip="4"]')).toBeNull();
  });

  it('renders a diff-shaped result as a chip, never inline', () => {
    seed([
      { id: 'u1', kind: 'tool_use', toolUseId: 't1', name: 'Bash', argSummary: 'git diff' },
      { id: 'r1', kind: 'tool_result', toolUseId: 't1', ok: true, bytes: 4096, diffLike: true },
    ]);
    const onOpenDiff = vi.fn();
    mount({ onOpenDiff });
    const chip = container.querySelector<HTMLButtonElement>('[data-chat-diff-chip]')!;
    expect(chip).not.toBeNull();
    expect(container.querySelectorAll('pre')).toHaveLength(0);
    expect(chip.textContent).toContain('diff');
    act(() => {
      chip.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenDiff).toHaveBeenCalledWith('r1');
  });

  it('folds consecutive tool calls into one collapsed line that expands on click', () => {
    const events: TurnEvent[] = [];
    for (let i = 0; i < 3; i++) {
      events.push({ id: `u${i}`, kind: 'tool_use', toolUseId: `t${i}`, name: 'Read', argSummary: `file${i}` });
      events.push({ id: `r${i}`, kind: 'tool_result', toolUseId: `t${i}`, ok: true, bytes: 10 });
    }
    seed(events);
    mount();
    const runs = container.querySelectorAll('[data-chat-tool-run]');
    expect(runs).toHaveLength(1);
    const label = container.querySelector('[data-chat-tool-run-label]')!;
    expect(label.textContent).toBe('3 tool calls (Read ×3)');
    expect(container.querySelector('[data-chat-tool-run-calls]')).toBeNull();
    act(() => {
      runs[0].querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelectorAll('[data-chat-tool-call]')).toHaveLength(3);
  });

  it('separates speakers by label, not by bubble', () => {
    seed([
      { id: 'u1', kind: 'user_text', text: 'hello' },
      { id: 'a1', kind: 'assistant_text', text: 'hi' },
    ]);
    mount({ agentName: 'claude-1' });
    const speakers = [...container.querySelectorAll('[data-chat-speaker]')].map((el) => [
      el.getAttribute('data-chat-speaker'),
      el.textContent,
    ]);
    expect(speakers).toEqual([
      ['you', 'You'],
      ['agent', 'claude-1'],
    ]);
  });

  it('renders a pending composer echo from the store', () => {
    seed([{ id: 'u1', kind: 'user_text', text: 'landed' }]);
    mount();
    act(() => {
      useStore.getState().pushChatPending(PTY, 'just sent this');
    });
    const pendingRow = container.querySelector('[data-chat-pending="1"]')!;
    expect(pendingRow.textContent).toContain('just sent this');
    expect(pendingRow.textContent).toContain('sending…');
  });

  it('sends through the composer and echoes the line optimistically', () => {
    const writes: string[] = [];
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      pty: { write: (_id: string, data: string) => writes.push(data) },
    };
    seed([]);
    mount();
    const ta = container.querySelector<HTMLTextAreaElement>('[data-chat-input]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      setter.call(ta, 'ship it');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-chat-send]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(writes[0]).toContain('ship it');
    expect(useStore.getState().chatPending[PTY]?.[0]?.text).toBe('ship it');
    expect(container.querySelector('[data-chat-pending="1"]')?.textContent).toContain('ship it');
  });

  it('shows the trust seam with the transcript basename and a jump arrow', () => {
    const onJumpToTerminal = vi.fn();
    seed([]);
    mount({ onJumpToTerminal });
    const seam = container.querySelector('[data-chat-trust-seam]')!;
    expect(seam.textContent).toContain('920b9112.jsonl');
    expect(seam.textContent).toContain('ground truth');
    expect(seam.getAttribute('data-chat-trust-stale')).toBeNull();
    act(() => {
      container.querySelector<HTMLButtonElement>('[data-chat-jump-terminal]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onJumpToTerminal).toHaveBeenCalledTimes(1);
  });

  it('takes the warning treatment on the trust seam when the projection is stale', () => {
    seed([]);
    mount({ stale: true });
    const seam = container.querySelector('[data-chat-trust-seam]')!;
    expect(seam.getAttribute('data-chat-trust-stale')).toBe('1');
    expect(seam.textContent).toContain('may lag');
  });

  it('explains an unsupported agent instead of an empty conversation', () => {
    useStore.getState().setChatStatus(PTY, { available: false, reason: 'not-claude' });
    mount();
    expect(container.querySelector('[data-chat-unavailable]')?.textContent).toContain(
      "this agent doesn't publish one yet",
    );
  });

  it('offers "Load earlier" only when the window is not at the head of the file', () => {
    seed([{ id: 'u1', kind: 'user_text', text: 'x' }]);
    mount();
    expect(container.querySelector('[data-chat-load-earlier]')).toBeNull();
    act(() => {
      useStore.getState().applyChatAppend(PTY, {
        seq: 2,
        events: [],
        cursor: { headOffset: 4096, tailOffset: 9000, fileSize: 9000, mtimeMs: 2 },
      });
    });
    expect(container.querySelector('[data-chat-load-earlier]')).not.toBeNull();
  });

  it('hides itself with display:none when not visible', () => {
    seed([]);
    mount({ visible: false });
    const view = container.querySelector<HTMLElement>('[data-chat-view]')!;
    expect(view.style.display).toBe('none');
  });

  // ─── Conversation layout (owner decision 2026-07-28) ──────────────────────
  // The human's own turns are right-aligned in a width-capped RAISED card; the
  // agent stays left and full width. Not a coloured bubble: the card is the
  // design system's existing raised treatment, so the no-wash rule holds.
  describe('conversation alignment', () => {
    it('right-aligns and width-caps the user turn, leaves the agent full width', () => {
      seed([
        { id: 'u1', kind: 'user_text', text: 'refactor the reader' },
        { id: 'a1', kind: 'assistant_text', text: 'on it' },
      ]);
      mount({ agentName: 'claude-1' });
      const user = container.querySelector<HTMLElement>('[data-chat-row="user"]')!;
      const agent = container.querySelector<HTMLElement>('[data-chat-row="assistant"]')!;
      expect(user.getAttribute('data-chat-align')).toBe('right');
      expect(agent.getAttribute('data-chat-align')).toBe('full');
      // Pushed to the right edge, capped high enough that a long message reads
      // as the human's half of the conversation rather than a footnote.
      expect(user.className).toContain('ml-auto');
      expect(user.className).toContain('max-w-[88%]');
      // Short messages still size to their content, with a floor.
      expect(user.className).toContain('w-fit');
      expect(user.className).toContain('min-w-[6rem]');
      expect(agent.className).not.toContain('ml-auto');
      expect(agent.className).not.toContain('max-w');
      // The agent keeps a right gutter so both sides share one measure.
      expect(agent.className).toContain('pr-[10%]');
    });

    it('gives the user turn the RAISED treatment — hairline + inset highlight, no colour fill', () => {
      seed([{ id: 'u1', kind: 'user_text', text: 'hello' }]);
      mount();
      const card = container.querySelector<HTMLElement>('[data-chat-user-card]')!;
      expect(card.style.borderRadius).toBe('7px'); // card radius
      expect(card.style.border).toContain('var(--text-main)');
      expect(card.style.boxShadow).toContain('inset 0 1px 0');
      // Tokens only, and no accent wash — amber never fills areas.
      expect(card.style.background).toContain('var(--bg-surface)');
      expect(card.getAttribute('style')).not.toContain('--accent');
      expect(card.getAttribute('style')).not.toMatch(/#[0-9a-f]{3,8}/i);
      // The label sits ABOVE the card, not cramped inside its top-right corner.
      const label = container.querySelector('[data-chat-speaker="you"]')!;
      expect(card.contains(label)).toBe(false);
      expect(container.querySelector('[data-chat-row="user"]')!.contains(label)).toBe(true);
    });

    it('leaves machine evidence left and full width (tool runs, diff chips, trust seam)', () => {
      seed([
        { id: 'u1', kind: 'tool_use', toolUseId: 't1', name: 'Bash', argSummary: 'git diff' },
        { id: 'r1', kind: 'tool_result', toolUseId: 't1', ok: true, bytes: 4096, diffLike: true },
      ]);
      mount();
      for (const sel of ['[data-chat-tool-run]', '[data-chat-diff-chip]', '[data-chat-trust-seam]']) {
        const el = container.querySelector<HTMLElement>(sel)!;
        expect(el).not.toBeNull();
        expect(el.closest('[data-chat-align="right"]')).toBeNull();
      }
    });
  });

  // ─── Prose rendering: the markdown subset (2026-07-28) ────────────────────
  // Raw `**bold**` / `` `code` `` / `- item` markers made the "conversation
  // minus the noise" read noisier than the terminal underneath.
  describe('markdown prose', () => {
    it('renders bold, inline code, headings and lists instead of raw markers', () => {
      seed([
        {
          id: 'a1',
          kind: 'assistant_text',
          text: '## Result\n\nOpen **`calculator.html`**:\n\n- first item\n- second item',
        },
      ]);
      mount();
      const text = container.querySelector('[data-chat-text]')!;
      expect(text.textContent).not.toContain('**');
      expect(text.textContent).not.toContain('`');
      expect(text.textContent).not.toContain('- first');
      expect(text.querySelector('[data-chat-md="heading"]')!.textContent).toBe('Result');
      expect(text.querySelector('strong [data-chat-inline-code]')!.textContent).toBe(
        'calculator.html',
      );
      const items = text.querySelectorAll('[data-chat-md="list"] li');
      expect(items).toHaveLength(2);
      expect(items[0].textContent).toContain('first item');
    });

    it('renders the operator\'s own prose the same way', () => {
      seed([{ id: 'u1', kind: 'user_text', text: 'try **this** and `that`' }]);
      mount();
      const card = container.querySelector('[data-chat-user-card]')!;
      expect(card.querySelector('strong')!.textContent).toBe('this');
      expect(card.querySelector('[data-chat-inline-code]')!.textContent).toBe('that');
    });

    it('keeps an unmatched marker literal instead of swallowing the message', () => {
      seed([{ id: 'a1', kind: 'assistant_text', text: 'a ** dangling and the rest survives' }]);
      mount();
      expect(container.querySelector('[data-chat-text]')!.textContent).toBe(
        'a ** dangling and the rest survives',
      );
    });

    it('shows a link as text and never as a navigable anchor', () => {
      seed([{ id: 'a1', kind: 'assistant_text', text: 'see [docs](https://example.test/x)' }]);
      mount();
      expect(container.querySelectorAll('a')).toHaveLength(0);
      const link = container.querySelector('[data-chat-link]')!;
      expect(link.textContent).toBe('docs');
      expect(link.getAttribute('title')).toBe('https://example.test/x');
    });

    it('cannot inject markup from adversarial transcript prose', () => {
      seed([
        {
          id: 'a1',
          kind: 'assistant_text',
          text: '<img src=x onerror="alert(1)"> and <script>alert(2)</script> **<b>bold</b>**',
        },
        { id: 'u1', kind: 'user_text', text: '<iframe src="javascript:alert(3)"></iframe>' },
      ]);
      mount();
      // Every angle bracket landed as TEXT — no element was created from it.
      for (const tag of ['img', 'script', 'iframe', 'b']) {
        expect(container.querySelectorAll(tag)).toHaveLength(0);
      }
      expect(container.textContent).toContain('<script>alert(2)</script>');
      expect(container.textContent).toContain('<iframe src="javascript:alert(3)"></iframe>');
    });

    it('still renders ZERO <pre> with markdown-heavy prose around a code chip', () => {
      seed([
        {
          id: 'a1',
          kind: 'assistant_text',
          text: '# Patch\n\n- **done**: \u0000code:1\u0000\n\n> and a quote',
          codeBlocks: [{ n: 1, lang: 'ts', lines: 9, path: 'src/a.ts' }],
        },
      ]);
      mount();
      expect(container.querySelectorAll('pre')).toHaveLength(0);
      // The chip is still inside the list item where the marker sat.
      expect(container.querySelector('li [data-chat-code-chip="1"]')).not.toBeNull();
      expect(container.querySelector('[data-chat-md="quote"]')!.textContent).toBe('and a quote');
    });
  });

  // ─── Markdown tables (2026-07-28) ───────────────────────────────────────
  //
  // Tables were the one construct still arriving as raw pipe soup. They render
  // as a real <table> — and, because a pane can be narrow, inside their own
  // horizontal scroller so a wide table can never widen the chat column.
  describe('tables', () => {
    const TABLE = [
      '| file | lines | note |',
      '| :--- | ---: | :---: |',
      '| a.ts | 12 | **new** |',
      '| b.ts | 3 |',
    ].join('\n');

    it('renders a real table with the right cells and alignment', () => {
      seed([{ id: 'a1', kind: 'assistant_text', text: TABLE }]);
      mount();
      const table = container.querySelector('table')!;
      expect(table).not.toBeNull();

      const headers = [...table.querySelectorAll('th')];
      expect(headers.map((h) => h.textContent)).toEqual(['file', 'lines', 'note']);
      expect(headers.map((h) => (h as HTMLElement).style.textAlign)).toEqual([
        'left',
        'right',
        'center',
      ]);

      const rows = [...table.querySelectorAll('tbody tr')];
      expect(rows.map((r) => [...r.querySelectorAll('td')].map((c) => c.textContent))).toEqual([
        ['a.ts', '12', 'new'],
        // Ragged row: GFM pads the missing cell rather than dropping the row.
        ['b.ts', '3', ''],
      ]);
      // Inline markdown inside a cell became structure, not literal markers.
      expect(rows[0].querySelector('strong')!.textContent).toBe('new');
    });

    it('keeps a code chip alive inside a table cell', () => {
      seed([
        {
          id: 'a1',
          kind: 'assistant_text',
          text: '| what | where |\n|---|---|\n| patch | \u0000code:1\u0000 |',
          codeBlocks: [{ n: 1, lang: 'ts', lines: 9, path: 'src/a.ts' }],
        },
      ]);
      mount();
      expect(container.querySelector('td [data-chat-code-chip="1"]')).not.toBeNull();
      // The invariant survives a table: still no <pre> until asked.
      expect(container.querySelectorAll('pre')).toHaveLength(0);
    });

    it('falls back to literal text for an unknown code ref in a cell', () => {
      seed([
        {
          id: 'a1',
          kind: 'assistant_text',
          text: '| what | where |\n|---|---|\n| patch | \u0000code:7\u0000 |',
        },
      ]);
      mount();
      const cells = [...container.querySelectorAll('td')].map((c) => c.textContent);
      expect(cells).toEqual(['patch', 'code:7']);
    });

    it('injects nothing from adversarial cell content', () => {
      seed([
        {
          id: 'a1',
          kind: 'assistant_text',
          text:
            '| a | b |\n|---|---|\n| <img src=x onerror="alert(1)"> | <script>alert(2)</script> |',
        },
      ]);
      mount();
      for (const tag of ['img', 'script', 'iframe', 'a']) {
        expect(container.querySelectorAll(tag)).toHaveLength(0);
      }
      expect(container.textContent).toContain('<script>alert(2)</script>');
    });

    it('puts a wide table in a horizontal scroller instead of widening the row', () => {
      const width = 14;
      const cols = Array.from({ length: width }, (_, i) => `column-header-${i}`);
      seed([
        {
          id: 'a1',
          kind: 'assistant_text',
          text: [
            `| ${cols.join(' | ')} |`,
            `| ${cols.map(() => '---').join(' | ')} |`,
            `| ${cols.map((_, i) => `a-fairly-long-value-${i}`).join(' | ')} |`,
          ].join('\n'),
        },
      ]);
      mount();
      const scroller = container.querySelector<HTMLElement>('[data-chat-md="table-scroll"]')!;
      expect(scroller).not.toBeNull();
      // The table lives INSIDE the scroller — that is what contains the width.
      expect(scroller.querySelector('table')).not.toBeNull();
      expect(scroller.style.overflowX).toBe('auto');
      expect(scroller.style.maxWidth).toBe('100%');
      expect(scroller.style.minWidth).toBe('0');
      // Nothing on the table itself asks for a width the row would have to grow to.
      const table = scroller.querySelector<HTMLElement>('table')!;
      expect(table.style.width).toBe('');
      expect(table.style.minWidth).toBe('');
    });

    it('leaves pipe-heavy prose as a paragraph, with no table at all', () => {
      seed([
        {
          id: 'a1',
          kind: 'assistant_text',
          text: 'grep a | sort | uniq -c\nthen head -n 5 | tail',
        },
      ]);
      mount();
      expect(container.querySelectorAll('table')).toHaveLength(0);
      expect(container.querySelector('[data-chat-md="paragraph"]')!.textContent).toBe(
        'grep a | sort | uniq -c\nthen head -n 5 | tail',
      );
    });
  });

  // ─── Speaker grouping (2026-07-28) ────────────────────────────────────────
  describe('speaker grouping', () => {
    it('prints ONE label for a run of the same speaker, across a tool line', () => {
      seed([
        { id: 'a1', kind: 'assistant_text', text: 'reading' },
        { id: 't1', kind: 'tool_use', toolUseId: 'x1', name: 'Read', argSummary: 'a.ts' },
        { id: 'r1', kind: 'tool_result', toolUseId: 'x1', ok: true, bytes: 10 },
        { id: 'a2', kind: 'assistant_text', text: 'patched' },
      ]);
      mount({ agentName: 'Claude Code' });
      const labels = [...container.querySelectorAll('[data-chat-speaker]')];
      expect(labels).toHaveLength(1);
      expect(labels[0].textContent).toBe('Claude Code');
      // …and the tool line is still there between the two prose rows.
      expect(container.querySelector('[data-chat-tool-run]')).not.toBeNull();
    });

    it('starts a new label on a genuine speaker change', () => {
      seed([
        { id: 'u1', kind: 'user_text', text: 'go' },
        { id: 'a1', kind: 'assistant_text', text: 'on it' },
        { id: 'a2', kind: 'assistant_text', text: 'done' },
        { id: 'u2', kind: 'user_text', text: 'thanks' },
      ]);
      mount({ agentName: 'Claude Code' });
      const labels = [...container.querySelectorAll('[data-chat-speaker]')].map(
        (el) => el.getAttribute('data-chat-speaker'),
      );
      expect(labels).toEqual(['you', 'agent', 'you']);
    });

    it('does not re-label an optimistic echo that continues the user run', () => {
      seed([{ id: 'u1', kind: 'user_text', text: 'first' }]);
      mount();
      act(() => {
        useStore.getState().pushChatPending(PTY, 'second');
      });
      expect(container.querySelectorAll('[data-chat-speaker="you"]')).toHaveLength(1);
    });
  });

  // ─── Counters read as English, not as a template ──────────────────────────
  describe('pluralization', () => {
    it('says "1 line" for a one-line block and "N lines" beyond', () => {
      seed([
        {
          id: 'a1',
          kind: 'assistant_text',
          text: 'one \u0000code:1\u0000 two \u0000code:2\u0000',
          codeBlocks: [
            { n: 1, lines: 1 },
            { n: 2, lines: 4, path: 'src/a.ts' },
          ],
        },
      ]);
      mount();
      const one = container.querySelector('[data-chat-code-chip="1"]')!;
      expect(one.textContent).toContain('1 line');
      expect(one.textContent).not.toContain('1 lines');
      expect(container.querySelector('[data-chat-code-chip="2"]')!.textContent).toContain(
        '4 lines · src/a.ts',
      );
    });

    it('says "1 line · path" for a one-line block that names a file', () => {
      seed([
        {
          id: 'a1',
          kind: 'assistant_text',
          text: 'x \u0000code:1\u0000',
          codeBlocks: [{ n: 1, lines: 1, path: 'src/a.ts' }],
        },
      ]);
      mount();
      const chip = container.querySelector('[data-chat-code-chip="1"]')!;
      expect(chip.textContent).toContain('1 line · src/a.ts');
      expect(chip.textContent).not.toContain('1 lines');
    });

    it('says "1 tool call" for a single call and "N tool calls" beyond', () => {
      seed([
        { id: 't1', kind: 'tool_use', toolUseId: 'x1', name: 'Read', argSummary: 'a.ts' },
        { id: 'r1', kind: 'tool_result', toolUseId: 'x1', ok: true, bytes: 10 },
      ]);
      mount();
      const label = container.querySelector('[data-chat-tool-run-label]')!;
      expect(label.textContent).toBe('1 tool call (Read)');
    });
  });

  // ─── Layout containment + the live tail ───────────────────────────────────
  // The host is a BLOCK box (`flex-1 relative overflow-hidden` in Pane), so a
  // `flex-1` root sized to its content: the wheel did nothing and the composer
  // was pushed past the host's clip.
  describe('scroll containment and sticky tail', () => {
    // jsdom does no layout, so the container's geometry is stubbed. The setter
    // clamps like a browser, which is what `scrollTop = scrollHeight` relies on.
    let clientHeight = 300;
    let contentHeight = 1000;
    const tops = new WeakMap<Element, number>();
    const isScroller = (el: Element): boolean => el.hasAttribute('data-chat-scroll');

    beforeEach(() => {
      clientHeight = 300;
      contentHeight = 1000;
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
        configurable: true,
        get(this: HTMLElement) { return isScroller(this) ? clientHeight : 0; },
      });
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
        configurable: true,
        get(this: HTMLElement) { return isScroller(this) ? contentHeight : 0; },
      });
      Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
        configurable: true,
        get(this: HTMLElement) { return tops.get(this) ?? 0; },
        set(this: HTMLElement, v: number) {
          const max = isScroller(this) ? Math.max(0, contentHeight - clientHeight) : 0;
          tops.set(this, Math.max(0, Math.min(v, max)));
        },
      });
    });

    afterEach(() => {
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollHeight;
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollTop;
    });

    const manyRows = (n: number): TurnEvent[] =>
      Array.from({ length: n }, (_, i) => ({ id: `u${i}`, kind: 'user_text' as const, text: `turn ${i}` }));

    const scroller = (): HTMLElement => container.querySelector<HTMLElement>('[data-chat-scroll]')!;

    it('sizes the root to the pane box, not to its content', () => {
      seed(manyRows(40));
      mount();
      const view = container.querySelector<HTMLElement>('[data-chat-view]')!;
      expect(view.style.height).toBe('100%');
      expect(view.style.display).toBe('flex');
      expect(view.style.flexDirection).toBe('column');
      // `flex-1` was the bug: the host is not a flex column, so it resolved to
      // auto height. It must not come back.
      expect(view.className).not.toContain('flex-1');
      // …and the row list is the part that scrolls, bounded by that root.
      expect(scroller().className).toContain('overflow-y-auto');
      expect(scroller().className).toContain('min-h-0');
      // The composer and the trust seam are siblings of the scroller, so they
      // are pinned inside the same bounded box rather than pushed past the clip.
      const view2 = scroller().parentElement!;
      expect(view2.querySelector('[data-chat-trust-seam]')).not.toBeNull();
      expect(view2.querySelector('[data-chat-input]')).not.toBeNull();
    });

    // Chat convention: a conversation shorter than the pane sits at the BOTTOM,
    // next to the composer, instead of stacking from the top and leaving a void.
    it('anchors a SHORT conversation to the bottom', () => {
      contentHeight = 120; // shorter than the 300px viewport
      seed([{ id: 'u1', kind: 'user_text', text: 'only turn' }]);
      mount();
      const rowsBox = container.querySelector<HTMLElement>('[data-chat-rows]')!;
      expect(rowsBox.className).toContain('justify-end');
      expect(rowsBox.className).toContain('min-h-full');
      // The anchoring lives on the inner box, never on the scroll container:
      // `justify-content: flex-end` on a scroller makes overflowing content
      // unreachable above the top edge.
      expect(scroller().className).not.toContain('justify-end');
      expect(scroller().className).toContain('overflow-y-auto');
      // Nothing was scrolled away — the row is still rendered.
      expect(container.querySelector('[data-chat-row="user"]')).not.toBeNull();
      expect(scroller().scrollTop).toBe(0);
    });

    it('opens on the NEWEST turn instead of the oldest row of the window', () => {
      seed(manyRows(40));
      mount();
      expect(scroller().scrollTop).toBe(contentHeight - clientHeight);
    });

    it('stays pinned to the bottom when a turn appends while following the tail', () => {
      seed(manyRows(40));
      mount();
      contentHeight = 1400;
      act(() => {
        useStore.getState().applyChatAppend(PTY, {
          seq: 2,
          events: [{ id: 'new', kind: 'user_text', text: 'newest' }],
          cursor: { headOffset: 0, tailOffset: 600, fileSize: 600, mtimeMs: 2 },
        });
      });
      expect(scroller().scrollTop).toBe(1400 - 300);
    });

    it('does NOT yank the view when the operator has scrolled up to read history', () => {
      seed(manyRows(40));
      mount();
      act(() => {
        scroller().scrollTop = 120;
        scroller().dispatchEvent(new Event('scroll'));
      });
      contentHeight = 1400;
      act(() => {
        useStore.getState().applyChatAppend(PTY, {
          seq: 2,
          events: [{ id: 'new', kind: 'user_text', text: 'newest' }],
          cursor: { headOffset: 0, tailOffset: 600, fileSize: 600, mtimeMs: 2 },
        });
      });
      expect(scroller().scrollTop).toBe(120);
    });

    it('resumes following the tail once the operator scrolls back down', () => {
      seed(manyRows(40));
      mount();
      act(() => {
        scroller().scrollTop = 120;
        scroller().dispatchEvent(new Event('scroll'));
      });
      act(() => {
        scroller().scrollTop = contentHeight - clientHeight;
        scroller().dispatchEvent(new Event('scroll'));
      });
      contentHeight = 1400;
      act(() => {
        useStore.getState().applyChatAppend(PTY, {
          seq: 3,
          events: [{ id: 'new2', kind: 'user_text', text: 'newest' }],
          cursor: { headOffset: 0, tailOffset: 700, fileSize: 700, mtimeMs: 3 },
        });
      });
      expect(scroller().scrollTop).toBe(1400 - 300);
    });
  });
});
