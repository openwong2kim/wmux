import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { A2aTaskService, REMOTE_STATE_IDS_MAX, statusMessageFromWire } from '../A2aTaskService';
import type { A2aRemoteTaskMarkerV1 } from '../../../shared/a2aRemote';
import type { A2aRemoteTaskState } from '../../../shared/a2aRemoteDelivery';
import { COMPANY_BRIEF_KIND } from '../../../shared/company';
import { panePrincipalId } from '../../../shared/principals';
import type { Message } from '../../../shared/types';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-a2a-remote-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function newLog(): AppendOnlyLog {
  const log = new AppendOnlyLog({ dir, fsync: () => undefined });
  log.open();
  return log;
}

function newService(log: AppendOnlyLog): A2aTaskService {
  return new A2aTaskService({ log, origin: { machineId: 'm1', daemonEpoch: 1 } });
}

const LINK = '11111111-1111-4111-8111-111111111111';
const REMOTE_WS = `remote:${LINK}`;
const HOST = '22222222-2222-4222-8222-222222222222';

function msg(id: string, text: string, role: Message['role'] = 'user'): Message {
  return { kind: 'message', messageId: id, role, parts: [{ kind: 'text', text }] };
}

function marker(direction: 'inbound' | 'outbound', extra: Partial<A2aRemoteTaskMarkerV1> = {}): A2aRemoteTaskMarkerV1 {
  return { v: 1, linkId: LINK, hostId: HOST, messageId: 'm-0', direction, ...(direction === 'inbound' ? { delivered: false } : {}), ...extra };
}

/** Receiver side (B): the peer sent us this task. */
async function inbound(svc: A2aTaskService, id = 'rt-in', text = 'do the thing') {
  return svc.createTask(
    {
      id,
      title: 'T',
      from: { workspaceId: REMOTE_WS, name: 'pc-a/ws/pane' },
      to: { workspaceId: 'ws-local', name: 'Local', paneId: 'pane-l' },
      history: [msg('m-0', text)],
      remote: marker('inbound'),
    },
    { conflictOnBodyMismatch: true },
  );
}

/** Sender side (A): we sent this task to the peer. */
async function outbound(svc: A2aTaskService, id = 'rt-out') {
  return svc.createTask({
    id,
    title: 'T',
    from: { workspaceId: 'ws-local', name: 'Local', paneId: 'pane-l' },
    to: { workspaceId: REMOTE_WS, name: 'pc-b/ws/pane' },
    history: [msg('m-0', 'please')],
    remote: marker('outbound'),
  });
}

/** Sender side (A), company mode: the CEO pane briefed a seat on the peer. */
async function companyOutbound(svc: A2aTaskService, id = 'rt-co') {
  return svc.createTask({
    id,
    title: 'T',
    from: { workspaceId: 'ws-local', name: 'Local', paneId: 'pane-ceo' },
    to: { workspaceId: REMOTE_WS, name: 'pc-b/ws/pane' },
    history: [{
      kind: 'message',
      messageId: 'm-0',
      role: 'user',
      parts: [
        { kind: 'text', text: 'please' },
        { kind: 'data', data: { kind: COMPANY_BRIEF_KIND, v: 1, goal: 'g', scope: 's', acceptance: 'a', verify: 'v', report: 'r' } },
      ],
    }],
    remote: marker('outbound'),
  });
}

const PEER_EVIDENCE = {
  summary: 'merged',
  items: [
    { kind: 'command' as const, status: 'passed' as const, command: 'npm test', summary: 'tests pass' },
    { kind: 'inspection' as const, status: 'unverified' as const, summary: 'read the diff' },
  ],
};

const remoteOf = (svc: A2aTaskService, id: string): A2aRemoteTaskState => svc.getTask(id)!.metadata.remote as A2aRemoteTaskState;
const lastPayload = (log: AppendOnlyLog): unknown => log.readAllRecords().filter((r) => r.domain === 'a2a').at(-1)!.payload;

describe('A2aTaskService — remote marker', () => {
  it('stores the marker on create and restores it from the log', async () => {
    const log = newLog();
    const svc = newService(log);
    expect((await inbound(svc)).ok).toBe(true);
    expect(svc.getTask('rt-in')?.metadata.remote).toEqual(marker('inbound'));

    const restored = newService(log);
    restored.restoreFromLog();
    expect(restored.getTask('rt-in')?.metadata.remote).toEqual(marker('inbound'));
  });

  it('same id + same body is an idempotent create; a different body is a conflict', async () => {
    const log = newLog();
    const svc = newService(log);
    await inbound(svc);
    const again = await inbound(svc);
    expect(again).toMatchObject({ ok: true, existed: true });
    const clash = await inbound(svc, 'rt-in', 'something else');
    expect(clash).toMatchObject({ ok: false, conflict: true });
    expect(log.readAllRecords().filter((r) => r.domain === 'a2a')).toHaveLength(1);
  });

  it('a non-remote create keeps the existing task without a conflict check', async () => {
    const svc = newService(newLog());
    const base = { id: 'task-x', title: 'T', from: { workspaceId: 'a', name: 'A' }, to: { workspaceId: 'b', name: 'B' } };
    await svc.createTask({ ...base, history: [msg('1', 'one')] });
    expect(await svc.createTask({ ...base, history: [msg('2', 'two')] })).toMatchObject({ ok: true, existed: true });
  });
});

