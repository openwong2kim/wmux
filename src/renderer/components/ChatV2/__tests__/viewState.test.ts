import { describe, expect, it } from 'vitest';
import type { ChatV2Binding } from '../../../../shared/chatv2/ipc';
import { applyPushToView, prependHistory, RESNAPSHOT, selectChatSurfaceView, stateFromSnapshot, type ChatV2ViewState } from '../viewState';
import { createMockHost } from './mockHost';

const PANE = 'daemon-p1';

async function hostWithChat(windowBlocks?: number) {
  let clock = 1_000;
  const host = createMockHost({ now: () => (clock += 10), windowBlocks });
  await host.call('subscribe', { paneId: PANE });
  const created = await host.call('create', { paneId: PANE, agent: 'claude', mode: 'default' });
  if (!created.ok) throw new Error('create failed');
  return host;
}

async function snapshotOf(host: Awaited<ReturnType<typeof hostWithChat>>): Promise<ChatV2ViewState> {
  const binding = host.record(PANE)!.binding;
  const result = await host.call('snapshot', { paneId: PANE, chatSessionId: binding.chatSessionId });
  if (!result.ok) throw new Error('snapshot failed');
  return stateFromSnapshot(result.snapshot);
}

describe('applyPushToView', () => {
  it('folds a push that continues the copy, to the same blocks as the daemon', async () => {
    const host = await hostWithChat();
    const state = await snapshotOf(host);
    const push = host.emit(PANE, [
      { type: 'user.message', text: 'hi', clientMessageId: 'c-00000001' },
      { type: 'message.delta', text: 'Hel' },
      { type: 'message.delta', text: 'lo' },
    ]);
    const next = applyPushToView(state, push);
    if (next === RESNAPSHOT) throw new Error('unexpected resnapshot');
    expect(next.session.blocks).toEqual(host.record(PANE)!.session.blocks);
    expect(next.lastSeq).toBe(push.events[2].seq);
    expect(next.binding.status).toBe('running');
  });

  it('drops events it already folded and keeps the same state', async () => {
    const host = await hostWithChat();
    const push = host.emit(PANE, [{ type: 'status', text: 'x' }]);
    const state = await snapshotOf(host); // already reflects the push
    expect(applyPushToView(state, push)).toBe(state);
  });

  it('applies only the unseen tail of an overlapping push', async () => {
    const host = await hostWithChat();
    const first = host.emit(PANE, [{ type: 'user.message', text: 'a', clientMessageId: 'c-00000001' }]);
    const state = await snapshotOf(host);
    const second = host.emit(PANE, [{ type: 'message.delta', text: 'b' }]);
    const overlap = { ...second, events: [...first.events, ...second.events] };
    const next = applyPushToView(state, overlap);
    if (next === RESNAPSHOT) throw new Error('unexpected resnapshot');
    expect(next.session.blocks).toEqual(host.record(PANE)!.session.blocks);
  });

  it('re-snapshots on a seq gap, an epoch change, a change below the window, or a fold mismatch', async () => {
    const host = await hostWithChat();
    const state = await snapshotOf(host);
    host.emit(PANE, [{ type: 'status', text: 'missed' }]);
    const after = host.emit(PANE, [{ type: 'status', text: 'seen' }]);
    expect(applyPushToView(state, after)).toBe(RESNAPSHOT);
    const live = host.emit(PANE, [{ type: 'status', text: 'y' }]);
    const fresh = await snapshotOf(host);
    const next = host.emit(PANE, [{ type: 'status', text: 'z' }]);
    expect(applyPushToView(fresh, { ...next, epoch: 'ffffffffffffffff' })).toBe(RESNAPSHOT);
    expect(applyPushToView({ ...fresh, baseIndex: 5 }, { ...next, touchedFrom: 2, blockCount: next.blockCount + 5 })).toBe(RESNAPSHOT);
    expect(applyPushToView(fresh, { ...next, blockCount: next.blockCount + 1 })).toBe(RESNAPSHOT);
    expect(applyPushToView(fresh, { ...next, lastBlockId: '1.1' })).toBe(RESNAPSHOT);
    expect(live.events.length).toBe(1);
  });

  it('takes the whole binding a push carries', async () => {
    const host = await hostWithChat();
    const state = await snapshotOf(host);
    const push = host.emit(PANE, [{ type: 'session.providerBound', providerSessionId: '00000000-0000-4000-8000-000000000001' }]);
    const next = applyPushToView(state, push);
    if (next === RESNAPSHOT) throw new Error('unexpected resnapshot');
    expect(next.binding.providerSessionId).toBe('00000000-0000-4000-8000-000000000001');
  });
});

describe('prependHistory', () => {
  it('prepends a page that ends where the window starts, and refuses one that does not', async () => {
    const host = await hostWithChat(2);
    host.emit(PANE, [
      { type: 'user.message', text: 'one', clientMessageId: 'c-00000001' },
      { type: 'message.delta', text: 'a' },
      { type: 'turn.ended', outcome: 'completed' },
      { type: 'user.message', text: 'two', clientMessageId: 'c-00000002' },
      { type: 'message.delta', text: 'b' },
    ]);
    const state = await snapshotOf(host);
    expect(state.baseIndex).toBeGreaterThan(0);
    const page = await host.call('history', { paneId: PANE, chatSessionId: state.binding.chatSessionId, epoch: state.epoch, beforeBlockId: state.session.blocks[0].id });
    if (!page.ok) throw new Error('history failed');
    const merged = prependHistory(state, page.page);
    expect(merged?.baseIndex).toBe(page.page.baseIndex);
    expect(merged?.session.blocks.length).toBe(state.session.blocks.length + page.page.blocks.length);
    expect(prependHistory(state, { ...page.page, baseIndex: page.page.baseIndex - 1 })).toBeNull();
  });
});

describe('selectChatSurfaceView', () => {
  const binding = { paneId: PANE } as ChatV2Binding;
  it('keeps Terminal outside Chat view', () => {
    expect(selectChatSurfaceView({ chatViewEnabled: false, viewMode: 'chat', binding, agentRunning: false })).toBe('terminal');
    expect(selectChatSurfaceView({ chatViewEnabled: true, viewMode: 'terminal', binding, agentRunning: false })).toBe('terminal');
  });
  it('shows chat v2 for a bound pane, even with an agent tracked', () => {
    expect(selectChatSurfaceView({ chatViewEnabled: true, viewMode: 'chat', binding, agentRunning: true })).toBe('chatv2');
  });
  it('shows the projection while a TUI agent runs, or when no chat-v2 host answered', () => {
    expect(selectChatSurfaceView({ chatViewEnabled: true, viewMode: 'chat', binding: null, agentRunning: true })).toBe('projection');
    expect(selectChatSurfaceView({ chatViewEnabled: true, viewMode: 'chat', binding: false, agentRunning: false })).toBe('projection');
    expect(selectChatSurfaceView({ chatViewEnabled: true, viewMode: 'chat', binding: undefined, agentRunning: false })).toBe('projection');
  });
  it('offers the empty chat-v2 composer on a free pane with no record', () => {
    expect(selectChatSurfaceView({ chatViewEnabled: true, viewMode: 'chat', binding: null, agentRunning: false })).toBe('chatv2');
  });
});
