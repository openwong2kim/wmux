import { describe, it, expect } from 'vitest';
import {
  countReadyToReview,
  isTaskReadyForReview,
  reviewQueueEntry,
  selectReviewQueue,
  selectReviewQueueIds,
} from '../reviewQueue';
import { taskRollup } from '../../../components/Sidebar/sidebarTree';
import type { StoreState } from '../../index';
import type { Workspace, Pane, Surface, AgentStatus } from '../../../../shared/types';
import type { WorkTask } from '../../../../shared/workTask';

const NOW = 5_000_000;

function surface(id: string, ptyId: string): Surface {
  return { id, ptyId, title: id, shell: 'zsh', cwd: `/repo/${id}`, surfaceType: 'terminal' };
}
function leaf(id: string, ptyId: string): Pane {
  return { id, type: 'leaf', surfaces: [surface(`s-${id}`, ptyId)], activeSurfaceId: `s-${id}` };
}
function workspace(id: string, panes: Pane[], extra: Partial<Workspace> = {}): Workspace {
  const rootPane: Pane = panes.length === 1 ? panes[0] : { id: `root-${id}`, type: 'branch', direction: 'horizontal', children: panes };
  return { id, name: id, rootPane, activePaneId: panes[0].id, ...extra };
}
function mission(id: string, owner: string, extra: Partial<WorkTask> = {}): WorkTask {
  return {
    id,
    title: `Task ${id}`,
    status: 'open',
    missionChannelId: `ch-${id}`,
    createdAt: 1,
    createdBy: { principalId: owner, verifiedWorkspaceId: owner },
    owner: { principalId: owner, verifiedWorkspaceId: owner },
    branch: `wmux/${id}`,
    worktreePath: `/wt/${id}`,
    ...extra,
  } as WorkTask;
}

/** Each pty gets a Claude agent in the given status. */
function state(opts: {
  workspaces: Workspace[];
  missions: Record<string, WorkTask>;
  status: Record<string, AgentStatus>;
  activityAt?: Record<string, number>;
}): StoreState {
  const surfaceAgent: Record<string, { name: string; status: AgentStatus }> = {};
  const surfaceAgentStatus: Record<string, AgentStatus> = {};
  for (const [pty, st] of Object.entries(opts.status)) {
    surfaceAgent[pty] = { name: 'Claude Code', status: st };
    if (st !== 'idle' && st !== 'running') surfaceAgentStatus[pty] = st;
  }
  return {
    workspaces: opts.workspaces,
    activeWorkspaceId: opts.workspaces[0]?.id ?? '',
    missionByPaneGroup: opts.missions,
    surfaceAgent,
    surfaceAgentStatus,
    surfacePendingQuestion: {},
    surfaceQuestionSeen: {},
    surfaceActivity: {},
    // A running pane's hook stamp is fresh; the rest are older.
    surfaceActivityAt: opts.activityAt ?? Object.fromEntries(Object.entries(opts.status).map(([p, s]) => [p, s === 'running' ? NOW : NOW - 60_000])),
    surfaceTurnOpenAt: Object.fromEntries(Object.entries(opts.status).filter(([, s]) => s === 'running').map(([p]) => [p, NOW])),
    paneLabel: {},
    agentClockMs: NOW,
    remoteWorkspaces: [],
  } as unknown as StoreState;
}

describe('isTaskReadyForReview', () => {
  const owner = workspace('owner', [leaf('po', 'pty-o')]);

  it('lists an open task whose every agent pane finished', () => {
    const s = state({
      workspaces: [owner, workspace('t1', [leaf('a', 'p1'), leaf('b', 'p2')])],
      missions: { t1: mission('task-1', 'owner') },
      status: { p1: 'complete', p2: 'complete' },
    });
    expect(isTaskReadyForReview(s, 't1')).toBe(true);
    expect(selectReviewQueueIds(s)).toEqual(['t1']);
  });

  it('does not list a running, awaiting or idle task', () => {
    for (const st of ['running', 'awaiting_input', 'waiting', 'error', 'idle'] as AgentStatus[]) {
      const s = state({
        workspaces: [owner, workspace('t1', [leaf('a', 'p1')])],
        missions: { t1: mission('task-1', 'owner') },
        status: { p1: st },
      });
      expect(isTaskReadyForReview(s, 't1')).toBe(false);
    }
  });

  it('does not list a task with mixed panes (one finished, one still running)', () => {
    const s = state({
      workspaces: [owner, workspace('t1', [leaf('a', 'p1'), leaf('b', 'p2')])],
      missions: { t1: mission('task-1', 'owner') },
      status: { p1: 'complete', p2: 'running' },
    });
    expect(isTaskReadyForReview(s, 't1')).toBe(false);
  });

  it('does not list a closed or detached task, or a workspace with no task record', () => {
    const ws = [owner, workspace('t1', [leaf('a', 'p1')])];
    const status = { p1: 'complete' as AgentStatus };
    expect(isTaskReadyForReview(state({ workspaces: ws, missions: { t1: mission('task-1', 'owner', { status: 'closed' }) }, status }), 't1')).toBe(false);
    expect(isTaskReadyForReview(state({ workspaces: ws, missions: { t1: mission('task-1', 'owner', { detachedAt: 3 }) }, status }), 't1')).toBe(false);
    expect(isTaskReadyForReview(state({ workspaces: ws, missions: {}, status }), 't1')).toBe(false);
  });

  it('does not list a task with no agent pane', () => {
    const s = state({ workspaces: [owner, workspace('t1', [leaf('a', 'p1')])], missions: { t1: mission('task-1', 'owner') }, status: {} });
    expect(isTaskReadyForReview(s, 't1')).toBe(false);
  });
});