describe('A2aTaskService — remote.mark and listRemotePending', () => {
  it('a Moa hold an older version logged reads as link-not-active: held for a person, never pending', async () => {
    const log = newLog();
    const svc = newService(log);
    await inbound(svc, 'rt-moa');
    // What an older main wrote for work it held for this PC's Moa.
    expect((await svc.markRemote({ taskId: 'rt-moa', held: 'brain-unavailable' as never })).ok).toBe(true);
    expect(svc.getTask('rt-moa')?.metadata.remote).toMatchObject({ held: 'link-not-active' });
    expect(svc.listRemotePending()).toEqual([]);
    expect(svc.listRemoteHeld().map((t) => t.id)).toEqual(['rt-moa']);

    const restored = newService(log);
    restored.restoreFromLog();
    expect(restored.getTask('rt-moa')?.metadata.remote).toMatchObject({ held: 'link-not-active', heldAt: expect.any(String) });
    expect(restored.listRemotePending()).toEqual([]);
  });

  it('lists undelivered, unheld inbound tasks; a hold moves to the held list; marks survive replay', async () => {
    const log = newLog();
    const svc = newService(log);
    await inbound(svc, 'rt-1');
    await inbound(svc, 'rt-2');
    await inbound(svc, 'rt-3');
    await outbound(svc);
    expect(svc.listRemotePending().map((t) => t.id).sort()).toEqual(['rt-1', 'rt-2', 'rt-3']);

    expect((await svc.markRemote({ taskId: 'rt-2', held: 'pane-missing' })).ok).toBe(true);
    expect(svc.getTask('rt-2')?.metadata.remote).toMatchObject({ delivered: false, held: 'pane-missing' });
    expect(svc.listRemotePending().map((t) => t.id).sort()).toEqual(['rt-1', 'rt-3']);
    expect(svc.listRemoteHeld().map((t) => t.id)).toEqual(['rt-2']);

    expect((await svc.markRemote({ taskId: 'rt-1', delivered: true, ptyId: 'pty-9' })).ok).toBe(true);
    expect(svc.getTask('rt-1')?.metadata.to.ptyId).toBe('pty-9');
    expect((await svc.markRemote({ taskId: 'rt-3', delivered: true, note: 'pasted-not-submitted' })).ok).toBe(true);
    expect(svc.listRemotePending()).toEqual([]);

    const restored = newService(log);
    restored.restoreFromLog();
    expect(restored.listRemotePending()).toEqual([]);
    expect(restored.listRemoteHeld().map((t) => t.id)).toEqual(['rt-2']);
    expect(restored.getTask('rt-2')?.metadata.remote).toMatchObject({ held: 'pane-missing', heldAt: expect.any(String) });
    expect(restored.getTask('rt-1')?.metadata.to.ptyId).toBe('pty-9');
    expect(restored.getTask('rt-3')?.metadata.remote).toMatchObject({ delivered: true, note: 'pasted-not-submitted' });
    expect(restored.getTask('rt-1')?.metadata.remote).toMatchObject({ delivered: true });
    expect(restored.getTask('rt-1')?.metadata.remote).not.toHaveProperty('held');
  });

  it('a delivered mark clears the hold, and a repeated mark appends nothing', async () => {
    const log = newLog();
    const svc = newService(log);
    await inbound(svc);
    await svc.markRemote({ taskId: 'rt-in', held: 'occupant-changed' });
    await svc.markRemote({ taskId: 'rt-in', held: 'occupant-changed' });
    await svc.markRemote({ taskId: 'rt-in', delivered: true });
    await svc.markRemote({ taskId: 'rt-in', delivered: true });
    expect(log.readAllRecords().filter((r) => r.domain === 'a2a')).toHaveLength(3);
    expect(svc.getTask('rt-in')?.metadata.remote).toMatchObject({ delivered: true });
    expect(svc.getTask('rt-in')?.metadata.remote).not.toHaveProperty('held');
  });

  it('refuses a mark on an outbound or non-remote task', async () => {
    const svc = newService(newLog());
    await outbound(svc);
    expect((await svc.markRemote({ taskId: 'rt-out', delivered: true })).ok).toBe(false);
    expect((await svc.markRemote({ taskId: 'nope', delivered: true })).ok).toBe(false);
  });

  it('an ended inbound task is no longer owed a delivery, only the notice of the peer cancel', async () => {
    const svc = newService(newLog());
    await inbound(svc);
    expect((await svc.applyRemoteState({ taskId: 'rt-in', linkId: LINK, messageId: 's1', to: 'canceled' })).ok).toBe(true);
    expect(svc.getTask('rt-in')?.metadata.remote).toMatchObject({ inbox: [{ messageId: 's1', kind: 'state', delivered: false }] });
    expect((await svc.markRemote({ taskId: 'rt-in', messageId: 's1', delivered: true })).ok).toBe(true);
    expect(svc.listRemotePending()).toEqual([]);
  });

  it('owes one delivery per peer reply/state, marked per message, replayed', async () => {
    const log = newLog();
    const svc = newService(log);
    await outbound(svc);
    await svc.appendRemoteMessage({ taskId: 'rt-out', linkId: LINK, actorWorkspaceId: REMOTE_WS, message: msg('r-1', 'hi', 'agent') });
    // Our own reply owes nothing.
    await svc.appendRemoteMessage({ taskId: 'rt-out', linkId: LINK, actorWorkspaceId: 'ws-local', message: msg('r-2', 'back') });
    await svc.applyRemoteState({ taskId: 'rt-out', linkId: LINK, messageId: 's-1', to: 'working' });
    const inbox = () => (svc.getTask('rt-out')?.metadata.remote as { inbox?: unknown[] }).inbox;
    expect(inbox()).toEqual([
      { messageId: 'r-1', kind: 'reply', delivered: false },
      { messageId: 's-1', kind: 'state', state: 'working', delivered: false },
    ]);
    expect(svc.listRemotePending().map((t) => t.id)).toEqual(['rt-out']);

    await svc.markRemote({ taskId: 'rt-out', messageId: 'r-1', held: 'occupant-changed' });
    await svc.markRemote({ taskId: 'rt-out', messageId: 's-1', delivered: true });
    expect(svc.listRemotePending()).toEqual([]);
    expect(svc.listRemoteHeld().map((t) => t.id)).toEqual(['rt-out']);
    expect((await svc.markRemote({ taskId: 'rt-out', messageId: 'nope', delivered: true })).ok).toBe(false);

    const restored = newService(log);
    restored.restoreFromLog();
    expect((restored.getTask('rt-out')?.metadata.remote as { inbox?: unknown[] }).inbox).toEqual([
      { messageId: 'r-1', kind: 'reply', delivered: false, held: 'occupant-changed', heldAt: expect.any(String) },
      { messageId: 's-1', kind: 'state', state: 'working', delivered: true },
    ]);
    // Delivering it later (a person retried) records the new occupant on our side.
    await restored.markRemote({ taskId: 'rt-out', messageId: 'r-1', delivered: true, ptyId: 'pty-new' });
    expect(restored.getTask('rt-out')?.metadata.from.ptyId).toBe('pty-new');
    expect(restored.listRemoteHeld()).toEqual([]);
  });

  it('forceFailRemote ends an open task from any state, once', async () => {
    const log = newLog();
    const svc = newService(log);
    await inbound(svc);
    const r = await svc.forceFailRemote({ taskId: 'rt-in', reason: 'link_revoked', forced: 'remote_link_ended' });
    expect(r).toMatchObject({ ok: true, failed: true });
    expect(svc.getTask('rt-in')?.status).toMatchObject({ state: 'failed', evidence: { summary: 'link_revoked', items: [] } });
    expect(await svc.forceFailRemote({ taskId: 'rt-in', reason: 'x', forced: 'remote_link_ended' })).toMatchObject({ ok: true, failed: false });
    expect(svc.listRemoteByLink(LINK)).toEqual([]);
    expect(log.readAllRecords().filter((x) => x.domain === 'a2a').at(-1)?.payload).toMatchObject({ forced: 'remote_link_ended' });
  });

  it('forceFailRemote leaves a report the peer made as it is, for every reason, also after a replay', async () => {
    const log = newLog();
    const svc = newService(log);
    await companyOutbound(svc);
    await svc.applyRemoteState({ taskId: 'rt-co', linkId: LINK, messageId: 's1', to: 'completed', summary: 'merged' });
    const before = log.readAllRecords().length;
    for (const forced of ['remote_link_ended', 'remote_refused', 'remote_held_rejected'] as const) {
      // eslint-disable-next-line no-await-in-loop -- sequential by design
      expect(await svc.forceFailRemote({ taskId: 'rt-co', reason: 'x', forced })).toMatchObject({ ok: true, failed: false });
    }
    expect(log.readAllRecords()).toHaveLength(before);
    expect(svc.getTask('rt-co')!.status.state).toBe('input-required');

    const restored = newService(log);
    restored.restoreFromLog();
    expect(await restored.forceFailRemote({ taskId: 'rt-co', reason: 'x', forced: 'remote_link_ended' })).toMatchObject({ ok: true, failed: false });
    // Once the peer works on it again, the report no longer stands.
    await restored.applyRemoteState({ taskId: 'rt-co', linkId: LINK, messageId: 's2', to: 'working' });
    expect(await restored.forceFailRemote({ taskId: 'rt-co', reason: 'x', forced: 'remote_link_ended' })).toMatchObject({ ok: true, failed: true });
  });
});

