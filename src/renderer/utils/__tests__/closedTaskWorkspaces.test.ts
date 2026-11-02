// #2934 — which task workspaces the renderer closes when their task closes.
import { describe, it, expect } from 'vitest';
import { leaveTaskWorkspaceToCaller, taskWorkspacesToClose } from '../closedTaskWorkspaces';
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
    multiviewIds: [],
    appRoute: 'workspace',
    botsWorkerPanel: null,
    commandRunningByPtyId: {},
    agentAliveByPtyId: {},
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

  it('keeps a task left to its caller, once', () => {
    leaveTaskWorkspaceToCaller('task-t1');
    expect(decide(closed)).toEqual([]);
    expect(decide(closed)).toEqual(['t1']);
  });

  it('keeps a shown workspace: active, a multiview tile, or the Bots worker panel', () => {
    expect(decide(closed, { activeWorkspaceId: 't1' })).toEqual([]);
    expect(decide(closed, { multiviewIds: ['owner', 't1'] })).toEqual([]);
    expect(decide(closed, { appRoute: 'bots', botsWorkerPanel: { workspaceId: 't1' } })).toEqual([]);
  });

  it.each(['running', 'awaiting_input', 'idle', 'error'] as AgentStatus[])('keeps a workspace whose agent is %s', (status) => {
    expect(decide(closed, withAgent(status))).toEqual([]);
  });

  it('keeps a workspace whose agent works without the turn-start hook', () => {
    // An older hook set reports no turn start: the working agent reads idle.
    const midTurn = { surfaceAgent: { 't1-pty': { name: 'Claude Code', status: 'running' } } };
    expect(decide(closed, midTurn)).toEqual([]);
  });

  it('keeps a workspace whose agent asked a question', () => {
    expect(decide(closed, { ...withAgent('waiting'), surfacePendingQuestion: { 't1-pty': 'Proceed?' } })).toEqual([]);
  });

  // `waiting` with no question is Claude idle at its prompt: a finished worker.
  it.each(['waiting', 'complete'] as AgentStatus[])('closes a workspace whose agent is %s', (status) => {
    expect(decide(closed, withAgent(status))).toEqual(['t1']);
  });

  it('keeps a workspace whose shell runs a command, but not for its own finished agent', () => {
    // A plain shell (no agent row) running a command.
    expect(decide(closed, { commandRunningByPtyId: { 't1-pty': true } })).toEqual([]);
    // A stashed shell has a roster row but is no agent.
    const stashedShell = workspace('t1');
    stashedShell.stashedPanes = [{ pane: { id: 'sp', type: 'leaf', surfaces: [surface('ss', 'shell-pty')], activeSurfaceId: 'ss' }, stashedAt: 1 }];
    expect(decide(closed, { commandRunningByPtyId: { 'shell-pty': true } }, stashedShell)).toEqual([]);
    // The finished agent is the command its shell runs: closing ends it.
    expect(decide(closed, { ...withAgent('complete'), commandRunningByPtyId: { 't1-pty': true } })).toEqual(['t1']);
    // An agent known gone: the command its shell runs now is something else.
    expect(decide(closed, {
      ...withAgent('complete'), commandRunningByPtyId: { 't1-pty': true }, agentAliveByPtyId: { 't1-pty': false },
    })).toEqual([]);
  });

  it('keeps a workspace that holds an editor (stashed included), not one with only a browser', () => {
    const editor = surface('e', '', { surfaceType: 'editor', editorFilePath: '/repo/a.ts' });
    expect(decide(closed, {}, workspace('t1', [surface('t1-s', 't1-pty'), editor]))).toEqual([]);
    const stashed = workspace('t1');
    stashed.stashedPanes = [{ pane: { id: 'sp', type: 'leaf', surfaces: [editor], activeSurfaceId: 'e' }, stashedAt: 1 }];
    expect(decide(closed, {}, stashed)).toEqual([]);
    const browser = surface('b', '', { surfaceType: 'browser', browserUrl: 'http://localhost:3000' });
    expect(decide(closed, {}, workspace('t1', [surface('t1-s', 't1-pty'), browser]))).toEqual(['t1']);
  });

  it('keeps a workspace that holds a remote-terminal session', () => {
    const remote = surface('r', '', { surfaceType: 'remote-terminal', remoteOwned: true, remoteHostId: 'h', remoteSessionId: 'rs' });
    expect(decide(closed, {}, workspace('t1', [remote]))).toEqual([]);
  });

  it('keeps a workspace that only views a remote terminal, with no agent read from it', () => {
    const viewed = surface('r', '', { surfaceType: 'remote-terminal', remoteHostId: 'h', remoteSessionId: 'rs' });
    expect(decide(closed, {}, workspace('t1', [surface('t1-s', 't1-pty'), viewed]))).toEqual([]);
  });

  it('keeps a workspace whose stashed pane holds an agent in a tab its roster row does not show', () => {
    const stashed = workspace('t1');
    stashed.stashedPanes = [{
      pane: { id: 'sp', type: 'leaf', surfaces: [surface('a', 'a-pty'), surface('b', 'b-pty')], activeSurfaceId: 'a' },
      stashedAt: 1,
    }];
    const agents = { 'a-pty': { name: 'Claude Code', status: 'complete' }, 'b-pty': { name: 'Codex', status: 'running' } };
    expect(decide(closed, { surfaceAgent: agents }, stashed)).toEqual([]);
    // Known gone: nothing of it is left to finish.
    expect(decide(closed, { surfaceAgent: agents, agentAliveByPtyId: { 'b-pty': false } }, stashed)).toEqual(['t1']);
  });

  it('never closes the last workspace, counting the ones it already closes', () => {
    expect(taskWorkspacesToClose(open, closed, state([workspace('t1')]))).toEqual([]);
    const prev = { t1: task('t1', 'open'), t2: task('t2', 'open') };
    const next = { t1: task('t1', 'closed'), t2: task('t2', 'closed') };
    expect(taskWorkspacesToClose(prev, next, state([workspace('t1'), workspace('t2')]))).toEqual(['t1']);
  });
});
