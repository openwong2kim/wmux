import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { A2A_REMOTE_PROTOCOL } from '../../../shared/a2aRemote';
import { A2A_REMOTE_HOLD_TTL_MS, type A2aRemoteTaskState } from '../../../shared/a2aRemoteDelivery';
import { COMPANY_BRIEF_KIND } from '../../../shared/company';
import { A2aTaskService } from '../../a2a/A2aTaskService';
import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { expireHeld, failTasksForLink, rejectHeld, sendHeldNotices, type HeldDeps } from '../held';
import { remoteTaskId } from '../ids';
import { acceptInbound } from '../inbound';
import { LinkStore } from '../linkStore';
import { heldNoticeMessageId, linkAlias, sendRemoteReply, sendRemoteTask } from '../outbound';
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

describe('expireHeld — one held message, not the task (#3326)', () => {
  /** The inbound task delivered, then two peer replies held for want of an agent, `gapMs` apart. */
  async function twoHeldReplies(gapMs: number): Promise<string> {
    const id = await inboundTask();
    await tasks.markRemote({ taskId: id, delivered: true });
    for (const [i, m] of ['r1', 'r2'].entries()) {
      if (i > 0) clock += gapMs;
      await tasks.appendRemoteMessage({
        taskId: id, linkId, actorWorkspaceId: `remote:${linkId}`,
        message: { kind: 'message', messageId: m, role: 'user', parts: [{ kind: 'text', text: `reply ${m}` }] },
      });
      await tasks.markRemote({ taskId: id, messageId: m, held: 'no-agent' });
    }
    return id;
  }
  const item = (id: string, m: string) => (tasks.getTask(id)!.metadata.remote as A2aRemoteTaskState).inbox!.find((i) => i.messageId === m)!;

  it('two held replies expire each at its own time; the task stays open and nothing is sent as a state', async () => {
    const id = await twoHeldReplies(6 * 60 * 60 * 1000);
    const before = outbox.pending(HOST).length;
    clock += A2A_REMOTE_HOLD_TTL_MS - 6 * 60 * 60 * 1000 + 60_000;
    expect(await expireHeld(deps)).toEqual([`${id}#r1`]);
    expect(item(id, 'r1')).toMatchObject({ delivered: false, rejected: { reason: 'held-expired', notice: 'pending' } });
    expect(item(id, 'r1').held).toBeUndefined();
    expect(item(id, 'r2')).toMatchObject({ held: 'no-agent' });
    expect(tasks.getTask(id)!.status.state).toBe('submitted');
    clock += 6 * 60 * 60 * 1000;
    expect(await expireHeld(deps)).toEqual([`${id}#r2`]);
    expect(await expireHeld(deps)).toEqual([]);
    expect(tasks.getTask(id)!.status.state).toBe('submitted');
    expect(outbox.pending(HOST).slice(before).filter((r) => r.envelope.kind === 'state')).toEqual([]);
    // A dropped reply is owed to nobody: never pending again.
    expect(tasks.listRemotePending().map((t) => t.id)).not.toContain(id);
  });

  it('a reply main is writing again right now is not dropped under it; once dropped it cannot be offered again', async () => {
    const id = await twoHeldReplies(0);
    await tasks.markRemote({ taskId: id, messageId: 'r1', attempted: true, reoffer: true });
    clock += A2A_REMOTE_HOLD_TTL_MS + 1;
    expect(await expireHeld(deps)).toEqual([`${id}#r2`]);
    expect(item(id, 'r1')).toMatchObject({ held: 'no-agent', attempted: true });
    expect(item(id, 'r1').rejected).toBeUndefined();
    // r2 was dropped: an offer again of it is refused, so main never writes it.
    expect(await tasks.markRemote({ taskId: id, messageId: 'r2', attempted: true, reoffer: true })).toMatchObject({ ok: false });
  });

  it('a person rejecting a held reply still ends the task, as before', async () => {
    const id = await twoHeldReplies(0);
    expect(await rejectHeld(deps, id, 'not for this agent')).toMatchObject({ ok: true, state: 'failed' });
    expect(tasks.getTask(id)!.status.state).toBe('failed');
  });

  it('a task whose own first message was never delivered still ends when its hold expires', async () => {
    const id = await inboundTask();
    await tasks.markRemote({ taskId: id, held: 'no-agent' });
    clock += A2A_REMOTE_HOLD_TTL_MS + 1;
    expect(await expireHeld(deps)).toEqual([id]);
    expect(tasks.getTask(id)!.status.state).toBe('failed');
  });

  it('a task kept after it ended is never dropped or noticed again', async () => {
    const id = await twoHeldReplies(0);
    await rejectHeld(deps, id, 'x');
    clock += A2A_REMOTE_HOLD_TTL_MS + 1;
    expect(await expireHeld(deps)).toEqual([]);
  });

  it('a reply whose paste was never confirmed expires from its first hold, keeps that hold, and its notice says it may have arrived (#3344)', async () => {
    const id = await twoHeldReplies(0);
    clock += 60 * 60 * 1000;
    await tasks.markRemote({ taskId: id, messageId: 'r1', held: 'delivery-unconfirmed' });
    // 24 h after the FIRST hold: the later mark did not start the clock again.
    clock += A2A_REMOTE_HOLD_TTL_MS - 60 * 60 * 1000 + 1;
    expect(await expireHeld(deps)).toEqual([`${id}#r1`, `${id}#r2`]);
    expect(item(id, 'r1').rejected).toMatchObject({ reason: 'held-expired', held: 'delivery-unconfirmed' });
    expect(item(id, 'r2').rejected).toMatchObject({ reason: 'held-expired', held: 'no-agent' });
    await sendHeldNotices({ ...deps, takesNotice: () => true });
    const sent = outbox.pending(HOST).filter((r) => r.envelope.notice);
    expect(sent.find((r) => r.envelope.notice!.messageId === 'r1')!.envelope.notice).toMatchObject({ unconfirmed: true });
    expect(sent.find((r) => r.envelope.notice!.messageId === 'r2')!.envelope.notice).not.toHaveProperty('unconfirmed');
  });

  describe('the notice, at most once per message', () => {
    async function expiredReply(): Promise<string> {
      const id = await twoHeldReplies(0);
      clock += A2A_REMOTE_HOLD_TTL_MS + 1;
      await expireHeld(deps);
      return id;
    }
    const notices = () => outbox.pending(HOST).filter((r) => r.envelope.notice);

    it('a PC that takes it: one reply carrying the notice, its id derived from the message, then marked sent', async () => {
      const id = await expiredReply();
      const sent = await sendHeldNotices({ ...deps, takesNotice: () => true });
      expect(sent).toBe(2);
      expect(notices().map((r) => r.envelope)).toEqual([
        expect.objectContaining({ kind: 'reply', taskId: id, messageId: heldNoticeMessageId('r1'), notice: { kind: 'held-expired', messageId: 'r1', sentAt: expect.any(String) } }),
        expect.objectContaining({ messageId: heldNoticeMessageId('r2'), notice: expect.objectContaining({ messageId: 'r2' }) }),
      ]);
      expect(item(id, 'r1').rejected?.notice).toBe('sent');
      // Again: nothing more.
      expect(await sendHeldNotices({ ...deps, takesNotice: () => true })).toBe(0);
      expect(notices()).toHaveLength(2);
    });

    it('its id: the full message id when it fits, else a hash of it, never a cut (two long ids never share one)', () => {
      expect(heldNoticeMessageId('r1')).toBe('notice-r1');
      const a = heldNoticeMessageId(`${'a'.repeat(121)}x`);
      const b = heldNoticeMessageId(`${'a'.repeat(121)}y`);
      expect(a).not.toBe(b);
      for (const x of [a, b]) expect(x.length).toBeLessThanOrEqual(128);
    });

    it('a PC that does not take it (an older build): nothing sent, marked not-sent', async () => {
      const id = await expiredReply();
      expect(await sendHeldNotices({ ...deps, takesNotice: () => false })).toBe(0);
      expect(notices()).toEqual([]);
      expect(item(id, 'r1').rejected?.notice).toBe('not-sent');
    });

    it('a PC not connected now: left pending, and sent once it is', async () => {
      const id = await expiredReply();
      expect(await sendHeldNotices({ ...deps, takesNotice: () => undefined })).toBe(0);
      expect(item(id, 'r1').rejected?.notice).toBe('pending');
      expect(await sendHeldNotices({ ...deps, takesNotice: () => true })).toBe(2);
    });

    it('a task that ended meanwhile: no notice', async () => {
      const id = await expiredReply();
      await tasks.forceFailRemote({ taskId: id, reason: 'x', forced: 'remote_held_rejected' });
      expect(await sendHeldNotices({ ...deps, takesNotice: () => true })).toBe(0);
      expect(item(id, 'r1').rejected?.notice).toBe('not-sent');
    });
  });
});