describe('A2aTaskService — remote messages and states', () => {
  it('appends a reply durably; same messageId is a duplicate, different text a conflict', async () => {
    const log = newLog();
    const svc = newService(log);
    await outbound(svc);
    const reply = msg('r-1', 'here you go', 'agent');
    expect(await svc.appendRemoteMessage({ taskId: 'rt-out', linkId: LINK, actorWorkspaceId: REMOTE_WS, message: reply }))
      .toMatchObject({ ok: true, duplicate: false });
    expect(await svc.appendRemoteMessage({ taskId: 'rt-out', linkId: LINK, actorWorkspaceId: REMOTE_WS, message: reply }))
      .toMatchObject({ ok: true, duplicate: true });
    expect(await svc.appendRemoteMessage({ taskId: 'rt-out', linkId: LINK, actorWorkspaceId: REMOTE_WS, message: msg('r-1', 'other') }))
      .toMatchObject({ ok: false, conflict: true });
    expect(await svc.appendRemoteMessage({ taskId: 'rt-out', linkId: 'other-link', actorWorkspaceId: REMOTE_WS, message: msg('r-2', 'x') }))
      .toMatchObject({ ok: false });

    const restored = newService(log);
    restored.restoreFromLog();
    expect(restored.getTask('rt-out')?.history.map((h) => h.messageId)).toEqual(['m-0', 'r-1']);
  });

  it('the peer as receiver moves an outbound task; completion is recorded summary-only', async () => {
    const log = newLog();
    const svc = newService(log);
    await outbound(svc);
    expect(await svc.applyRemoteState({ taskId: 'rt-out', linkId: LINK, messageId: 's1', to: 'working' }))
      .toMatchObject({ ok: true, duplicate: false });
    const done = await svc.applyRemoteState({ taskId: 'rt-out', linkId: LINK, messageId: 's2', to: 'completed', summary: 'merged' });
    expect(done.ok).toBe(true);
    const task = svc.getTask('rt-out')!;
    expect(task.status.state).toBe('completed');
    expect(task.status.evidence).toEqual({ summary: 'merged', items: [] });
    const last = log.readAllRecords().filter((r) => r.domain === 'a2a').at(-1)!;
    expect(last.payload).toMatchObject({ forced: 'remote_state', remoteMessageId: 's2' });
    expect(last.authContext?.verifiedWorkspaceId).toBe(REMOTE_WS);

    // Replay keeps the state and the dedupe: the same message is a duplicate,
    // the same id asking for another state is a conflict.
    const restored = newService(log);
    restored.restoreFromLog();
    expect(restored.getTask('rt-out')?.status.state).toBe('completed');
    expect(await restored.applyRemoteState({ taskId: 'rt-out', linkId: LINK, messageId: 's2', to: 'completed' }))
      .toMatchObject({ ok: true, duplicate: true });
    expect(await restored.applyRemoteState({ taskId: 'rt-out', linkId: LINK, messageId: 's2', to: 'failed' }))
      .toMatchObject({ ok: false, conflict: true });
  });

  it('a peer completion with its message and evidence is kept on our copy, graded like a local one', async () => {
    const log = newLog();
    const svc = newService(log);
    await outbound(svc);
    await svc.applyRemoteState({ taskId: 'rt-out', linkId: LINK, messageId: 's1', to: 'working' });
    const evidence = {
      summary: 'merged',
      items: [
        { kind: 'command' as const, status: 'passed' as const, command: 'npm test', summary: 'tests pass' },
        { kind: 'inspection' as const, status: 'unverified' as const, summary: 'read the diff' },
      ],
    };
    const done = await svc.applyRemoteState({
      taskId: 'rt-out', linkId: LINK, messageId: 's2', to: 'completed', summary: 'merged', message: 'Full report.', evidence,
    });
    expect(done.ok).toBe(true);
    const task = svc.getTask('rt-out')!;
    expect(task.status.evidence).toEqual(evidence);
    expect(task.status.message?.parts).toEqual([{ kind: 'text', text: 'Full report.' }]);
    const last = log.readAllRecords().filter((r) => r.domain === 'a2a').at(-1)!;
    expect(last.payload).toMatchObject({ forced: 'remote_state', verifiedItemCount: 1 });
    expect(task.metadata.remote).toMatchObject({ inbox: [{ messageId: 's1', state: 'working' }, { messageId: 's2', state: 'completed' }] });

    // Replay rebuilds the same copy.
    const restored = newService(log);
    restored.restoreFromLog();
    expect(restored.getTask('rt-out')?.status.evidence).toEqual(evidence);
    expect(restored.getTask('rt-out')?.status.message?.parts).toEqual([{ kind: 'text', text: 'Full report.' }]);
  });

  it('peer evidence that fails the local completion gate leaves the summary alone', async () => {
    const svc = newService(newLog());
    await outbound(svc);
    await svc.applyRemoteState({ taskId: 'rt-out', linkId: LINK, messageId: 's1', to: 'working' });
    // A command item needs a command: the gate refuses it, so the item is not stored.
    const badItem = { kind: 'command' as const, status: 'passed' as const, command: ' ', summary: 'claimed' };
    await svc.applyRemoteState({ taskId: 'rt-out', linkId: LINK, messageId: 's2', to: 'completed', summary: 'merged', evidence: { summary: 'merged', items: [badItem] } });
    expect(svc.getTask('rt-out')?.status.evidence).toEqual({ summary: 'merged', items: [] });
    expect(svc.getTask('rt-out')?.status.state).toBe('completed');
  });

  it('the peer as sender cannot move an inbound task, but can cancel it', async () => {
    const svc = newService(newLog());
    await inbound(svc);
    expect((await svc.applyRemoteState({ taskId: 'rt-in', linkId: LINK, messageId: 's1', to: 'working' })).ok).toBe(false);
    expect(svc.getTask('rt-in')?.status.state).toBe('submitted');
    expect((await svc.applyRemoteState({ taskId: 'rt-in', linkId: LINK, messageId: 's2', to: 'canceled' })).ok).toBe(true);
    expect(svc.getTask('rt-in')?.status.state).toBe('canceled');
  });

  it('a peer receiver failure is taken from submitted', async () => {
    const svc = newService(newLog());
    await outbound(svc);
    expect((await svc.applyRemoteState({ taskId: 'rt-out', linkId: LINK, messageId: 's1', to: 'failed', summary: 'rejected' })).ok).toBe(true);
    expect(svc.getTask('rt-out')?.status.state).toBe('failed');
    expect((await svc.applyRemoteState({ taskId: 'rt-out', linkId: LINK, messageId: 's2', to: 'failed' })).ok).toBe(false);
  });

  it('refuses an invalid transition and a task on another link', async () => {
    const svc = newService(newLog());
    await outbound(svc);
    expect((await svc.applyRemoteState({ taskId: 'rt-out', linkId: LINK, messageId: 's1', to: 'submitted' })).ok).toBe(false);
    expect((await svc.applyRemoteState({ taskId: 'rt-out', linkId: 'x', messageId: 's2', to: 'working' })).ok).toBe(false);
  });

  it('the regular transition API still refuses a summary-only completion', async () => {
    const svc = newService(newLog());
    await inbound(svc);
    await svc.transition({ taskId: 'rt-in', to: 'working', callerWorkspaceId: 'ws-local' });
    const r = await svc.transition({ taskId: 'rt-in', to: 'completed', callerWorkspaceId: 'ws-local', evidence: { summary: 's', items: [] } });
    expect(r.ok).toBe(false);
  });
});

