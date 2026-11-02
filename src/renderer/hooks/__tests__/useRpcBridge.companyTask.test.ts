// @vitest-environment jsdom
//
// Company mode: a new task to a company pane is checked against the pane
// the send resolved, before anything is stored; a company task is canceled
// only by the pane that created it, and marked done only by the coordinator
// or the human. These drive the real bridge handler.
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

// HOME is the company "Eng": the coordinator pane and two staff panes.
const HOME = {
  id: 'ws-dept-home',
  name: 'Eng',
  rootPane: {
    id: 'branch-home',
    type: 'branch',
    direction: 'horizontal',
    sizes: [34, 33, 33],
    children: [leaf('pane-coord', 'pty-coord'), leaf('pane-member', 'pty-member'), leaf('pane-m2', 'pty-m2')],
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

  it('as a background worker is refused before anything is stored', async () => {
    const res = await send({ workspaceId: HOME.id, to: HOME.id, paneId: 'pane-member', senderPtyId: 'pty-coord', data: BRIEF, execute: true });
    expect(res.error).toContain('without execute');
    expect(taskCount()).toBe(0);
  });
});

describe('pane.list', () => {
  it('gives each pane of a company its seat, and no seat outside one', async () => {
    const rows = (await handleRpcMethod('pane.list', { workspaceId: HOME.id })) as Array<Record<string, unknown>>;
    expect(rows.find((r) => r.id === 'pane-coord')?.companySeat).toBe('coordinator');
    expect(rows.find((r) => r.id === 'pane-member')?.companySeat).toBe('staff');
    const outside = (await handleRpcMethod('pane.list', { workspaceId: OUTSIDE.id })) as Array<Record<string, unknown>>;
    expect(outside[0]).not.toHaveProperty('companySeat');
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

describe('marking a company task done (no daemon)', () => {
  const evidence = { summary: 'checked the report', items: [{ kind: 'command', status: 'passed', summary: 'tests', command: 'npm test' }] };
  const update = (params: Record<string, unknown>) =>
    handleRpcMethod('a2a.task.update', { workspaceId: HOME.id, requirePaneIdentity: true, ...params }) as Promise<Result>;

  /** A lateral brief, #m2 to #member, already started: the coordinator is neither party. */
  async function startedTask(): Promise<string> {
    const created = await send({ workspaceId: HOME.id, to: HOME.id, paneId: 'pane-member', senderPtyId: 'pty-m2', data: BRIEF });
    const taskId = created.taskId as string;
    expect((await update({ taskId, status: 'working', senderPtyId: 'pty-member' })).ok).toBe(true);
    return taskId;
  }
  const stateOf = (taskId: string) => useStore.getState().a2aTasks[taskId].status.state;

  it('refuses the seat that did the work, which reports instead, and lets the coordinator mark it done', async () => {
    const taskId = await startedTask();
    const self = await update({ taskId, status: 'completed', senderPtyId: 'pty-member', evidence });
    expect(self.error).toContain('coordinator (CEO) pane or the human');
    expect(stateOf(taskId)).toBe('working');
    const reported = await update({ taskId, status: 'input-required', senderPtyId: 'pty-member', message: 'PR #12 at abc123, tests passed' });
    expect(reported.ok).toBe(true);
    // The briefing seat cannot close it either.
    expect((await update({ taskId, status: 'completed', senderPtyId: 'pty-m2', evidence })).error).toBeDefined();
    const done = await update({ taskId, status: 'completed', senderPtyId: 'pty-coord', evidence, message: 'Checked, done.' });
    expect(done.ok).toBe(true);
    expect(stateOf(taskId)).toBe('completed');
    // Its message is stored as the requesting side's.
    const history = useStore.getState().a2aTasks[taskId].history;
    expect(history[history.length - 1].role).toBe('user');
  });

  it('lets the trusted lane mark it done, the only way while the seat is vacant', async () => {
    useStore.setState({ workspaces: [{ ...HOME, company: { v: 1, id: 'co-eng', coordinatorPaneId: null } }, OUTSIDE] });
    const taskId = await startedTask();
    expect((await update({ taskId, status: 'completed', senderPtyId: 'pty-coord', evidence })).error).toBeDefined();
    // A call that skipped main's router is not the trusted lane.
    expect((await update({ taskId, status: 'completed', senderPtyId: 'pty-member', requirePaneIdentity: undefined, evidence })).error)
      .toContain('coordinator (CEO) pane or the human');
    const trusted = await update({ taskId, status: 'completed', requirePaneIdentity: false, evidence });
    expect(trusted.ok).toBe(true);
    expect(stateOf(taskId)).toBe('completed');
  });

  it('leaves an ordinary task to its receiver', async () => {
    const created = await send({ workspaceId: HOME.id, to: OUTSIDE.id, senderPtyId: 'pty-member' });
    const taskId = created.taskId as string;
    const res = (await handleRpcMethod('a2a.task.update', { taskId, workspaceId: OUTSIDE.id, status: 'working' })) as Result;
    expect(res.ok).toBe(true);
    const done = (await handleRpcMethod('a2a.task.update', { taskId, workspaceId: OUTSIDE.id, status: 'completed', evidence })) as Result;
    expect(done.ok).toBe(true);
  });

  it('lets a pane in no company finish a briefed task it was sent: it has no CEO to report to', async () => {
    const created = await send({ workspaceId: HOME.id, to: OUTSIDE.id, paneId: 'pane-out', senderPtyId: 'pty-coord', data: BRIEF });
    const taskId = created.taskId as string;
    expect((await update({ taskId, workspaceId: OUTSIDE.id, status: 'working', senderPtyId: 'pty-out' })).ok).toBe(true);
    const done = await update({ taskId, workspaceId: OUTSIDE.id, status: 'completed', senderPtyId: 'pty-out', evidence });
    expect(done.ok).toBe(true);
  });
});
