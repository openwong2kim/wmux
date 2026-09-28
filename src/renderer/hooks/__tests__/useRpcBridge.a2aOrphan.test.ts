// @vitest-environment jsdom
//
// #1598: a task pinned to a pane that has since closed must still be closable
// by its workspace, and the receiver may drop a superseded task as `canceled`.
// Drives the renderer's fallback writer (no daemon commit) the way main does.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneBranch, PaneLeaf, Surface, Workspace } from '../../../shared/types';
import { useStore } from '../../stores';
import { handleRpcMethod } from '../useRpcBridge';

const { publishA2aTaskMock } = vi.hoisted(() => ({ publishA2aTaskMock: vi.fn() }));
vi.mock('../../events/publisher', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../events/publisher')>()),
  publishA2aTask: publishA2aTaskMock,
}));

function leaf(id: string, ptyId: string): PaneLeaf {
  const surface = { id: `surf-${id}`, ptyId, title: id, shell: '', cwd: '', surfaceType: 'terminal' } as Surface;
  return { id, type: 'leaf', surfaces: [surface], activeSurfaceId: surface.id };
}

const WS = {
  id: 'ws-orphan',
  name: 'Orphan',
  rootPane: {
    id: 'branch',
    type: 'branch',
    direction: 'horizontal',
    children: [leaf('pane-live', 'pty-live'), leaf('pane-now', 'pty-now')],
  } as PaneBranch,
  activePaneId: 'pane-now',
} as Workspace;
const OTHER = { id: 'ws-other', name: 'Other', rootPane: leaf('pane-other', 'pty-other'), activePaneId: 'pane-other' } as Workspace;

function pinnedTask(paneId: string): string {
  return useStore.getState().createA2aTask({
    title: 'pinned',
    from: { workspaceId: WS.id, name: 'Orphan' },
    to: { workspaceId: WS.id, name: 'Orphan', paneId },
    history: [],
    artifacts: [],
  });
}

type Result = { ok?: boolean; error?: string };
const update = async (params: Record<string, unknown>): Promise<Result> =>
  (await handleRpcMethod('a2a.task.update', { requirePaneIdentity: true, ...params })) as Result;

beforeEach(() => {
  publishA2aTaskMock.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    pty: { write: vi.fn() },
    rpc: { gatedSubmit: async () => ({ ok: true }) },
  };
  useStore.setState({ workspaces: [WS, OTHER], paneGate: 'ready', a2aTasks: {} });
});

describe('a2a.task.update — orphaned receiver pane (#1598)', () => {
  it('the current pane of the workspace closes a task whose pane is gone', async () => {
    const taskId = pinnedTask('pane-closed');
    expect((await update({ workspaceId: WS.id, taskId, status: 'working', senderPtyId: 'pty-now' })).ok).toBe(true);
    expect(useStore.getState().getTask(taskId)?.status.state).toBe('working');
  });

  it('a live receiver pane keeps its task', async () => {
    const taskId = pinnedTask('pane-live');
    const res = await update({ workspaceId: WS.id, taskId, status: 'working', senderPtyId: 'pty-now' });
    expect(res.error).toMatch(/not the addressed receiver pane/);
  });

  it('a pane of another workspace cannot touch it', async () => {
    const taskId = pinnedTask('pane-closed');
    const res = await update({ workspaceId: OTHER.id, taskId, status: 'working', senderPtyId: 'pty-other' });
    expect(res.error).toMatch(/not the receiver/);
  });
});

describe('a2a.task.update — receiver cancel (#1598)', () => {
  it('cancels with a reason and emits a cancelled pointer', async () => {
    const taskId = pinnedTask('pane-closed');
    const res = await update({
      workspaceId: WS.id, taskId, status: 'canceled', senderPtyId: 'pty-now', evidence: { summary: 'superseded', items: [] },
    });
    expect(res.ok).toBe(true);
    expect(useStore.getState().getTask(taskId)?.status.state).toBe('canceled');
    expect(publishA2aTaskMock).toHaveBeenCalledWith(WS.id, WS.id, taskId, 'canceled', 'cancelled', undefined, undefined);
  });

  it('refuses a cancel without a reason', async () => {
    const taskId = pinnedTask('pane-now');
    const res = await update({ workspaceId: WS.id, taskId, status: 'canceled', senderPtyId: 'pty-now' });
    expect(res.error).toMatch(/cancel_reason_missing/);
    expect(useStore.getState().getTask(taskId)?.status.state).toBe('submitted');
  });
});
