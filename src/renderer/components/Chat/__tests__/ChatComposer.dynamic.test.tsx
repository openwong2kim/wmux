// @vitest-environment jsdom
//
// Safety verification for the Chat composer (plan PR-7, PRD §4.3).
//
// The load-bearing assertions:
//
//   • needsInput=true ⇒ the textarea and the send button are ABSENT from the
//     DOM (removed, not disabled — a disabled input still takes paste in some
//     engines), replaced by exactly one warm primary "Answer in terminal →".
//   • a send calls submitBracketedPasteToPty with the RAW text and reports it
//     to onSend so the caller can echo it.
//   • eng-review A7: the helper writes `\r` from a 100ms timeout, so the gate
//     is re-checked (a) synchronously before the call and (b) inside the
//     timeout — a gate that engages mid-window must abort the Enter.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { ChatComposer, type ChatComposerProps } from '../ChatComposer';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const writes: { ptyId: string; data: string }[] = [];

let container: HTMLDivElement;
let root: Root;

function render(props: Partial<ChatComposerProps>): void {
  act(() => {
    root.render(
      React.createElement(ChatComposer, {
        ptyId: 'pty-a',
        needsInput: false,
        agentStatus: 'idle',
        onJumpToTerminal: () => {},
        onSend: () => {},
        ...props,
      } as ChatComposerProps),
    );
  });
}

function type(text: string): void {
  const ta = container.querySelector<HTMLTextAreaElement>('[data-chat-input]')!;
  // React tracks the DOM value on the node, so a plain `.value =` assignment is
  // swallowed as a no-op change — go through the prototype setter.
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function clickSend(): void {
  const btn = container.querySelector<HTMLButtonElement>('[data-chat-send]')!;
  act(() => {
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('ChatComposer', () => {
  beforeEach(() => {
    writes.length = 0;
    vi.useFakeTimers();
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      pty: { write: (ptyId: string, data: string) => writes.push({ ptyId, data }) },
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    vi.useRealTimers();
  });

  it('renders a textarea and a send button when the gate is open', () => {
    render({});
    expect(container.querySelector('[data-chat-input]')).not.toBeNull();
    expect(container.querySelector('[data-chat-send]')).not.toBeNull();
    expect(container.querySelector('[data-chat-composer]')?.getAttribute('data-chat-composer')).toBe('open');
  });

  it('REMOVES the textarea and send button under needsInput', () => {
    render({ needsInput: true });
    expect(container.querySelector('[data-chat-input]')).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelector('[data-chat-send]')).toBeNull();
    expect(container.querySelector('[data-chat-composer]')?.getAttribute('data-chat-composer')).toBe('locked');
  });

  it('offers exactly one warm primary action, "Answer in terminal", under needsInput', () => {
    const onJumpToTerminal = vi.fn();
    render({ needsInput: true, onJumpToTerminal });
    const primaries = container.querySelectorAll('.ui-btn-primary');
    expect(primaries).toHaveLength(1);
    const answer = container.querySelector<HTMLButtonElement>('[data-chat-answer-in-terminal]')!;
    expect(answer.textContent).toContain('Answer in terminal');
    expect(answer.classList.contains('ui-btn-primary')).toBe(true);
    act(() => {
      answer.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onJumpToTerminal).toHaveBeenCalledTimes(1);
  });

  it('shows the pending question above the locked composer', () => {
    render({ needsInput: true, pendingQuestion: 'Allow Bash(rm -rf build)?' });
    expect(container.querySelector('[data-chat-pending-question]')?.textContent).toBe(
      'Allow Bash(rm -rf build)?',
    );
  });

  it('sends the raw text as a bracketed paste plus a deferred Enter', () => {
    const onSend = vi.fn();
    render({ onSend });
    type('run the tests');
    clickSend();

    expect(writes).toHaveLength(1);
    expect(writes[0].ptyId).toBe('pty-a');
    expect(writes[0].data).toContain('run the tests');
    expect(writes[0].data.startsWith('\x1b[200~')).toBe(true);
    expect(onSend).toHaveBeenCalledWith('run the tests');

    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(writes[1].data).toBe('\r');
  });

  it('clears the field and refuses an empty send', () => {
    render({});
    type('hello');
    clickSend();
    expect(container.querySelector<HTMLTextAreaElement>('[data-chat-input]')!.value).toBe('');
    writes.length = 0;
    clickSend();
    expect(writes).toHaveLength(0);
  });

  it('A7: aborts the deferred Enter when the gate engages inside the 100ms window', () => {
    render({});
    type('yes');
    clickSend();
    expect(writes).toHaveLength(1);

    // The pane moved onto a permission menu before the Enter fired.
    render({ needsInput: true });
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(writes.some((w) => w.data === '\r')).toBe(false);
  });

  it('does not send at all once the gate is engaged', () => {
    const onSend = vi.fn();
    render({ onSend });
    type('do it');
    // Re-render locked; the composer is gone, so no send path is reachable.
    render({ needsInput: true, onSend });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onSend).not.toHaveBeenCalled();
  });
});
