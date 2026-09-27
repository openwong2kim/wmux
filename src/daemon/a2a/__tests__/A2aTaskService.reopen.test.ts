import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { A2aTaskService } from '../A2aTaskService';

let dir: string;
const syncOk = (): void => undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-a2a-reopen-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function newLog(): AppendOnlyLog {
  const log = new AppendOnlyLog({ dir, fsync: syncOk });
  log.open();
  return log;
}

function newService(log: AppendOnlyLog): A2aTaskService {
  return new A2aTaskService({ log, origin: { machineId: 'm1', daemonEpoch: 1 } });
}

const EVIDENCE = { summary: 'done', items: [{ kind: 'command', status: 'passed', summary: 'ok', command: 'true' }] };

async function completedTask(svc: A2aTaskService, id = 'task-1'): Promise<string> {
  await svc.createTask({
    id,
    title: 'T',
    from: { workspaceId: 'ws-sender', name: 'Sender' },
    to: { workspaceId: 'ws-receiver', name: 'Receiver', paneId: 'pane-r' },
  });
  expect((await svc.transition({ taskId: id, to: 'working', callerWorkspaceId: 'ws-receiver' })).ok).toBe(true);
  expect((await svc.transition({ taskId: id, to: 'completed', callerWorkspaceId: 'ws-receiver', evidence: EVIDENCE })).ok).toBe(true);
  return id;
}

describe('A2aTaskService — pane-resolved caller', () => {
  it('commits a pinned-pane update when the caller pane is resolved', async () => {
    const svc = newService(newLog());
    await svc.createTask({
      id: 'task-p',
      title: 'T',
      from: { workspaceId: 'ws-sender', name: 'Sender' },
      to: { workspaceId: 'ws-receiver', name: 'Receiver', paneId: 'pane-r' },
    });
    const r = await svc.transition({
      taskId: 'task-p',
      to: 'working',
      callerWorkspaceId: 'ws-receiver',
      callerHasPaneIdentity: true,
      callerAddr: { paneId: 'pane-r' },
    });
    expect(r.ok).toBe(true);
    expect(svc.getTask('task-p')?.status.state).toBe('working');
  });
});

describe('A2aTaskService.reopenTask', () => {
  it('sends a completed task back to submitted, durably', async () => {
    const log = newLog();
    const svc = newService(log);
    const id = await completedTask(svc);

    const r = await svc.reopenTask({ taskId: id, callerWorkspaceId: 'ws-sender' });

    expect(r).toMatchObject({ ok: true, reopened: true });
    expect(svc.getTask(id)?.status.state).toBe('submitted');
    expect(svc.queryTasks('ws-receiver', { role: 'agent', status: 'submitted' }).map((t) => t.id)).toEqual([id]);
    // Survives a daemon restart: the log replays to submitted.
    const restored = newService(log);
    restored.restoreFromLog();
    expect(restored.getTask(id)?.status.state).toBe('submitted');
    // And the receiver can work it again through the normal graph.
    expect((await restored.transition({ taskId: id, to: 'working', callerWorkspaceId: 'ws-receiver' })).ok).toBe(true);
  });

  it('leaves a task that has not ended alone', async () => {
    const svc = newService(newLog());
    await svc.createTask({
      id: 'task-w',
      title: 'T',
      from: { workspaceId: 'ws-sender', name: 'Sender' },
      to: { workspaceId: 'ws-receiver', name: 'Receiver' },
    });
    await svc.transition({ taskId: 'task-w', to: 'working', callerWorkspaceId: 'ws-receiver' });

    const r = await svc.reopenTask({ taskId: 'task-w', callerWorkspaceId: 'ws-sender' });

    expect(r).toMatchObject({ ok: true, reopened: false });
    expect(svc.getTask('task-w')?.status.state).toBe('working');
  });

  it('only the sender may reopen', async () => {
    const svc = newService(newLog());
    const id = await completedTask(svc);

    const r = await svc.reopenTask({ taskId: id, callerWorkspaceId: 'ws-receiver' });

    expect(r.ok).toBe(false);
    expect(svc.getTask(id)?.status.state).toBe('completed');
  });

  it('the regular transition API still refuses completed -> submitted', async () => {
    const svc = newService(newLog());
    const id = await completedTask(svc);
    const r = await svc.transition({ taskId: id, to: 'submitted', callerWorkspaceId: 'ws-receiver' });
    expect(r.ok).toBe(false);
  });
});
