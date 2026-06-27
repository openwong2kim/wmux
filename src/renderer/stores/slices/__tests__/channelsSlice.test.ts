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
// Plus U4 coverage for the `*Daemon` wire-path entry points:
//   9. `createChannelDaemon` on RPC success: `*Optimistic` runs, state
//      has the daemon's authoritative row (NOT the synthesized input),
//      `result.ok === true`.
//  10. `createChannelDaemon` on RPC failure: `*Optimistic` does NOT
//      run, `result.ok === false`, `result.error.code` matches the
//      daemon's `ChannelError` code.
//  11. `postMessageDaemon` on RPC success: optimistic message pushed
//      with the daemon's authoritative row, `clientMsgId` propagated.
//  12. `postMessageDaemon` on RPC failure: no optimistic message
//      pushed, `result.error.code === 'PERSIST_FAILED'` propagates
//      to the caller.
//  13. `mapRpcError` buckets unknown daemon codes to `UNKNOWN` and
//      prefixes the original code in the message for debuggability.
//  14. Bridge-missing: `createChannelDaemon` returns an `UNKNOWN`
//      error without mutating state when `__wmuxChannelsRpc` is not
//      installed (the renderer mounting before the bridge effect).
//  15. Regression: the slice's existing `*Optimistic` thunks are
//      still callable directly (state-mirror-only use case).
//
// The slice is bridge-aware for the `*Daemon` thunks but the bridge
// is read lazily from `window.__wmuxChannelsRpc`. Tests install a
// mock global via `setChannelsRpc` to drive the success/failure
// paths without a real `useRpcBridge` mount.

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

