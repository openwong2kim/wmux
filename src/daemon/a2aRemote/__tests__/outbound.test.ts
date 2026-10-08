import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { A2aTaskService } from '../../a2a/A2aTaskService';
import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { remoteTaskId } from '../ids';
import { LinkStore } from '../linkStore';
import { OutboxStore } from '../outboxStore';
import { aliasTable, linkAlias, listRemoteTargets, sendRemoteReply, sendRemoteState, sendRemoteTask, stateMessageId, syncRemoteTask, type OutboundDeps } from '../outbound';

const HOST = '11111111-1111-4111-8111-111111111111';

let dir: string;
let links: LinkStore;
let tasks: A2aTaskService;
let outbox: OutboxStore;
let deps: OutboundDeps;
let n = 0;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-outbound-'));
  links = new LinkStore({ dir, scheduleHarden: () => undefined });
  outbox = new OutboxStore({ dir, scheduleHarden: () => undefined });
  const log = new AppendOnlyLog({ dir: path.join(dir, 'log'), fsync: () => undefined });
  log.open();
  tasks = new A2aTaskService({ log, origin: { machineId: 'm', daemonEpoch: 1 } });
  n = 0;
  deps = { linkStore: links, taskService: tasks, outbox, aliasFor: (l) => linkAlias(l, 'pc-b'), mintId: () => `msg-${++n}` };
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function activeLink(allow = { outbound: true, inbound: true }, label = 'codex', remotePane = 'pane-b'): string {
  const linkId = crypto.randomUUID();
  links.receiveProposal({
    linkId,
    local: { kind: 'pane', workspaceId: 'ws-a', paneId: 'pane-a' },
    remote: { hostId: HOST, kind: 'pane', workspaceId: 'ws-b', paneId: remotePane, label },
    allow,
  });
  links.accept(linkId);
  return linkId;
}

const FROM = { workspaceId: 'ws-a', name: 'Frontend', paneId: 'pane-a' };

describe('listRemoteTargets', () => {
  it('lists active links only, with their alias and direction flag', () => {
    const linkId = activeLink({ outbound: false, inbound: true });
    links.proposeOut({ local: { kind: 'pane', workspaceId: 'ws-a', paneId: 'p2' }, remote: { hostId: HOST, kind: 'pane', workspaceId: 'w', paneId: 'p' }, allow: { outbound: true, inbound: true } });
    expect(listRemoteTargets(deps)).toEqual([
      {
        alias: 'pc-b/ws-b/codex',
        linkId,
        hostId: HOST,
        kind: 'pane',
        local: { workspaceId: 'ws-a', paneId: 'pane-a' },
        remote: { workspaceId: 'ws-b', paneId: 'pane-b', label: 'codex' },
        allowOutbound: false,
      },
    ]);
  });

  it('a "/" inside a part cannot fake an extra alias segment', () => {
    activeLink(undefined, 'a/b');
    expect(listRemoteTargets(deps)[0].alias).toBe('pc-b/ws-b/a-b');
  });
});

describe('aliases', () => {
  it('uses the remote workspace name, falls back to ids, and reads <PC>/Moa for a brain end', () => {
    const base = links.get(activeLink())!;
    expect(linkAlias({ ...base, remote: { ...base.remote, workspaceName: 'API' } }, 'DESK')).toBe('DESK/API/codex');
    expect(linkAlias({ ...base, remote: { ...base.remote, label: undefined } }, 'DESK')).toBe('DESK/ws-b/pane-b');
    expect(linkAlias({ ...base, remote: { hostId: HOST, kind: 'brain', workspaceId: 'hq' } }, 'DESK')).toBe('DESK/Moa');
    expect(linkAlias({ ...base, remote: { ...base.remote, workspaceName: 'a/b' } }, 'DE/SK')).toBe('DE-SK/a-b/codex');
  });

  it('numbers a repeated alias by link age, so an exact alias names one link', () => {
    const older = { ...links.get(activeLink(undefined, 'codex', 'pane-b'))!, createdAt: '2026-01-01T00:00:00.000Z' };
    const newer = { ...links.get(activeLink(undefined, 'codex', 'pane-c'))!, createdAt: '2026-01-02T00:00:00.000Z' };
    const table = aliasTable([newer, older], () => 'pc-b');
    expect(table.get(older.linkId)).toBe('pc-b/ws-b/codex');
    expect(table.get(newer.linkId)).toBe('pc-b/ws-b/codex#2');
  });
});

