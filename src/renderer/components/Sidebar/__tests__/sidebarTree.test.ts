// #1481 — fan-out nesting, rollup, default expansion and "finished".
import { describe, expect, it } from 'vitest';
import { buildSidebarTree, isFinishedTask, isTaskGroupExpanded, taskRollup } from '../sidebarTree';
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
  });
});

describe('taskRollup', () => {
  const status = (map: Record<string, AgentStatus>) => (id: string) => map[id] ?? 'idle';

  it('counts tasks and the ones that need you', () => {
    expect(taskRollup(['a', 'b', 'c'], status({ a: 'awaiting_input', b: 'running', c: 'waiting' }))).toEqual({ tasks: 3, needYou: 2 });
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

  it('lets the remembered toggle win', () => {
    expect(isTaskGroupExpanded({ remembered: false, ownerActive: true, anyNeedsYou: true })).toBe(false);
    expect(isTaskGroupExpanded({ remembered: true, ownerActive: false, anyNeedsYou: false })).toBe(true);
  });
});

describe('isFinishedTask', () => {
  it('offers complete, idle and ledger-closed tasks, never running, blocked or errored ones', () => {
    expect(isFinishedTask('complete', false)).toBe(true);
    expect(isFinishedTask('idle', false)).toBe(true);
    expect(isFinishedTask('running', true)).toBe(true);
    expect(isFinishedTask('running', false)).toBe(false);
    expect(isFinishedTask('awaiting_input', false)).toBe(false);
    expect(isFinishedTask('error', false)).toBe(false);
  });
});
