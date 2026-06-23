// ─── Tests for hydrateChannelsCatalog (channel catalog hydration core) ───────
//
// The hook `useChannelsHydration` runs a React effect that can't be exercised
// under the repo's node-env vitest (renderToStaticMarkup doesn't run effects),
// so the list→getMembers→setChannels logic is extracted into the pure
// `hydrateChannelsCatalog` (the same extract-for-test pattern as
// `createLateReconcileOnConnect` / `resolvePtyIdsToClear`). These tests drive
// it with a mock `rpc` bridge and a spy `setChannels`.

import { describe, it, expect, vi } from 'vitest';
import { hydrateChannelsCatalog, loadChannelHistory } from '../useChannelsHydration';
import type { Channel, ChannelMember, ChannelMessage } from '../../../shared/channels';

function makeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: 'ch-1',
    companyId: 'co-default',
    name: 'general',
    visibility: 'public',
    status: 'active',
    createdAt: 1,
    createdBy: 'ws-1',
    nextSeq: 1,
    ...overrides,
  };
}

function makeMember(overrides: Partial<ChannelMember> = {}): ChannelMember {
  return { workspaceId: 'ws-1', memberId: 'm-1', joinedAt: 1, historyFromSeq: 0, ...overrides };
}

function makeMsg(seq: number, overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    channelId: 'ch-1',
    seq,
    workspaceId: 'ws-1',
    memberId: 'm-1',
    memberName: 'M',
    text: `msg-${seq}`,
    postedAt: seq,
    deliveryStatus: 'delivered',
    ...overrides,
  };
}

/** Build a mock `rpc` that routes by method, with per-method handlers.
 *  The real renderer `rpc` bridge (electronAPI.rpc.invoke → pipe RpcRouter)
 *  wraps the daemon reply in the transport envelope `{ id, ok, result }` —
 *  confirmed via live CDP. The mock MUST reproduce that wrapping, otherwise the
 *  test validates a shape that never occurs in production (the original bug:
 *  hydration read `.channels` one level too shallow and always got nothing). */
function wrap(daemonReply: unknown) {
  return { id: 'test', ok: true, result: daemonReply };
}
function makeRpc(handlers: {
  list?: (params: Record<string, unknown>) => unknown;
  getMembers?: (params: Record<string, unknown>) => unknown;
  getMessages?: (params: Record<string, unknown>) => unknown;
}) {
  return vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === 'a2a.channel.list') {
      return wrap(handlers.list ? handlers.list(params) : { ok: true, channels: [] });
    }
    if (method === 'a2a.channel.getMembers') {
      return wrap(handlers.getMembers ? handlers.getMembers(params) : { ok: true, members: [] });
    }
    if (method === 'a2a.channel.getMessages') {
      return wrap(handlers.getMessages ? handlers.getMessages(params) : { ok: true, messages: [] });
    }
    throw new Error(`unexpected method ${method}`);
  });
}

