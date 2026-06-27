// @vitest-environment jsdom
//
// Dynamic interaction test for the composer @-mention autocomplete (#5).
// renderToStaticMarkup (Composer.test.tsx) can't fire input/keydown events, so
// this mounts the REAL <ComposerContent/> via react-dom/client and drives the
// actual DOM: typing '@', filtering, keyboard nav, commit, and the mentions[]
// payload handed to onSubmit. Mirrors ChannelView.archive.dynamic.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ComposerContent, type MentionCandidate } from '../Composer';

const CANDIDATES: MentionCandidate[] = [
  { workspaceId: 'ws-2', memberId: 'local-ui', name: 'alice' },
  { workspaceId: 'ws-3', memberId: 'local-ui', name: 'bob' },
  { workspaceId: 'ws-4', memberId: 'local-ui', name: 'alf' },
];

let container: HTMLDivElement;
let root: Root;

function mount(
  props: {
    onSubmit?: (
      text: string,
      mentions: unknown[],
    ) => Promise<{ ok: boolean; errorMessage?: string }>;
    candidates?: MentionCandidate[];
  } = {},
): void {
  act(() => {
    root.render(
      createElement(ComposerContent, {
        channelId: 'ch-1',
        onSubmit: props.onSubmit ?? (async () => ({ ok: true })),
        mentionCandidates: props.candidates ?? CANDIDATES,
        t: (k: string) => k,
      }),
    );
  });
}

const input = (): HTMLTextAreaElement => {
  const el = container.querySelector(
    '[data-channel-composer-input]',
  ) as HTMLTextAreaElement | null;
  if (!el) throw new Error('composer input not rendered');
  return el;
};
const dropdown = (): HTMLElement | null =>
  container.querySelector('[data-channel-mention-dropdown]');
const options = (): HTMLElement[] =>
  Array.from(container.querySelectorAll('[data-channel-mention-option]'));
const sendBtn = (): HTMLElement => {
  const el = container.querySelector(
    '[data-channel-composer-send]',
  ) as HTMLElement | null;
  if (!el) throw new Error('send button not rendered');
  return el;
};

// Set a controlled <textarea>'s value the way React's synthetic onChange
// expects: the native value setter + a bubbling input event, with the caret
// placed at `caret` (detectMentionToken reads selectionStart).
function type(value: string, caret = value.length): void {
  const el = input();
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(el),
      'value',
    )?.set;
    setter?.call(el, value);
    el.selectionStart = caret;
    el.selectionEnd = caret;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const press = (k: string): void => {
  act(() => {
    input().dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }),
    );
  });
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ComposerContent — @-mention autocomplete (jsdom)', () => {
  it('shows no dropdown until an @ token is typed', () => {
    mount();
    expect(dropdown()).toBeNull();
    type('hello');
    expect(dropdown()).toBeNull();
  });

  it('typing @ opens the dropdown with every candidate', () => {
    mount();
    type('@');
    expect(dropdown()).not.toBeNull();
    expect(options()).toHaveLength(3);
  });

  it('filters candidates by the query (case-insensitive substring)', () => {
    mount();
    type('@AL'); // uppercase — match is case-insensitive
    const names = options().map((o) => o.textContent ?? '');
    expect(options()).toHaveLength(2); // alice, alf — not bob
    expect(names.some((n) => n.includes('alice'))).toBe(true);
    expect(names.some((n) => n.includes('alf'))).toBe(true);
    expect(names.some((n) => n.includes('bob'))).toBe(false);
  });

  it('collapses the dropdown when the query matches nothing', () => {
    mount();
    type('@zzz');
    expect(dropdown()).toBeNull();
  });

  it('ArrowDown moves the active option (wrapping)', () => {
    mount();
    type('@al'); // [alice, alf]
    expect(options()[0].getAttribute('data-active')).toBe('true');
    press('ArrowDown');
    expect(options()[0].getAttribute('data-active')).toBeNull();
    expect(options()[1].getAttribute('data-active')).toBe('true');
    press('ArrowDown'); // wraps back to first
    expect(options()[0].getAttribute('data-active')).toBe('true');
  });

  it('Enter commits the highlighted mention and closes the dropdown', () => {
    mount();
    type('@al');
    press('ArrowDown'); // highlight alf
    press('Enter'); // commit alf
    expect(input().value).toBe('@alf ');
    expect(dropdown()).toBeNull();
  });

  it('clicking an option commits that mention', () => {
    mount();
    type('@');
    act(() => {
      options()[1].dispatchEvent(new MouseEvent('click', { bubbles: true })); // bob
    });
    expect(input().value).toBe('@bob ');
    expect(dropdown()).toBeNull();
  });

  it('Escape closes the dropdown without committing', () => {
    mount();
    type('@al');
    expect(dropdown()).not.toBeNull();
    press('Escape');
    expect(dropdown()).toBeNull();
    expect(input().value).toBe('@al'); // text untouched
  });

  it('sends the picked mention in the mentions[] payload', async () => {
    const onSubmit = vi.fn(async () => ({ ok: true }));
    mount({ onSubmit });
    type('@alice');
    press('Enter'); // commit alice → '@alice '
    await act(async () => {
      sendBtn().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('@alice', [
      { workspaceId: 'ws-2', memberId: 'local-ui', name: 'alice' },
    ]);
  });

  it('drops a picked mention whose @token was deleted before send', async () => {
    const onSubmit = vi.fn(async () => ({ ok: true }));
    mount({ onSubmit });
    type('@alice');
    press('Enter'); // '@alice '
    type('different text'); // user wiped the mention token
    await act(async () => {
      sendBtn().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith('different text', []);
  });
});
