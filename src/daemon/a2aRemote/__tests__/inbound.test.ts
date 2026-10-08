import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { A2A_REMOTE_PROTOCOL, type A2aRemoteEnvelope } from '../../../shared/a2aRemote';
import { A2aTaskService } from '../../a2a/A2aTaskService';
import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { remoteTaskId } from '../ids';
import { acceptInbound, type InboundDeps } from '../inbound';
import { LinkStore } from '../linkStore';
import { linkAlias, syncRemoteTask } from '../outbound';
import { OutboxStore } from '../outboxStore';

const HOST = '11111111-1111-4111-8111-111111111111';
const OTHER_HOST = '22222222-2222-4222-8222-222222222222';

let dir: string;
let links: LinkStore;
let tasks: A2aTaskService;
let broadcast: ReturnType<typeof vi.fn<InboundDeps['broadcast']>>;
let deps: InboundDeps;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-inbound-'));
  links = new LinkStore({ dir, scheduleHarden: () => undefined });
  const log = new AppendOnlyLog({ dir: path.join(dir, 'log'), fsync: () => undefined });
  log.open();
  tasks = new A2aTaskService({ log, origin: { machineId: 'm', daemonEpoch: 1 } });
  broadcast = vi.fn<InboundDeps['broadcast']>();
  linkCount = 0;
  deps = {
    linkStore: links,
    taskService: tasks,
    broadcast,
    aliasFor: (l) => linkAlias(l, 'pc-a'),
    localWorkspaceName: (id) => (id === 'ws-b' ? 'Backend' : undefined),
  };
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** An active link on this host (B): local ws-b/pane-b <-> remote ws-a/pane-a on HOST. */
let linkCount = 0;
function activeLink(allow = { outbound: true, inbound: true }): string {
  const linkId = crypto.randomUUID();
  links.receiveProposal({
    linkId,
    local: { kind: 'pane', workspaceId: 'ws-b', paneId: 'pane-b' },
    // A distinct remote pane per link: one pane pair holds one live link.
    remote: { hostId: HOST, kind: 'pane', workspaceId: 'ws-a', paneId: linkCount++ === 0 ? 'pane-a' : `pane-a${linkCount}`, label: 'claude' },
    allow,
  });
  links.accept(linkId); // version 2
  return linkId;
}

function env(linkId: string, o: Partial<A2aRemoteEnvelope>): A2aRemoteEnvelope {
  return {
    protocol: A2A_REMOTE_PROTOCOL,
    linkId,
    linkVersion: 2,
    messageId: crypto.randomUUID(),
    kind: 'task',
    text: 'please review',
    sentAt: new Date().toISOString(),
    ...o,
  };
}

const peer = { hostId: HOST };

