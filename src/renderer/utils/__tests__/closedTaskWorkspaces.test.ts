// #2934 — which task workspaces the renderer closes when their task closes.
import { describe, it, expect } from 'vitest';
import { agentKeepsWorkspace, taskWorkspacesToClose } from '../closedTaskWorkspaces';
import type { StoreState } from '../../stores';
import type { AgentStatus, Pane, Surface, Workspace } from '../../../shared/types';
import type { WorkTask } from '../../../shared/workTask';

function surface(id: string, ptyId: string, extra: Partial<Surface> = {}): Surface {
  return { id, ptyId, title: id, shell: 'zsh', cwd: '/repo', surfaceType: 'terminal', ...extra };
}
function workspace(id: string, surfaces: Surface[] = [surface(`${id}-s`, `${id}-pty`)]): Workspace {
  const rootPane: Pane = { id: `${id}-p`, type: 'leaf', surfaces, activeSurfaceId: surfaces[0]?.id ?? '' };
  return { id, name: id, rootPane, activePaneId: rootPane.id };
}
function task(wsId: string, status: WorkTask['status'], extra: Partial<WorkTask> = {}): WorkTask {
  const ref = { verifiedWorkspaceId: 'owner' } as WorkTask['owner'];
  return {
    id: `task-${wsId}`, title: wsId, status, missionChannelId: 'ch', createdAt: 1,
    createdBy: ref, owner: ref, paneGroupId: wsId, ...extra,
  };
}

function state(workspaces: Workspace[], extra: Record<string, unknown> = {}): StoreState {
  return {
    workspaces,
    activeWorkspaceId: 'owner',
    surfaceAgent: {},
    surfaceAgentStatus: {},
    surfacePendingQuestion: {},
    surfaceQuestionSeen: {},
    surfaceActivity: {},
    surfaceActivityAt: {},
    surfaceTurnOpenAt: {},
    paneLabel: {},
    agentClockMs: 1_000_000,
    remoteWorkspaces: [],
    ...extra,
  } as unknown as StoreState;
}

const OWNER = workspace('owner');
const open = { t1: task('t1', 'open') };
const closed = { t1: task('t1', 'closed') };

/** The single-task case: prev → next over the owner and task workspace t1. */
function decide(next: Record<string, WorkTask>, extra: Record<string, unknown> = {}, t1 = workspace('t1')): string[] {
  return taskWorkspacesToClose(open, next, state([OWNER, t1], extra));
}

/** An agent in t1 with `status`. A `running` one gets an open turn: without
 *  it the sidebar reads `running` as a stale boot seed, i.e. idle. */
function withAgent(status: AgentStatus): Record<string, unknown> {
  const turn = status === 'running' ? { surfaceTurnOpenAt: { 't1-pty': 1 } } : {};
  return { surfaceAgent: { 't1-pty': { name: 'Claude Code', status } }, ...turn };
}

describe('taskWorkspacesToClose (#2934)', () => {
  it('closes the workspace of a task that went from open to closed', () => {
    expect(decide(closed)).toEqual(['t1']);
  });

  it('never closes a task that was already closed or is seen closed for the first time', () => {
    const s = state([OWNER, workspace('t1')]);
    expect(taskWorkspacesToClose(closed, closed, s)).toEqual([]);
    expect(taskWorkspacesToClose({}, closed, s)).toEqual([]);
    expect(taskWorkspacesToClose(open, open, s)).toEqual([]);
  });

  it('keeps a detached task workspace', () => {
    expect(decide({ t1: task('t1', 'closed', { detachedAt: 5 }) })).toEqual([]);
  });

  it('keeps nothing to close when the workspace is gone', () => {
    expect(taskWorkspacesToClose(open, closed, state([OWNER]))).toEqual([]);
  });

  it('keeps the active workspace', () => {
    expect(decide(closed, { activeWorkspaceId: 't1' })).toEqual([]);
  });

  it.each(['running', 'awaiting_input'] as AgentStatus[])('keeps a workspace whose agent is %s', (status) => {
    expect(decide(closed, withAgent(status))).toEqual([]);
  });

  it('keeps a workspace whose agent asked a question', () => {
    expect(decide(closed, { ...withAgent('waiting'), surfacePendingQuestion: { 't1-pty': 'Proceed?' } })).toEqual([]);
  });

  // `waiting` with no question is Claude idle at its prompt: a finished worker.
  it.each(['waiting', 'idle', 'complete', 'error'] as AgentStatus[])('closes a workspace whose agent is %s', (status) => {
    expect(decide(closed, withAgent(status))).toEqual(['t1']);
  });

  it('a waiting agent keeps the workspace only with a question', () => {
    expect(agentKeepsWorkspace({ status: 'waiting' })).toBe(false);
    expect(agentKeepsWorkspace({ status: 'waiting', pendingQuestion: 'Proceed?' })).toBe(true);
  });

  it('keeps a workspace that holds a remote-terminal session', () => {
    const remote = surface('r', '', { surfaceType: 'remote-terminal', remoteOwned: true, remoteHostId: 'h', remoteSessionId: 'rs' });
    expect(decide(closed, {}, workspace('t1', [remote]))).toEqual([]);
  });

  it('never closes the last workspace, counting the ones it already closes', () => {
    expect(taskWorkspacesToClose(open, closed, state([workspace('t1')]))).toEqual([]);
    const prev = { t1: task('t1', 'open'), t2: task('t2', 'open') };
    const next = { t1: task('t1', 'closed'), t2: task('t2', 'closed') };
    expect(taskWorkspacesToClose(prev, next, state([workspace('t1'), workspace('t2')]))).toEqual(['t1']);
  });
});
