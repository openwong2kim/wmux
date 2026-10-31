// Work sent to another PC, end to end on this PC's side over the real pieces:
// the daemon ledger holds the task and every way it moves, the remote bridge
// pulls the way main does, and after each pull the work link is brought in
// line with the ledger through the daemon's own task query.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppendOnlyLog } from '../../../daemon/eventlog/AppendOnlyLog';
import { A2aTaskService } from '../../../daemon/a2a/A2aTaskService';
import { A2A_REMOTE_RPC } from '../../../shared/a2aRemoteDelivery';
import { applyTaskQueryView } from '../../../shared/a2aTaskQueryView';
import { RemoteA2aBridge } from '../../a2a/RemoteA2aBridge';
import { WorkLinkStore } from '../workLinkStore';
import { reconcileRemoteLinks, recordSentTask, workLinkFromRemoteSend } from '../a2aProducer';

const LINK = '11111111-1111-4111-8111-111111111111';
const HOST = '22222222-2222-4222-8222-222222222222';
const RT = `rt-${'a'.repeat(32)}`;
const ALIAS = 'mac-mini/wmux/#w1-2';

let dir: string;
let svc: A2aTaskService;
let store: WorkLinkStore;
let bridge: RemoteA2aBridge;

/** What crosses the daemon socket is JSON. */
const wire = <T>(v: T): T => JSON.parse(JSON.stringify(v));

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-remote-ledger-'));
  const log = new AppendOnlyLog({ dir: path.join(dir, 'log'), fsync: () => undefined });
  log.open();
  svc = new A2aTaskService({ log, origin: { machineId: 'm1', daemonEpoch: 1 } });
  let clock = 1000;
  store = new WorkLinkStore({ dir, pendingDecisionIds: () => new Set(), now: () => ++clock });
  // The daemon's `a2a.task.query` handler, as daemon/index.ts registers it.
  const query = async (p: Record<string, unknown>) =>
    wire({ ok: true, workspaceId: p.workspaceId, tasks: applyTaskQueryView(svc.queryTasks(p.workspaceId as string), p) });
  bridge = new RemoteA2aBridge({
    daemonRpc: async (method, p) => {
      if (method === A2A_REMOTE_RPC.pending) return wire({ tasks: svc.listRemotePending() });
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
    afterPull: () => reconcileRemoteLinks(query, store),
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
}

describe('work sent to another PC, over the real ledger and bridge', () => {
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

  it('a task the daemon ends itself, with nothing queued for this pane, still ends its link', async () => {
    const ended = await svc.forceFailRemote({ taskId: RT, reason: 'the other PC refused it: too many new tasks', forced: 'remote_refused' });
    expect(ended.ok).toBe(true);
    expect(svc.listRemotePending()).toEqual([]);
    await pull();
    expect(store.getByTaskId(RT)).toMatchObject({ state: 'blocked', reason: 'task-failed', result: { summary: expect.stringContaining('refused') } });
  });

  it('a live link whose task the daemon no longer holds is closed', async () => {
    await recordSentTask(workLinkFromRemoteSend({
      taskId: `rt-${'9'.repeat(32)}`, linkId: LINK, alias: ALIAS, requester: { workspaceId: 'ws-co' },
      title: 'Gone', message: 'x', fromCommander: false,
    }), store);
    await pull();
    expect(store.getByTaskId(`rt-${'9'.repeat(32)}`)?.state).toBe('abandoned');
    expect(store.getByTaskId(RT)?.state).toBe('queued');
  });
});