describe('A2aTaskService — a company task\'s remote completion is held as a report', () => {
  it('a peer completed commits input-required with its message, evidence and grade; the report stays in history and on the marker', async () => {
    const log = newLog();
    const svc = newService(log);
    await companyOutbound(svc);
    await svc.applyRemoteState({ taskId: 'rt-co', linkId: LINK, messageId: 's1', to: 'working' });
    const res = await svc.applyRemoteState({
      taskId: 'rt-co', linkId: LINK, messageId: 's2', to: 'completed', summary: 'merged', message: 'PR #12 merged.', evidence: PEER_EVIDENCE,
    });
    expect(res).toMatchObject({ ok: true, duplicate: false });
    const task = svc.getTask('rt-co')!;
    expect(task.status.state).toBe('input-required');
    expect(task.status.evidence).toEqual(PEER_EVIDENCE);
    expect(task.status.message?.parts).toEqual([{ kind: 'text', text: 'PR #12 merged.' }]);
    expect(task.history.at(-1)).toMatchObject({ messageId: 's2', role: 'agent', parts: [{ kind: 'text', text: 'PR #12 merged.' }] });
    expect(remoteOf(svc, 'rt-co')).toMatchObject({ reported: 's2', stateSync: 'input-required' });
    expect(lastPayload(log)).toMatchObject({
      to: 'input-required', remoteAsked: 'completed', remoteMessageId: 's2', forced: 'remote_state', verifiedItemCount: 1,
    });

    // Replay rebuilds the same report.
    const restored = newService(log);
    restored.restoreFromLog();
    const again = restored.getTask('rt-co')!;
    expect(again.status).toMatchObject({ state: 'input-required', evidence: PEER_EVIDENCE });
    expect(again.history.map((h) => h.messageId)).toEqual(['m-0', 's2']);
    expect(remoteOf(restored, 'rt-co')).toMatchObject({ reported: 's2' });
  });

  it('a report\'s inbox item says completed and is flagged, live and on replay; a non-company completion has no flag', async () => {
    const log = newLog();
    const svc = newService(log);
    await companyOutbound(svc);
    await outbound(svc);
    for (const id of ['rt-co', 'rt-out']) {
      // eslint-disable-next-line no-await-in-loop -- sequential by design
      await svc.applyRemoteState({ taskId: id, linkId: LINK, messageId: `${id}-s1`, to: 'working' });
      // eslint-disable-next-line no-await-in-loop -- sequential by design
      await svc.applyRemoteState({ taskId: id, linkId: LINK, messageId: `${id}-s2`, to: 'completed', summary: 'done' });
    }
    const report = { messageId: 'rt-co-s2', kind: 'state', state: 'completed', reported: true, delivered: false };
    const plain = { messageId: 'rt-out-s2', kind: 'state', state: 'completed', delivered: false };
    expect(remoteOf(svc, 'rt-co').inbox?.at(-1)).toEqual(report);
    expect(remoteOf(svc, 'rt-out').inbox?.at(-1)).toEqual(plain);
    const restored = newService(log);
    restored.restoreFromLog();
    expect(remoteOf(restored, 'rt-co').inbox?.at(-1)).toEqual(report);
    expect(remoteOf(restored, 'rt-out').inbox?.at(-1)).toEqual(plain);
  });

  it('a non-company remote task keeps today\'s completion', async () => {
    const log = newLog();
    const svc = newService(log);
    await outbound(svc);
    await svc.applyRemoteState({ taskId: 'rt-out', linkId: LINK, messageId: 's1', to: 'working' });
    await svc.applyRemoteState({ taskId: 'rt-out', linkId: LINK, messageId: 's2', to: 'completed', message: 'Done.', evidence: PEER_EVIDENCE });
    const task = svc.getTask('rt-out')!;
    expect(task.status).toMatchObject({ state: 'completed', evidence: PEER_EVIDENCE });
    expect(task.history.map((h) => h.messageId)).toEqual(['m-0']);
    expect(task.metadata.remote).not.toHaveProperty('reported');
    expect(lastPayload(log)).toMatchObject({ to: 'completed', verifiedItemCount: 1 });
    expect(lastPayload(log)).not.toHaveProperty('remoteAsked');
  });

  it('a redelivered report is a duplicate, live and after a replay; the same id asking another state is a conflict', async () => {
    const log = newLog();
    const svc = newService(log);
    await companyOutbound(svc);
    await svc.applyRemoteState({ taskId: 'rt-co', linkId: LINK, messageId: 's1', to: 'working' });
    await svc.applyRemoteState({ taskId: 'rt-co', linkId: LINK, messageId: 's2', to: 'completed', message: 'Done.' });
    const records = (): number => log.readAllRecords().filter((r) => r.domain === 'a2a').length;
    const before = records();
    expect(await svc.applyRemoteState({ taskId: 'rt-co', linkId: LINK, messageId: 's2', to: 'completed', message: 'Done.' }))
      .toMatchObject({ ok: true, duplicate: true });

    const restored = newService(log);
    restored.restoreFromLog();
    expect(await restored.applyRemoteState({ taskId: 'rt-co', linkId: LINK, messageId: 's2', to: 'completed', message: 'Done.' }))
      .toMatchObject({ ok: true, duplicate: true });
    expect(await restored.applyRemoteState({ taskId: 'rt-co', linkId: LINK, messageId: 's2', to: 'failed' }))
      .toMatchObject({ ok: false, conflict: true });
    expect(records()).toBe(before);
    expect(restored.getTask('rt-co')!.history.filter((h) => h.messageId === 's2')).toHaveLength(1);
    expect(restored.getTask('rt-co')!.status.state).toBe('input-required');
  });

  it('a question then a completed is a same-state report; a second completed under a new id replaces it', async () => {
    const svc = newService(newLog());
    await companyOutbound(svc);
    await svc.applyRemoteState({ taskId: 'rt-co', linkId: LINK, messageId: 's1', to: 'working' });
    await svc.applyRemoteState({ taskId: 'rt-co', linkId: LINK, messageId: 's2', to: 'input-required', message: 'Which branch?' });
    expect(svc.getTask('rt-co')!.status.state).toBe('input-required');
    expect(remoteOf(svc, 'rt-co')).not.toHaveProperty('reported');

    expect(await svc.applyRemoteState({ taskId: 'rt-co', linkId: LINK, messageId: 's3', to: 'completed', message: 'Done on main.', evidence: PEER_EVIDENCE }))
      .toMatchObject({ ok: true, duplicate: false });
    expect(svc.getTask('rt-co')!.status).toMatchObject({ state: 'input-required', evidence: PEER_EVIDENCE });
    expect(remoteOf(svc, 'rt-co').reported).toBe('s3');

    expect(await svc.applyRemoteState({ taskId: 'rt-co', linkId: LINK, messageId: 's4', to: 'completed', message: 'Fixed the nit.' }))
      .toMatchObject({ ok: true, duplicate: false });
    const task = svc.getTask('rt-co')!;
    expect(task.status.state).toBe('input-required');
    expect(task.status.message?.parts).toEqual([{ kind: 'text', text: 'Fixed the nit.' }]);
    expect(task.status.evidence).toEqual({ summary: 'completed on the remote host (evidence stays there)', items: [] });
    expect(remoteOf(svc, 'rt-co').reported).toBe('s4');
    // Both reports stay readable; the question was a status, not a report.
    expect(task.history.map((h) => h.messageId)).toEqual(['m-0', 's3', 's4']);
  });

  it('a later peer state replaces the report; failed still ends the task', async () => {
    const svc = newService(newLog());
    await companyOutbound(svc);
    await svc.applyRemoteState({ taskId: 'rt-co', linkId: LINK, messageId: 's1', to: 'working' });
    await svc.applyRemoteState({ taskId: 'rt-co', linkId: LINK, messageId: 's2', to: 'completed' });
    // B works again: the report no longer stands.
    expect((await svc.applyRemoteState({ taskId: 'rt-co', linkId: LINK, messageId: 's3', to: 'working' })).ok).toBe(true);
    expect(svc.getTask('rt-co')!.status.state).toBe('working');
    expect(remoteOf(svc, 'rt-co')).not.toHaveProperty('reported');

    // B asks a question after a report: input-required on input-required.
    await svc.applyRemoteState({ taskId: 'rt-co', linkId: LINK, messageId: 's4', to: 'completed' });
    expect((await svc.applyRemoteState({ taskId: 'rt-co', linkId: LINK, messageId: 's5', to: 'input-required', message: 'One more thing?' })).ok).toBe(true);
    expect(svc.getTask('rt-co')!.status.message?.parts).toEqual([{ kind: 'text', text: 'One more thing?' }]);
    expect(remoteOf(svc, 'rt-co')).not.toHaveProperty('reported');
    // A question on a question is still refused, as for any remote task.
    expect((await svc.applyRemoteState({ taskId: 'rt-co', linkId: LINK, messageId: 's6', to: 'input-required' })).ok).toBe(false);

    await svc.applyRemoteState({ taskId: 'rt-co', linkId: LINK, messageId: 's7', to: 'completed' });
    expect((await svc.applyRemoteState({ taskId: 'rt-co', linkId: LINK, messageId: 's8', to: 'failed', summary: 'reverted' })).ok).toBe(true);
    expect(svc.getTask('rt-co')!.status.state).toBe('failed');
  });

  it('a peer completed or input-required is taken from submitted for any remote task; an ended task refuses every move', async () => {
    const svc = newService(newLog());
    await outbound(svc, 'rt-a');
    await outbound(svc, 'rt-b');
    await companyOutbound(svc, 'rt-c');
    await companyOutbound(svc, 'rt-d');
    expect((await svc.applyRemoteState({ taskId: 'rt-a', linkId: LINK, messageId: 'a1', to: 'completed', summary: 'done' })).ok).toBe(true);
    expect((await svc.applyRemoteState({ taskId: 'rt-b', linkId: LINK, messageId: 'b1', to: 'input-required' })).ok).toBe(true);
    expect((await svc.applyRemoteState({ taskId: 'rt-c', linkId: LINK, messageId: 'c1', to: 'completed', summary: 'done' })).ok).toBe(true);
    expect((await svc.applyRemoteState({ taskId: 'rt-d', linkId: LINK, messageId: 'd1', to: 'input-required' })).ok).toBe(true);
    expect(svc.getTask('rt-a')!.status.state).toBe('completed');
    expect(svc.getTask('rt-b')!.status.state).toBe('input-required');
    expect(svc.getTask('rt-c')!.status.state).toBe('input-required');
    expect(remoteOf(svc, 'rt-c').reported).toBe('c1');
    expect(svc.getTask('rt-d')!.status.state).toBe('input-required');
    expect(remoteOf(svc, 'rt-d')).not.toHaveProperty('reported');

    for (const to of ['working', 'input-required', 'completed', 'failed'] as const) {
      // eslint-disable-next-line no-await-in-loop -- sequential by design
      expect((await svc.applyRemoteState({ taskId: 'rt-a', linkId: LINK, messageId: `a-${to}`, to })).ok).toBe(false);
    }
    expect(svc.getTask('rt-a')!.status.state).toBe('completed');
  });
});

