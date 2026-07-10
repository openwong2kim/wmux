// @vitest-environment jsdom
//
// Dynamic interaction test for the P1 channel DISCOVERY group. A public channel
// the self workspace hasn't joined is surfaced in a collapsible "Discover" group
// with a Join button (instead of being mixed into the joined/active list).
// renderToStaticMarkup (ChannelsPanel.test.tsx) can't fire clicks or run the
// disclosure state, so this mounts the REAL <ChannelsPanelView/> via
// react-dom/client and drives the actual DOM events the user dogfoods:
// expand the group → click Join → assert the join callback fires with the right
// channel id, and the name-click previews via onSelect.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Channel, OperatorChannelSummary } from '../../../../shared/channels';
import { ChannelsPanelView } from '../ChannelsPanel';

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

interface MountOpts {
  onJoinDiscoverable?: (id: string) => void;
  onSelect?: (id: string) => void;
}

function mount(opts: MountOpts = {}): void {
  act(() => {
    root.render(
      createElement(ChannelsPanelView, {
        channels: {
          joined: makeChannel({ id: 'joined', name: 'joined-room', visibility: 'public' }),
          pub: makeChannel({ id: 'pub', name: 'browse-me', visibility: 'public' }),
        },
        channelUnread: {},
        channelMentions: {},
        activeChannelId: null,
        company: null,
        // self ws is a member of `joined` only → `pub` is discoverable
        memberChannelIds: new Set<string>(['joined']),
        onSelect: opts.onSelect ?? (() => undefined),
        onCreate: () => true,
        onJoinDiscoverable: opts.onJoinDiscoverable ?? (() => undefined),
      }),
    );
  });
}

const q = (sel: string): HTMLElement | null => container.querySelector(sel);
function must(sel: string, what: string): HTMLElement {
  const el = container.querySelector(sel);
  if (!el) throw new Error(`${what} not found: ${sel}`);
  return el as HTMLElement;
}
const click = (el: HTMLElement): void =>
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ChannelsPanelView — discovery group (jsdom)', () => {
  it('shows a Discover group for public non-member channels, collapsed by default', () => {
    mount();
    const group = q('[data-channels-discover-group]');
    expect(group).not.toBeNull();
    // Toggle present with the count of discoverable channels (1).
    expect(q('[data-channels-discover-toggle]')?.textContent).toContain('1');
    // Collapsed by default → the item is not rendered yet.
    expect(q('[data-channels-discover-item]')).toBeNull();
    // The joined channel is NOT in the discover group.
    expect(container.querySelector('[data-channels-discover-item][data-channel-id="joined"]')).toBeNull();
  });

  it('expanding reveals the discoverable item; Join fires onJoinDiscoverable with its id', () => {
    const onJoinDiscoverable = vi.fn();
    mount({ onJoinDiscoverable });

    click(must('[data-channels-discover-toggle]', 'discover toggle')); // expand
    expect(q('[data-channels-discover-item][data-channel-id="pub"]')).not.toBeNull();
    const joinBtn = must(
      '[data-channels-discover-item][data-channel-id="pub"] [data-channels-discover-join]',
      'join button',
    );
    click(joinBtn);
    expect(onJoinDiscoverable).toHaveBeenCalledTimes(1);
    expect(onJoinDiscoverable).toHaveBeenCalledWith('pub');
  });

  it('clicking the discoverable name previews via onSelect (without joining)', () => {
    const onSelect = vi.fn();
    const onJoinDiscoverable = vi.fn();
    mount({ onSelect, onJoinDiscoverable });

    click(must('[data-channels-discover-toggle]', 'discover toggle')); // expand
    const nameBtn = must(
      '[data-channels-discover-item][data-channel-id="pub"] button',
      'name button',
    );
    click(nameBtn);
    expect(onSelect).toHaveBeenCalledWith('pub');
    expect(onJoinDiscoverable).not.toHaveBeenCalled();
  });

  it('without memberChannelIds (back-compat) renders no Discover group', () => {
    act(() => {
      root.render(
        createElement(ChannelsPanelView, {
          channels: { pub: makeChannel({ id: 'pub', name: 'browse-me' }) },
          channelUnread: {},
          channelMentions: {},
          activeChannelId: null,
          company: null,
          onSelect: () => undefined,
          onCreate: () => true,
        }),
      );
    });
    expect(q('[data-channels-discover-group]')).toBeNull();
  });
});

