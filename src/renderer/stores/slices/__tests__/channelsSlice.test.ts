// Tests for the channelsSlice state mirror.
//
// Coverage (mirrors plan U6 test scenarios):
//   1. Initial state defaults (empty maps, no active channel, no unread).
//   2. `createChannelOptimistic` adds a channel + auto-member to local
//      state and returns `{ ok: true, channel }`.
//   3. `postMessageOptimistic` appends a message to the right
//      `channelMessages` entry and bumps `channelUnread` when the
//      channel isn't active; the post path returns the message.
//   4. `appendMessageFromEvent` appends a message and bumps unread
//      for non-active channels; existing same-seq rows are deduped
//      (optimistic + event both arrive for the same post).
//   5. `markChannelRead` clears the unread count for the channel.
//   6. `setActiveChannel` updates `activeChannelId` AND clears the
//      unread count for the new active channel.
//   7. `setChannels` replaces the catalog and preserves existing
//      per-channel message caches.
//   8. Wiring: the slice is registered in `src/renderer/stores/index.ts`
//      and visible via `useStore` — smoke test on the composed store.
//
// The slice is bridge-free (no daemon RPCs of its own); transport-level
// failure is the caller's concern, so the slice tests focus on
// state-shape correctness.

import { describe, it, expect } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import {
  createChannelsSlice,
  type ChannelsSlice,
  type ChannelMemberAddress,
} from '../channelsSlice';
import type { Channel, ChannelMember, ChannelMessage } from '../../../../shared/channels';

// Minimal test store carrying only ChannelsSlice — mirrors the
// searchSlice / a2aSlice test pattern. The `@ts-expect-error` is
// unavoidable because createChannelsSlice's StateCreator is typed
// against the full StoreState union.
type TestState = ChannelsSlice;

function createTestStore() {
  return create<TestState>()(
    immer((...args) => ({
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createChannelsSlice(...args),
    })),
  );
}

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

const sender: ChannelMemberAddress = {
  workspaceId: 'ws-1',
  memberId: 'm-1',
  memberName: 'Lead',
};

describe('channelsSlice — initial state', () => {
  it('starts with empty maps and no active channel', () => {
    const store = createTestStore();
    const s = store.getState();
    expect(s.channels).toEqual({});
    expect(s.channelMembers).toEqual({});
    expect(s.channelMessages).toEqual({});
    expect(s.activeChannelId).toBeNull();
    expect(s.channelUnread).toEqual({});
  });
});

