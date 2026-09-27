// @vitest-environment jsdom
//
// A verified sender that writes to a task the receiver already completed is
// asking for more work, so the task reopens. Anyone else (the receiver, a
// sibling pane, a caller with no verified pane) must never reopen it, and a
// receiver closing a task with a message must leave it closed. These tests
// drive the real renderer handlers the way main does: a preflight call, then
// the real call carrying main's reopen decision.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneBranch, PaneLeaf, Surface, Task, Workspace } from '../../../shared/types';
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
// One workspace, three panes: the sender pane, the receiver pane, a third pane.
const SAME = {
  id: 'ws-same',
  name: 'Same',
  rootPane: {
    id: 'branch-same',
    type: 'branch',
    direction: 'horizontal',
    children: [leaf('pane-from', 'pty-from'), leaf('pane-to', 'pty-to'), leaf('pane-third', 'pty-third')],
  } as PaneBranch,
  activePaneId: 'pane-from',
} as Workspace;
const EVIDENCE = { summary: 'done', items: [{ kind: 'command', status: 'passed', summary: 'ok', command: 'true' }] };

type Result = { ok?: boolean; error?: string; reason?: string; preflight?: { reopen: boolean } };

async function rpc(method: string, params: Record<string, unknown>): Promise<Result> {
  return (await handleRpcMethod(method, params)) as Result;
}

/** What main does for a reply / message-only update: preflight, then the real call. */
async function viaMain(method: string, params: Record<string, unknown>): Promise<Result> {
  const pre = await rpc(method, { ...params, reopenPreflight: true });
  if (!pre.preflight) return pre;
  return rpc(method, { ...params, ...(pre.preflight.reopen ? { localReopen: true } : {}) });
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

function sameWsTask(state: Task['status']['state']): string {
  const id = useStore.getState().createA2aTask({
    id: `task-same-${Math.random().toString(36).slice(2)}`,
    title: 'same',
    from: { workspaceId: SAME.id, name: 'Same', paneId: 'pane-from', surfaceId: 'surf-pane-from' },
    to: { workspaceId: SAME.id, name: 'Same', paneId: 'pane-to', surfaceId: 'surf-pane-to' },
    history: [],
    artifacts: [],
  });
  useStore.setState((s) => {
    s.a2aTasks[id].status = { state, timestamp: '2026-09-27T00:00:00.000Z' };
  });
  return id;
}

async function receiverMoves(taskId: string, status: string, extra: Record<string, unknown> = {}): Promise<void> {
  const res = await rpc('a2a.task.update', {
    workspaceId: RECEIVER.id,
    taskId,
    status,
    ...(status === 'completed' ? { evidence: EVIDENCE } : {}),
    ...extra,
  });
  expect(res.ok).toBe(true);
}

function state(taskId: string): string | undefined {
  return useStore.getState().getTask(taskId)?.status.state;
}

beforeEach(() => {
  vi.useRealTimers();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    pty: { write: vi.fn() },
    rpc: { gatedSubmit: async () => ({ ok: true }) },
  };
  useStore.setState({ workspaces: [SENDER, RECEIVER, SAME], paneGate: 'ready', a2aTasks: {} });
});

describe('a sender message reopens an ended task', () => {
  it('reply to a completed task: back to submitted and in the receiver inbox', async () => {
    const taskId = await newTask();
    await receiverMoves(taskId, 'working');
    await receiverMoves(taskId, 'completed');
    const before = useStore.getState().getTask(taskId)!.metadata.updatedAt;
    await new Promise((r) => setTimeout(r, 2));

    const res = await viaMain('a2a.task.send', { workspaceId: SENDER.id, taskId, message: 'one more thing', silent: true });

    expect(res.ok).toBe(true);
    expect(state(taskId)).toBe('submitted');
    expect(useStore.getState().getTask(taskId)!.metadata.updatedAt > before).toBe(true);
    const inbox = useStore.getState().queryTasks(RECEIVER.id, { role: 'agent', status: 'submitted' });
    expect(inbox.map((t) => t.id)).toContain(taskId);
  });

  it('the preflight mutates nothing', async () => {
    const taskId = await newTask();
    await receiverMoves(taskId, 'working');
    await receiverMoves(taskId, 'completed');
    const historyBefore = useStore.getState().getTask(taskId)!.history.length;

    const pre = await rpc('a2a.task.send', { workspaceId: SENDER.id, taskId, message: 'x', silent: true, reopenPreflight: true });

    expect(pre.preflight).toEqual({ reopen: true });
    expect(state(taskId)).toBe('completed');
    expect(useStore.getState().getTask(taskId)!.history.length).toBe(historyBefore);
  });

  it('applies the daemon snapshot main hands over', async () => {
    const taskId = await newTask();
    await receiverMoves(taskId, 'working');
    await receiverMoves(taskId, 'completed');
    const snapshot = { ...useStore.getState().getTask(taskId)!, status: { state: 'submitted', timestamp: '2099-01-01T00:00:00.000Z' } };

    await rpc('a2a.task.send', { workspaceId: SENDER.id, taskId, message: 'again', silent: true, daemonReopenedTask: snapshot });

    expect(useStore.getState().getTask(taskId)!.status).toEqual({ state: 'submitted', timestamp: '2099-01-01T00:00:00.000Z' });
  });

  it('reply to a working task leaves it working', async () => {
    const taskId = await newTask();
    await receiverMoves(taskId, 'working');
    const res = await viaMain('a2a.task.send', { workspaceId: SENDER.id, taskId, message: 'fyi', silent: true });
    expect(res.ok).toBe(true);
    expect(state(taskId)).toBe('working');
  });

  it('a receiver message does not reopen', async () => {
    const taskId = await newTask();
    await receiverMoves(taskId, 'working');
    await receiverMoves(taskId, 'completed');
    await viaMain('a2a.task.send', { workspaceId: RECEIVER.id, taskId, message: 'report', silent: true });
    expect(state(taskId)).toBe('completed');
  });

  it('a message-only update from the sender reopens too', async () => {
    const taskId = await newTask();
    await receiverMoves(taskId, 'working');
    await receiverMoves(taskId, 'completed');
    const res = await viaMain('a2a.task.update', { workspaceId: SENDER.id, taskId, message: 'follow-up' });
    expect(res.ok).toBe(true);
    expect(state(taskId)).toBe('submitted');
  });
});

