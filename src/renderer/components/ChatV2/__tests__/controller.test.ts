import { describe, expect, it } from 'vitest';
import { ChatV2Controller, knownBinding } from '../controller';
import { createMockHost } from './mockHost';

const PANE = 'daemon-race';
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function seeded() {
  let clock = 5_000;
  const host = createMockHost({ now: () => (clock += 7) });
  await host.call('subscribe', { paneId: PANE });
  await host.call('create', { paneId: PANE, agent: 'claude', mode: 'default' });
  await host.call('unsubscribe', { paneId: PANE });
  host.emit(PANE, [{ type: 'user.message', text: 'start', clientMessageId: 'c-00000001' }]);
  return host;
}

describe('ChatV2Controller snapshot/push race', () => {
  it('buffers pushes that land between subscribe and snapshot, and ends identical to the daemon', async () => {
    const host = await seeded();
    const release = host.holdSnapshot();
    const controller = new ChatV2Controller(host, PANE);
    const started = controller.start();
    await flush(); // subscribed; snapshot is held
    expect(host.calls.map((call) => call.method)).toEqual(['subscribe', 'create', 'unsubscribe', 'subscribe', 'snapshot']);
    // Pushed after the daemon took the snapshot but before its reply arrives: buffered.
    const early = host.emit(PANE, [{ type: 'message.delta', text: 'Hel' }]);
    host.deliver(early); // a duplicate delivery of the same seq must not fold twice
    expect(controller.current.phase).toBe('loading');
    release();
    await started;
    host.emit(PANE, [{ type: 'message.delta', text: 'lo' }, { type: 'turn.ended', outcome: 'completed' }]);
    await flush();
    const state = controller.current;
    expect(state.phase).toBe('ready');
    expect(state.view?.session.blocks).toEqual(host.record(PANE)!.session.blocks);
    expect(state.view?.lastSeq).toBe(host.record(PANE)!.binding.seq);
    expect(knownBinding(PANE)).toMatchObject({ chatSessionId: host.record(PANE)!.binding.chatSessionId });
    // The buffered push continued the snapshot: no second snapshot was needed.
    expect(host.calls.filter((call) => call.method === 'snapshot')).toHaveLength(1);
    controller.dispose();
  });

  it('re-snapshots after a seq gap and after a resync, and stays in step', async () => {
    const host = await seeded();
    const controller = new ChatV2Controller(host, PANE);
    await controller.start();
    const snapshots = () => host.calls.filter((call) => call.method === 'snapshot').length;
    const before = snapshots();
    // A push the controller never sees (dropped socket), then a later one: gap.
    const record = host.record(PANE)!;
    record.subscribed = false;
    host.emit(PANE, [{ type: 'message.delta', text: 'lost' }]);
    record.subscribed = true;
    host.emit(PANE, [{ type: 'message.delta', text: ' found' }]);
    await flush();
    expect(snapshots()).toBe(before + 1);
    expect(controller.current.view?.session.blocks).toEqual(host.record(PANE)!.session.blocks);

    host.reload(PANE); // daemon restart: new epoch
    host.resync([PANE]);
    await flush();
    expect(snapshots()).toBe(before + 2);
    expect(controller.current.view?.epoch).toBe(host.record(PANE)!.binding.epoch);
    controller.dispose();
    expect(host.calls.at(-1)?.method).toBe('unsubscribe');
  });

  it('shows the empty composer without a record, then loads the chat a create made', async () => {
    const host = createMockHost();
    const controller = new ChatV2Controller(host, 'daemon-empty');
    await controller.start();
    expect(controller.current.phase).toBe('empty');
    expect(knownBinding('daemon-empty')).toBeNull();
    expect(await controller.create({ agent: 'claude', mode: 'bypass', model: 'claude-opus-5-5' })).toBe(true);
    await flush();
    expect(controller.current.phase).toBe('ready');
    expect(controller.current.view?.binding).toMatchObject({ mode: 'bypass', model: 'claude-opus-5-5' });
    expect(await controller.send('hello')).toBe(true);
    expect(controller.current.view?.session.blocks.at(-1)).toMatchObject({ role: 'user', text: 'hello' });
    controller.dispose();
  });

  it('reports a refused create without leaving the empty state', async () => {
    const host = createMockHost();
    host.busyPanes.add('daemon-busy');
    const controller = new ChatV2Controller(host, 'daemon-busy');
    await controller.start();
    expect(await controller.create({ agent: 'claude', mode: 'default', model: '' })).toBe(false);
    expect(controller.current).toMatchObject({ phase: 'empty', error: { code: 'agent-running-in-pane' } });
    controller.dispose();
  });
});
