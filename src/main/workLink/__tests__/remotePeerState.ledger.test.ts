// A task sent to another PC, end to end on this PC's side over the real
// pieces: the daemon ledger applies the peer's states, the remote bridge pulls
// them the way main does, and the work link follows.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppendOnlyLog } from '../../../daemon/eventlog/AppendOnlyLog';
import { A2aTaskService } from '../../../daemon/a2a/A2aTaskService';
import { A2A_REMOTE_RPC } from '../../../shared/a2aRemoteDelivery';
import { RemoteA2aBridge } from '../../a2a/RemoteA2aBridge';
import { WorkLinkStore } from '../workLinkStore';
import { recordPeerTaskState, recordSentTask, workLinkFromRemoteSend } from '../a2aProducer';

const LINK = '11111111-1111-4111-8111-111111111111';
const HOST = '22222222-2222-4222-8222-222222222222';
const RT = `rt-${'a'.repeat(32)}`;
const ALIAS = 'mac-mini/wmux/#w1-2';

let dir: string;
let svc: A2aTaskService;
let store: WorkLinkStore;
let bridge: RemoteA2aBridge;
let writes: Promise<void>[];

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-remote-ledger-'));
  const log = new AppendOnlyLog({ dir: path.join(dir, 'log'), fsync: () => undefined });
  log.open();
  svc = new A2aTaskService({ log, origin: { machineId: 'm1', daemonEpoch: 1 } });
  let clock = 1000;
  store = new WorkLinkStore({ dir, pendingDecisionIds: () => new Set(), now: () => ++clock });
  writes = [];
  bridge = new RemoteA2aBridge({
    // What crosses the daemon socket is JSON.
    daemonRpc: async (method, p) => {
      if (method === A2A_REMOTE_RPC.pending) return JSON.parse(JSON.stringify({ tasks: svc.listRemotePending() }));
      if (method === A2A_REMOTE_RPC.mark) {
        const res = await svc.markRemote({
          taskId: p.taskId as string,
          ...(typeof p.messageId === 'string' ? { messageId: p.messageId } : {}),
          ...(p.delivered === true ? { delivered: true } : {}),
          ...(typeof p.attempted === 'boolean' && p.delivered !== true ? { attempted: p.attempted } : {}),
        });
        return res.ok ? { ok: true } : res;
      }
      return { ok: false, error: `unexpected ${method}` };
    },
    sendToRenderer: async () => ({ ok: true, delivered: true }),
    onDaemonEvent: () => () => undefined,
    onPeerUpdate: (task) => { writes.push(recordPeerTaskState(task, store)); },
    backstopMs: 3_600_000,
  });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  await svc.createTask({
    id: RT,
    title: 'Fix the flaky test',
    from: { workspaceId: 'ws-co', name: 'Company', paneId: 'pane-ceo' },
    to: { workspaceId: `remote:${LINK}`, name: ALIAS },
    history: [{ kind: 'message', messageId: 'm-0', role: 'user', parts: [{ kind: 'text', text: 'Fix the flaky test' }] }],
    remote: { v: 1, linkId: LINK, hostId: HOST, messageId: 'm-0', direction: 'outbound' },
  });
  await recordSentTask(workLinkFromRemoteSend({
    taskId: RT, linkId: LINK, alias: ALIAS, requester: { workspaceId: 'ws-co', paneId: 'pane-ceo' },
    title: '', message: 'Fix the flaky test', fromCommander: false,
  }), store);
});
afterEach(async () => {
  bridge.stop();
  await bridge.whenIdle();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function pull(): Promise<void> {
  await bridge.trigger();
  await bridge.whenIdle();
  await Promise.all(writes);
}

describe('a task sent to another PC, over the real ledger and bridge', () => {
  it('its link follows the peer from queued to working to done, with the report', async () => {
    expect(store.getByTaskId(RT)?.state).toBe('queued');

    expect((await svc.applyRemoteState({ taskId: RT, linkId: LINK, messageId: 's-1', to: 'working' })).ok).toBe(true);
    await pull();
    const running = store.getByTaskId(RT);
    expect(running?.state).toBe('running');

    // Nothing new from the peer: a later pull leaves the link as it was.
    await pull();
    expect(store.getByTaskId(RT)?.updatedAt).toBe(running?.updatedAt);

    expect((await svc.applyRemoteState({ taskId: RT, linkId: LINK, messageId: 's-2', to: 'completed', summary: 'Fixed; 3 runs green.' })).ok).toBe(true);
    await pull();
    expect(store.getByTaskId(RT)).toMatchObject({
      state: 'done',
      owner: { workspaceId: `remote:${LINK}`, name: ALIAS },
      requester: { workspaceId: 'ws-co', paneId: 'pane-ceo' },
      result: { summary: 'Fixed; 3 runs green.' },
    });
  });

  it('a peer that asks for input puts the link on the owner, and a cancel takes it off the board', async () => {
    await svc.applyRemoteState({ taskId: RT, linkId: LINK, messageId: 's-1', to: 'working' });
    await svc.applyRemoteState({ taskId: RT, linkId: LINK, messageId: 's-2', to: 'input-required' });
    await pull();
    expect(store.getByTaskId(RT)).toMatchObject({ state: 'needs-you', reason: 'input-required' });
    await svc.applyRemoteState({ taskId: RT, linkId: LINK, messageId: 's-3', to: 'canceled' });
    await pull();
    expect(store.getByTaskId(RT)?.state).toBe('abandoned');
  });
});
