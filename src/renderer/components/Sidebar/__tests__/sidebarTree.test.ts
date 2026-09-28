// #1481 — fan-out nesting, rollup, default expansion and "finished".
import { describe, expect, it, vi } from 'vitest';
import { buildSidebarTree, closedPaneFoldKey, isTaskGroupExpanded, paneRowsFinished, paneTaskFoldKey, revalidateTaskForClose, selectOwnerPaneTaskSplit, splitTasksByPane, taskRollup, withTimeout, ORPHAN_GROUP_KEY } from '../sidebarTree';
import type { FanoutOrigin } from '../../../../shared/fanoutOrigin';
import type { WorkTask } from '../../../../shared/workTask';
import type { TaskLink } from '../../../utils/fanoutProvenance';
import type { AgentStatus } from '../../../../shared/types';

const rows = (...ids: string[]) => ids.map((id) => ({ id }));
const links = (map: Record<string, TaskLink>) => (id: string) => map[id] ?? null;

describe('buildSidebarTree', () => {
  it('nests a task under its open owner, keeping list order inside the group', () => {
    const tree = buildSidebarTree(
      rows('owner', 't2', 'other', 't1'),
      links({ t1: { ownerId: 'owner', detached: false }, t2: { ownerId: 'owner', detached: false } }),
    );
    expect(tree.top.map((n) => n.id)).toEqual(['owner', 'other']);
    expect(tree.top[0].taskIds).toEqual(['t2', 't1']);
    expect(tree.orphanTaskIds).toEqual([]);
  });

  it('leaves a detached task top-level', () => {
    const tree = buildSidebarTree(rows('owner', 't1'), links({ t1: { ownerId: 'owner', detached: true } }));
    expect(tree.top.map((n) => n.id)).toEqual(['owner', 't1']);
    expect(tree.top[0].taskIds).toEqual([]);
    expect(tree.taskIds.has('t1')).toBe(false);
  });

  it('collects a task whose owner is gone — or unnamed — in the orphan group', () => {
    const tree = buildSidebarTree(
      rows('a', 't1', 't2'),
      links({ t1: { ownerId: 'closed-ws', detached: false }, t2: { ownerId: '', detached: false } }),
    );
    expect(tree.top.map((n) => n.id)).toEqual(['a']);
    expect(tree.orphanTaskIds).toEqual(['t1', 't2']);
  });

  it('does not orphan a task whose owner is only filtered out of view', () => {
    const tree = buildSidebarTree(
      rows('t1'),
      links({ t1: { ownerId: 'owner', detached: false } }),
      new Set(['owner', 't1']),
    );
    expect(tree.orphanTaskIds).toEqual([]);
    expect(tree.top.map((n) => n.id)).toEqual(['t1']);
    // #1481 review B9 — it still renders as a task row.
    expect(tree.taskIds.has('t1')).toBe(true);
  });
});