describe('a held reply dropped, by build on each side (held-notice.1, #3326)', () => {
  /** PC B (this test's ledger) holds A's reply r1 and drops it; A is a second ledger with the same task, sent by it. */
  async function bothSides(): Promise<{ id: string; peer: A2aTaskService; peerLinks: LinkStore }> {
    const id = await inboundTask();
    await tasks.markRemote({ taskId: id, delivered: true });
    await tasks.appendRemoteMessage({
      taskId: id, linkId, actorWorkspaceId: `remote:${linkId}`,
      message: { kind: 'message', messageId: 'r1', role: 'user', parts: [{ kind: 'text', text: 'from A' }] },
    });
    await tasks.markRemote({ taskId: id, messageId: 'r1', held: 'no-agent' });
    clock += A2A_REMOTE_HOLD_TTL_MS + 1;
    await expireHeld(deps);
    // PC A: the same link from its side, and the task it sent with its reply r1 queued to B.
    const peerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-held-peer-'));
    const peerLinks = new LinkStore({ dir: peerDir, scheduleHarden: () => undefined });
    peerLinks.receiveProposal({
      linkId,
      local: { kind: 'pane', workspaceId: 'ws-a', paneId: 'pane-a' },
      remote: { hostId: '33333333-3333-4333-8333-333333333333', kind: 'pane', workspaceId: 'ws-b', paneId: 'pane-b' },
      allow: { outbound: true, inbound: true },
    });
    peerLinks.accept(linkId);
    const peerLog = new AppendOnlyLog({ dir: path.join(peerDir, 'log'), fsync: () => undefined });
    peerLog.open();
    const peer = new A2aTaskService({ log: peerLog, origin: { machineId: 'a', daemonEpoch: 1 }, now: () => clock });
    const first = tasks.getTask(id)!.history[0];
    await peer.createTask({
      id,
      title: 'mine',
      from: { workspaceId: 'ws-a', name: 'A', paneId: 'pane-a' },
      to: { workspaceId: `remote:${linkId}`, name: 'pc-b' },
      history: [first, { kind: 'message', messageId: 'r1', role: 'user', parts: [{ kind: 'text', text: 'from A' }] }],
      remote: { v: 1, linkId, hostId: '33333333-3333-4333-8333-333333333333', messageId: first.messageId, direction: 'outbound', kind: 'pane' },
    });
    await peer.markRemote({ taskId: id, sent: 'r1' });
    return { id, peer, peerLinks };
  }

  it('new host, new asker: B sends the notice; A stores it in its own words, a notice item, no state moved', async () => {
    const { id, peer, peerLinks } = await bothSides();
    await sendHeldNotices({ ...deps, takesNotice: () => true });
    const envelope = outbox.pending(HOST).map((r) => r.envelope).find((e) => e.notice)!;
    const res = await acceptInbound(envelope, { hostId: '33333333-3333-4333-8333-333333333333' }, {
      linkStore: peerLinks, taskService: peer, broadcast: () => undefined, aliasFor: (l) => linkAlias(l, 'pc-b'),
    });
    expect(res).toMatchObject({ ok: true, duplicate: false });
    const stored = peer.getTask(id)!;
    expect(stored.history.at(-1)!.metadata).toEqual({ wmuxNotice: { kind: 'held-expired', messageId: 'r1' } });
    expect((stored.metadata.remote as A2aRemoteTaskState).inbox!.at(-1)).toMatchObject({ kind: 'notice', delivered: false });
    expect(stored.status.state).toBe('submitted');
    expect(tasks.getTask(id)!.status.state).toBe('submitted');
  });

  it('new host, older asker: nothing goes to A; both copies stay open', async () => {
    const { id, peer } = await bothSides();
    await sendHeldNotices({ ...deps, takesNotice: () => false });
    expect(outbox.pending(HOST).some((r) => r.envelope.notice)).toBe(false);
    expect(tasks.getTask(id)!.status.state).toBe('submitted');
    expect(peer.getTask(id)!.status.state).toBe('submitted');
  });

  it('older host, new asker: an older B still fails the whole task with its reason; A keeps it 24 h with the reason (see A2aTaskService.remote and a2aTaskQueryView tests)', async () => {
    const { id, peer } = await bothSides();
    await peer.applyRemoteState({ taskId: id, linkId, messageId: 'st-1', to: 'failed', summary: 'rejected on the receiving host: held-expired' });
    expect(peer.getTask(id)!.status).toMatchObject({ state: 'failed', evidence: { summary: 'rejected on the receiving host: held-expired' } });
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
