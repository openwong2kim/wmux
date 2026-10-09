import { describe, it, expect } from 'vitest';
import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { createPcRailSlice, migrateAttachedToPcRail, type PcRailSlice } from '../pcRailSlice';
import { selectPcAttention, selectPcRailHosts, selectPcRailRows, selectPcRailPersisted } from '../../selectors/pcRail';
import { DEFAULT_PC_RAIL_PERSISTED, LOCAL_PC_ID } from '../../../../shared/pcRail';
import type { PcRailFeedEvent } from '../../../../main/remote/pcRailWire';
import type { StoreState } from '../../index';

type TestState = PcRailSlice & { remoteWorkspaces: StoreState['remoteWorkspaces']; activeRemoteKey: string | null };

function createTestStore(extra: Partial<TestState> = {}) {
  return create<TestState>()(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    immer((...args: any) => ({
      // @ts-expect-error — minimal test store doesn't match full StoreState
      ...createPcRailSlice(...args),
      remoteWorkspaces: [],
      activeRemoteKey: null,
      ...extra,
    })),
  );
}

const asStore = (s: TestState) => s as unknown as StoreState;

const hosts: PcRailFeedEvent = { type: 'hosts', hosts: [{ id: 'h1', label: 'office-mac' }, { id: 'h2', label: 'mini' }] };

function feed(hostId: string, panes: Array<{ sessionId: string; agentStatus?: 'complete' | 'awaiting_input' | 'running' }>, extra: object = {}): PcRailFeedEvent {
  return {
    type: 'feed', hostId, at: 1000, ok: true,
    response: { workspaces: [{ id: 'w1', name: 'one', panes: panes.map((p) => ({ ...p, agentName: 'claude' })) }] },
    ...extra,
  };
}

describe('pcRailSlice', () => {
  it('restores the persisted part and refuses shadow ids', () => {
    const store = createTestStore();
    store.getState().loadPcRailPersisted({
      activePcId: 'shadow:h1:w1',
      lastWorkspaceByPc: { local: 'ws-1', h1: 'shadow:h1:w1', h2: 'w9' },
      mutedPcs: ['h2'],
    });
    expect(selectPcRailPersisted(asStore(store.getState()))).toEqual({
      activePcId: LOCAL_PC_ID, lastWorkspaceByPc: { local: 'ws-1', h2: 'w9' }, mutedPcs: ['h2'],
    });
    store.getState().rememberPcWorkspace('h1', 'shadow:h1:w2');
    expect(store.getState().pcRail.lastWorkspaceByPc.h1).toBeUndefined();
  });

  it('prunes state for a host that is no longer paired', () => {
    const store = createTestStore();
    store.getState().loadPcRailPersisted({ activePcId: 'h3', lastWorkspaceByPc: { h3: 'w' }, mutedPcs: ['h3', 'h1'] });
    store.getState().applyPcRailFeedEvent(hosts);
    expect(store.getState().pcRail).toEqual({ ...DEFAULT_PC_RAIL_PERSISTED, mutedPcs: ['h1'] });
    store.getState().setActivePc('h3');
    expect(store.getState().pcRail.activePcId).toBe(LOCAL_PC_ID);
    store.getState().setActivePc('h2');
    expect(store.getState().pcRail.activePcId).toBe('h2');
  });

  it('counts needs-you from panes and approvals, and finished only after the first list', () => {
    const store = createTestStore();
    const s = () => asStore(store.getState());
    store.getState().applyPcRailFeedEvent(hosts);
    store.getState().applyPcRailFeedEvent(feed('h1', [{ sessionId: 'done-before', agentStatus: 'complete' }, { sessionId: 's2', agentStatus: 'running' }]), 1000);
    expect(selectPcAttention(s(), 'h1')).toEqual({ needsYou: 0, finished: 0 });

    // s2 completes later; an approval raised by SSE counts at once.
    store.getState().applyPcRailFeedEvent(feed('h1', [{ sessionId: 'done-before', agentStatus: 'complete' }, { sessionId: 's2', agentStatus: 'complete' }]), 2000);
    const refetch = store.getState().applyPcRailAttention({ hostId: 'h1', kind: 'approval', data: { sessionId: 'x', approvalId: 'a1', phase: 'create', tier: 'act' } }, 2100);
    expect(refetch).toBe(true);
    expect(selectPcAttention(s(), 'h1')).toEqual({ needsYou: 1, finished: 1 });

    // The list reconcile is the truth: a1 is no longer pending.
    store.getState().reconcilePcRailHostApprovals('h1', [], 2200);
    expect(selectPcAttention(s(), 'h1')).toEqual({ needsYou: 0, finished: 1 });

    // Viewing the workspace clears finished.
    store.getState().markPcWorkspaceSeen('h1', 'w1', 3000);
    expect(selectPcAttention(s(), 'h1')).toEqual({ needsYou: 0, finished: 0 });
  });

  it('keeps the last rows on a failed tick and goes stale after three', () => {
    const store = createTestStore();
    store.getState().applyPcRailFeedEvent(hosts);
    store.getState().applyPcRailFeedEvent(feed('h1', [{ sessionId: 's1' }]));
    for (let i = 0; i < 3; i++) store.getState().applyPcRailFeedEvent({ type: 'feed', hostId: 'h1', at: 2000, ok: false, reason: 'unreachable' });
    const feedState = store.getState().pcRailFeeds.h1;
    expect(feedState.workspaces).toHaveLength(1);
    expect(feedState.failedTicks).toBe(3);
    const [h1] = selectPcRailHosts(asStore(store.getState()));
    expect(h1).toMatchObject({ id: 'h1', status: 'unreachable', lastSeenAt: 1000 });
  });

  it('an unchanged tick keeps the same rows and host list', () => {
    const store = createTestStore();
    store.getState().applyPcRailFeedEvent(hosts);
    store.getState().applyPcRailFeedEvent(feed('h1', [{ sessionId: 's1' }]));
    const rows = selectPcRailRows(asStore(store.getState()), 'h1');
    const list = selectPcRailHosts(asStore(store.getState()));
    store.getState().applyPcRailFeedEvent({ ...feed('h1', [{ sessionId: 's1' }]), at: 1000 } as PcRailFeedEvent);
    expect(selectPcRailRows(asStore(store.getState()), 'h1')).toBe(rows);
    expect(selectPcRailHosts(asStore(store.getState()))).toBe(list);
    // A later tick with the same rows moves only lastSeenAt.
    store.getState().applyPcRailFeedEvent({ ...feed('h1', [{ sessionId: 's1' }]), at: 5000 } as PcRailFeedEvent);
    expect(selectPcRailRows(asStore(store.getState()), 'h1')).toBe(rows);
    expect(selectPcRailHosts(asStore(store.getState()))[0].lastSeenAt).toBe(5000);
  });

  it('maps attached remote workspaces onto lastWorkspaceByPc without touching them', () => {
    const attached = [
      { key: 'h1:wa', hostId: 'h1', workspaceId: 'wa' },
      { key: 'h1:wb', hostId: 'h1', workspaceId: 'wb' },
      { key: 'h2:wc', hostId: 'h2', workspaceId: 'wc', ephemeral: true },
      { key: 'h3:wd', hostId: 'h3', workspaceId: 'wd' },
    ];
    const out = migrateAttachedToPcRail({ ...DEFAULT_PC_RAIL_PERSISTED, lastWorkspaceByPc: { h3: 'kept' }, mutedPcs: [] }, attached, 'h1:wb');
    expect(out.lastWorkspaceByPc).toEqual({ h1: 'wb', h3: 'kept' });
  });
});