// 2026-09-27 — tasks nest under the pane that requested them.
describe('splitTasksByPane', () => {
  const origins = (map: Record<string, FanoutOrigin>) => (id: string) => map[id];
  // Pane p1 holds two tabs (s1a, s1b); pane p2 one (s2); p3 is stashed with
  // two real surfaces (s3a, s3b) — the roster lists it as one row.
  const panes = [
    { paneId: 'p1', surfaceIds: ['s1a', 's1b'] },
    { paneId: 'p2', surfaceIds: ['s2'] },
    { paneId: 'p3', surfaceIds: ['s3a', 's3b'] },
  ];
  const byPane = (split: ReturnType<typeof splitTasksByPane>) => Object.fromEntries(split.byPane);

  it('files each task under the requesting pane, keeping list order (any tab of the pane)', () => {
    const split = splitTasksByPane(['t3', 't1', 't2', 't4'], origins({
      t1: { kind: 'pane', paneId: 'p1', surfaceId: 's1a' },
      t2: { kind: 'pane', paneId: 'p2', surfaceId: 's2' },
      t3: { kind: 'pane', paneId: 'p1', surfaceId: 's1a' },
      t4: { kind: 'pane', paneId: 'p1', surfaceId: 's1b' },
    }), panes);
    expect(byPane(split)).toEqual({ p1: ['t3', 't1', 't4'], p2: ['t2'] });
    expect(split.closedPane).toEqual([]);
  });

  it('files a task from any real surface of a stashed pane under that pane', () => {
    const split = splitTasksByPane(['t1', 't2'], origins({
      t1: { kind: 'pane', paneId: 'p3', surfaceId: 's3b' },
      t2: { kind: 'pane', paneId: 'p3', surfaceId: 's3a' },
    }), panes);
    expect(byPane(split)).toEqual({ p3: ['t1', 't2'] });
  });

  it('follows the surface when it moved to another pane, and matches a pane-only origin by pane', () => {
    const split = splitTasksByPane(['moved', 'paneOnly'], origins({
      moved: { kind: 'pane', paneId: 'p-old', surfaceId: 's2' },
      paneOnly: { kind: 'pane', paneId: 'p1' },
    }), panes);
    expect(byPane(split)).toEqual({ p2: ['moved'], p1: ['paneOnly'] });
  });

  it('sends a closed pane — or a closed tab of a pane still open — to the trailing group', () => {
    const split = splitTasksByPane(['t1', 't2', 't3'], origins({
      t1: { kind: 'pane', paneId: 'gone', surfaceId: 'gone-s', label: 'w1-9 · old' },
      // The surface left; its pane's other tab did not ask.
      t2: { kind: 'pane', paneId: 'p1', surfaceId: 's1-closed' },
      t3: { kind: 'pane', paneId: 'p2', surfaceId: 's2' },
    }), panes);
    expect(split.closedPane).toEqual(['t1', 't2']);
    expect(byPane(split)).toEqual({ p2: ['t3'] });
  });

  it('sends GUI, orchestrator and unknown requesters to the trailing group', () => {
    const split = splitTasksByPane(['gui', 'orch', 'bare'], origins({
      gui: { kind: 'gui' },
      orch: { kind: 'orchestrator' },
      bare: { kind: 'pane' },
    }), panes);
    expect(split.closedPane).toEqual(['gui', 'orch', 'bare']);
    expect(split.byPane.size).toBe(0);
  });

  it('sends a legacy task with no origin stamp to the trailing group', () => {
    const split = splitTasksByPane(['legacy'], origins({}), panes);
    expect(split.closedPane).toEqual(['legacy']);
  });

  it('owner gone still lands in the workspace-level orphan group, not a pane group', () => {
    // The pane split only ever sees an open owner's tasks: buildSidebarTree
    // takes a task whose owner is gone out of every owner first.
    const tree = buildSidebarTree(rows('a', 't1'), links({ t1: { ownerId: 'closed-ws', detached: false } }));
    expect(tree.orphanTaskIds).toEqual(['t1']);
    expect(tree.top.find((n) => n.id === 'a')?.taskIds).toEqual([]);
  });

  it('keys fold state per owner and requesting pane', () => {
    expect(paneTaskFoldKey('ws1', 'p1')).not.toBe(paneTaskFoldKey('ws1', 'p2'));
    expect(paneTaskFoldKey('ws1', 'p1')).not.toBe(paneTaskFoldKey('ws2', 'p1'));
    expect(closedPaneFoldKey('ws1')).not.toBe('ws1');
  });
});

describe('selectOwnerPaneTaskSplit (shared per-owner memo)', () => {
  const leaf = (id: string, surfaces: string[]) => ({ id, type: 'leaf', surfaces: surfaces.map((sid) => ({ id: sid })), activeSurfaceId: surfaces[0] });
  const ws = (title: string) => ({ id: 'memo-owner', title, rootPane: { id: 'b', type: 'branch', children: [leaf('p1', ['s1']), leaf('p2', ['s2'])] } });
  const fanoutOrigin = { t1: { kind: 'pane' as const, surfaceId: 's1' }, t2: { kind: 'pane' as const, surfaceId: 's2' } };

  it('returns the same object for the same inputs and across layout churn that moves no task', () => {
    const a = selectOwnerPaneTaskSplit({ workspaces: [ws('a')], fanoutOrigin }, 'memo-owner', ['t1', 't2']);
    expect(selectOwnerPaneTaskSplit({ workspaces: [ws('a')], fanoutOrigin }, 'memo-owner', ['t1', 't2'])).toBe(a);
    expect(Object.fromEntries(a.byPane)).toEqual({ p1: ['t1'], p2: ['t2'] });
  });

  it('recomputes when a task changes group', () => {
    const a = selectOwnerPaneTaskSplit({ workspaces: [ws('a')], fanoutOrigin }, 'memo-owner', ['t1', 't2']);
    const closed = { id: 'memo-owner', rootPane: leaf('p1', ['s1']) };
    const b = selectOwnerPaneTaskSplit({ workspaces: [closed], fanoutOrigin }, 'memo-owner', ['t1', 't2']);
    expect(b).not.toBe(a);
    expect(b.closedPane).toEqual(['t2']);
  });
});

describe('taskRollup', () => {
  const status = (map: Record<string, AgentStatus>) => (id: string) => map[id] ?? 'idle';

  it('counts tasks and the ones that need you', () => {
    expect(taskRollup(['a', 'b', 'c'], status({ a: 'awaiting_input', b: 'running', c: 'waiting' }))).toEqual({ tasks: 3, needYou: 2, toReview: 0 });
  });

  it('is nothing at zero tasks', () => {
    expect(taskRollup([], status({}))).toBeNull();
  });
});

