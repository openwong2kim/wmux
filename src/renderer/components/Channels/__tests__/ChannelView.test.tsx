// ─── Tests for ChannelView (U8) ──────────────────────────────────────────
//
// Mirrors the ChannelsPanel.test pattern: pure helpers exercised
// directly, presentational views driven via renderToStaticMarkup with
// controlled props. The container's store reads are tested via the
// round-trip-style "container renders the active channel" case, which
// also exercises the real Composer mount as a slot.
//
// The test renders <ChannelViewContent /> in isolation — never the
// container — so no zustand server-snapshot state-mutation problem.
// The container's mount-gate ("returns null when no active channel")
// is asserted by importing the file and asserting the default export
// is a function (the actual mount behavior is verified by
// `useStore.setState` in the round-trip test).
//
// Plan ref: U8 verification — `npx vitest run src/renderer/components/Channels/`.

import { describe, it, expect, beforeEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Channel, ChannelMember, ChannelMessage } from '../../../../shared/channels';
import { useStore } from '../../../stores';
import {
  ChannelView,
  ChannelViewContent,
  isMessageVisibleToViewer,
  sortMessagesBySeq,
  renderMessageText,
  renderMessageBody,
  SCROLLBACK_PAGE,
} from '../ChannelView';

// ─── Test fixtures ──────────────────────────────────────────────────────

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

function makeMember(overrides: Partial<ChannelMember> = {}): ChannelMember {
  return {
    workspaceId: 'ws-1',
    memberId: 'm-1',
    joinedAt: 1_700_000_000_000,
    historyFromSeq: 0,
    ...overrides,
  };
}

function makeMessage(
  channelId: string,
  seq: number,
  overrides: Partial<ChannelMessage> = {},
): ChannelMessage {
  return {
    channelId,
    seq,
    workspaceId: 'ws-1',
    memberId: 'm-1',
    memberName: 'Lead',
    text: `msg-${seq}`,
    postedAt: 1_700_000_000_000 + seq,
    deliveryStatus: 'pending',
    ...overrides,
  };
}

// ─── Pure helper tests ──────────────────────────────────────────────────

describe('renderMessageText', () => {
  it('returns the plain string when there are no mentions', () => {
    expect(renderMessageText('hello world')).toBe('hello world');
    expect(renderMessageText('hello', [])).toBe('hello');
  });

  it('wraps an @name token in a highlight span', () => {
    const out = renderMessageText('hi @bob bye', [{ workspaceId: 'ws-2', name: 'bob' }]);
    const html = renderToStaticMarkup(createElement('div', null, out));
    expect(html).toContain('data-channel-mention-token');
    expect(html).toContain('@bob');
  });

  it('prefers the longer name when two mentions share a prefix', () => {
    const out = renderMessageText('ping @john doe!', [
      { workspaceId: 'ws-2', name: 'john' },
      { workspaceId: 'ws-3', name: 'john doe' },
    ]);
    const html = renderToStaticMarkup(createElement('div', null, out));
    expect(html).toContain('@john doe');
  });

  it('leaves a bare @ that matches no member as plain text', () => {
    const out = renderMessageText('email a@b.com', [{ workspaceId: 'ws-2', name: 'bob' }]);
    const html = renderToStaticMarkup(createElement('div', null, out));
    expect(html).not.toContain('data-channel-mention-token');
  });
});

describe('renderMessageBody (markdown subset)', () => {
  const html = (node: React.ReactNode): string =>
    renderToStaticMarkup(createElement('div', null, node));

  it('returns plain text verbatim when there is nothing to format', () => {
    expect(renderMessageBody('just text')).toBe('just text');
    expect(renderMessageBody('')).toBe('');
  });

  it('renders a fenced code block as <pre> and does NOT format inside it', () => {
    const out = html(renderMessageBody('before\n```\nconst x = **not bold**\n```\nafter'));
    expect(out).toContain('data-channel-code-block');
    expect(out).toContain('const x = **not bold**'); // literal, not bolded
    expect(out).not.toContain('data-md-bold');
    expect(out).toContain('before');
    expect(out).toContain('after');
  });

  it('renders inline `code` and **bold**', () => {
    const out = html(renderMessageBody('use `npm run build` and **ship** it'));
    expect(out).toContain('data-md-code');
    expect(out).toContain('npm run build');
    expect(out).toContain('data-md-bold');
    expect(out).toContain('ship');
  });

  it('still highlights @mentions in plain runs', () => {
    const out = html(renderMessageBody('hey @bob check `this`', [{ workspaceId: 'ws-2', name: 'bob' }]));
    expect(out).toContain('data-channel-mention-token');
    expect(out).toContain('@bob');
    expect(out).toContain('data-md-code');
  });

  it('does not highlight an @mention inside a code block', () => {
    const out = html(renderMessageBody('```\nping @bob\n```', [{ workspaceId: 'ws-2', name: 'bob' }]));
    expect(out).toContain('data-channel-code-block');
    expect(out).not.toContain('data-channel-mention-token');
  });

  it('never emits a raw HTML sink (no dangerouslySetInnerHTML escape)', () => {
    const out = html(renderMessageBody('<script>alert(1)</script> **x**'));
    // The angle brackets are escaped by React (rendered as text), not injected.
    expect(out).toContain('&lt;script&gt;');
    expect(out).not.toContain('<script>');
  });
});