describe('sendRemoteTask', () => {
  it('creates the outbound task under the deterministic id and queues its envelope', async () => {
    const linkId = activeLink();
    const res = await sendRemoteTask(deps, { linkId, from: FROM, title: '', text: 'run the tests' });
    const id = remoteTaskId(linkId, 'msg-1');
    expect(res).toEqual({ ok: true, taskId: id });
    const t = tasks.getTask(id)!;
    expect(t.metadata.to).toEqual({ workspaceId: `remote:${linkId}`, name: 'pc-b/ws-b/codex' });
    expect(t.metadata.from).toEqual(FROM);
    expect(t.metadata.remote).toEqual({ v: 1, linkId, hostId: HOST, messageId: 'msg-1', direction: 'outbound', kind: 'pane' });
    const [rec] = outbox.pending(HOST);
    expect(rec.envelope).toMatchObject({ linkId, linkVersion: 2, messageId: 'msg-1', kind: 'task', text: 'run the tests' });
    // Outbound tasks are never "pending delivery" here.
    expect(tasks.listRemotePending()).toEqual([]);
  });

  it('refuses a pane that is not the link local pane, and a link without outbound', async () => {
    const linkId = activeLink();
    expect(await sendRemoteTask(deps, { linkId, from: { ...FROM, paneId: 'pane-x' }, title: '', text: 'x' })).toMatchObject({ ok: false });
    const inboundOnly = activeLink({ outbound: false, inbound: true }, 'codex', 'pane-b2');
    expect(await sendRemoteTask(deps, { linkId: inboundOnly, from: FROM, title: '', text: 'x' }))
      .toEqual({ ok: false, error: 'direction-not-allowed' });
    expect(outbox.pending(HOST)).toEqual([]);
    expect(tasks.taskCount).toBe(0);
  });

  it('cancels the ledger task when the envelope cannot be queued', async () => {
    const linkId = activeLink();
    deps.outbox = { enqueue: () => { throw new Error('disk full'); } };
    const res = await sendRemoteTask(deps, { linkId, from: FROM, title: '', text: 'x' });
    expect(res).toMatchObject({ ok: false });
    expect(tasks.getTask(remoteTaskId(linkId, 'msg-1'))!.status.state).toBe('canceled');
  });
});

describe('sendRemoteTask — brain link (Moa to Moa)', () => {
  function brainLink(): string {
    const linkId = crypto.randomUUID();
    links.receiveProposal({
      linkId,
      local: { kind: 'brain', workspaceId: 'ws-hq' },
      remote: { hostId: HOST, kind: 'brain', workspaceId: 'ws-rhq' },
      allow: { outbound: true, inbound: true },
    });
    links.accept(linkId);
    return linkId;
  }
  const MOA = { workspaceId: 'ws-hq', name: 'Moa' };

  it('lists the link as a brain target without pane ids', () => {
    const linkId = brainLink();
    expect(listRemoteTargets(deps)).toEqual([
      { alias: 'pc-b/Moa', linkId, hostId: HOST, kind: 'brain', local: { workspaceId: 'ws-hq' }, remote: { workspaceId: 'ws-rhq' }, allowOutbound: true },
    ]);
  });

  it('Moa sends as its HQ workspace with no pane', async () => {
    const linkId = brainLink();
    const res = await sendRemoteTask(deps, { linkId, from: MOA, title: '', text: 'summarize the build' });
    expect(res).toEqual({ ok: true, taskId: remoteTaskId(linkId, 'msg-1') });
    expect(tasks.getTask(remoteTaskId(linkId, 'msg-1'))!.metadata.from).toEqual(MOA);
    expect(outbox.pending(HOST)).toHaveLength(1);
  });

  it('refuses a pane sender or another workspace on a brain link', async () => {
    const linkId = brainLink();
    expect(await sendRemoteTask(deps, { linkId, from: { ...MOA, paneId: 'pane-a' }, title: '', text: 'x' })).toMatchObject({ ok: false });
    expect(await sendRemoteTask(deps, { linkId, from: { ...MOA, workspaceId: 'ws-a' }, title: '', text: 'x' })).toMatchObject({ ok: false });
    expect(outbox.pending(HOST)).toEqual([]);
  });

  it('a pane link refuses a sender without a pane', async () => {
    const linkId = activeLink();
    expect(await sendRemoteTask(deps, { linkId, from: { workspaceId: 'ws-a', name: 'Moa' }, title: '', text: 'x' })).toMatchObject({ ok: false });
  });
});

