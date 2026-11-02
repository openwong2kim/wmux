import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { A2A_REMOTE_PROTOCOL } from '../../../shared/a2aRemote';
import { A2A_REMOTE_HOLD_TTL_MS } from '../../../shared/a2aRemoteDelivery';
import { COMPANY_BRIEF_KIND } from '../../../shared/company';
import { A2aTaskService } from '../../a2a/A2aTaskService';
import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { expireHeld, failTasksForLink, rejectHeld, type HeldDeps } from '../held';
import { remoteTaskId } from '../ids';
import { acceptInbound } from '../inbound';
import { LinkStore } from '../linkStore';
import { linkAlias, sendRemoteReply, sendRemoteTask } from '../outbound';
import { OutboxStore } from '../outboxStore';

const HOST = '11111111-1111-4111-8111-111111111111';

let dir: string;
let clock: number;
let links: LinkStore;
let tasks: A2aTaskService;
let outbox: OutboxStore;
let deps: HeldDeps;
let linkId: string;

beforeEach(() => {
  clock = Date.parse('2026-10-07T00:00:00.000Z');
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-held-'));
  links = new LinkStore({ dir, scheduleHarden: () => undefined });
  outbox = new OutboxStore({ dir, scheduleHarden: () => undefined });
  const log = new AppendOnlyLog({ dir: path.join(dir, 'log'), fsync: () => undefined });
  log.open();
  tasks = new A2aTaskService({ log, origin: { machineId: 'm', daemonEpoch: 1 }, now: () => clock });
  deps = { taskService: tasks, linkStore: links, outbox, now: () => clock };
  linkId = crypto.randomUUID();
  links.receiveProposal({
    linkId,
    local: { kind: 'pane', workspaceId: 'ws-b', paneId: 'pane-b' },
    remote: { hostId: HOST, kind: 'pane', workspaceId: 'ws-a', paneId: 'pane-a' },
    allow: { outbound: true, inbound: true },
  });
  links.accept(linkId);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

async function inboundTask(): Promise<string> {
  const res = await acceptInbound(
    { protocol: A2A_REMOTE_PROTOCOL, linkId, linkVersion: 2, messageId: crypto.randomUUID(), kind: 'task', text: 'do it', sentAt: 'x' },
    { hostId: HOST },
    { linkStore: links, taskService: tasks, broadcast: () => undefined, aliasFor: (l) => linkAlias(l, 'pc-a') },
  );
  if (!res.ok || !res.taskId) throw new Error('no task');
  return res.taskId;
}

async function outboundTask(): Promise<string> {
  const res = await sendRemoteTask(
    { linkStore: links, taskService: tasks, outbox, aliasFor: (l) => linkAlias(l, 'pc-a') },
    { linkId, from: { workspaceId: 'ws-b', name: 'B', paneId: 'pane-b', ptyId: 'pty-b' }, title: '', text: 'please' },
  );
  if (!res.ok) throw new Error(res.error);
  return res.taskId;
}

const lastEnvelope = () => outbox.pending(HOST).at(-1)?.envelope;

describe('rejectHeld', () => {
  it('fails a held inbound task and tells the peer', async () => {
    const id = await inboundTask();
    await tasks.markRemote({ taskId: id, held: 'occupant-changed' });
    expect(await rejectHeld(deps, id, 'not for this agent')).toEqual({ ok: true, taskId: id, state: 'failed', queued: true });
    expect(tasks.getTask(id)!.status).toMatchObject({ state: 'failed', evidence: { summary: 'rejected on the receiving host: not for this agent' } });
    expect(lastEnvelope()).toMatchObject({ kind: 'state', taskId: id, state: 'failed' });
    expect(tasks.listRemoteHeld()).toEqual([]);
  });

  it('cancels our outbound task whose reply was held, and tells the peer', async () => {
    const id = await outboundTask();
    await tasks.appendRemoteMessage({
      taskId: id, linkId, actorWorkspaceId: `remote:${linkId}`,
      message: { kind: 'message', messageId: 'r1', role: 'agent', parts: [{ kind: 'text', text: 'hi' }] },
    });
    await tasks.markRemote({ taskId: id, messageId: 'r1', held: 'pane-missing' });
    expect(await rejectHeld(deps, id, 'pane closed')).toMatchObject({ ok: true, state: 'canceled', queued: true });
    expect(tasks.getTask(id)!.status.state).toBe('canceled');
    expect(lastEnvelope()).toMatchObject({ kind: 'state', taskId: id, state: 'canceled' });
  });

  it('refuses a task that is not held, and an unknown one', async () => {
    const id = await inboundTask();
    expect(await rejectHeld(deps, id, 'x')).toEqual({ ok: false, error: 'not-held' });
    expect(await rejectHeld(deps, 'rt-nope', 'x')).toEqual({ ok: false, error: 'unknown-task' });
  });

  it('ends the task even when the link is gone, without queuing', async () => {
    const id = await inboundTask();
    await tasks.markRemote({ taskId: id, held: 'pane-missing' });
    links.revoke(linkId, 'local');
    expect(await rejectHeld(deps, id, 'x')).toMatchObject({ ok: true, queued: false });
    expect(tasks.getTask(id)!.status.state).toBe('failed');
  });
});

describe('expireHeld', () => {
  it('rejects only holds older than the TTL, as held-expired', async () => {
    const old = await inboundTask();
    await tasks.markRemote({ taskId: old, held: 'pane-missing' });
    clock += A2A_REMOTE_HOLD_TTL_MS - 60_000;
    const fresh = await inboundTask();
    await tasks.markRemote({ taskId: fresh, held: 'occupant-changed' });
    clock += 2 * 60_000;
    expect(await expireHeld(deps)).toEqual([old]);
    expect(tasks.getTask(old)!.status.evidence?.summary).toMatch(/held-expired/);
    expect(tasks.getTask(fresh)!.status.state).toBe('submitted');
  });
});

describe('failTasksForLink', () => {
  it('fails every open task on the link and refuses what the outbox still owes for it', async () => {
    const inId = await inboundTask();
    const outId = await outboundTask();
    await sendRemoteReply({ linkStore: links, taskService: tasks, outbox, aliasFor: () => '' }, { taskId: inId, workspaceId: 'ws-b', text: 'ok' });
    outbox.enqueue(HOST, { protocol: A2A_REMOTE_PROTOCOL, linkId, linkVersion: 3, messageId: 'n', kind: 'link', link: { state: 'revoked', version: 3 }, sentAt: 'x' });
    expect(outbox.pending(HOST).map((r) => r.envelope.kind)).toEqual(['task', 'reply', 'link']);

    links.revoke(linkId, 'local');
    const res = await failTasksForLink(deps, linkId, 'link_revoked');
    expect(res.failed.sort()).toEqual([inId, outId].sort());
    expect(res.refused).toBe(2);
    expect(tasks.getTask(inId)!.status).toMatchObject({ state: 'failed', evidence: { summary: 'link_revoked' } });
    expect(tasks.getTask(outId)!.status.state).toBe('failed');
    // The link notice still goes out.
    expect(outbox.pending(HOST).map((r) => r.envelope.kind)).toEqual(['link']);
    expect(await failTasksForLink(deps, linkId, 'link_revoked')).toEqual({ failed: [], refused: 0 });
  });
});

describe('failTasksForLink — a report the peer made', () => {
  /** A company task this PC sent, which the peer reported done (held here as input-required). */
  async function reportedTask(): Promise<string> {
    const id = remoteTaskId(linkId, 'brief-1');
    await tasks.createTask({
      id,
      title: 'T',
      from: { workspaceId: 'ws-b', name: 'B', paneId: 'pane-b' },
      to: { workspaceId: `remote:${linkId}`, name: 'pc-a/ws-a/pane-a' },
      history: [{
        kind: 'message',
        messageId: 'brief-1',
        role: 'user',
        parts: [
          { kind: 'text', text: 'ship it' },
          { kind: 'data', data: { kind: COMPANY_BRIEF_KIND, v: 1, goal: 'g', scope: 's', acceptance: 'a', verify: 'v', report: 'r' } },
        ],
      }],
      remote: { v: 1, linkId, hostId: HOST, messageId: 'brief-1', direction: 'outbound', kind: 'pane' },
    });
    expect((await tasks.applyRemoteState({ taskId: id, linkId, messageId: 'st-1', to: 'completed', summary: 'merged' })).ok).toBe(true);
    return id;
  }

  for (const reason of ['link_revoked', 'link_broken'] as const) {
    it(`${reason}: the report stays input-required; an unreported open task fails`, async () => {
      const reported = await reportedTask();
      const open = await outboundTask();
      if (reason === 'link_revoked') links.revoke(linkId, 'local');
      else links.markBroken(linkId, 'pane-closed');
      const res = await failTasksForLink(deps, linkId, reason);
      expect(res.failed).toEqual([open]);
      expect(tasks.getTask(open)!.status.state).toBe('failed');
      expect(tasks.getTask(reported)!.status.state).toBe('input-required');
      expect(tasks.getTask(reported)!.metadata.remote).toMatchObject({ reported: 'st-1' });
    });
  }
});

describe('failTasksForLink — what is still owed to our pane', () => {
  it('holds a peer reply our pane never got as link-not-active, so it is never pasted later', async () => {
    const outId = await outboundTask();
    const reply = { protocol: A2A_REMOTE_PROTOCOL, linkId, linkVersion: 2, messageId: crypto.randomUUID(), kind: 'reply' as const, taskId: outId, text: 'late answer', sentAt: 'x' };
    await acceptInbound(reply, { hostId: HOST }, { linkStore: links, taskService: tasks, broadcast: () => undefined, aliasFor: (l) => linkAlias(l, 'pc-a') });
    expect(tasks.listRemotePending().map((t) => t.id)).toEqual([outId]);
    links.revoke(linkId, 'local');
    await failTasksForLink(deps, linkId, 'link_revoked');
    expect(tasks.listRemotePending()).toEqual([]);
    const marker = tasks.getTask(outId)!.metadata.remote as { inbox?: Array<{ messageId: string; held?: string }> };
    expect(marker.inbox?.find((i) => i.messageId === reply.messageId)?.held).toBe('link-not-active');
  });
});
