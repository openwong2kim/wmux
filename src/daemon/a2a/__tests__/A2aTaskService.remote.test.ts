import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { A2aTaskService, REMOTE_STATE_IDS_MAX } from '../A2aTaskService';
import type { A2aRemoteTaskMarkerV1 } from '../../../shared/a2aRemote';
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
      { messageId: 's-1', kind: 'state', delivered: false },
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
      { messageId: 's-1', kind: 'state', delivered: true },
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
    expect((await svc.applyRemoteState({ taskId: 'rt-out', linkId: LINK, messageId: 's1', to: 'completed' })).ok).toBe(false);
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