describe('hydrateChannelsCatalog', () => {
  it('lists channels, fetches members per channel, and dispatches setChannels', async () => {
    const channels = [
      makeChannel({ id: 'ch-1', name: 'general' }),
      makeChannel({ id: 'ch-2', name: 'design' }),
    ];
    const rpc = makeRpc({
      list: () => ({ ok: true, channels }),
      getMembers: (p) => ({
        ok: true,
        members: [makeMember({ memberId: `m-${String(p.channelId)}` })],
      }),
    });
    const setChannels = vi.fn();

    const n = await hydrateChannelsCatalog({ rpc, workspaceId: 'ws-self', setChannels });

    expect(n).toBe(2);
    expect(setChannels).toHaveBeenCalledTimes(1);
    const [dispatchedChannels, dispatchedMembers] = setChannels.mock.calls[0];
    expect(dispatchedChannels).toEqual(channels);
    expect(Object.keys(dispatchedMembers).sort()).toEqual(['ch-1', 'ch-2']);
    expect(dispatchedMembers['ch-1'][0].memberId).toBe('m-ch-1');
  });

  it('also accepts an already-unwrapped daemon reply (defensive — no transport envelope)', async () => {
    // If the bridge ever returns the daemon reply directly (no { id, ok, result }
    // wrapper), unwrapRpc must fall back to the value itself.
    const rpc = vi.fn(async (method: string) => {
      if (method === 'a2a.channel.list') return { ok: true, channels: [makeChannel({ id: 'ch-1' })] };
      return { ok: true, members: [makeMember()] };
    });
    const setChannels = vi.fn();
    const n = await hydrateChannelsCatalog({ rpc, workspaceId: 'ws-self', setChannels });
    expect(n).toBe(1);
    expect(setChannels).toHaveBeenCalledTimes(1);
    const [chs, mem] = setChannels.mock.calls[0];
    expect(chs).toHaveLength(1);
    expect(mem['ch-1']).toHaveLength(1);
  });

  it('passes the self workspace as BOTH workspaceId and verifiedWorkspaceId on every read', async () => {
    const rpc = makeRpc({
      list: () => ({ ok: true, channels: [makeChannel({ id: 'ch-1' })] }),
      getMembers: () => ({ ok: true, members: [] }),
    });
    await hydrateChannelsCatalog({ rpc, workspaceId: 'ws-self', setChannels: vi.fn() });

    expect(rpc).toHaveBeenCalledWith('a2a.channel.list', {
      workspaceId: 'ws-self',
      verifiedWorkspaceId: 'ws-self',
    });
    expect(rpc).toHaveBeenCalledWith('a2a.channel.getMembers', {
      channelId: 'ch-1',
      workspaceId: 'ws-self',
      verifiedWorkspaceId: 'ws-self',
    });
  });

  it('no-ops (no rpc, no dispatch) when workspaceId is empty', async () => {
    const rpc = makeRpc({});
    const setChannels = vi.fn();
    const n = await hydrateChannelsCatalog({ rpc, workspaceId: '', setChannels });
    expect(n).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
    expect(setChannels).not.toHaveBeenCalled();
  });

  it('does not dispatch when the list RPC returns ok:false', async () => {
    const rpc = makeRpc({ list: () => ({ ok: false, error: { code: 'NOT_AUTHORIZED', message: 'x' } }) });
    const setChannels = vi.fn();
    const n = await hydrateChannelsCatalog({ rpc, workspaceId: 'ws-self', setChannels });
    expect(n).toBe(0);
    expect(setChannels).not.toHaveBeenCalled();
    // getMembers must not be probed once the list failed.
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch when the list RPC throws', async () => {
    const rpc = vi.fn(async (method: string) => {
      if (method === 'a2a.channel.list') throw new Error('DaemonClient not connected');
      return { ok: true, members: [] };
    });
    const setChannels = vi.fn();
    const n = await hydrateChannelsCatalog({ rpc, workspaceId: 'ws-self', setChannels });
    expect(n).toBe(0);
    expect(setChannels).not.toHaveBeenCalled();
  });

  it('treats a malformed list payload (channels not an array) as empty and does not dispatch', async () => {
    const rpc = makeRpc({ list: () => ({ ok: true, channels: 'nope' }) });
    const setChannels = vi.fn();
    const n = await hydrateChannelsCatalog({ rpc, workspaceId: 'ws-self', setChannels });
    expect(n).toBe(0);
    expect(setChannels).not.toHaveBeenCalled();
  });

  it('still dispatches when one channel getMembers fails — that channel hydrates with no member entry', async () => {
    const channels = [makeChannel({ id: 'ch-ok' }), makeChannel({ id: 'ch-bad' })];
    const rpc = makeRpc({
      list: () => ({ ok: true, channels }),
      getMembers: (p) => {
        if (p.channelId === 'ch-bad') throw new Error('boom');
        return { ok: true, members: [makeMember()] };
      },
    });
    const setChannels = vi.fn();
    const n = await hydrateChannelsCatalog({ rpc, workspaceId: 'ws-self', setChannels });
    expect(n).toBe(2);
    expect(setChannels).toHaveBeenCalledTimes(1);
    const [, dispatchedMembers] = setChannels.mock.calls[0];
    expect(dispatchedMembers['ch-ok']).toHaveLength(1);
    expect(dispatchedMembers['ch-bad']).toBeUndefined();
  });

  it('skips dispatch when the liveness guard reports disposed after the list resolves', async () => {
    const rpc = makeRpc({ list: () => ({ ok: true, channels: [makeChannel()] }) });
    const setChannels = vi.fn();
    const n = await hydrateChannelsCatalog({
      rpc,
      workspaceId: 'ws-self',
      setChannels,
      isCurrent: () => false,
    });
    expect(n).toBe(0);
    expect(setChannels).not.toHaveBeenCalled();
  });
});