describe('channelsSlice — createChannelOptimistic', () => {
  it('adds the channel + an auto-member row + an empty message list', () => {
    const store = createTestStore();
    const ch = makeChannel({ id: 'ch-new', name: 'release-notes' });

    const res = store.getState().createChannelOptimistic({
      name: 'release-notes',
      visibility: 'public',
      createdBy: sender,
      channel: ch,
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.id).toBe('ch-new');

    const s = store.getState();
    expect(s.channels['ch-new']).toEqual(ch);
    expect(s.channelMembers['ch-new']).toHaveLength(1);
    expect(s.channelMembers['ch-new'][0].memberId).toBe('m-1');
    expect(s.channelMessages['ch-new']).toEqual([]);
  });

  it('does not double-add an existing auto-member on re-call', () => {
    const store = createTestStore();
    const ch = makeChannel({ id: 'ch-1' });
    store.getState().createChannelOptimistic({
      name: 'general',
      visibility: 'public',
      createdBy: sender,
      channel: ch,
    });
    // Re-applying with the same channel + same creator is a no-op for
    // members (defensive: callers may retry on a transient RPC error).
    store.getState().createChannelOptimistic({
      name: 'general',
      visibility: 'public',
      createdBy: sender,
      channel: ch,
    });
    expect(store.getState().channelMembers['ch-1']).toHaveLength(1);
  });
});

describe('channelsSlice — postMessageOptimistic', () => {
  it('appends the message and returns ok when channel is not active', () => {
    const store = createTestStore();
    const ch = makeChannel();
    store.getState().createChannelOptimistic({
      name: 'general',
      visibility: 'public',
      createdBy: sender,
      channel: ch,
    });

    const msg = makeMessage('ch-1', 1, { text: 'hello' });
    const res = store.getState().postMessageOptimistic('ch-1', {
      text: 'hello',
      sender,
      message: msg,
    });

    expect(res.ok).toBe(true);
    const s = store.getState();
    expect(s.channelMessages['ch-1']).toHaveLength(1);
    expect(s.channelMessages['ch-1'][0].text).toBe('hello');
    // Channel is not active → unread bumps to 1.
    expect(s.channelUnread['ch-1']).toBe(1);
  });

  it('does NOT bump unread when the channel is active', () => {
    const store = createTestStore();
    store.getState().createChannelOptimistic({
      name: 'general',
      visibility: 'public',
      createdBy: sender,
      channel: makeChannel(),
    });
    store.getState().setActiveChannel('ch-1');

    store.getState().postMessageOptimistic('ch-1', {
      text: 'hi',
      sender,
      message: makeMessage('ch-1', 1),
    });

    expect(store.getState().channelUnread['ch-1']).toBe(0);
  });

  it('dedupes optimistic post by seq (event will follow)', () => {
    const store = createTestStore();
    store.getState().createChannelOptimistic({
      name: 'general',
      visibility: 'public',
      createdBy: sender,
      channel: makeChannel(),
    });
    store.getState().postMessageOptimistic('ch-1', {
      text: 'first',
      sender,
      message: makeMessage('ch-1', 1),
    });
    // Same seq, same channel → second post must NOT append a duplicate row.
    store.getState().postMessageOptimistic('ch-1', {
      text: 'second',
      sender,
      message: makeMessage('ch-1', 1),
    });
    expect(store.getState().channelMessages['ch-1']).toHaveLength(1);
    expect(store.getState().channelUnread['ch-1']).toBe(1);
  });
});

describe('channelsSlice — appendMessageFromEvent', () => {
  it('appends an event message and bumps unread for non-active channels', () => {
    const store = createTestStore();
    store.getState().createChannelOptimistic({
      name: 'general',
      visibility: 'public',
      createdBy: sender,
      channel: makeChannel(),
    });

    store.getState().appendMessageFromEvent(makeMessage('ch-1', 1, { text: 'from-event' }));

    const s = store.getState();
    expect(s.channelMessages['ch-1']).toHaveLength(1);
    expect(s.channelMessages['ch-1'][0].text).toBe('from-event');
    expect(s.channelUnread['ch-1']).toBe(1);
  });

  it('overwrites an existing same-seq row with the event payload (authoritative)', () => {
    const store = createTestStore();
    store.getState().createChannelOptimistic({
      name: 'general',
      visibility: 'public',
      createdBy: sender,
      channel: makeChannel(),
    });
    // Optimistic post lands first.
    store.getState().postMessageOptimistic('ch-1', {
      text: 'optimistic',
      sender,
      message: makeMessage('ch-1', 7, { text: 'optimistic', clientMsgId: 'k-1' }),
    });
    // Event follows with the same seq but the authoritative text.
    store.getState().appendMessageFromEvent(
      makeMessage('ch-1', 7, { text: 'authoritative', clientMsgId: 'k-1' }),
    );

    const list = store.getState().channelMessages['ch-1'];
    expect(list).toHaveLength(1);
    expect(list[0].text).toBe('authoritative');
    // The optimistic append bumped unread to 1. The event for the SAME
    // seq must not double-bump it — the dedup-by-seq path replaces,
    // it does not append.
    expect(store.getState().channelUnread['ch-1']).toBe(1);
  });

  it('does NOT bump unread when the channel is active', () => {
    const store = createTestStore();
    store.getState().createChannelOptimistic({
      name: 'general',
      visibility: 'public',
      createdBy: sender,
      channel: makeChannel(),
    });
    store.getState().setActiveChannel('ch-1');
    store.getState().appendMessageFromEvent(makeMessage('ch-1', 1));
    expect(store.getState().channelUnread['ch-1']).toBe(0);
  });
});

describe('channelsSlice — markChannelRead', () => {
  it('clears the unread count for the channel', () => {
    const store = createTestStore();
    store.getState().createChannelOptimistic({
      name: 'general',
      visibility: 'public',
      createdBy: sender,
      channel: makeChannel(),
    });
    store.getState().appendMessageFromEvent(makeMessage('ch-1', 1));
    store.getState().appendMessageFromEvent(makeMessage('ch-1', 2));
    expect(store.getState().channelUnread['ch-1']).toBe(2);

    store.getState().markChannelRead('ch-1');
    expect(store.getState().channelUnread['ch-1']).toBe(0);
  });
});

describe('channelsSlice — setActiveChannel', () => {
  it('updates activeChannelId and clears the new channel unread badge', () => {
    const store = createTestStore();
    store.getState().createChannelOptimistic({
      name: 'general',
      visibility: 'public',
      createdBy: sender,
      channel: makeChannel(),
    });
    store.getState().appendMessageFromEvent(makeMessage('ch-1', 1));
    expect(store.getState().channelUnread['ch-1']).toBe(1);

    store.getState().setActiveChannel('ch-1');
    expect(store.getState().activeChannelId).toBe('ch-1');
    expect(store.getState().channelUnread['ch-1']).toBe(0);
  });

  it('setting null leaves unread untouched (closing the panel is not "read")', () => {
    const store = createTestStore();
    store.getState().createChannelOptimistic({
      name: 'general',
      visibility: 'public',
      createdBy: sender,
      channel: makeChannel(),
    });
    store.getState().appendMessageFromEvent(makeMessage('ch-1', 1));
    expect(store.getState().channelUnread['ch-1']).toBe(1);

    store.getState().setActiveChannel(null);
    // activeChannelId cleared, but the unread badge persists so the
    // sidebar can still show "you have unread messages here".
    expect(store.getState().activeChannelId).toBeNull();
    expect(store.getState().channelUnread['ch-1']).toBe(1);
  });
});

describe('channelsSlice — setChannels (refresh path)', () => {
  it('replaces the catalog wholesale and preserves existing per-channel message caches', () => {
    const store = createTestStore();
    // Seed a channel + a message so the cache has something to preserve.
    store.getState().createChannelOptimistic({
      name: 'general',
      visibility: 'public',
      createdBy: sender,
      channel: makeChannel({ id: 'ch-1' }),
    });
    store.getState().appendMessageFromEvent(makeMessage('ch-1', 1));

    // Refresh with an updated catalog: ch-1 (now archived) + ch-2 (new).
    store.getState().setChannels(
      [
        makeChannel({ id: 'ch-1', status: 'archived', archivedAt: 1_700_000_001_000 }),
        makeChannel({ id: 'ch-2', name: 'design', nextSeq: 1 }),
      ],
      {
        'ch-1': [makeMember({ memberId: 'm-1', workspaceId: 'ws-1' })],
        'ch-2': [makeMember({ memberId: 'm-2', workspaceId: 'ws-2', joinedAt: 1_700_000_002_000 })],
      },
    );

    const s = store.getState();
    expect(Object.keys(s.channels).sort()).toEqual(['ch-1', 'ch-2']);
    expect(s.channels['ch-1'].status).toBe('archived');
    // Message cache preserved across refresh.
    expect(s.channelMessages['ch-1']).toHaveLength(1);
    // New channel has an empty message list (setChannels initializes it).
    expect(s.channelMessages['ch-2']).toEqual([]);
    // Members replaced wholesale.
    expect(s.channelMembers['ch-2']).toHaveLength(1);
  });
});

describe('channelsSlice — leaveChannelOptimistic', () => {
  it('removes the member row but preserves the channel catalog entry', () => {
    const store = createTestStore();
    store.getState().createChannelOptimistic({
      name: 'general',
      visibility: 'public',
      createdBy: sender,
      channel: makeChannel(),
    });
    store.getState().joinChannelOptimistic('ch-1', { ...sender, memberId: 'm-2' }, 'ws-2');
    expect(store.getState().channelMembers['ch-1']).toHaveLength(2);

    store.getState().leaveChannelOptimistic('ch-1', 'm-2');

    expect(store.getState().channelMembers['ch-1']).toHaveLength(1);
    // Channel still exists; the 7-day empty-channel reaper (KTD8)
    // will purge it if no one rejoins.
    expect(store.getState().channels['ch-1']).toBeDefined();
  });
});

describe('channelsSlice — archiveChannelOptimistic', () => {
  it('replaces the catalog row with the archived variant', () => {
    const store = createTestStore();
    store.getState().createChannelOptimistic({
      name: 'general',
      visibility: 'public',
      createdBy: sender,
      channel: makeChannel({ status: 'active' }),
    });
    const archived = makeChannel({
      status: 'archived',
      archivedAt: 1_700_000_005_000,
      archivedBy: 'ws-1',
    });
    store.getState().archiveChannelOptimistic('ch-1', archived);
    expect(store.getState().channels['ch-1'].status).toBe('archived');
    expect(store.getState().channels['ch-1'].archivedBy).toBe('ws-1');
  });
});

describe('channelsSlice — wiring (composed store)', () => {
  // Smoke test: when the slice is composed into the full renderer
  // store, all the channel fields are reachable from the useStore
  // selector. This is the property the plan's U6 verification
  // asserts — the sidebar (U7) and composer (U8) will read these
  // through `useStore((s) => s.channels)` etc.
  it('is reachable through the composed store via channels selector', async () => {
    const { useStore } = await import('../../index');
    // Initial state: every field defaults to its empty value.
    const s = useStore.getState();
    expect(s.channels).toEqual({});
    expect(s.channelMembers).toEqual({});
    expect(s.channelMessages).toEqual({});
    expect(s.activeChannelId).toBeNull();
    expect(s.channelUnread).toEqual({});
    // Optimistic mutation goes through the same path as the test
    // store — composing the slice does not change the reducer logic.
    s.createChannelOptimistic({
      name: 'general',
      visibility: 'public',
      createdBy: sender,
      channel: makeChannel(),
    });
    expect(useStore.getState().channels['ch-1']).toBeDefined();
  });
});