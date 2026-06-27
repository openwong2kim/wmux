// @vitest-environment jsdom
//
// Dynamic interaction test for the channel-archive affordance. The header
// archive button is a TWO-CLICK confirm (first click ARMS, second COMMITS;
// blur cancels), so an accidental single click can't trigger the one-way
// archive. renderToStaticMarkup (ChannelView.test.tsx) cannot fire clicks,
// so this mounts the REAL <ChannelViewContent/> via react-dom/client and
// drives the actual DOM events — the click flow the user dogfoods.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Channel, ChannelMember, ChannelMessage } from '../../../../shared/channels';
import { ChannelViewContent } from '../ChannelView';

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

function mount(props: { channel?: Channel; onArchive?: () => void }): void {
  act(() => {
    root.render(
      createElement(ChannelViewContent, {
        channel: props.channel ?? makeChannel(),
        messages: [] as ChannelMessage[],
        viewer: null as ChannelMember | null,
        onClose: () => undefined,
        onArchive: props.onArchive,
        composerSlot: createElement('div', { 'data-fake-composer': true }),
      }),
    );
  });
}

function archiveBtn(): HTMLElement {
  const el = container.querySelector('[data-channel-view-archive]') as HTMLElement | null;
  if (!el) throw new Error('archive button not rendered');
  return el;
}
const click = (el: HTMLElement) =>
  act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ChannelViewContent — archive two-click confirm (jsdom)', () => {
  it('first click ARMS (does not archive); second click COMMITS once', () => {
    const onArchive = vi.fn();
    mount({ onArchive });

    expect(archiveBtn().getAttribute('data-armed')).toBe('false');
    expect(onArchive).not.toHaveBeenCalled();

    click(archiveBtn()); // arm
    expect(archiveBtn().getAttribute('data-armed')).toBe('true');
    expect(onArchive).not.toHaveBeenCalled();

    click(archiveBtn()); // commit
    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(archiveBtn().getAttribute('data-armed')).toBe('false'); // disarms after commit
  });

  it('blur cancels the armed state without archiving', () => {
    const onArchive = vi.fn();
    mount({ onArchive });

    click(archiveBtn());
    expect(archiveBtn().getAttribute('data-armed')).toBe('true');

    // React wires onBlur via focusout delegation at the root.
    act(() => { archiveBtn().dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    expect(archiveBtn().getAttribute('data-armed')).toBe('false');
    expect(onArchive).not.toHaveBeenCalled();
  });

  it('renders no archive affordance for an already-archived channel', () => {
    mount({ channel: makeChannel({ status: 'archived' }), onArchive: () => undefined });
    expect(container.querySelector('[data-channel-view-archive]')).toBeNull();
  });
});