describe('ChannelsPanelView — operator section vs observed channels (W1, jsdom)', () => {
  const makeSummary = (overrides: Partial<OperatorChannelSummary> = {}): OperatorChannelSummary => ({
    id: 'op-1',
    name: 'agent-room',
    visibility: 'private',
    status: 'active',
    memberCount: 1,
    createdAt: 1_700_000_000_000,
    ...overrides,
  });

  it('an OBSERVED channel already in the mirror is NOT duplicated in the operator section', () => {
    act(() => {
      root.render(
        createElement(ChannelsPanelView, {
          channels: {
            // Present in the catalog mirror → renders in the normal (active,
            // observed-badged) list, so the operator section must exclude it.
            obs: makeChannel({ id: 'obs', name: 'agent-room', visibility: 'private', observed: true }),
          },
          channelUnread: {},
          channelMentions: {},
          activeChannelId: null,
          company: null,
          memberChannelIds: new Set<string>(),
          onSelect: () => undefined,
          onCreate: () => true,
          operatorChannels: [
            // Same channel as the mirror row above → excluded (no double-show).
            makeSummary({ id: 'obs', name: 'agent-room' }),
            // NOT in the mirror (stale hydration / pre-W1 daemon) → still listed.
            makeSummary({ id: 'hidden', name: 'not-hydrated' }),
          ],
          onOperatorToggle: () => undefined,
          onOperatorJoin: () => undefined,
        }),
      );
    });
    // The observed channel shows ONCE, in the normal active group.
    expect(q('[data-channels-active-group] [data-channel-id="obs"]')).not.toBeNull();
    click(must('[data-channels-operator-toggle]', 'operator toggle')); // expand
    // ...and never again in the operator section; the un-mirrored one remains.
    expect(q('[data-channels-operator-item][data-channel-id="obs"]')).toBeNull();
    expect(q('[data-channels-operator-item][data-channel-id="hidden"]')).not.toBeNull();
  });
});

describe('ChannelsPanelView — create-channel modal (jsdom)', () => {
  it('opens as a viewport-fixed popover (not absolute) so the dock overflow cannot clip it', () => {
    mount();
    click(must('[data-channels-new]', 'new-channel button'));
    const modal = must('[data-create-channel-modal]', 'create modal');
    // The bug: an absolutely-positioned modal was clipped by ChannelDock's
    // overflow-y-auto wrapper (right edge + Cancel/Create cut off). The fix
    // makes it `fixed` (escapes every overflow ancestor), anchored to the "+".
    expect(modal.className).toContain('fixed');
    expect(modal.className).not.toContain('absolute');
  });

  it('creates the channel on Enter in the name input (no Create-button click needed)', () => {
    const onCreate = vi.fn(() => true);
    act(() => {
      root.render(
        createElement(ChannelsPanelView, {
          channels: {},
          channelUnread: {},
          channelMentions: {},
          activeChannelId: null,
          company: null,
          onSelect: () => undefined,
          onCreate,
        }),
      );
    });
    click(must('[data-channels-new]', 'new-channel button'));
    const input = must('[data-create-channel-name]', 'name input') as HTMLInputElement;
    const setVal = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
    act(() => {
      setVal?.call(input, 'release-notes');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onCreate).toHaveBeenCalledWith({ name: 'release-notes', visibility: 'public' });
  });

  it('disables Create until the name is valid (not only after a failed submit)', () => {
    mount();
    click(must('[data-channels-new]', 'new-channel button'));
    const btn = must('[data-create-channel-submit]', 'create button') as HTMLButtonElement;
    expect(btn.disabled).toBe(true); // empty name → invalid → disabled up front
    const input = must('[data-create-channel-name]', 'name input') as HTMLInputElement;
    const setVal = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
    act(() => {
      setVal?.call(input, 'release-notes');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(btn.disabled).toBe(false); // valid → enabled
  });

  it('guards the in-flight create — a second submit while creating does not double-create', () => {
    let resolveCreate: (v: boolean) => void = () => undefined;
    const onCreate = vi.fn(() => new Promise<boolean>((r) => {
      resolveCreate = r;
    }));
    act(() => {
      root.render(
        createElement(ChannelsPanelView, {
          channels: {},
          channelUnread: {},
          channelMentions: {},
          activeChannelId: null,
          company: null,
          onSelect: () => undefined,
          onCreate,
        }),
      );
    });
    click(must('[data-channels-new]', 'new-channel button'));
    const input = must('[data-create-channel-name]', 'name input') as HTMLInputElement;
    const setVal = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
    act(() => {
      setVal?.call(input, 'release-notes');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // First submit starts the (pending) create → creating=true.
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    // Second submit while the first is still in-flight must be a no-op.
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onCreate).toHaveBeenCalledTimes(1);
    act(() => {
      resolveCreate(false); // settle the pending promise so the modal cleans up
    });
  });

  it('does NOT submit on Enter while an IME composition is active', () => {
    const onCreate = vi.fn(() => true);
    act(() => {
      root.render(
        createElement(ChannelsPanelView, {
          channels: {},
          channelUnread: {},
          channelMentions: {},
          activeChannelId: null,
          company: null,
          onSelect: () => undefined,
          onCreate,
        }),
      );
    });
    click(must('[data-channels-new]', 'new-channel button'));
    const input = must('[data-create-channel-name]', 'name input') as HTMLInputElement;
    const setVal = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
    act(() => {
      setVal?.call(input, 'release-notes');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Enter that COMMITS an IME composition must not create the channel.
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    });
    expect(onCreate).not.toHaveBeenCalled();
  });
});
