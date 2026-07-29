// @vitest-environment jsdom
//
// The sidebar row's trailing action fires immediately, which is fine for the
// reversible ones (restore, trashing an already-archived row) and NOT fine for
// trashing an ACTIVE channel: that archives it in the same commit and restore
// does not un-archive, so one misclick permanently read-onlies a live room.
// `requiresConfirm` gives that case the repo's existing two-click armed pattern
// (ChannelView.archive.dynamic.test.tsx). renderToStaticMarkup cannot click, so
// this mounts the real component and drives the DOM events.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Channel } from '../../../../shared/channels';
import { ChannelItemView } from '../ChannelItem';

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'ch-1',
    companyId: 'co-1',
    name: 'general',
    visibility: 'public',
    status: 'active',
    createdAt: 1_700_000_000_000,
    createdBy: 'ws-1',
    nextSeq: 1,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

function mount(action: Record<string, unknown>): void {
  act(() => {
    root.render(
      createElement(ChannelItemView, {
        channel: makeChannel(),
        isActive: false,
        unreadCount: 0,
        onSelect: () => undefined,
        action,
      } as never),
    );
  });
}

function trashBtn(): HTMLElement {
  const el = container.querySelector('[data-channel-trash]') as HTMLElement | null;
  if (!el) throw new Error('trash button not rendered');
  return el;
}
const click = (el: HTMLElement): void => {
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
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

describe('ChannelItemView — trash action confirm (jsdom)', () => {
  const baseAction = {
    label: 'Move to trash',
    glyph: '×',
    testAttr: 'data-channel-trash',
  };

  it('requiresConfirm: the first click ARMS, the second commits exactly once', () => {
    const onClick = vi.fn();
    mount({ ...baseAction, onClick, requiresConfirm: true, confirmLabel: 'Confirm' });

    expect(trashBtn().getAttribute('data-armed')).toBe('false');

    click(trashBtn());
    expect(onClick).not.toHaveBeenCalled();
    expect(trashBtn().getAttribute('data-armed')).toBe('true');

    click(trashBtn());
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledWith('ch-1');
    expect(trashBtn().getAttribute('data-armed')).toBe('false');
  });

  it('blur disarms without firing', () => {
    const onClick = vi.fn();
    mount({ ...baseAction, onClick, requiresConfirm: true });

    click(trashBtn());
    expect(trashBtn().getAttribute('data-armed')).toBe('true');

    // React wires onBlur via focusout delegation at the root (same as the
    // ChannelView archive test). The row's onMouseLeave is the other disarm.
    act(() => {
      trashBtn().dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });

    expect(trashBtn().getAttribute('data-armed')).toBe('false');
    expect(onClick).not.toHaveBeenCalled();
  });

  it('without requiresConfirm the action stays ONE click (reversible ops)', () => {
    const onClick = vi.fn();
    mount({ ...baseAction, onClick });

    expect(trashBtn().hasAttribute('data-armed')).toBe(false);
    click(trashBtn());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('the action never doubles as a row select', () => {
    const onClick = vi.fn();
    const onSelect = vi.fn();
    act(() => {
      root.render(
        createElement(ChannelItemView, {
          channel: makeChannel(),
          isActive: false,
          unreadCount: 0,
          onSelect,
          action: { ...baseAction, onClick, requiresConfirm: true },
        } as never),
      );
    });

    click(trashBtn());
    click(trashBtn());

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
