// @vitest-environment jsdom
//
// A sender that writes to a task the receiver already completed is asking for
// more work. The message used to land in history while the task stayed
// `completed`, so a receiver scanning its inbox for `submitted` work never saw
// it. These tests drive the real handlers and check the reopen on both sides.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneLeaf, Surface, Task, Workspace } from '../../../shared/types';
import { useStore } from '../../stores';
import { handleRpcMethod } from '../useRpcBridge';

function leaf(id: string, ptyId: string): PaneLeaf {
  const surface = { id: `surf-${id}`, ptyId, title: id, shell: '', cwd: '', surfaceType: 'terminal' } as Surface;
  return { id, type: 'leaf', surfaces: [surface], activeSurfaceId: surface.id };
}

function workspace(id: string, name: string, ptyId: string): Workspace {
  return { id, name, rootPane: leaf(`pane-${id}`, ptyId), activePaneId: `pane-${id}` } as Workspace;
}

const SENDER = workspace('ws-reopen-sender', 'Sender', 'pty-reopen-sender');
const RECEIVER = workspace('ws-reopen-receiver', 'Receiver', 'pty-reopen-receiver');
const EVIDENCE = { summary: 'done', items: [{ kind: 'command', status: 'passed', summary: 'ok', command: 'true' }] };

type Result = { ok?: boolean; error?: string; reopenedTask?: Task };

async function rpc(method: string, params: Record<string, unknown>): Promise<Result> {
  return (await handleRpcMethod(method, params)) as Result;
}

async function newTask(): Promise<string> {
  const res = (await handleRpcMethod('a2a.task.send', {
    workspaceId: SENDER.id,
    to: RECEIVER.id,
    message: 'first ask',
    silent: true,
  })) as { taskId: string };
  return res.taskId;
}

async function receiverMoves(taskId: string, status: string): Promise<void> {
  const res = await rpc('a2a.task.update', {
    workspaceId: RECEIVER.id,
    taskId,
    status,
    ...(status === 'completed' ? { evidence: EVIDENCE } : {}),
  });
  expect(res.ok).toBe(true);
}

function state(taskId: string): string | undefined {
  return useStore.getState().getTask(taskId)?.status.state;
}

function receiverInbox(status: string): string[] {
  return useStore.getState().queryTasks(RECEIVER.id, { role: 'agent', status: status as Task['status']['state'] }).map((t) => t.id);
}

beforeEach(() => {
  vi.useRealTimers();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    pty: { write: vi.fn() },
    rpc: { gatedSubmit: async () => ({ ok: true }) },
  };
  useStore.setState({ workspaces: [SENDER, RECEIVER], paneGate: 'ready', a2aTasks: {} });
});

describe('a sender message reopens an ended task', () => {
  it('reply to a completed task: back to submitted, in the receiver inbox, snapshot returned', async () => {
    const taskId = await newTask();
    await receiverMoves(taskId, 'working');
    await receiverMoves(taskId, 'completed');
    const before = useStore.getState().getTask(taskId)!.metadata.updatedAt;
    await new Promise((r) => setTimeout(r, 2));

    const res = await rpc('a2a.task.send', { workspaceId: SENDER.id, taskId, message: 'one more thing', silent: true });

    expect(res.ok).toBe(true);
    expect(state(taskId)).toBe('submitted');
    expect(useStore.getState().getTask(taskId)!.metadata.updatedAt > before).toBe(true);
    expect(receiverInbox('submitted')).toContain(taskId);
    expect(res.reopenedTask?.status.state).toBe('submitted');
    const history = useStore.getState().getTask(taskId)!.history;
    expect(history[history.length - 1].parts[0]).toMatchObject({ kind: 'text', text: 'one more thing' });
  });

  it('the receiver can pick the reopened task up again', async () => {
    const taskId = await newTask();
    await receiverMoves(taskId, 'working');
    await receiverMoves(taskId, 'completed');
    await rpc('a2a.task.send', { workspaceId: SENDER.id, taskId, message: 'again', silent: true });

    await receiverMoves(taskId, 'working');
    expect(state(taskId)).toBe('working');
  });

  it('reply to a working task leaves it working', async () => {
    const taskId = await newTask();
    await receiverMoves(taskId, 'working');

    const res = await rpc('a2a.task.send', { workspaceId: SENDER.id, taskId, message: 'fyi', silent: true });

    expect(state(taskId)).toBe('working');
    expect(res.reopenedTask).toBeUndefined();
  });

  it('a receiver message on its own completed task does not reopen it', async () => {
    const taskId = await newTask();
    await receiverMoves(taskId, 'working');
    await receiverMoves(taskId, 'completed');

    const res = await rpc('a2a.task.send', { workspaceId: RECEIVER.id, taskId, message: 'report', silent: true });

    expect(state(taskId)).toBe('completed');
    expect(res.reopenedTask).toBeUndefined();
  });

  it('a message-only update from the sender reopens too', async () => {
    const taskId = await newTask();
    await receiverMoves(taskId, 'working');
    await receiverMoves(taskId, 'completed');

    const res = await rpc('a2a.task.update', { workspaceId: SENDER.id, taskId, message: 'follow-up' });

    expect(res.ok).toBe(true);
    expect(state(taskId)).toBe('submitted');
    expect(res.reopenedTask?.status.state).toBe('submitted');
  });
});