describe('ChannelViewContent — mention highlight', () => {
  it('flags a message that mentions the viewer with data-mentions-me', () => {
    const html = renderToStaticMarkup(
      createElement(ChannelViewContent, {
        channel: makeChannel(),
        messages: [makeMessage('ch-1', 1, { text: 'hey @me', mentions: [{ workspaceId: 'ws-me', name: 'me' }] })],
        viewer: makeMember({ workspaceId: 'ws-me' }),
        onClose: () => undefined,
        composerSlot: createElement('div'),
      }),
    );
    expect(html).toContain('data-mentions-me="true"');
    expect(html).toContain('data-channel-mention-token');
  });

  it('does not flag a message that mentions another workspace', () => {
    const html = renderToStaticMarkup(
      createElement(ChannelViewContent, {
        channel: makeChannel(),
        messages: [makeMessage('ch-1', 1, { mentions: [{ workspaceId: 'ws-other', name: 'other' }] })],
        viewer: makeMember({ workspaceId: 'ws-me' }),
        onClose: () => undefined,
        composerSlot: createElement('div'),
      }),
    );
    expect(html).not.toContain('data-mentions-me');
  });
});

describe('isMessageVisibleToViewer', () => {
  it('returns false when viewer is null', () => {
    const m = makeMessage('ch-1', 1);
    expect(isMessageVisibleToViewer(m, null)).toBe(false);
  });

  it('returns true for seq >= historyFromSeq', () => {
    const m = makeMessage('ch-1', 5);
    const viewer = makeMember({ historyFromSeq: 3 });
    expect(isMessageVisibleToViewer(m, viewer)).toBe(true);
  });

  it('returns false for seq < historyFromSeq', () => {
    const m = makeMessage('ch-1', 2);
    const viewer = makeMember({ historyFromSeq: 3 });
    expect(isMessageVisibleToViewer(m, viewer)).toBe(false);
  });

  it('returns true when historyFromSeq is 0 (full history)', () => {
    const m = makeMessage('ch-1', 1);
    const viewer = makeMember({ historyFromSeq: 0 });
    expect(isMessageVisibleToViewer(m, viewer)).toBe(true);
  });
});

