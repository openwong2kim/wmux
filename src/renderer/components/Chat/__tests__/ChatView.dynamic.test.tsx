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
    // …the text stays exactly as the agent wrote it…
    expect(container.querySelector('[data-chat-text]')!.textContent).toContain('`code:2`');
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
    expect(text).toContain('ignore this: `code:9` and this too');
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
      // Pushed to the right edge and capped well under the row width.
      expect(user.className).toContain('ml-auto');
      expect(user.className).toMatch(/max-w-\[7[58]%\]/);
      expect(agent.className).not.toContain('ml-auto');
      expect(agent.className).not.toContain('max-w');
    });

    it('gives the user turn the RAISED treatment — hairline + inset highlight, no colour fill', () => {
      seed([{ id: 'u1', kind: 'user_text', text: 'hello' }]);
      mount();
      const user = container.querySelector<HTMLElement>('[data-chat-row="user"]')!;
      expect(user.style.borderRadius).toBe('7px'); // card radius
      expect(user.style.border).toContain('var(--text-main)');
      expect(user.style.boxShadow).toContain('inset 0 1px 0');
      // Tokens only, and no accent wash — amber never fills areas.
      expect(user.style.background).toContain('var(--bg-surface)');
      expect(user.getAttribute('style')).not.toContain('--accent');
      expect(user.getAttribute('style')).not.toMatch(/#[0-9a-f]{3,8}/i);
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