describe('reviewQueueEntry', () => {
  it('carries title, owner, branch, PR and the completion time', () => {
    const pr = { number: 7, state: 'open' as const, checks: null, url: 'https://github.com/o/r/pull/7' };
    const s = state({
      workspaces: [workspace('owner', [leaf('po', 'pty-o')], { name: 'My project' }), workspace('t1', [leaf('a', 'p1'), leaf('b', 'p2')], { metadata: { pr } })],
      missions: { t1: mission('task-1', 'owner') },
      status: { p1: 'complete', p2: 'complete' },
    });
    Object.assign(s, { surfaceTurnEndAt: { p1: 100, p2: 250 } });
    expect(reviewQueueEntry(s, 't1')).toEqual({
      workspaceId: 't1',
      taskId: 'task-1',
      title: 'Task task-1',
      ownerWorkspaceId: 'owner',
      ownerName: 'My project',
      branch: 'wmux/task-1',
      worktreePath: '/wt/task-1',
      pr,
      completedAt: 250,
    });
  });

  it('takes the finish time from the turn-end stamp, not later output or the turn latch', () => {
    const s = state({ workspaces: [workspace('t1', [leaf('a', 'p1')])], missions: { t1: mission('task-1', 'gone') }, status: { p1: 'complete' }, activityAt: {} });
    Object.assign(s, { surfaceTurnEndAt: { p1: 3_000 }, surfaceOutputAt: { p1: 9_000 }, surfaceTurnOpenAt: { p1: 9_500 } });
    expect(reviewQueueEntry(s, 't1')?.completedAt).toBe(3_000);
  });

  it('falls back to the last output for a pane with no turn-end stamp', () => {
    const s = state({ workspaces: [workspace('t1', [leaf('a', 'p1')])], missions: { t1: mission('task-1', 'gone') }, status: { p1: 'complete' }, activityAt: {} });
    Object.assign(s, { surfaceOutputAt: { p1: 4_000 } });
    expect(reviewQueueEntry(s, 't1')?.completedAt).toBe(4_000);
  });

  it('omits the owner name when the owner workspace is gone', () => {
    const s = state({ workspaces: [workspace('t1', [leaf('a', 'p1')])], missions: { t1: mission('task-1', 'gone') }, status: { p1: 'complete' } });
    expect(reviewQueueEntry(s, 't1')?.ownerName).toBeUndefined();
  });

  it('orders the queue newest completion first', () => {
    const s = state({
      workspaces: [workspace('owner', [leaf('po', 'pty-o')]), workspace('t1', [leaf('a', 'p1')]), workspace('t2', [leaf('b', 'p2')])],
      missions: { t1: mission('task-1', 'owner'), t2: mission('task-2', 'owner') },
      status: { p1: 'complete', p2: 'complete' },
    });
    Object.assign(s, { surfaceTurnEndAt: { p1: 10, p2: 20 } });
    expect(selectReviewQueue(s).map((e) => e.workspaceId)).toEqual(['t2', 't1']);
  });
});

// #1508 parity — the sidebar rollup and the Fleet section count the same tasks.
describe('sidebar rollup parity', () => {
  it('counts the same ready tasks the Fleet queue lists', () => {
    const s = state({
      workspaces: [
        workspace('owner', [leaf('po', 'pty-o')]),
        workspace('t1', [leaf('a', 'p1')]),
        workspace('t2', [leaf('b', 'p2')]),
        workspace('t3', [leaf('c', 'p3'), leaf('d', 'p4')]),
      ],
      missions: { t1: mission('task-1', 'owner'), t2: mission('task-2', 'owner'), t3: mission('task-3', 'owner') },
      status: { p1: 'complete', p2: 'running', p3: 'complete', p4: 'complete' },
    });
    const taskIds = ['t1', 't2', 't3'];
    const rollup = taskRollup(taskIds, () => 'idle', (id) => isTaskReadyForReview(s, id));
    expect(rollup?.toReview).toBe(2);
    expect(countReadyToReview(s, taskIds)).toBe(2);
    expect(selectReviewQueue(s)).toHaveLength(2);
  });
});
