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
        onJumpToTerminal: () => {},
        ...props,
      }),
    );
  });
}

describe('ChatView', () => {
  beforeEach(() => {
    useStore.getState().clearChatSurface(PTY);
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      pty: { write: () => {} },
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
});