describe('isTaskGroupExpanded', () => {
  it('opens by default only while the owner is active or a task needs you', () => {
    expect(isTaskGroupExpanded({ remembered: undefined, ownerActive: false, anyNeedsYou: false })).toBe(false);
    expect(isTaskGroupExpanded({ remembered: undefined, ownerActive: true, anyNeedsYou: false })).toBe(true);
    expect(isTaskGroupExpanded({ remembered: undefined, ownerActive: false, anyNeedsYou: true })).toBe(true);
  });

  it('always opens while one of its tasks is the active workspace', () => {
    expect(isTaskGroupExpanded({ remembered: false, ownerActive: false, anyNeedsYou: false, childActive: true })).toBe(true);
  });

  it('lets the remembered toggle win', () => {
    expect(isTaskGroupExpanded({ remembered: false, ownerActive: true, anyNeedsYou: true })).toBe(false);
    expect(isTaskGroupExpanded({ remembered: true, ownerActive: false, anyNeedsYou: false })).toBe(true);
  });
});

// #1481 review A1 — per pane, complete only.
describe('paneRowsFinished', () => {
  const rows = (...st: AgentStatus[]) => st.map((status) => ({ status }));
  it('is finished only when every agent pane is complete', () => {
    expect(paneRowsFinished(rows('complete', 'complete'))).toBe(true);
  });
  it('is not finished when any pane is still running or waiting, even if another completed', () => {
    expect(paneRowsFinished(rows('complete', 'running'))).toBe(false);
    expect(paneRowsFinished(rows('complete', 'awaiting_input'))).toBe(false);
  });
  it('does not count idle (booting, never started, quiet) or a task with no agent pane', () => {
    expect(paneRowsFinished(rows('idle'))).toBe(false);
    expect(paneRowsFinished(rows('complete', 'idle'))).toBe(false);
    expect(paneRowsFinished([])).toBe(false);
  });
});

// #1481 review A2/A3 — re-validated from the current store right before closing.
describe('revalidateTaskForClose', () => {
  const mission = (owner: string, extra: Partial<WorkTask> = {}) =>
    ({ id: 'task-1', status: 'open', owner: { verifiedWorkspaceId: owner, principalId: owner }, ...extra } as WorkTask);
  const done = () => [{ status: 'complete' as AgentStatus }];
  const running = () => [{ status: 'running' as AgentStatus }];
  const state = (m: WorkTask | undefined, ids = ['owner', 't']) => ({
    workspaces: ids.map((id) => ({ id })),
    missionByPaneGroup: m ? { t: m } : {},
  });

  it('passes a finished task still attached to this owner', () => {
    expect(revalidateTaskForClose(state(mission('owner')), 't', 'owner', done)).toMatchObject({ ok: true });
  });
  it('passes a ledger-closed record through too: the real close still runs for it', () => {
    expect(revalidateTaskForClose(state(mission('owner', { status: 'closed' })), 't', 'owner', done)).toMatchObject({ ok: true });
  });
  it('skips a task that resumed, was detached, moved, lost its record or is gone', () => {
    expect(revalidateTaskForClose(state(mission('owner')), 't', 'owner', running)).toEqual({ ok: false, reason: 'not-finished' });
    expect(revalidateTaskForClose(state(mission('owner', { detachedAt: 1 })), 't', 'owner', done)).toEqual({ ok: false, reason: 'detached' });
    expect(revalidateTaskForClose(state(mission('other')), 't', 'owner', done)).toEqual({ ok: false, reason: 'moved' });
    expect(revalidateTaskForClose(state(undefined), 't', 'owner', done)).toEqual({ ok: false, reason: 'no-record' });
    expect(revalidateTaskForClose(state(mission('owner'), ['owner']), 't', 'owner', done)).toEqual({ ok: false, reason: 'gone' });
  });
  it('treats the closed-owner group as "owner not open"', () => {
    expect(revalidateTaskForClose(state(mission('closed-ws')), 't', ORPHAN_GROUP_KEY, done)).toMatchObject({ ok: true });
    expect(revalidateTaskForClose(state(mission('owner')), 't', ORPHAN_GROUP_KEY, done)).toEqual({ ok: false, reason: 'moved' });
  });
});

// #1481 review A4 — a hung close must settle.
describe('withTimeout', () => {
  it('rejects a promise that never settles', async () => {
    vi.useFakeTimers();
    const p = withTimeout(new Promise<never>(() => undefined), 1000);
    const assertion = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    vi.useRealTimers();
  });
  it('passes a settled value through', async () => {
    await expect(withTimeout(Promise.resolve(3), 1000)).resolves.toBe(3);
  });
});
