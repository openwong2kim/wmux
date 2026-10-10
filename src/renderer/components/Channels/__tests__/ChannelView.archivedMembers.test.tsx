// @vitest-environment jsdom
//
// Catalog hydration no longer fetches archived rosters (one getMembers per
// archived room on every catalog event tripped the daemon's RPC rate limit),
// so opening an archived channel loads its own roster. A live channel's roster
// still comes from hydration and is never re-fetched here.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChannelView } from '../ChannelView';
import { useStore } from '../../../stores';
import type { Channel } from '../../../../shared/channels';

const act = React.act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function channel(id: string, extra: Partial<Channel> = {}): Channel {
  return {
    id, companyId: 'co', name: id, visibility: 'public', status: 'active', createdAt: 1, createdBy: 'ws-1', nextSeq: 1, ...extra,
  };
}

let container: HTMLDivElement;
let root: Root;
const rpc = vi.fn();

beforeEach(() => {
  rpc.mockReset().mockImplementation(async (method: string) => {
    if (method === 'a2a.channel.getMembers') {
      return { ok: true, members: [{ workspaceId: 'ws-human', memberId: 'human', joinedAt: 0, historyFromSeq: 0 }] };
    }
    if (method === 'a2a.channel.getMessages') return { ok: true, messages: [] };
    return { ok: false };
  });
  (window as unknown as { __wmuxChannelsRpc: unknown }).__wmuxChannelsRpc = { rpc, mutateLocal: vi.fn(async () => ({ ok: true })) };
  act(() => {
    useStore.setState({
      ...useStore.getInitialState(),
      locale: 'en',
      channels: {
        'ch-arch': channel('ch-arch', { status: 'archived', archivedAt: 2 }),
        'ch-live': channel('ch-live'),
      },
      channelMembers: { 'ch-live': [] },
    });
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  try { act(() => { root.unmount(); }); } catch { /* already unmounted */ }
  container.remove();
});

async function openChannel(id: string): Promise<void> {
  act(() => { useStore.getState().setActiveChannel(id); });
  act(() => { root.render(React.createElement(ChannelView)); });
  for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
}

describe('ChannelView — archived roster loads on open', () => {
  it('fetches the roster of an opened archived channel once', async () => {
    await openChannel('ch-arch');
    const calls = rpc.mock.calls.filter(([m]) => m === 'a2a.channel.getMembers');
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({ channelId: 'ch-arch', workspaceId: 'ws-human' });
    expect(useStore.getState().channelMembers['ch-arch']?.map((m) => m.memberId)).toEqual(['human']);
  });

  it('a failed fetch recovers on the next catalog refresh while the channel is open', async () => {
    const base = rpc.getMockImplementation()!;
    let failed = false;
    rpc.mockImplementation(async (method: string, params: Record<string, unknown>) => {
      if (method === 'a2a.channel.getMembers' && !failed) {
        failed = true;
        throw new Error('rate limited (global)');
      }
      return base(method, params);
    });
    await openChannel('ch-arch');
    expect(useStore.getState().channelMembers['ch-arch']).toBeUndefined();
    // A catalog refresh (hydration skips archived rosters) replaces the row.
    act(() => {
      useStore.getState().setChannels(
        [channel('ch-arch', { status: 'archived', archivedAt: 2 }), channel('ch-live')],
        { 'ch-live': [] },
      );
    });
    for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
    expect(rpc.mock.calls.filter(([m]) => m === 'a2a.channel.getMembers')).toHaveLength(2);
    expect(useStore.getState().channelMembers['ch-arch']?.map((m) => m.memberId)).toEqual(['human']);
  });

  it('does not fetch a live channel roster (hydration owns it)', async () => {
    await openChannel('ch-live');
    expect(rpc.mock.calls.some(([m]) => m === 'a2a.channel.getMembers')).toBe(false);
  });
});
