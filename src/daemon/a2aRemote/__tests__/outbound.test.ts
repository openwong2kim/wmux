import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { A2A_REMOTE_STATE_ENVELOPE_MAX, A2A_REMOTE_STATE_EVIDENCE_MAX } from '../../../shared/a2aRemote';
import { COMPANY_BRIEF_KIND, isCompanyTask, type CompanyBriefV1 } from '../../../shared/company';
import type { Task } from '../../../shared/types';
import { A2aTaskService } from '../../a2a/A2aTaskService';
import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { remoteTaskId } from '../ids';
import { LinkStore } from '../linkStore';
import { OutboxStore } from '../outboxStore';
import { aliasTable, linkAlias, listRemoteTargets, sendRemoteReply, sendRemoteState, sendRemoteTask, stateMessageId, syncRemoteTask, type OutboundDeps, type StateDeps } from '../outbound';

const HOST = '11111111-1111-4111-8111-111111111111';

let dir: string;
let links: LinkStore;
let log: AppendOnlyLog;
let tasks: A2aTaskService;
let outbox: OutboxStore;
let deps: OutboundDeps;
let n = 0;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-outbound-'));
  links = new LinkStore({ dir, scheduleHarden: () => undefined });
  outbox = new OutboxStore({ dir, scheduleHarden: () => undefined });
  log = new AppendOnlyLog({ dir: path.join(dir, 'log'), fsync: () => undefined });
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

  it('keeps a company brief as data on this PC\'s copy only; the envelope carries the same text and nothing else', async () => {
    const linkId = activeLink();
    const brief: CompanyBriefV1 = { kind: COMPANY_BRIEF_KIND, v: 1, goal: 'g', scope: 's', acceptance: 'a', verify: 'v', report: 'r' };
    const res = await sendRemoteTask(deps, { linkId, from: FROM, title: 'T', text: 'Take it.\n\nGoal:\ng', brief });
    const t = tasks.getTask(remoteTaskId(linkId, 'msg-1'))!;
    expect(res.ok).toBe(true);
    expect(t.history).toHaveLength(1);
    expect(t.history[0].parts).toEqual([
      { kind: 'text', text: 'Take it.\n\nGoal:\ng' },
      { kind: 'data', data: brief, metadata: { mimeType: 'application/json' } },
    ]);
    expect(isCompanyTask(t.history)).toBe(true);
    const [rec] = outbox.pending(HOST);
    expect(rec.envelope).toMatchObject({ kind: 'task', text: 'Take it.\n\nGoal:\ng' });
    expect(JSON.stringify(rec.envelope)).not.toContain(COMPANY_BRIEF_KIND);
    expect(Object.keys(rec.envelope).sort()).toEqual(['kind', 'linkId', 'linkVersion', 'messageId', 'protocol', 'sentAt', 'text']);
  });

  it('a task without a brief keeps a text-only first message', async () => {
    const linkId = activeLink();
    await sendRemoteTask(deps, { linkId, from: FROM, title: '', text: 'run the tests' });
    const t = tasks.getTask(remoteTaskId(linkId, 'msg-1'))!;
    expect(t.history[0].parts).toEqual([{ kind: 'text', text: 'run the tests' }]);
    expect(isCompanyTask(t.history)).toBe(false);
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

  // We are the receiver of a task the peer sent: our completion goes back with its report.
  async function completedInbound(evidence: Parameters<A2aTaskService['transition']>[0]['evidence'], text = 'The full report.'): Promise<string> {
    const linkId = activeLink();
    const id = remoteTaskId(linkId, 'peer-msg');
    await tasks.createTask({
      id,
      title: 't',
      from: { workspaceId: `remote:${linkId}`, name: 'pc-b/ws/pane' },
      to: { workspaceId: 'ws-a', name: 'Frontend', paneId: 'pane-a' },
      history: [{ kind: 'message', messageId: 'peer-msg', role: 'user', parts: [{ kind: 'text', text: 'review it' }] }],
      remote: { v: 1, linkId, hostId: HOST, messageId: 'peer-msg', direction: 'inbound', delivered: true },
    });
    expect((await tasks.transition({ taskId: id, to: 'working', callerWorkspaceId: 'ws-a' })).ok).toBe(true);
    const done = await tasks.transition({
      taskId: id, to: 'completed', callerWorkspaceId: 'ws-a', evidence,
      message: { kind: 'message', messageId: 'status-1', role: 'agent', parts: [{ kind: 'text', text }] },
    });
    expect(done.ok).toBe(true);
    await syncRemoteTask(deps, id);
    return id;
  }

  it('a completion carries its status message and evidence; `text` stays the summary for an older peer', async () => {
    const evidence = { summary: 'reviewed', items: [{ kind: 'inspection' as const, status: 'verified' as const, summary: 'no P1' }] };
    const id = await completedInbound(evidence);
    const state = outbox.pending(HOST).filter((r) => r.envelope.kind === 'state' && r.envelope.taskId === id).at(-1)!;
    expect(state.envelope).toMatchObject({ state: 'completed', text: 'reviewed', message: 'The full report.', evidence });
  });

  it('evidence too large for one envelope is sent with the items that fit', async () => {
    const item = (n: number) => ({ kind: 'inspection' as const, status: 'verified' as const, summary: `${n} ${'x'.repeat(3000)}` });
    const evidence = { summary: 'big', items: Array.from({ length: 16 }, (_, n) => item(n)) };
    const id = await completedInbound(evidence);
    const sent = outbox.pending(HOST).filter((r) => r.envelope.kind === 'state' && r.envelope.taskId === id).at(-1)!.envelope.evidence!;
    expect(Buffer.byteLength(JSON.stringify(sent), 'utf8')).toBeLessThanOrEqual(A2A_REMOTE_STATE_EVIDENCE_MAX);
    expect(sent.items.length).toBeGreaterThan(0);
    expect(sent.items.length).toBeLessThan(16);
    expect(sent.items).toEqual(evidence.items.slice(0, sent.items.length));
  });

  it('control characters, which JSON escapes to six bytes each, cannot push the envelope past the body limit', async () => {
    // Within the local cap (64 KiB of JSON), but about 60 KiB once escaped as \\u00XX.
    const item = (n: number) => ({ kind: 'inspection' as const, status: 'verified' as const, summary: `${n} ${'\u0001'.repeat(1000)}` });
    const evidence = { summary: 'big', items: Array.from({ length: 10 }, (_, n) => item(n)) };
    const id = await completedInbound(evidence, `start ${'\u001b'.repeat(10_000)} end`);
    const sent = outbox.pending(HOST).filter((r) => r.envelope.kind === 'state' && r.envelope.taskId === id).at(-1)!.envelope;
    expect(Buffer.byteLength(JSON.stringify(sent), 'utf8')).toBeLessThanOrEqual(A2A_REMOTE_STATE_ENVELOPE_MAX);
    expect(sent).toMatchObject({ state: 'completed', text: 'big' });
    // The outgoing message is peer text already: no escape sequences.
    expect(sent.message?.includes('\u001b')).toBe(false);
    expect(sent.evidence!.items.length).toBeLessThan(10);
  });

  it('a task this PC sent tells the peer no state but a cancel, also after a restart', async () => {
    const states = (taskId: string) => outbox.pending(HOST).filter((r) => r.envelope.kind === 'state' && r.envelope.taskId === taskId);
    // Failed here (the other PC refused it): only the receiver moves a task there.
    const { id: refused } = await outboundTask();
    expect(await tasks.forceFailRemote({ taskId: refused, reason: 'refused', forced: 'remote_refused' })).toMatchObject({ ok: true, failed: true });
    expect(await syncRemoteTask(deps, refused)).toEqual({ ok: true, queued: 0 });
    // A restart replays the ledger; the sync still owes the peer nothing.
    const restarted = new A2aTaskService({ log, origin: { machineId: 'm', daemonEpoch: 2 } });
    restarted.restoreFromLog();
    expect(await syncRemoteTask({ ...deps, taskService: restarted }, refused)).toEqual({ ok: true, queued: 0 });
    expect(states(refused)).toEqual([]);

    // Completed here while the peer was last told another state: nothing goes, nothing is recorded as told.
    const linkId = activeLink({ outbound: true, inbound: true }, 'codex', 'pane-c');
    const task: Task = {
      kind: 'task',
      id: remoteTaskId(linkId, 'sent-1'),
      status: { state: 'completed', timestamp: '2026-11-01T00:00:00.000Z' },
      history: [{ kind: 'message', messageId: 'sent-1', role: 'user', parts: [{ kind: 'text', text: 'ship it' }] }],
      artifacts: [],
      metadata: {
        title: 't',
        from: FROM,
        to: { workspaceId: `remote:${linkId}`, name: 'pc-b/ws-b/codex' },
        createdAt: '2026-11-01T00:00:00.000Z',
        updatedAt: '2026-11-01T00:00:00.000Z',
        remote: { v: 1, linkId, hostId: HOST, messageId: 'sent-1', direction: 'outbound', kind: 'pane', stateSync: 'input-required' },
      },
    };
    const marks: unknown[] = [];
    const fake: StateDeps = {
      linkStore: links,
      outbox,
      taskService: {
        getTask: () => task,
        markRemote: async (input) => {
          marks.push(input);
          return { ok: true as const, task };
        },
      },
    };
    expect(await syncRemoteTask(fake, task.id)).toEqual({ ok: true, queued: 0 });
    expect(marks).toEqual([]);
    expect(states(task.id)).toEqual([]);
    // Canceled here: the cancel goes.
    task.status = { state: 'canceled', timestamp: '2026-11-01T00:00:01.000Z' };
    expect(await syncRemoteTask(fake, task.id)).toEqual({ ok: true, queued: 1 });
    expect(states(task.id).map((r) => r.envelope.state)).toEqual(['canceled']);
    expect(marks).toEqual([{ taskId: task.id, stateSync: 'canceled' }]);
  });

  it('nothing is queued on a revoked link', async () => {
    const { linkId, id } = await outboundTask();
    links.revoke(linkId, 'local');
    expect(await sendRemoteReply(deps, { taskId: id, workspaceId: 'ws-a', text: 'x' })).toEqual({ ok: false, error: 'link-not-active' });
    expect(outbox.pending(HOST)).toHaveLength(1);
  });
});
