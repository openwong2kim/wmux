// #1481 — fan-out nesting, rollup, default expansion and "finished".
import { describe, expect, it, vi } from 'vitest';
import { buildSidebarTree, closedPaneFoldKey, isTaskGroupExpanded, paneRowsFinished, paneTaskFoldKey, revalidateTaskForClose, splitTasksByPane, taskRollup, withTimeout, ORPHAN_GROUP_KEY } from '../sidebarTree';
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

// 2026-09-27 — tasks nest under the roster row of the pane that requested them.
describe('splitTasksByPane', () => {
  const origins = (map: Record<string, FanoutOrigin>) => (id: string) => map[id];
  // Pane p1 holds two agent tabs (s1a, s1b); pane p2 one (s2).
  const roster = [
    { paneId: 'p1', surfaceId: 's1a' },
    { paneId: 'p1', surfaceId: 's1b' },
    { paneId: 'p2', surfaceId: 's2' },
  ];
  const byRow = (split: ReturnType<typeof splitTasksByPane>) => Object.fromEntries(split.byRow);

  it('files each task under the requesting surface, keeping list order', () => {
    const split = splitTasksByPane(['t3', 't1', 't2'], origins({
      t1: { kind: 'pane', paneId: 'p1', surfaceId: 's1a' },
      t2: { kind: 'pane', paneId: 'p2', surfaceId: 's2' },
      t3: { kind: 'pane', paneId: 'p1', surfaceId: 's1a' },
    }), roster);
    expect(byRow(split)).toEqual({ s1a: ['t3', 't1'], s2: ['t2'] });
    expect(split.closedPane).toEqual([]);
  });

  it('matches an origin recorded without a surface by its pane (first row of the pane)', () => {
    const split = splitTasksByPane(['t1'], origins({ t1: { kind: 'pane', paneId: 'p1' } }), roster);
    expect(byRow(split)).toEqual({ s1a: ['t1'] });
  });

  it('sends a closed pane — or a closed tab of a pane still open — to the trailing group', () => {
    const split = splitTasksByPane(['t1', 't2', 't3'], origins({
      t1: { kind: 'pane', paneId: 'gone', surfaceId: 'gone-s', label: 'w1-9 · old' },
      // The surface left; its pane's other tab did not ask.
      t2: { kind: 'pane', paneId: 'p1', surfaceId: 's1-closed' },
      t3: { kind: 'pane', paneId: 'p2', surfaceId: 's2' },
    }), roster);
    expect(split.closedPane).toEqual(['t1', 't2']);
    expect(byRow(split)).toEqual({ s2: ['t3'] });
  });

  it('sends GUI, orchestrator and unknown requesters to the trailing group', () => {
    const split = splitTasksByPane(['gui', 'orch', 'bare'], origins({
      gui: { kind: 'gui' },
      orch: { kind: 'orchestrator' },
      bare: { kind: 'pane' },
    }), roster);
    expect(split.closedPane).toEqual(['gui', 'orch', 'bare']);
    expect(split.byRow.size).toBe(0);
  });

  it('sends a legacy task with no origin stamp to the trailing group', () => {
    const split = splitTasksByPane(['legacy'], origins({}), roster);
    expect(split.closedPane).toEqual(['legacy']);
  });

  it('owner gone still lands in the workspace-level orphan group, not a pane group', () => {
    // The pane split only ever sees an open owner's tasks: buildSidebarTree
    // takes a task whose owner is gone out of every owner first.
    const tree = buildSidebarTree(rows('a', 't1'), links({ t1: { ownerId: 'closed-ws', detached: false } }));
    expect(tree.orphanTaskIds).toEqual(['t1']);
    expect(tree.top.find((n) => n.id === 'a')?.taskIds).toEqual([]);
  });

  it('keys fold state per owner and requesting surface', () => {
    expect(paneTaskFoldKey('ws1', 's1a')).not.toBe(paneTaskFoldKey('ws1', 's2'));
    expect(paneTaskFoldKey('ws1', 's1a')).not.toBe(paneTaskFoldKey('ws2', 's1a'));
    expect(closedPaneFoldKey('ws1')).not.toBe('ws1');
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