describe('A2aTaskService — the sending PC marks a remote company task\'s report done', () => {
  const DONE_EVIDENCE = { summary: 'PR checked', items: [{ kind: 'inspection' as const, status: 'unverified' as const, summary: 'PR head read' }] };
  const CEO = { callerWorkspaceId: 'ws-local', callerAddr: { paneId: 'pane-ceo' }, callerCompanySeat: 'coordinator' as const };
  const records = (log: AppendOnlyLog) => log.readAllRecords().filter((r) => r.domain === 'a2a');

  /** A company task the peer reported done (s2), held here as input-required. */
  async function reported(svc: A2aTaskService, id = 'rt-co'): Promise<void> {
    await companyOutbound(svc, id);
    await svc.applyRemoteState({ taskId: id, linkId: LINK, messageId: 's1', to: 'working' });
    await svc.applyRemoteState({ taskId: id, linkId: LINK, messageId: 's2', to: 'completed', summary: 'merged' });
    expect(svc.getTask(id)!.status.state).toBe('input-required');
  }

  it('the sending pane in the coordinator seat marks it done, stamped as that pane; a retry is the cached result', async () => {
    const log = newLog();
    const svc = newService(log);
    await reported(svc);
    // The evidence gate holds as for any completion.
    const bare = await svc.transition({ taskId: 'rt-co', to: 'completed', ...CEO });
    expect(!bare.ok && bare.error).toContain('completion_evidence_missing');

    const done = await svc.transition({ taskId: 'rt-co', to: 'completed', ...CEO, evidence: DONE_EVIDENCE, idempotencyKey: 'k1' });
    expect(done.ok).toBe(true);
    expect(svc.getTask('rt-co')!.status).toMatchObject({ state: 'completed', evidence: DONE_EVIDENCE });
    const last = records(log).at(-1)!;
    expect(last.payload).toMatchObject({ kind: 'task.transition', to: 'completed' });
    expect(last.payload).not.toHaveProperty('remoteMessageId');
    expect(last.authContext?.verifiedWorkspaceId).toBe('ws-local');
    expect(last.authContext?.principalId).toBe(panePrincipalId('ws-local', 'pane-ceo'));

    // The same key returns the first result, live and after a restart, appending nothing.
    const count = records(log).length;
    expect(await svc.transition({ taskId: 'rt-co', to: 'completed', ...CEO, evidence: DONE_EVIDENCE, idempotencyKey: 'k1' })).toMatchObject({ ok: true });
    const restored = newService(log);
    restored.restoreFromLog();
    expect(await restored.transition({ taskId: 'rt-co', to: 'completed', ...CEO, evidence: DONE_EVIDENCE, idempotencyKey: 'k1' }))
      .toMatchObject({ ok: true, task: { status: { state: 'completed' } } });
    // A new done is refused: the task has ended.
    expect((await restored.transition({ taskId: 'rt-co', to: 'completed', ...CEO, evidence: DONE_EVIDENCE, idempotencyKey: 'k2' })).ok).toBe(false);
    expect(records(log)).toHaveLength(count);

    // The peer's report redelivered is still a duplicate; a new completed meets an ended task.
    expect(await restored.applyRemoteState({ taskId: 'rt-co', linkId: LINK, messageId: 's2', to: 'completed', summary: 'merged' }))
      .toMatchObject({ ok: true, duplicate: true });
    expect((await restored.applyRemoteState({ taskId: 'rt-co', linkId: LINK, messageId: 's3', to: 'completed' })).ok).toBe(false);
    expect(restored.getTask('rt-co')!.status.state).toBe('completed');
  });

  it('the trusted lane marks it done for the sending workspace only', async () => {
    const log = newLog();
    const svc = newService(log);
    await reported(svc);
    const elsewhere = await svc.transition({ taskId: 'rt-co', to: 'completed', callerWorkspaceId: 'ws-other', trustedLane: true, evidence: DONE_EVIDENCE });
    expect(!elsewhere.ok && elsewhere.error).toContain('is not the receiver');
    const done = await svc.transition({ taskId: 'rt-co', to: 'completed', callerWorkspaceId: 'ws-local', trustedLane: true, evidence: DONE_EVIDENCE });
    expect(done.ok).toBe(true);
    // As for a local trusted completion: the receiver side's principal, here the sending workspace (no receiver pane on this PC).
    expect(records(log).at(-1)!.authContext?.principalId).toBe('ws-local');
  });

  it('the workspace\'s coordinator now, after the CEO seat moved to another pane, marks it done as its own pane', async () => {
    const log = newLog();
    const svc = newService(log);
    await reported(svc);
    const done = await svc.transition({
      taskId: 'rt-co', to: 'completed', callerWorkspaceId: 'ws-local', callerAddr: { paneId: 'pane-new-ceo' }, callerCompanySeat: 'coordinator', evidence: DONE_EVIDENCE,
    });
    expect(done.ok).toBe(true);
    expect(records(log).at(-1)!.authContext?.principalId).toBe(panePrincipalId('ws-local', 'pane-new-ceo'));
    // The done ends the report, live and after a replay.
    expect((svc.getTask('rt-co')!.metadata.remote as { reported?: string }).reported).toBeUndefined();
    const replayed = newService(log);
    replayed.restoreFromLog();
    expect((replayed.getTask('rt-co')!.metadata.remote as { reported?: string }).reported).toBeUndefined();
  });

  it('refuses a staff seat, another workspace\'s coordinator and a seat with no resolved pane', async () => {
    const svc = newService(newLog());
    await reported(svc);
    const callers = [
      { callerWorkspaceId: 'ws-local', callerAddr: { paneId: 'pane-ceo' }, callerCompanySeat: 'staff' as const },
      { callerWorkspaceId: 'ws-ops', callerAddr: { paneId: 'pane-ceo' }, callerCompanySeat: 'coordinator' as const },
      { callerWorkspaceId: 'ws-local', callerCompanySeat: 'coordinator' as const },
      { callerWorkspaceId: 'ws-local', callerAddr: { paneId: 'pane-ceo' } },
    ];
    for (const caller of callers) {
      // eslint-disable-next-line no-await-in-loop -- sequential by design
      const res = await svc.transition({ taskId: 'rt-co', to: 'completed', ...caller, evidence: DONE_EVIDENCE });
      expect(!res.ok && res.error).toContain('is not the receiver');
    }
    expect(svc.getTask('rt-co')!.status.state).toBe('input-required');
  });

  it('refuses the done on anything but a report, and any other state on a report', async () => {
    const svc = newService(newLog());
    // Still working on the peer.
    await companyOutbound(svc, 'rt-w');
    await svc.applyRemoteState({ taskId: 'rt-w', linkId: LINK, messageId: 'w1', to: 'working' });
    // A real question from the peer, not a report.
    await companyOutbound(svc, 'rt-q');
    await svc.applyRemoteState({ taskId: 'rt-q', linkId: LINK, messageId: 'q1', to: 'working' });
    await svc.applyRemoteState({ taskId: 'rt-q', linkId: LINK, messageId: 'q2', to: 'input-required', message: 'Which branch?' });
    for (const id of ['rt-w', 'rt-q']) {
      // eslint-disable-next-line no-await-in-loop -- sequential by design
      const res = await svc.transition({ taskId: id, to: 'completed', ...CEO, evidence: DONE_EVIDENCE });
      expect(!res.ok && res.error).toContain('only on its report');
    }
    expect(svc.getTask('rt-w')!.status.state).toBe('working');
    expect(svc.getTask('rt-q')!.status.state).toBe('input-required');

    // On a report, the sending pane moves nothing but the done.
    await reported(svc);
    for (const to of ['working', 'input-required', 'failed'] as const) {
      // eslint-disable-next-line no-await-in-loop -- sequential by design
      const res = await svc.transition({ taskId: 'rt-co', to, ...CEO, evidence: { summary: 'x', items: [] } });
      expect(!res.ok && res.error).toContain('only on its report');
    }
    expect(svc.getTask('rt-co')!.status.state).toBe('input-required');

    // A remote task outside a company keeps the receiver-only rule.
    await outbound(svc, 'rt-plain');
    await svc.applyRemoteState({ taskId: 'rt-plain', linkId: LINK, messageId: 'p1', to: 'working' });
    await svc.applyRemoteState({ taskId: 'rt-plain', linkId: LINK, messageId: 'p2', to: 'input-required' });
    const plain = await svc.transition({
      taskId: 'rt-plain', to: 'completed', callerWorkspaceId: 'ws-local', callerAddr: { paneId: 'pane-l' }, callerCompanySeat: 'coordinator', evidence: DONE_EVIDENCE,
    });
    expect(!plain.ok && plain.error).toContain('is not the receiver');
  });
});