describe('only a verified sender reopens (same workspace)', () => {
  it('a receiver completing with a message and no pane identity stays completed', async () => {
    const taskId = sameWsTask('working');
    // No senderPtyId: the caller's role falls back to the workspace-level
    // 'user', which used to reopen the task inside the same call.
    const res = await rpc('a2a.task.update', {
      workspaceId: SAME.id, taskId, status: 'completed', evidence: EVIDENCE, message: 'done, see evidence',
    });
    expect(res.ok).toBe(true);
    expect(state(taskId)).toBe('completed');
  });

  it('a caller without a verified pane cannot reopen', async () => {
    const taskId = sameWsTask('completed');
    await viaMain('a2a.task.update', { workspaceId: SAME.id, taskId, message: 'hello?' });
    expect(state(taskId)).toBe('completed');
  });

  it('the receiver pane cannot reopen', async () => {
    const taskId = sameWsTask('completed');
    await viaMain('a2a.task.send', { workspaceId: SAME.id, taskId, message: 'x', senderPtyId: 'pty-to', silent: true });
    expect(state(taskId)).toBe('completed');
  });

  it('the from pane can', async () => {
    const taskId = sameWsTask('completed');
    const res = await viaMain('a2a.task.send', { workspaceId: SAME.id, taskId, message: 'more', senderPtyId: 'pty-from', silent: true });
    expect(res.ok).toBe(true);
    expect(state(taskId)).toBe('submitted');
  });
});

describe('message-only updates carry the reply round cap', () => {
  it('refuses once one side exceeded its message ceiling, before storing anything', async () => {
    const taskId = await newTask();
    for (let i = 0; i < 12; i++) {
      // eslint-disable-next-line no-await-in-loop -- sequential by design
      await viaMain('a2a.task.update', { workspaceId: SENDER.id, taskId, message: `ping ${i}` });
    }
    const before = useStore.getState().getTask(taskId)!.history.length;
    const res = await viaMain('a2a.task.update', { workspaceId: SENDER.id, taskId, message: 'one too many' });
    expect(res.reason).toBe('cap_reached');
    expect(useStore.getState().getTask(taskId)!.history.length).toBe(before);
  });
});

describe('pane-pinned tasks need a verified pane (renderer fallback)', () => {
  it('refuses a status update without pane identity when main requires one', async () => {
    const taskId = sameWsTask('submitted');
    const res = await rpc('a2a.task.update', { workspaceId: SAME.id, taskId, status: 'working', requirePaneIdentity: true });
    expect(res.error).toMatch(/pinned to a pane/);
    expect(state(taskId)).toBe('submitted');
  });

  it('accepts it from the pinned pane', async () => {
    const taskId = sameWsTask('submitted');
    const res = await rpc('a2a.task.update', {
      workspaceId: SAME.id, taskId, status: 'working', requirePaneIdentity: true, senderPtyId: 'pty-to',
    });
    expect(res.ok).toBe(true);
    expect(state(taskId)).toBe('working');
  });
});

describe('a stale daemon snapshot never rolls the cache back', () => {
  it('ignores a completion older than a reopen already applied', () => {
    const taskId = sameWsTask('submitted');
    useStore.setState((s) => {
      s.a2aTasks[taskId].status = { state: 'submitted', timestamp: '2026-09-27T02:00:00.000Z' };
    });
    const stale = { ...useStore.getState().getTask(taskId)!, status: { state: 'completed', timestamp: '2026-09-27T01:00:00.000Z' } } as Task;
    useStore.getState().applyDaemonTaskUpdate(stale);
    expect(state(taskId)).toBe('submitted');
  });
});
