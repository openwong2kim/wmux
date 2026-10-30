// @vitest-environment jsdom
//
// Company mode: a new task to a company pane is checked against the pane
// the send resolved, before anything is stored; a company task is canceled
// only by the pane that created it. These drive the real bridge handler.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pane, PaneLeaf, Surface, Workspace } from '../../../shared/types';
import { COMPANY_BRIEF_KIND } from '../../../shared/company';
import { useStore } from '../../stores';
import { handleRpcMethod } from '../useRpcBridge';

const BRIEF = {
  kind: COMPANY_BRIEF_KIND,
  v: 1,
  goal: 'Fix the flaky test',
  scope: 'src/parser only',
  acceptance: 'the test passes ten runs in a row',
  verify: 'npx vitest run src/parser',
  report: 'reply with the cause',
};

function leaf(id: string, ptyId: string): PaneLeaf {
  const surface = { id: `surf-${id}`, ptyId, title: id, shell: '', cwd: '', surfaceType: 'terminal' } as Surface;
  return { id, type: 'leaf', surfaces: [surface], activeSurfaceId: surface.id };
}

// HOME is the company "Eng": the coordinator pane and one staff pane.
const HOME = {
  id: 'ws-dept-home',
  name: 'Eng',
  rootPane: {
    id: 'branch-home',
    type: 'branch',
    direction: 'horizontal',
    sizes: [50, 50],
    children: [leaf('pane-coord', 'pty-coord'), leaf('pane-member', 'pty-member')],
  } as Pane,
  activePaneId: 'pane-coord',
  company: { v: 1, id: 'co-eng', coordinatorPaneId: 'pane-coord' },
} as Workspace;
const OUTSIDE = { id: 'ws-dept-outside', name: 'Outside', rootPane: leaf('pane-out', 'pty-out'), activePaneId: 'pane-out' } as Workspace;

type Result = { ok?: boolean; taskId?: string; error?: string };

async function send(params: Record<string, unknown>): Promise<Result> {
  return (await handleRpcMethod('a2a.task.send', { message: 'please do this', silent: true, ...params })) as Result;
}

function taskCount(): number {
  return Object.keys(useStore.getState().a2aTasks).length;
}

beforeEach(() => {
  vi.useFakeTimers();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    pty: { write: vi.fn() },
    rpc: { gatedSubmit: async () => ({ ok: true }) },
  };
  useStore.setState({ workspaces: [HOME, OUTSIDE], paneGate: 'ready', a2aTasks: {} });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a new task to a company pane', () => {
  it('from the coordinator, with a brief, is stored pinned to both panes with the brief first', async () => {
    const res = await send({ workspaceId: HOME.id, to: HOME.id, paneId: 'pane-member', senderPtyId: 'pty-coord', data: BRIEF });
    expect(res.error).toBeUndefined();
    const task = useStore.getState().a2aTasks[res.taskId as string];
    expect(task.metadata.to.paneId).toBe('pane-member');
    expect(task.metadata.from.paneId).toBe('pane-coord');
    expect(task.history[0].parts).toContainEqual(expect.objectContaining({ kind: 'data', data: BRIEF }));
  });

  it('without a brief is refused, names what is missing, and stores nothing', async () => {
    const res = await send({ workspaceId: HOME.id, to: HOME.id, paneId: 'pane-member', senderPtyId: 'pty-coord' });
    expect(res.error).toContain('missing: goal, scope, acceptance, verify, report');
    expect(taskCount()).toBe(0);
  });

  it('from outside the company reaches the coordinator but not a staff pane', async () => {
    const toMember = await send({ workspaceId: OUTSIDE.id, to: HOME.id, paneId: 'pane-member', senderPtyId: 'pty-out', data: BRIEF });
    expect(toMember.error).toContain('through its coordinator');
    expect(taskCount()).toBe(0);
    const toCoordinator = await send({ workspaceId: OUTSIDE.id, to: HOME.id, paneId: 'pane-coord', senderPtyId: 'pty-out', data: BRIEF });
    expect(toCoordinator.error).toBeUndefined();
    expect(taskCount()).toBe(1);
  });

  it('from outside, a one-line request without a brief reaches the coordinator', async () => {
    const res = await send({ workspaceId: OUTSIDE.id, to: HOME.id, paneId: 'pane-coord', senderPtyId: 'pty-out' });
    expect(res.error).toBeUndefined();
    expect(useStore.getState().a2aTasks[res.taskId as string].metadata.to.paneId).toBe('pane-coord');
  });

  it('from a caller that claims the company workspace without its pane is refused', async () => {
    // pty-out is not a pane of HOME, so the claimed sender pane does not hold.
    const res = await send({ workspaceId: HOME.id, to: HOME.id, paneId: 'pane-member', senderPtyId: 'pty-out', data: BRIEF });
    expect(res.error).toBeDefined();
    expect(taskCount()).toBe(0);
  });

  it('leaves a send to a workspace outside every company as it was', async () => {
    const res = await send({ workspaceId: HOME.id, to: OUTSIDE.id, senderPtyId: 'pty-member' });
    expect(res.error).toBeUndefined();
    expect(taskCount()).toBe(1);
  });
});

describe('canceling a company task (no daemon)', () => {
  it('is refused for a sibling pane and allowed for the pane that created it', async () => {
    const created = await send({ workspaceId: HOME.id, to: HOME.id, paneId: 'pane-member', senderPtyId: 'pty-coord', data: BRIEF });
    const taskId = created.taskId as string;
    const bySibling = (await handleRpcMethod('a2a.task.cancel', { taskId, workspaceId: HOME.id, senderPtyId: 'pty-member' })) as Result;
    expect(bySibling.error).toContain('only the pane that created');
    expect(useStore.getState().a2aTasks[taskId].status.state).toBe('submitted');
    const byCreator = (await handleRpcMethod('a2a.task.cancel', { taskId, workspaceId: HOME.id, senderPtyId: 'pty-coord' })) as Result;
    expect(byCreator.ok).toBe(true);
    expect(useStore.getState().a2aTasks[taskId].status.state).toBe('canceled');
  });

  it('is refused when the receiver moves it to canceled through an update', async () => {
    const created = await send({ workspaceId: HOME.id, to: HOME.id, paneId: 'pane-member', senderPtyId: 'pty-coord', data: BRIEF });
    const taskId = created.taskId as string;
    const res = (await handleRpcMethod('a2a.task.update', {
      taskId, workspaceId: HOME.id, status: 'canceled', senderPtyId: 'pty-member', requirePaneIdentity: true,
      evidence: { summary: 'giving up', items: [] },
    })) as Result;
    expect(res.error).toContain('only the pane that created');
    expect(useStore.getState().a2aTasks[taskId].status.state).toBe('submitted');
  });
});