describe('peer state ids are bounded', () => {
  it('cancels repeated on an ended task under new ids are not kept', async () => {
    const svc = newService(newLog());
    await outbound(svc);
    await svc.cancelTask({ taskId: 'rt-out', callerWorkspaceId: 'ws-local' });
    for (let i = 0; i < 200; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential by design
      expect(await svc.applyRemoteState({ taskId: 'rt-out', linkId: LINK, messageId: `c-${i}`, to: 'canceled' })).toMatchObject({ ok: true });
    }
    expect((svc as unknown as { remoteStates: Map<string, Map<string, string>> }).remoteStates.get('rt-out')?.size ?? 0).toBe(0);
  });

  it('the per-task dedupe window is capped', async () => {
    const svc = newService(newLog());
    await inbound(svc, 'rt-cap');
    const states = (svc as unknown as { remoteStates: Map<string, Map<string, string>> }).remoteStates;
    // Fill the window directly through the recorder (each real transition needs a new state).
    const record = (svc as unknown as { recordRemoteState(t: string, m: string, s: string): void }).recordRemoteState.bind(svc);
    for (let i = 0; i < 500; i++) record('rt-cap', `m-${i}`, 'working');
    expect(states.get('rt-cap')!.size).toBe(REMOTE_STATE_IDS_MAX);
    expect(states.get('rt-cap')!.has('m-499')).toBe(true);
  });
});

describe('statusMessageFromWire (a2a.task.update)', () => {
  it('turns the wire string into the status message, checked like main checks it', () => {
    expect(statusMessageFromWire(undefined, () => 'id')).toBeUndefined();
    expect(statusMessageFromWire('  Done.  ', () => 'm-1')).toEqual({ kind: 'message', messageId: 'm-1', role: 'agent', parts: [{ kind: 'text', text: 'Done.' }] });
    expect(() => statusMessageFromWire('   ', () => 'x')).toThrow();
    expect(() => statusMessageFromWire('x'.repeat(10_001), () => 'x')).toThrow();
    expect(() => statusMessageFromWire({ text: 'x' }, () => 'x')).toThrow();
  });

  it('the daemon\'s a2a.task.update hands the parsed message to the transition', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../index.ts'), 'utf8');
    const handler = src.slice(src.indexOf("pipeServer.onRpc('a2a.task.update'"), src.indexOf("pipeServer.onRpc('a2a.task.cancel'"));
    expect(handler).toMatch(/statusMessageFromWire\(p\.message, randomUUID\)/);
    expect(handler).toMatch(/\.\.\.\(message \? \{ message \} : \{\}\)/);
  });
});
