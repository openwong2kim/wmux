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
import { useStore } from '../../../stores';

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

// Enter is the only way to send — the composer has no send button.
function pressEnter(opts?: { isComposing?: boolean; shiftKey?: boolean }): void {
  const ta = container.querySelector<HTMLTextAreaElement>('[data-chat-input]');
  if (!ta) return;
  act(() => {
    ta.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        shiftKey: opts?.shiftKey ?? false,
        // jsdom's KeyboardEvent supports `isComposing` in its init dict, which
        // is what React surfaces as `e.nativeEvent.isComposing`.
        ...(opts?.isComposing ? { isComposing: true } : {}),
      }),
    );
  });
}

function pressCtrlJ(): void {
  const ta = container.querySelector<HTMLTextAreaElement>('[data-chat-input]');
  if (!ta) return;
  act(() => {
    ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true }));
  });
}

function inputValue(): string {
  return container.querySelector<HTMLTextAreaElement>('[data-chat-input]')?.value ?? '(absent)';
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

  it('renders a textarea and no send button when the gate is open', () => {
    render({});
    expect(container.querySelector('[data-chat-input]')).not.toBeNull();
    expect(container.querySelector('[data-chat-send]')).toBeNull();
    expect(container.querySelector('[data-chat-composer]')?.getAttribute('data-chat-composer')).toBe('open');
  });

  it('REMOVES the textarea under needsInput', () => {
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
    pressEnter();

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
    pressEnter();
    expect(container.querySelector<HTMLTextAreaElement>('[data-chat-input]')!.value).toBe('');
    writes.length = 0;
    pressEnter();
    expect(writes).toHaveLength(0);
  });

  it('A7: aborts the deferred Enter when the gate engages inside the 100ms window', () => {
    render({});
    type('yes');
    pressEnter();
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


// ── Terminal affordances the composer has to reproduce ─────────────────────
//
// Chat View replaces the terminal VIEW of a surface, so anything the user could
// do at the agent's prompt and can no longer do here reads as the feature
// taking something away. All three below were found by dogfooding the packaged
// build against a live agent.
  it('Ctrl+J inserts a newline instead of vanishing', () => {
    render({});
    type('first');
    pressCtrlJ();
    expect(inputValue()).toBe('first\n');
    // …and it must not be mistaken for a send.
    expect(writes).toHaveLength(0);
  });

  it('Ctrl+J inserts at the caret, not only at the end', () => {
    render({});
    type('ab');
    const ta = container.querySelector<HTMLTextAreaElement>('[data-chat-input]')!;
    ta.selectionStart = ta.selectionEnd = 1;
    pressCtrlJ();
    expect(inputValue()).toBe('a\nb');
  });

  it('does NOT send on the Enter that commits an IME composition', () => {
    // Mid-Hangul, Enter commits the candidate — it is not a submit. Sending
    // there cuts the message off at a half-finished syllable and clears the box.
    render({});
    type('안녕하세');
    pressEnter({ isComposing: true });
    expect(writes).toHaveLength(0);
    expect(inputValue()).toBe('안녕하세');
  });

  it('still sends on a normal Enter once composition has ended', () => {
    render({});
    type('안녕하세요');
    pressEnter();
    act(() => { vi.advanceTimersByTime(200); });
    expect(writes.length).toBeGreaterThan(0);
  });

  it('Shift+Enter never sends', () => {
    render({});
    type('line');
    pressEnter({ shiftKey: true });
    expect(writes).toHaveLength(0);
  });


// A dropped file used to be written straight to the PTY by AppLayout's global
// handler, which never checked chatMode — so on a chat surface the path landed
// in the hidden xterm's buffer while the composer the user was looking at
// stayed empty. AppLayout now routes it here instead; this pins the receiving
// half.
  beforeEach(() => {
    useStore.setState({ chatDropInjection: {} } as never);
  });

  it('appends an injected path to the draft', () => {
    render({});
    act(() => { useStore.getState().injectChatDrop('pty-a', 'C:\shot.png'); });
    expect(inputValue()).toBe('C:\shot.png');
    // …and nothing was written to the PTY on the way.
    expect(writes).toHaveLength(0);
  });

  it('keeps what the user already typed, space-separated', () => {
    render({});
    type('look at');
    act(() => { useStore.getState().injectChatDrop('pty-a', 'C:\shot.png'); });
    expect(inputValue()).toBe('look at C:\shot.png');
  });

  it('injects twice when the same path is dropped twice', () => {
    render({});
    act(() => { useStore.getState().injectChatDrop('pty-a', 'a.png'); });
    act(() => { useStore.getState().injectChatDrop('pty-a', 'a.png'); });
    expect(inputValue()).toBe('a.png a.png');
  });

  it('ignores an injection addressed to a different pane', () => {
    render({});
    act(() => { useStore.getState().injectChatDrop('pty-other', 'nope.png'); });
    expect(inputValue()).toBe('');
  });
});