describe('sendRemoteReply / sendRemoteState', () => {
  async function outboundTask(): Promise<{ linkId: string; id: string }> {
    const linkId = activeLink();
    const res = await sendRemoteTask(deps, { linkId, from: FROM, title: '', text: 'do it' });
    if (!res.ok) throw new Error(res.error);
    return { linkId, id: res.taskId };
  }

  it('a reply from the local side is stored and queued', async () => {
    const { id } = await outboundTask();
    expect(await sendRemoteReply(deps, { taskId: id, workspaceId: 'ws-a', text: 'also this' })).toEqual({ ok: true, taskId: id });
    expect(tasks.getTask(id)!.history.at(-1)).toMatchObject({ messageId: 'msg-2', role: 'user' });
    expect(outbox.pending(HOST).map((r) => [r.envelope.kind, r.envelope.taskId])).toEqual([['task', undefined], ['reply', id]]);
  });

  it('refuses a reply from a workspace that is not the local party', async () => {
    const { id } = await outboundTask();
    expect(await sendRemoteReply(deps, { taskId: id, workspaceId: 'ws-other', text: 'x' })).toMatchObject({ ok: false });
    expect(await sendRemoteReply(deps, { taskId: 'task-local', workspaceId: 'ws-a', text: 'x' })).toEqual({ ok: false, error: 'unknown-task' });
  });

  it('queues only a state the ledger is really in', async () => {
    const { id } = await outboundTask();
    expect(await sendRemoteState(deps, { taskId: id, state: 'completed' })).toMatchObject({ ok: false });
    await tasks.cancelTask({ taskId: id, callerWorkspaceId: 'ws-a' });
    expect(await sendRemoteState(deps, { taskId: id, state: 'canceled', summary: 'not needed' })).toEqual({ ok: true, taskId: id });
    expect(outbox.pending(HOST).at(-1)!.envelope).toMatchObject({ kind: 'state', taskId: id, state: 'canceled', text: 'not needed' });
    // Asking again queues nothing more: the state was already told.
    const before = outbox.pending(HOST).length;
    expect(await sendRemoteState(deps, { taskId: id, state: 'canceled' })).toEqual({ ok: true, taskId: id });
    expect(outbox.pending(HOST)).toHaveLength(before);
  });

  it('the ledger is the source of truth: a reply whose queueing failed is queued by the next sync', async () => {
    const { id } = await outboundTask();
    const enqueue = outbox.enqueue.bind(outbox);
    let broken = true;
    const flaky = { ...deps, outbox: { enqueue: (h: string, e: Parameters<OutboxStore['enqueue']>[1]) => {
      if (broken) throw new Error('disk full');
      return enqueue(h, e);
    } } };
    expect(await sendRemoteReply(flaky, { taskId: id, workspaceId: 'ws-a', text: 'kept' })).toEqual({ ok: true, taskId: id });
    expect(outbox.pending(HOST).filter((r) => r.envelope.kind === 'reply')).toHaveLength(0);
    broken = false;
    expect(await syncRemoteTask(flaky, id)).toEqual({ ok: true, queued: 1 });
    const reply = outbox.pending(HOST).find((r) => r.envelope.kind === 'reply')!;
    expect(reply.envelope).toMatchObject({ text: 'kept' });
    // Recorded as sent: a second sync queues nothing.
    expect(await syncRemoteTask(flaky, id)).toEqual({ ok: true, queued: 0 });
  });

  it('a state is queued under an id derived from the ledger transition', async () => {
    const { id } = await outboundTask();
    await tasks.cancelTask({ taskId: id, callerWorkspaceId: 'ws-a' });
    await syncRemoteTask(deps, id);
    expect(outbox.pending(HOST).at(-1)!.envelope.messageId).toBe(stateMessageId(tasks.getTask(id)!));
  });

  it('nothing is queued on a revoked link', async () => {
    const { linkId, id } = await outboundTask();
    links.revoke(linkId, 'local');
    expect(await sendRemoteReply(deps, { taskId: id, workspaceId: 'ws-a', text: 'x' })).toEqual({ ok: false, error: 'link-not-active' });
    expect(outbox.pending(HOST)).toHaveLength(1);
  });
});