describe('acceptInbound — task', () => {
  it('lands an undelivered inbound task on the linked pane and broadcasts it', async () => {
    const linkId = activeLink();
    const e = env(linkId, {});
    const res = await acceptInbound(e, peer, deps);
    const id = remoteTaskId(linkId, e.messageId);
    expect(res).toEqual({ ok: true, taskId: id, duplicate: false });
    const t = tasks.getTask(id)!;
    expect(t.metadata.from).toEqual({ workspaceId: `remote:${linkId}`, name: 'pc-a/ws-a/claude' });
    expect(t.metadata.to).toEqual({ workspaceId: 'ws-b', name: 'Backend', paneId: 'pane-b' });
    expect(t.metadata.remote).toMatchObject({ linkId, hostId: HOST, direction: 'inbound', delivered: false });
    expect(broadcast).toHaveBeenCalledWith({ type: 'a2a.remote.inbound', taskId: id });
    expect(tasks.listRemotePending().map((x) => x.id)).toEqual([id]);
  });

  it('a task to a brain (Moa) end is pending for main to wake Moa, never held; its reply is owed the same way', async () => {
    const linkId = crypto.randomUUID();
    links.receiveProposal({
      linkId,
      local: { kind: 'brain', workspaceId: 'ws-hq' },
      remote: { hostId: HOST, kind: 'brain', workspaceId: 'ws-hq-a' },
      allow: { outbound: true, inbound: true },
    });
    links.accept(linkId);
    const e = env(linkId, {});
    expect(await acceptInbound(e, peer, deps)).toMatchObject({ ok: true, duplicate: false });
    const id = remoteTaskId(linkId, e.messageId);
    expect(tasks.getTask(id)!.metadata.remote).toMatchObject({ delivered: false, kind: 'brain' });
    expect(tasks.getTask(id)!.metadata.remote).not.toHaveProperty('held');
    expect(tasks.listRemotePending().map((t) => t.id)).toEqual([id]);
    expect(broadcast).toHaveBeenCalledWith({ type: 'a2a.remote.inbound', taskId: id });
    const reply = env(linkId, { kind: 'reply', taskId: id, text: 'more' });
    expect(await acceptInbound(reply, peer, deps)).toMatchObject({ ok: true, duplicate: false });
    const inbox = (tasks.getTask(id)!.metadata.remote as { inbox?: Array<{ messageId: string; held?: string }> }).inbox;
    expect(inbox?.find((i) => i.messageId === reply.messageId)).toMatchObject({ messageId: reply.messageId });
    expect(inbox?.find((i) => i.messageId === reply.messageId)?.held).toBeUndefined();
  });

  it('the same message again is a duplicate; same id with another body is a conflict', async () => {
    const linkId = activeLink();
    const e = env(linkId, {});
    await acceptInbound(e, peer, deps);
    expect(await acceptInbound(e, peer, deps)).toMatchObject({ ok: true, duplicate: true });
    expect(await acceptInbound({ ...e, text: 'something else' }, peer, deps)).toMatchObject({ ok: false, error: 'conflict' });
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it('refuses per link-store verdict', async () => {
    const linkId = activeLink({ outbound: true, inbound: false });
    expect(await acceptInbound(env(linkId, {}), peer, deps)).toMatchObject({ ok: false, error: 'direction-not-allowed' });
    const open = activeLink();
    expect(await acceptInbound(env(crypto.randomUUID(), {}), peer, deps)).toMatchObject({ ok: false, error: 'unknown-link' });
    expect(await acceptInbound(env(open, {}), { hostId: OTHER_HOST }, deps)).toMatchObject({ ok: false, error: 'forbidden' });
    expect(await acceptInbound(env(open, { linkVersion: 1 }), peer, deps)).toMatchObject({ ok: false, error: 'stale-link-version' });
    links.revoke(open, 'local');
    expect(await acceptInbound(env(open, { linkVersion: 3 }), peer, deps)).toMatchObject({ ok: false, error: 'link-not-active' });
    expect(tasks.taskCount).toBe(0);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('refuses malformed and oversized envelopes before touching anything', async () => {
    const linkId = activeLink();
    expect(await acceptInbound(env(linkId, { protocol: 99 }), peer, deps)).toMatchObject({ error: 'protocol' });
    expect(await acceptInbound(env(linkId, { text: '' }), peer, deps)).toMatchObject({ error: 'bad-request' });
    expect(await acceptInbound(env(linkId, { text: 'x'.repeat(40 * 1024) }), peer, deps)).toMatchObject({ error: 'too-large' });
    expect(await acceptInbound('nope', peer, deps)).toMatchObject({ error: 'bad-request' });
    expect(tasks.taskCount).toBe(0);
  });
});

describe('acceptInbound — reply and state', () => {
  async function landed(linkId: string): Promise<string> {
    const e = env(linkId, {});
    await acceptInbound(e, peer, deps);
    return remoteTaskId(linkId, e.messageId);
  }

  it('appends a reply from the sender; a redelivery is a duplicate, a changed body a conflict', async () => {
    const linkId = activeLink();
    const id = await landed(linkId);
    const r = env(linkId, { kind: 'reply', taskId: id, text: 'one more thing' });
    expect(await acceptInbound(r, peer, deps)).toEqual({ ok: true, taskId: id, duplicate: false });
    expect(tasks.getTask(id)!.history.at(-1)).toMatchObject({ messageId: r.messageId, role: 'user' });
    expect(await acceptInbound(r, peer, deps)).toMatchObject({ ok: true, duplicate: true });
    expect(await acceptInbound({ ...r, text: 'changed' }, peer, deps)).toMatchObject({ ok: false, error: 'conflict' });
  });

  it('a reply into a task that is not on this link is unknown-task', async () => {
    const linkId = activeLink();
    await tasks.createTask({ id: 'task-local', title: 't', from: { workspaceId: 'ws-x', name: 'x' }, to: { workspaceId: 'ws-b', name: 'b' } });
    expect(await acceptInbound(env(linkId, { kind: 'reply', taskId: 'task-local', text: 'inject' }), peer, deps))
      .toMatchObject({ ok: false, error: 'unknown-task' });
    const other = activeLink();
    const foreign = await landed(other);
    // Reusing another link's task id: refused, history untouched.
    expect(await acceptInbound(env(linkId, { kind: 'reply', taskId: foreign, text: 'inject' }), peer, deps))
      .toMatchObject({ ok: false, error: 'unknown-task' });
    expect(tasks.getTask(foreign)!.history).toHaveLength(1);
    expect(tasks.getTask('task-local')!.history).toHaveLength(0);
  });

  it('applies state as the peer: it may cancel the task it sent, not move it', async () => {
    const linkId = activeLink();
    const id = await landed(linkId);
    expect(await acceptInbound(env(linkId, { kind: 'state', taskId: id, state: 'working', text: undefined }), peer, deps))
      .toMatchObject({ ok: false, error: 'forbidden' });
    const cancel = env(linkId, { kind: 'state', taskId: id, state: 'canceled', text: undefined });
    expect(await acceptInbound(cancel, peer, deps)).toMatchObject({ ok: true, duplicate: false });
    expect(tasks.getTask(id)!.status.state).toBe('canceled');
    expect(await acceptInbound(cancel, peer, deps)).toMatchObject({ ok: true, duplicate: true });
    expect(await acceptInbound({ ...cancel, state: 'working' }, peer, deps)).toMatchObject({ ok: false, error: 'conflict' });
  });

  it('completes an outbound task with the summary-only evidence', async () => {
    const linkId = activeLink();
    const id = remoteTaskId(linkId, 'orig');
    await tasks.createTask({
      id,
      title: 't',
      from: { workspaceId: 'ws-b', name: 'Backend', paneId: 'pane-b' },
      to: { workspaceId: `remote:${linkId}`, name: 'pc-a/ws-a/claude' },
      remote: { v: 1, linkId, hostId: HOST, messageId: 'orig', direction: 'outbound' },
    });
    await acceptInbound(env(linkId, { kind: 'state', taskId: id, state: 'working', text: undefined }), peer, deps);
    expect(await acceptInbound(env(linkId, { kind: 'state', taskId: id, state: 'completed', text: 'shipped' }), peer, deps))
      .toMatchObject({ ok: true });
    expect(tasks.getTask(id)!.status).toMatchObject({ state: 'completed', evidence: { summary: 'shipped', items: [] } });
  });
});

describe('acceptInbound — link notices', () => {
  it('applies a remote accept once; the redelivery is a duplicate', async () => {
    const out = links.proposeOut({
      local: { kind: 'pane', workspaceId: 'ws-b', paneId: 'pane-b' },
      remote: { hostId: HOST, kind: 'pane', workspaceId: 'ws-a', paneId: 'pane-a' },
      allow: { outbound: true, inbound: true },
    });
    const notice = env(out.linkId, { kind: 'link', text: undefined, link: { state: 'active', version: 2 } });
    expect(await acceptInbound(notice, peer, deps)).toEqual({ ok: true, duplicate: false });
    expect(links.get(out.linkId)!.state).toBe('active');
    expect(await acceptInbound(notice, peer, deps)).toEqual({ ok: true, duplicate: true });
  });

  it('a revoke is taken at any version, and only from the owning host', async () => {
    const linkId = activeLink();
    const notice = env(linkId, { kind: 'link', text: undefined, link: { state: 'revoked', version: 99 } });
    expect(await acceptInbound(notice, { hostId: OTHER_HOST }, deps)).toMatchObject({ ok: false, error: 'forbidden' });
    expect(await acceptInbound(notice, peer, deps)).toEqual({ ok: true, duplicate: false });
    expect(links.get(linkId)).toMatchObject({ state: 'revoked', endedReason: 'revoked-remote' });
    expect(await acceptInbound(notice, peer, deps)).toEqual({ ok: true, duplicate: true });
  });

  it('a broken notice needs the next version and a broken reason', async () => {
    const linkId = activeLink();
    expect(await acceptInbound(env(linkId, { kind: 'link', text: undefined, link: { state: 'broken', version: 9, reason: 'pane-closed' } }), peer, deps))
      .toMatchObject({ ok: false, error: 'stale-link-version' });
    expect(await acceptInbound(env(linkId, { kind: 'link', text: undefined, link: { state: 'broken', version: 3 } }), peer, deps))
      .toMatchObject({ ok: false, error: 'bad-request' });
    expect(await acceptInbound(env(linkId, { kind: 'link', text: undefined, link: { state: 'broken', version: 3, reason: 'pane-closed' } }), peer, deps))
      .toEqual({ ok: true, duplicate: false });
  });
});

describe('acceptInbound — brain link (Moa to Moa)', () => {
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

  it('lands the task on this PC\'s Moa: HQ workspace, no pane, same broadcast', async () => {
    const linkId = brainLink();
    deps.aliasFor = () => 'pc-a/Moa';
    const e = env(linkId, {});
    const res = await acceptInbound(e, peer, deps);
    const id = remoteTaskId(linkId, e.messageId);
    expect(res).toEqual({ ok: true, taskId: id, duplicate: false });
    const t = tasks.getTask(id)!;
    expect(t.metadata.from).toEqual({ workspaceId: `remote:${linkId}`, name: 'pc-a/Moa' });
    expect(t.metadata.to).toEqual({ workspaceId: 'ws-hq', name: 'Moa' });
    expect(broadcast).toHaveBeenCalledWith({ type: 'a2a.remote.inbound', taskId: id });
  });
});

describe('acceptInbound — message id', () => {
  it('accepts only a plain token as the peer\'s message id', async () => {
    const linkId = activeLink();
    for (const messageId of ['a b', 'x"y', 'é', 'a'.repeat(129), 'a/b']) {
      expect(await acceptInbound(env(linkId, { messageId }), peer, deps)).toMatchObject({ ok: false, error: 'bad-request' });
    }
    expect(await acceptInbound(env(linkId, { messageId: 'Abc_123-xyz' }), peer, deps)).toMatchObject({ ok: true });
  });

  it('records the link endpoint kind on the marker', async () => {
    const linkId = activeLink();
    const e = env(linkId, {});
    await acceptInbound(e, peer, deps);
    expect(tasks.getTask(remoteTaskId(linkId, e.messageId))!.metadata.remote).toMatchObject({ kind: 'pane' });
  });
});

describe('acceptInbound — peer text is made safe before it is stored', () => {
  it('drops escapes (CSI, OSC 52, bracketed-paste end), controls and CR line forgery, keeps newlines and tabs', async () => {
    const linkId = activeLink();
    const evil = 'ok\x1b[2J\x1b]52;c;cm0gLXJmIH4=\x07 line\x1b[201~rm -rf ~\rforged\ttab\nnext\x00\x9b31m\x7f';
    const e = env(linkId, { text: evil });
    expect(await acceptInbound(e, peer, deps)).toMatchObject({ ok: true });
    const text = (tasks.getTask(remoteTaskId(linkId, e.messageId))!.history[0].parts[0] as { text: string }).text;
    expect(text).toBe('ok linerm -rf ~\nforged\ttab\nnext');
    expect(text).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  });

  it('a task whose text is nothing but escapes is refused', async () => {
    const linkId = activeLink();
    expect(await acceptInbound(env(linkId, { text: '\x1b[201~\x1b]0;x\x07' }), peer, deps)).toMatchObject({ ok: false, error: 'bad-request' });
  });
});

describe('receipts', () => {
  it('the receiver queues delivered, then read, once each; never a state change', async () => {
    const linkId = activeLink();
    const e = env(linkId, {});
    await acceptInbound(e, peer, deps);
    const id = remoteTaskId(linkId, e.messageId);
    const outbox = new OutboxStore({ dir, scheduleHarden: () => undefined });
    const sync = { linkStore: links, taskService: tasks, outbox };
    const receipts = (): unknown[] => outbox.pending(HOST).map((r) => r.envelope).filter((x) => x.kind === 'receipt').map((x) => x.receipt);
    expect(await syncRemoteTask(sync, id)).toEqual({ ok: true, queued: 0 }); // not handed over yet
    await tasks.markRemote({ taskId: id, delivered: true });
    await syncRemoteTask(sync, id);
    await syncRemoteTask(sync, id);
    expect(receipts()).toEqual(['delivered']);
    await tasks.markRemote({ taskId: id, read: true });
    await syncRemoteTask(sync, id);
    await syncRemoteTask(sync, id);
    expect(receipts()).toEqual(['delivered', 'read']);
    expect(tasks.getTask(id)!.status.state).toBe('submitted');
  });

  it('the sender records the peer\'s receipts on its own task; a receipt for a task it did not send is refused', async () => {
    const linkId = activeLink();
    const out = remoteTaskId(linkId, 'mine-1');
    await tasks.createTask({
      id: out,
      title: 'mine',
      from: { workspaceId: 'ws-b', name: 'Backend', paneId: 'pane-b' },
      to: { workspaceId: `remote:${linkId}`, name: 'pc-a/ws-a/claude' },
      history: [{ kind: 'message', messageId: 'mine-1', role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
      remote: { v: 1, linkId, hostId: HOST, messageId: 'mine-1', direction: 'outbound', kind: 'pane' },
    });
    expect(await acceptInbound(env(linkId, { kind: 'receipt', taskId: out, receipt: 'delivered', text: undefined }), peer, deps)).toMatchObject({ ok: true });
    expect(tasks.getTask(out)!.metadata.remote).toMatchObject({ remoteDeliveredAt: expect.any(String) });
    expect(tasks.getTask(out)!.metadata.remote).not.toHaveProperty('remoteReadAt');
    expect(await acceptInbound(env(linkId, { kind: 'receipt', taskId: out, receipt: 'read', text: undefined }), peer, deps)).toMatchObject({ ok: true });
    expect(tasks.getTask(out)!.metadata.remote).toMatchObject({ remoteReadAt: expect.any(String) });
    expect(tasks.getTask(out)!.status.state).toBe('submitted');

    const e = env(linkId, {});
    await acceptInbound(e, peer, deps);
    expect(await acceptInbound(env(linkId, { kind: 'receipt', taskId: remoteTaskId(linkId, e.messageId), receipt: 'read', text: undefined }), peer, deps))
      .toMatchObject({ ok: false, error: 'forbidden' });
    expect(await acceptInbound(env(linkId, { kind: 'receipt', taskId: out, receipt: 'opened' as never, text: undefined }), peer, deps))
      .toMatchObject({ ok: false, error: 'bad-request' });
  });
});