describe('channelsSlice — hydrateChannelMessages (P0)', () => {
  it('merges history into the store, sorted by seq', () => {
    const store = createTestStore();
    store.getState().hydrateChannelMessages('ch-1', [
      makeMessage('ch-1', 3),
      makeMessage('ch-1', 1),
      makeMessage('ch-1', 2),
    ]);
    expect(store.getState().channelMessages['ch-1'].map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it('dedups by seq; the existing (live) row wins on collision', () => {
    const store = createTestStore();
    store.getState().appendMessageFromEvent(makeMessage('ch-1', 2, { text: 'live' }));
    store.getState().hydrateChannelMessages('ch-1', [
      makeMessage('ch-1', 1, { text: 'hist-1' }),
      makeMessage('ch-1', 2, { text: 'hist-2' }),
    ]);
    const list = store.getState().channelMessages['ch-1'];
    expect(list.map((m) => m.seq)).toEqual([1, 2]);
    // The live row already in the store wins the seq-2 collision (it may carry
    // a fresher delivery snapshot than the persisted history row).
    expect(list.find((m) => m.seq === 2)?.text).toBe('live');
  });

  it('does NOT bump channelUnread (loading history is not new unread)', () => {
    const store = createTestStore();
    // ch-1 is not the active channel, so a live append WOULD bump unread.
    store.getState().hydrateChannelMessages('ch-1', [makeMessage('ch-1', 1), makeMessage('ch-1', 2)]);
    expect(store.getState().channelUnread['ch-1'] ?? 0).toBe(0);
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

describe('channelsSlice — joinChannelOptimistic (composite-key dedup, invite fix)', () => {
  it('adds a workspace that reuses an existing memberId (the roster shares one UI memberId across workspaces)', () => {
    const store = createTestStore();
    store.getState().createChannelOptimistic({
      name: 'general',
      visibility: 'public',
      createdBy: sender, // creator = (ws-1, m-1)
      channel: makeChannel(),
    });
    expect(store.getState().channelMembers['ch-1']).toHaveLength(1);

    // Add a DIFFERENT workspace that reuses the SAME memberId (m-1) — exactly
    // what the members roster does (one constant UI_MEMBER_ID per add). Pre-fix
    // this collapsed on memberId and the new member never appeared.
    const res = store
      .getState()
      .joinChannelOptimistic('ch-1', { ...sender, workspaceId: 'ws-2' }, 'ws-2');

    expect(res.ok).toBe(true);
    const members = store.getState().channelMembers['ch-1'];
    expect(members).toHaveLength(2); // pre-fix: 1 (wrongly deduped on memberId alone)
    expect(members.map((m) => m.workspaceId).sort()).toEqual(['ws-1', 'ws-2']);
  });

  it('still dedups an exact (workspaceId, memberId) repeat', () => {
    const store = createTestStore();
    store.getState().joinChannelOptimistic('ch-1', { ...sender, workspaceId: 'ws-2' }, 'ws-2');
    store.getState().joinChannelOptimistic('ch-1', { ...sender, workspaceId: 'ws-2' }, 'ws-2');
    expect(store.getState().channelMembers['ch-1']).toHaveLength(1);
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

// ───────────────────────────────────────────────────────────────────────────
// U4: *Daemon thunks — wire-path entry points
// ───────────────────────────────────────────────────────────────────────────

// vitest's default `node` environment doesn't define `window`. The
// slice dereferences `window.__wmuxChannelsRpc` (and the *Optimistic
// thunks reach it through `get().channelsRpc()`), so we install a
// stub on globalThis to satisfy that lookup. The bridge-missing tests
// delete the stub so the slice falls into its `UNKNOWN` branch.
// Mirrors the searchSlice test pattern at
// `src/renderer/stores/slices/__tests__/searchSlice.test.ts:46-64`.
type ChannelsRpcFn = (method: string, params: Record<string, unknown>) => Promise<unknown>;
interface MockedWindow {
  __wmuxChannelsRpc?: { rpc: ChannelsRpcFn; mutateLocal: ChannelsRpcFn };
}
const g = globalThis as unknown as { window?: MockedWindow };

/** Install a stub `__wmuxChannelsRpc` global for the duration of a
 *  test. The `respond` callback returns whatever the test wants the
 *  daemon to have replied with; the test then asserts state + result.
 *  Each test uses its own stub so they don't share call records.
 *
 *  Both `rpc` (reads) and `mutateLocal` (D5 mutating path — create/post)
 *  record to the same `calls` array and run the same `respond`, so a test
 *  driving a *Daemon thunk asserts the method + params regardless of which
 *  transport the slice picked. */
function withChannelsRpc(
  respond: ChannelsRpcFn,
): { calls: Array<{ method: string; params: Record<string, unknown> }> } {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const record: ChannelsRpcFn = async (method, params) => {
    calls.push({ method, params });
    return respond(method, params);
  };
  g.window = {
    __wmuxChannelsRpc: {
      rpc: record,
      mutateLocal: record,
    },
  };
  return { calls };
}

function clearChannelsRpc() {
  if (g.window) delete g.window.__wmuxChannelsRpc;
}

describe('channelsSlice — createChannelDaemon (U4, R4)', () => {
  it('on RPC success: applies the daemon row, returns ok', async () => {
    const { calls } = withChannelsRpc(async () => ({
      ok: true,
      channel: makeChannel({ id: 'ch-daemon-1', name: 'release-notes' }),
    }));
    try {
      const store = createTestStore();
      const synthesized = makeChannel({ id: 'ch-local-fake', name: 'release-notes' });

      const res = await store.getState().createChannelDaemon({
        name: 'release-notes',
        visibility: 'public',
        createdBy: sender,
        channel: synthesized,
      });

      expect(res.ok).toBe(true);
      if (res.ok) expect(res.value.id).toBe('ch-daemon-1');

      // The bridge was called with the a2a.channel.create method.
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe('a2a.channel.create');
      expect(calls[0].params).toMatchObject({
        name: 'release-notes',
        visibility: 'public',
        createdBy: sender,
      });

      // The local mirror holds the DAEMON's row, not the synthesized
      // input. The synthesized id must NOT appear; the daemon id MUST.
      const s = store.getState();
      expect(s.channels['ch-local-fake']).toBeUndefined();
      expect(s.channels['ch-daemon-1']).toBeDefined();
      expect(s.channels['ch-daemon-1'].name).toBe('release-notes');
      // Auto-membership is applied by the *Optimistic primitive.
      expect(s.channelMembers['ch-daemon-1']).toHaveLength(1);
    } finally {
      clearChannelsRpc();
    }
  });

  it('on RPC failure: does NOT apply state, returns the structured error', async () => {
    withChannelsRpc(async () => ({
      ok: false,
      error: { code: 'INVALID_NAME', message: 'bad name' },
    }));
    try {
      const store = createTestStore();
      const synthesized = makeChannel({ id: 'ch-local-fake' });

      const res = await store.getState().createChannelDaemon({
        name: 'bad name',
        visibility: 'public',
        createdBy: sender,
        channel: synthesized,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('INVALID_NAME');
        expect(res.error.message).toBe('bad name');
      }
      // The local mirror is unchanged — neither the synthesized nor
      // the (nonexistent) daemon row lands in state.
      const s = store.getState();
      expect(s.channels['ch-local-fake']).toBeUndefined();
      expect(Object.keys(s.channels)).toEqual([]);
    } finally {
      clearChannelsRpc();
    }
  });

  it('on bridge throw: returns an UNKNOWN error without mutating state', async () => {
    withChannelsRpc(async () => {
      throw new Error('IPC pipe disconnected');
    });
    try {
      const store = createTestStore();
      const res = await store.getState().createChannelDaemon({
        name: 'general',
        visibility: 'public',
        createdBy: sender,
        channel: makeChannel(),
      });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('UNKNOWN');
        expect(res.error.message).toContain('IPC pipe disconnected');
      }
      expect(Object.keys(store.getState().channels)).toEqual([]);
    } finally {
      clearChannelsRpc();
    }
  });
});

describe('channelsSlice — joinChannelDaemon (membership)', () => {
  const member = { workspaceId: 'ws-join', memberId: 'local-ui', memberName: 'alpha' };

  it('on RPC success: calls a2a.channel.join with the pinned workspace and adds the member', async () => {
    const { calls } = withChannelsRpc(async () => ({ ok: true }));
    try {
      const store = createTestStore();
      const res = await store.getState().joinChannelDaemon('ch-1', member, 'ws-join');
      expect(res.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe('a2a.channel.join');
      expect(calls[0].params).toMatchObject({
        channelId: 'ch-1',
        member,
        verifiedWorkspaceId: 'ws-join',
        includeHistory: true,
      });
      expect(store.getState().channelMembers['ch-1']).toEqual([
        expect.objectContaining({ workspaceId: 'ws-join', memberId: 'local-ui' }),
      ]);
    } finally {
      clearChannelsRpc();
    }
  });

  it('on DUPLICATE_MEMBER: returns the error and does not add a member', async () => {
    withChannelsRpc(async () => ({ ok: false, error: { code: 'DUPLICATE_MEMBER', message: 'Already a member' } }));
    try {
      const store = createTestStore();
      const res = await store.getState().joinChannelDaemon('ch-1', member, 'ws-join');
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.message).toContain('DUPLICATE_MEMBER');
      expect(store.getState().channelMembers['ch-1']).toBeUndefined();
    } finally {
      clearChannelsRpc();
    }
  });

  it('bridge missing: returns UNKNOWN without mutating state', async () => {
    clearChannelsRpc();
    const store = createTestStore();
    const res = await store.getState().joinChannelDaemon('ch-1', member, 'ws-join');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('UNKNOWN');
    expect(store.getState().channelMembers['ch-1']).toBeUndefined();
  });
});

describe('channelsSlice — leaveChannelDaemon (membership, self-only)', () => {
  it('on RPC success: calls a2a.channel.leave with self params and removes the member', async () => {
    const { calls } = withChannelsRpc(async () => ({ ok: true }));
    try {
      const store = createTestStore();
      // Seed membership: creator is auto-added as (ws-1, m-1).
      store.getState().createChannelOptimistic({
        name: 'general',
        visibility: 'public',
        createdBy: sender,
        channel: makeChannel({ id: 'ch-1' }),
      });
      expect(store.getState().channelMembers['ch-1']).toHaveLength(1);

      const res = await store.getState().leaveChannelDaemon('ch-1', 'm-1', 'ws-1');
      expect(res.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe('a2a.channel.leave');
      // Self-only: workspaceId === verifiedWorkspaceId, plus memberId.
      expect(calls[0].params).toMatchObject({
        channelId: 'ch-1',
        workspaceId: 'ws-1',
        memberId: 'm-1',
        verifiedWorkspaceId: 'ws-1',
      });
      expect(store.getState().channelMembers['ch-1']).toHaveLength(0);
    } finally {
      clearChannelsRpc();
    }
  });

  it('on NOT_A_MEMBER: returns the error and leaves membership untouched', async () => {
    withChannelsRpc(async () => ({ ok: false, error: { code: 'NOT_A_MEMBER', message: 'not a member' } }));
    try {
      const store = createTestStore();
      store.getState().createChannelOptimistic({
        name: 'general',
        visibility: 'public',
        createdBy: sender,
        channel: makeChannel({ id: 'ch-1' }),
      });
      const res = await store.getState().leaveChannelDaemon('ch-1', 'm-1', 'ws-1');
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('NOT_A_MEMBER');
      // Optimistic removal must NOT run on failure.
      expect(store.getState().channelMembers['ch-1']).toHaveLength(1);
    } finally {
      clearChannelsRpc();
    }
  });

  it('bridge missing: returns UNKNOWN without mutating state', async () => {
    clearChannelsRpc();
    const store = createTestStore();
    store.getState().createChannelOptimistic({
      name: 'general',
      visibility: 'public',
      createdBy: sender,
      channel: makeChannel({ id: 'ch-1' }),
    });
    const res = await store.getState().leaveChannelDaemon('ch-1', 'm-1', 'ws-1');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('UNKNOWN');
    expect(store.getState().channelMembers['ch-1']).toHaveLength(1);
  });
});

describe('channelsSlice — archiveChannelDaemon (lifecycle, creator-only)', () => {
  it('on RPC success: calls a2a.channel.archive and marks the channel archived', async () => {
    const { calls } = withChannelsRpc(async () => ({ ok: true })); // daemon returns EmptyResult
    try {
      const store = createTestStore();
      store.getState().createChannelOptimistic({
        name: 'general',
        visibility: 'public',
        createdBy: sender,
        channel: makeChannel({ id: 'ch-1', status: 'active' }),
      });

      const res = await store.getState().archiveChannelDaemon('ch-1', 'ws-1');
      expect(res.ok).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe('a2a.channel.archive');
      expect(calls[0].params).toMatchObject({
        channelId: 'ch-1',
        verifiedWorkspaceId: 'ws-1',
        archivedBy: 'ws-1',
      });
      // Daemon returns no row → the thunk synthesizes the archived variant.
      const ch = store.getState().channels['ch-1'];
      expect(ch.status).toBe('archived');
      expect(typeof ch.archivedAt).toBe('number');
      expect(ch.archivedBy).toBe('ws-1');
    } finally {
      clearChannelsRpc();
    }
  });

  it('on NOT_AUTHORIZED: returns the error and leaves the channel active', async () => {
    withChannelsRpc(async () => ({
      ok: false,
      error: { code: 'NOT_AUTHORIZED', message: 'Only the channel creator or the company CEO may archive this channel' },
    }));
    try {
      const store = createTestStore();
      store.getState().createChannelOptimistic({
        name: 'general',
        visibility: 'public',
        createdBy: sender,
        channel: makeChannel({ id: 'ch-1', status: 'active' }),
      });
      const res = await store.getState().archiveChannelDaemon('ch-1', 'ws-other');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        // NOT_AUTHORIZED isn't in the renderer's known-code union → bucketed to
        // UNKNOWN, with the daemon code preserved in the message.
        expect(res.error.code).toBe('UNKNOWN');
        expect(res.error.message).toContain('NOT_AUTHORIZED');
      }
      // No optimistic flip on failure.
      expect(store.getState().channels['ch-1'].status).toBe('active');
    } finally {
      clearChannelsRpc();
    }
  });

  it('channel not in the local mirror: returns CHANNEL_NOT_FOUND without calling the bridge', async () => {
    const { calls } = withChannelsRpc(async () => ({ ok: true }));
    try {
      const store = createTestStore();
      const res = await store.getState().archiveChannelDaemon('ch-missing', 'ws-1');
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('CHANNEL_NOT_FOUND');
      expect(calls).toHaveLength(0); // short-circuits before the RPC
    } finally {
      clearChannelsRpc();
    }
  });

  it('bridge missing: returns UNKNOWN without mutating state', async () => {
    clearChannelsRpc();
    const store = createTestStore();
    store.getState().createChannelOptimistic({
      name: 'general',
      visibility: 'public',
      createdBy: sender,
      channel: makeChannel({ id: 'ch-1', status: 'active' }),
    });
    const res = await store.getState().archiveChannelDaemon('ch-1', 'ws-1');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('UNKNOWN');
    expect(store.getState().channels['ch-1'].status).toBe('active');
  });
});

describe('channelsSlice — postMessageDaemon (U4, R4 + R11)', () => {
  it('on RPC success: applies the daemon row, returns ok, propagates clientMsgId', async () => {
    const { calls } = withChannelsRpc(async (_method, params) => ({
      ok: true,
      message: makeMessage(String(params.channelId), 7, {
        text: 'hello',
        clientMsgId: String(params.clientMsgId),
      }),
    }));
    try {
      const store = createTestStore();
      // Seed the channel via *Optimistic so the local mirror has a
      // catalog entry for postMessageDaemon to find.
      store.getState().createChannelOptimistic({
        name: 'general',
        visibility: 'public',
        createdBy: sender,
        channel: makeChannel({ id: 'ch-1' }),
      });
      // Reset to clear the create auto-member side effects from the
      // assertion baseline.
      const synthesized = makeMessage('ch-1', 1, {
        text: 'optimistic-text',
        clientMsgId: 'cmid-1',
      });

      const res = await store.getState().postMessageDaemon('ch-1', {
        text: 'optimistic-text',
        sender,
        clientMsgId: 'cmid-1',
        message: synthesized,
      });

      expect(res.ok).toBe(true);
      if (res.ok) {
        // The slice's *Optimistic applied the DAEMON's row, which
        // uses seq 7 and the daemon's text. The synthesized seq 1
        // is discarded.
        expect(res.value.seq).toBe(7);
        expect(res.value.text).toBe('hello');
        expect(res.value.clientMsgId).toBe('cmid-1');
      }

      // The bridge was called with the a2a.channel.post method and
      // the structured params (R11: clientMsgId propagated for
      // daemon-side idempotency).
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe('a2a.channel.post');
      expect(calls[0].params).toMatchObject({
        channelId: 'ch-1',
        text: 'optimistic-text',
        sender,
        clientMsgId: 'cmid-1',
      });

      // The local mirror holds the DAEMON's row (seq 7), not the
      // synthesized row (seq 1).
      const list = store.getState().channelMessages['ch-1'];
      expect(list).toHaveLength(1);
      expect(list[0].seq).toBe(7);
      expect(list[0].text).toBe('hello');
    } finally {
      clearChannelsRpc();
    }
  });

  it('on RPC failure (PERSIST_FAILED): does NOT apply state, propagates code', async () => {
    withChannelsRpc(async () => ({
      ok: false,
      error: { code: 'PERSIST_FAILED', message: 'disk full' },
    }));
    try {
      const store = createTestStore();
      store.getState().createChannelOptimistic({
        name: 'general',
        visibility: 'public',
        createdBy: sender,
        channel: makeChannel({ id: 'ch-1' }),
      });
      const synthesized = makeMessage('ch-1', 1, { text: 'hello' });

      const res = await store.getState().postMessageDaemon('ch-1', {
        text: 'hello',
        sender,
        message: synthesized,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('PERSIST_FAILED');
        expect(res.error.message).toBe('disk full');
      }
      // The synthesized row is NOT appended — failure leaves the
      // local mirror untouched (caller is responsible for surfacing
      // the error to the user; the composer's onError slot handles it).
      expect(store.getState().channelMessages['ch-1']).toEqual([]);
    } finally {
      clearChannelsRpc();
    }
  });

  it('on RPC failure (NOT_A_MEMBER): propagates the code unchanged', async () => {
    withChannelsRpc(async () => ({
      ok: false,
      error: { code: 'NOT_A_MEMBER', message: 'not a member' },
    }));
    try {
      const store = createTestStore();
      store.getState().createChannelOptimistic({
        name: 'general',
        visibility: 'public',
        createdBy: sender,
        channel: makeChannel({ id: 'ch-1' }),
      });
      const res = await store.getState().postMessageDaemon('ch-1', {
        text: 'hi',
        sender,
        message: makeMessage('ch-1', 1),
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('NOT_A_MEMBER');
    } finally {
      clearChannelsRpc();
    }
  });
});

describe('channelsSlice — mapRpcError (U4 helper)', () => {
  it('returns the structured error envelope for a daemon `{ok: false, error}` response', () => {
    const store = createTestStore();
    const err = store
      .getState()
      .mapRpcError({ ok: false, error: { code: 'PERSIST_FAILED', message: 'disk full' } }, 'fallback');
    expect(err).toEqual({ code: 'PERSIST_FAILED', message: 'disk full' });
  });

  it('buckets unknown daemon codes to UNKNOWN and prefixes the original code in the message', () => {
    const store = createTestStore();
    // NOT_A_MEMBER is currently a daemon code but the renderer's
    // union may not include it in older snapshots; this is the
    // future-proofing path: every unrecognized code falls through
    // to UNKNOWN with the original code name in the message so the
    // developer can see what the daemon actually said.
    const err = store
      .getState()
      .mapRpcError({ ok: false, error: { code: 'SOMETHING_NEW', message: 'x' } }, 'fallback');
    expect(err.code).toBe('UNKNOWN');
    expect(err.message).toBe('SOMETHING_NEW: x');
  });

  it('returns the fallback envelope when the response is not an error shape', () => {
    const store = createTestStore();
    const err = store.getState().mapRpcError(null, 'a2a.channel.create failed');
    expect(err).toEqual({ code: 'UNKNOWN', message: 'a2a.channel.create failed' });
  });
});

describe('channelsSlice — bridge-missing fallback (U4)', () => {
  it('createChannelDaemon returns UNKNOWN without mutating state when __wmuxChannelsRpc is not installed', async () => {
    clearChannelsRpc();
    const store = createTestStore();
    const res = await store.getState().createChannelDaemon({
      name: 'general',
      visibility: 'public',
      createdBy: sender,
      channel: makeChannel(),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('UNKNOWN');
      expect(res.error.message).toContain('bridge not mounted');
    }
    expect(Object.keys(store.getState().channels)).toEqual([]);
  });

  it('postMessageDaemon returns UNKNOWN without mutating state when __wmuxChannelsRpc is not installed', async () => {
    clearChannelsRpc();
    const store = createTestStore();
    store.getState().createChannelOptimistic({
      name: 'general',
      visibility: 'public',
      createdBy: sender,
      channel: makeChannel({ id: 'ch-1' }),
    });
    const res = await store.getState().postMessageDaemon('ch-1', {
      text: 'hi',
      sender,
      message: makeMessage('ch-1', 1),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('UNKNOWN');
    expect(store.getState().channelMessages['ch-1']).toEqual([]);
  });
});

describe('channelsSlice — *Optimistic regression (U4)', () => {
  it('createChannelOptimistic is still callable directly as a state-mirror primitive', () => {
    const store = createTestStore();
    const ch = makeChannel({ id: 'ch-direct' });
    const res = store.getState().createChannelOptimistic({
      name: 'general',
      visibility: 'public',
      createdBy: sender,
      channel: ch,
    });
    expect(res.ok).toBe(true);
    expect(store.getState().channels['ch-direct']).toEqual(ch);
  });

  it('postMessageOptimistic is still callable directly as a state-mirror primitive', () => {
    const store = createTestStore();
    store.getState().createChannelOptimistic({
      name: 'general',
      visibility: 'public',
      createdBy: sender,
      channel: makeChannel({ id: 'ch-1' }),
    });
    const msg = makeMessage('ch-1', 1, { text: 'hello' });
    const res = store.getState().postMessageOptimistic('ch-1', {
      text: 'hello',
      sender,
      message: msg,
    });
    expect(res.ok).toBe(true);
    expect(store.getState().channelMessages['ch-1']).toEqual([msg]);
  });
});