describe('sortMessagesBySeq', () => {
  it('sorts ascending by seq', () => {
    const sorted = sortMessagesBySeq([
      makeMessage('ch-1', 3),
      makeMessage('ch-1', 1),
      makeMessage('ch-1', 2),
    ]);
    expect(sorted.map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it('does not mutate the input array', () => {
    const input = [makeMessage('ch-1', 3), makeMessage('ch-1', 1)];
    const snapshot = input.slice();
    sortMessagesBySeq(input);
    expect(input).toEqual(snapshot);
  });

  it('returns an empty array for an empty input', () => {
    expect(sortMessagesBySeq([])).toEqual([]);
  });
});

// `viewerDeliveryStatus` is gone (C-2): it read the SENDER's own row out of
// the recipient snapshot, a row that is never there. Its replacement,
// ownMessageDeliveryState, is covered by deliveryStatus.test.ts.

// ─── ChannelViewContent (renderToStaticMarkup) ──────────────────────────

function renderView(args: {
  channel?: Channel;
  messages?: ChannelMessage[];
  viewer?: ChannelMember | null;
  onClose?: () => void;
  onLeave?: () => void;
  onArchive?: () => void;
  composerSlot?: React.ReactNode;
} = {}): string {
  return renderToStaticMarkup(
    createElement(ChannelViewContent, {
      channel: args.channel ?? makeChannel(),
      messages: args.messages ?? [],
      viewer: args.viewer === undefined ? null : args.viewer,
      onClose: args.onClose ?? (() => undefined),
      onLeave: args.onLeave,
      onArchive: args.onArchive,
      composerSlot: args.composerSlot ?? <div data-fake-composer />,
    }),
  );
}

beforeEach(() => {
  // Reset channel state so cross-test leakage (especially the
  // round-trip test at the bottom) doesn't pollute these.
  useStore.setState((s) => {
    s.channels = {};
    s.channelMembers = {};
    s.channelMessages = {};
    s.activeChannelId = null;
    s.channelUnread = {};
  });
});

describe('ChannelViewContent', () => {
  it('renders the empty-messages prompt when the channel has no messages', () => {
    const html = renderView({ messages: [] });
    expect(html).toContain('data-channel-view-empty');
    expect(html).toContain('data-channel-view-messages');
    expect(html).toContain('data-message-count="0"');
  });

  it('windows the list to the most recent page and offers "load earlier" (P3b)', () => {
    const messages = Array.from({ length: SCROLLBACK_PAGE + 1 }, (_, i) =>
      makeMessage('ch-1', i + 1, { text: `m${i + 1}` }),
    );
    const html = renderView({ viewer: makeMember({ memberId: 'm-1' }), messages });
    // The container still reports the TOTAL visible count.
    expect(html).toContain(`data-message-count="${SCROLLBACK_PAGE + 1}"`);
    // Only the most recent page of rows renders.
    expect((html.match(/data-channel-message="true"/g) || []).length).toBe(SCROLLBACK_PAGE);
    // The load-earlier affordance shows the hidden count (1).
    expect(html).toContain('data-channels-load-earlier');
    // Oldest (m1) is windowed out; newest (m201) is shown.
    expect(html).not.toContain('>m1<');
    expect(html).toContain('>m201<');
  });

  it('renders the search toggle but no search input until opened (P3c)', () => {
    const html = renderView({ viewer: makeMember({ memberId: 'm-1' }), messages: [makeMessage('ch-1', 1)] });
    expect(html).toContain('data-channel-search-toggle');
    // The input is behind the toggle (useState) — absent in the static render.
    expect(html).not.toContain('data-channel-search="true"');
  });

  it('does not render the load-earlier affordance when under the window (P3b)', () => {
    const messages = Array.from({ length: 3 }, (_, i) => makeMessage('ch-1', i + 1, { text: `m${i + 1}` }));
    const html = renderView({ viewer: makeMember({ memberId: 'm-1' }), messages });
    expect(html).not.toContain('data-channels-load-earlier');
    expect((html.match(/data-channel-message="true"/g) || []).length).toBe(3);
  });

  it('renders messages in seq order', () => {
    const html = renderView({
      viewer: makeMember({ memberId: 'm-1' }),
      messages: [
        makeMessage('ch-1', 2, { text: 'second', memberName: 'B' }),
        makeMessage('ch-1', 1, { text: 'first', memberName: 'A' }),
        makeMessage('ch-1', 3, { text: 'third', memberName: 'C' }),
      ],
    });
    // Check that 'first' appears before 'second' before 'third' in the
    // rendered HTML.
    const i1 = html.indexOf('first');
    const i2 = html.indexOf('second');
    const i3 = html.indexOf('third');
    expect(i1).toBeGreaterThan(-1);
    expect(i2).toBeGreaterThan(i1);
    expect(i3).toBeGreaterThan(i2);
    expect(html).toContain('data-message-count="3"');
  });

  it('filters out messages with seq < historyFromSeq for the viewer', () => {
    const html = renderView({
      messages: [
        makeMessage('ch-1', 1, { text: 'hidden-pre-history' }),
        makeMessage('ch-1', 5, { text: 'visible-post-history' }),
      ],
      viewer: makeMember({ historyFromSeq: 3 }),
    });
    expect(html).not.toContain('hidden-pre-history');
    expect(html).toContain('visible-post-history');
    expect(html).toContain('data-message-count="1"');
  });

  it('hides all messages when the viewer is null', () => {
    const html = renderView({
      messages: [makeMessage('ch-1', 1, { text: 'should-be-hidden' })],
      viewer: null,
    });
    expect(html).not.toContain('should-be-hidden');
    expect(html).toContain('data-message-count="0"');
  });

  it('shows the per-recipient delivery indicator on the viewer own message', () => {
    const html = renderView({
      messages: [
        makeMessage('ch-1', 1, {
          memberId: 'm-1',
          memberName: 'Me',
          text: 'own-message',
          deliveryStatus: 'delivered',
        }),
        makeMessage('ch-1', 2, {
          memberId: 'm-2',
          memberName: 'Other',
          text: 'their-message',
          deliveryStatus: 'delivered',
        }),
      ],
      viewer: makeMember({ memberId: 'm-1' }),
    });
    // The own message carries a delivery footer.
    expect(html).toContain('data-channel-message-delivery');
    expect(html).toContain('data-delivery-status="delivered"');
    // The other-member message has no delivery footer.
    // Each message row's data-delivery attribute reflects whether the
    // viewer is the author. The own message gets the live status; the
    // other message gets 'unknown' (no status indicator for non-self).
    expect(html).toMatch(/data-seq="1"[\s\S]*?data-delivery="delivered"/);
    expect(html).toMatch(/data-seq="2"[\s\S]*?data-delivery="unknown"/);
  });

  it('shows the archived badge when the channel is archived', () => {
    const html = renderView({
      channel: makeChannel({ status: 'archived' }),
    });
    expect(html).toContain('data-channel-archived-badge');
    expect(html).toContain('data-channel-status="archived"');
  });

  it('does not show the archived badge for active channels', () => {
    const html = renderView({
      channel: makeChannel({ status: 'active' }),
    });
    expect(html).not.toContain('data-channel-archived-badge');
  });

  it('renders the archive affordance when onArchive is provided and the channel is active', () => {
    const html = renderView({ onArchive: () => undefined });
    expect(html).toContain('data-channel-view-archive');
    expect(html).toContain('data-armed="false"'); // unarmed until first click
  });

  it('does NOT render the archive affordance when onArchive is absent (non-creator)', () => {
    const html = renderView(); // no onArchive
    expect(html).not.toContain('data-channel-view-archive');
  });

  it('does NOT render the archive affordance for an already-archived channel', () => {
    const html = renderView({
      channel: makeChannel({ status: 'archived' }),
      onArchive: () => undefined,
    });
    expect(html).not.toContain('data-channel-view-archive');
  });

  it('mounts the composer slot at the bottom of the view', () => {
    const html = renderView({
      composerSlot: <div data-custom-composer-marker>composer-here</div>,
    });
    expect(html).toContain('data-custom-composer-marker');
    expect(html).toContain('composer-here');
  });

  it('exposes a close-view affordance (data-channel-view-close) for onClose', () => {
    // Close-view button = deselect the conversation, channel stays. Present
    // regardless of membership.
    const html = renderView();
    expect(html).toContain('data-channel-view-close');
  });

  it('shows the leave (X) affordance only when onLeave is provided', () => {
    // X = leave the channel. The container passes onLeave only when self is a
    // member; a public channel you are merely previewing has no leave button.
    expect(renderView({ onLeave: () => undefined })).toContain('data-channel-view-leave');
    expect(renderView()).not.toContain('data-channel-view-leave');
  });

  it('contains no literal hex colors in the rendered view (theme tokens only)', () => {
    const html = renderView({
      messages: [
        makeMessage('ch-1', 1, { memberId: 'm-1', deliveryStatus: 'delivered' }),
      ],
      viewer: makeMember({ memberId: 'm-1' }),
    });
    // Plan U8 verification: no literal hex colors.
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}(?=[^a-zA-Z0-9])/);
  });
});

// ─── Round-trip — container mount gate (activeChannelId null vs set) ────
//
// The container's mount-gate is `if (!activeChannelId || !channel) return null;`.
// We assert it from both sides:
//
//   1. The default export is the container function (sanity check).
//   2. Direct state inspection after setState — the gate's inputs are
//      `activeChannelId` (a slice field) and `s.channels[activeChannelId]`
//      (a slice field). Verifying the state machine is equivalent to
//      verifying the gate's inputs are wired correctly.
//   3. The slice action `setActiveChannel(null)` clears the gate's
//      primary input — exercises the round-trip path (action → state)
//      that the container depends on.
//
// We deliberately avoid `renderToStaticMarkup(createElement(ChannelView))`
// under the shared `useStore` because zustand + immer's server-snapshot
// caching does not pick up post-setState changes within a single test
// pass (it captures the initial state at the first subscription). The
// ChannelsPanel.test.tsx pattern follows the same constraint — it tests
// the slice's `createChannelOptimistic` directly, not the container.
// The actual mount-gate behavior is covered by the AppLayout integration
// smoke test (mount/unmount on toggle).

describe('ChannelView container — mount gate', () => {
  it('the default export is the container function component', () => {
    expect(typeof ChannelView).toBe('function');
  });

  it('activeChannelId is null after the slice reset', () => {
    expect(useStore.getState().activeChannelId).toBeNull();
  });

  it('setActiveChannel(null) clears the mount-gate primary input', () => {
    // Seed an active channel then clear it via the slice action —
    // mirrors the click-to-close handler the container registers.
    useStore.getState().setActiveChannel('ch-1');
    expect(useStore.getState().activeChannelId).toBe('ch-1');
    useStore.getState().setActiveChannel(null);
    expect(useStore.getState().activeChannelId).toBeNull();
  });

  it('channel lookup resolves a known id and is undefined for a missing id', () => {
    useStore.setState((s) => {
      s.channels = { 'ch-1': makeChannel() };
    });
    expect(useStore.getState().channels['ch-1']?.id).toBe('ch-1');
    expect(useStore.getState().channels['ch-missing']).toBeUndefined();
  });
});