describe('loadChannelHistory (P0 recent-history load)', () => {
  it('floors sinceSeq at nextSeq - limit and applies the returned messages', async () => {
    let captured: Record<string, unknown> | undefined;
    const rpc = makeRpc({
      getMessages: (p) => {
        captured = p;
        return { ok: true, messages: [makeMsg(298), makeMsg(299)] };
      },
    });
    const apply = vi.fn();
    const n = await loadChannelHistory({ rpc, channelId: 'ch-1', nextSeq: 300, workspaceId: 'ws-self', apply, limit: 200 });
    expect(n).toBe(2);
    expect(captured).toMatchObject({
      channelId: 'ch-1',
      sinceSeq: 100,
      workspaceId: 'ws-self',
      verifiedWorkspaceId: 'ws-self',
    });
    expect(apply).toHaveBeenCalledWith('ch-1', expect.arrayContaining([expect.objectContaining({ seq: 299 })]));
  });

  it('floors sinceSeq at 0 for a short channel (nextSeq < limit)', async () => {
    let captured: Record<string, unknown> | undefined;
    const rpc = makeRpc({
      getMessages: (p) => {
        captured = p;
        return { ok: true, messages: [] };
      },
    });
    await loadChannelHistory({ rpc, channelId: 'ch-1', nextSeq: 5, workspaceId: 'ws-self', apply: vi.fn(), limit: 200 });
    expect(captured?.sinceSeq).toBe(0);
  });

  it('no-ops (no rpc, no apply) when workspaceId is empty', async () => {
    const rpc = makeRpc({});
    const apply = vi.fn();
    const n = await loadChannelHistory({ rpc, channelId: 'ch-1', nextSeq: 10, workspaceId: '', apply });
    expect(n).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('bails (no apply) when the RPC throws', async () => {
    const rpc = vi.fn(async () => {
      throw new Error('pipe down');
    });
    const apply = vi.fn();
    const n = await loadChannelHistory({ rpc, channelId: 'ch-1', nextSeq: 10, workspaceId: 'ws-self', apply });
    expect(n).toBe(0);
    expect(apply).not.toHaveBeenCalled();
  });

  it('respects the disposed guard (no apply after dispose)', async () => {
    const rpc = makeRpc({ getMessages: () => ({ ok: true, messages: [makeMsg(1)] }) });
    const apply = vi.fn();
    const n = await loadChannelHistory({ rpc, channelId: 'ch-1', nextSeq: 10, workspaceId: 'ws-self', apply, isCurrent: () => false });
    expect(n).toBe(0);
    expect(apply).not.toHaveBeenCalled();
  });

  it('does not apply on an ok:false envelope', async () => {
    const rpc = makeRpc({ getMessages: () => ({ ok: false, error: { code: 'CHANNEL_NOT_FOUND', message: 'x' } }) });
    const apply = vi.fn();
    const n = await loadChannelHistory({ rpc, channelId: 'ch-1', nextSeq: 10, workspaceId: 'ws-self', apply });
    expect(n).toBe(0);
    expect(apply).not.toHaveBeenCalled();
  });
});
