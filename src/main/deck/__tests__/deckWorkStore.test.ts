// Durable human-request ownership.
//
// A direct message to the commander is explicit permission to carry that work
// through its delegated pane/A2A stages, even when the workspace's resting
// autonomy is `off`. The record outlives a turn, a pane stop, an A2A handoff and
// an app restart, and is closed only by an explicit deck_complete_work the
// server has verified. These lock the store's contract: one active item per
// workspace, follow-ups appended (never silently replacing running work),
// pointer-only A2A projection, and compare-and-delete on completion.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  beginOrContinueDeckWork,
  recordDeckWorkA2aTask,
  completeActiveDeckWork,
  clearActiveDeckWork,
  loadActiveDeckWork,
  loadActiveDeckWorks,
  hasPendingDeckWorkA2aTasks,
  renderActiveDeckWorkBlock,
  getDeckWorkPath,
} from '../deckWorkStore';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wmux-deckwork-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('deckWorkStore — ownership lifecycle', () => {
  it('starts a request and loads it back from disk', () => {
    const work = beginOrContinueDeckWork('ws-1', 'ship the badge PR', dir)!;
    expect(work).toMatchObject({ workspaceId: 'ws-1', objective: 'ship the badge PR', followUps: [] });
    expect(work.id).toMatch(/^work-/);
    // Durability: a fresh read (no in-memory cache) must see it.
    expect(loadActiveDeckWork('ws-1', dir)).toMatchObject({ id: work.id });
  });

  it('is per-workspace and does not leak across workspaces', () => {
    beginOrContinueDeckWork('ws-1', 'first', dir);
    beginOrContinueDeckWork('ws-2', 'second', dir);
    expect(loadActiveDeckWork('ws-1', dir)!.objective).toBe('first');
    expect(loadActiveDeckWork('ws-2', dir)!.objective).toBe('second');
    expect(Object.keys(loadActiveDeckWorks(dir)).sort()).toEqual(['ws-1', 'ws-2']);
  });

  it('APPENDS a second human message instead of abandoning running work', () => {
    const first = beginOrContinueDeckWork('ws-1', 'build it', dir)!;
    const second = beginOrContinueDeckWork('ws-1', 'also add tests', dir)!;
    // Same work item — workers already running under it keep their owner.
    expect(second.id).toBe(first.id);
    expect(second.objective).toBe('build it');
    expect(second.followUps).toEqual(['also add tests']);
  });

  it('does not record a follow-up that merely repeats the objective', () => {
    beginOrContinueDeckWork('ws-1', 'build it', dir);
    const again = beginOrContinueDeckWork('ws-1', 'build it', dir)!;
    expect(again.followUps).toEqual([]);
  });

  it('collapses an immediately repeated follow-up', () => {
    beginOrContinueDeckWork('ws-1', 'objective', dir);
    beginOrContinueDeckWork('ws-1', 'retry', dir);
    const third = beginOrContinueDeckWork('ws-1', 'retry', dir)!;
    expect(third.followUps).toEqual(['retry']);
  });

  it('caps the follow-up list, keeping the most recent', () => {
    beginOrContinueDeckWork('ws-1', 'objective', dir);
    for (let i = 1; i <= 20; i++) beginOrContinueDeckWork('ws-1', `step ${i}`, dir);
    const work = loadActiveDeckWork('ws-1', dir)!;
    expect(work.followUps.length).toBeLessThanOrEqual(12);
    expect(work.followUps.at(-1)).toBe('step 20');
  });

  it('refuses an empty or whitespace-only request', () => {
    expect(beginOrContinueDeckWork('ws-1', '   ', dir)).toBeNull();
    expect(loadActiveDeckWork('ws-1', dir)).toBeNull();
  });

  it('refuses a malformed workspace id (path-traversal shaped)', () => {
    expect(beginOrContinueDeckWork('../escape', 'x', dir)).toBeNull();
    expect(loadActiveDeckWork('../escape', dir)).toBeNull();
  });

  it('preserves the ownership start while advancing updatedAt on a follow-up', () => {
    const first = beginOrContinueDeckWork('ws-1', 'objective', dir, 1_000)!;
    const second = beginOrContinueDeckWork('ws-1', 'follow', dir, 5_000)!;
    expect(first.startedAt).toBe(1_000);
    expect(second.startedAt).toBe(1_000);
    expect(second.updatedAt).toBe(5_000);
  });
});

describe('deckWorkStore — completion', () => {
  it('completes with a matching revision and removes the record', () => {
    const work = beginOrContinueDeckWork('ws-1', 'objective', dir)!;
    expect(completeActiveDeckWork('ws-1', work, dir)).toMatchObject({ id: work.id });
    expect(loadActiveDeckWork('ws-1', dir)).toBeNull();
  });

  it('REFUSES to close a newer request with an older verdict (compare-and-delete)', () => {
    // The commander's completion check is async; a human prompt can land while
    // it is in flight. Closing on the stale record would silently drop the new work.
    const first = beginOrContinueDeckWork('ws-1', 'objective', dir)!;
    completeActiveDeckWork('ws-1', first, dir);
    const second = beginOrContinueDeckWork('ws-1', 'brand new request', dir)!;
    expect(second.id).not.toBe(first.id);

    expect(completeActiveDeckWork('ws-1', first, dir)).toBeNull();
    expect(loadActiveDeckWork('ws-1', dir)!.id).toBe(second.id);
  });

  it('REFUSES when a human FOLLOW-UP landed mid-check (same id, new revision)', () => {
    // The id alone is not enough: a follow-up keeps the work id, so an id-only
    // comparison would delete ownership of instructions the brain never saw.
    const before = beginOrContinueDeckWork('ws-1', 'objective', dir, 1_000)!;
    beginOrContinueDeckWork('ws-1', 'also do this', dir, 2_000);

    expect(completeActiveDeckWork('ws-1', before, dir)).toBeNull();
    const surviving = loadActiveDeckWork('ws-1', dir)!;
    expect(surviving.id).toBe(before.id);
    expect(surviving.followUps).toEqual(['also do this']);
  });

  it('REFUSES when an A2A transition landed mid-check (same id, new tasks)', () => {
    const before = beginOrContinueDeckWork('ws-1', 'objective', dir, 1_000)!;
    recordDeckWorkA2aTask(
      'ws-1',
      { taskId: 'task-late', to: 'ws-worker', state: 'working', ts: 3_000 },
      dir,
    );
    expect(completeActiveDeckWork('ws-1', before, dir)).toBeNull();
    expect(loadActiveDeckWork('ws-1', dir)!.a2aTasks['task-late']).toBeDefined();
  });

  it('completing an absent record is a null no-op', () => {
    const ghost = beginOrContinueDeckWork('ws-1', 'objective', dir)!;
    clearActiveDeckWork('ws-1', dir);
    expect(completeActiveDeckWork('ws-1', ghost, dir)).toBeNull();
  });

  it('clearActiveDeckWork drops the record unconditionally (conversation clear)', () => {
    beginOrContinueDeckWork('ws-1', 'objective', dir);
    clearActiveDeckWork('ws-1', dir);
    expect(loadActiveDeckWork('ws-1', dir)).toBeNull();
    expect(() => clearActiveDeckWork('ws-1', dir)).not.toThrow();
  });
});

describe('deckWorkStore — A2A projection', () => {
  const task = (over: Record<string, unknown> = {}) => ({
    taskId: 'task-1',
    to: 'ws-worker',
    state: 'submitted' as const,
    ts: 2_000,
    ...over,
  });

  it('projects a task onto the active request', () => {
    beginOrContinueDeckWork('ws-1', 'objective', dir, 1_000);
    const work = recordDeckWorkA2aTask('ws-1', task(), dir)!;
    expect(work.a2aTasks['task-1']).toMatchObject({ taskId: 'task-1', to: 'ws-worker', state: 'submitted' });
  });

  it('updates a tracked task in place as it transitions', () => {
    beginOrContinueDeckWork('ws-1', 'objective', dir, 1_000);
    recordDeckWorkA2aTask('ws-1', task(), dir);
    const work = recordDeckWorkA2aTask('ws-1', task({ state: 'completed', ts: 3_000, verifiedItemCount: 2 }), dir)!;
    expect(Object.keys(work.a2aTasks)).toEqual(['task-1']);
    expect(work.a2aTasks['task-1']).toMatchObject({ state: 'completed', verifiedItemCount: 2 });
  });

  it('IGNORES a task older than the request (it belongs to earlier work)', () => {
    beginOrContinueDeckWork('ws-1', 'objective', dir, 5_000);
    const work = recordDeckWorkA2aTask('ws-1', task({ ts: 1_000 }), dir)!;
    expect(work.a2aTasks).toEqual({});
  });

  it('is a no-op when no request is active', () => {
    expect(recordDeckWorkA2aTask('ws-1', task(), dir)).toBeNull();
  });

  it('rejects a malformed transition rather than storing junk', () => {
    beginOrContinueDeckWork('ws-1', 'objective', dir, 1_000);
    const work = recordDeckWorkA2aTask('ws-1', task({ state: 'not-a-state' as never }), dir)!;
    expect(work.a2aTasks).toEqual({});
  });

  it('reports pending work for non-terminal states only', () => {
    beginOrContinueDeckWork('ws-1', 'objective', dir, 1_000);
    for (const state of ['submitted', 'working', 'input-required'] as const) {
      recordDeckWorkA2aTask('ws-1', task({ taskId: `t-${state}`, state }), dir);
    }
    expect(hasPendingDeckWorkA2aTasks(loadActiveDeckWork('ws-1', dir)!)).toBe(true);

    clearActiveDeckWork('ws-1', dir);
    beginOrContinueDeckWork('ws-1', 'objective', dir, 1_000);
    recordDeckWorkA2aTask('ws-1', task({ state: 'completed' }), dir);
    recordDeckWorkA2aTask('ws-1', task({ taskId: 'task-2', state: 'failed' }), dir);
    expect(hasPendingDeckWorkA2aTasks(loadActiveDeckWork('ws-1', dir)!)).toBe(false);
  });
});

describe('deckWorkStore — corrupt / hostile file handling', () => {
  it('treats an unreadable file as no active work rather than throwing', () => {
    writeFileSync(getDeckWorkPath(dir), 'not json at all', 'utf8');
    expect(loadActiveDeckWork('ws-1', dir)).toBeNull();
    expect(loadActiveDeckWorks(dir)).toEqual({});
  });

  it('drops entries that fail validation instead of surfacing partial records', () => {
    writeFileSync(
      getDeckWorkPath(dir),
      JSON.stringify({
        version: 1,
        active: {
          'ws-good': {
            id: 'work-good', objective: 'real', followUps: [],
            startedAt: 1, updatedAt: 1, a2aTasks: {},
          },
          'ws-bad': { id: '', objective: '', startedAt: 0, updatedAt: 0 },
          '../traversal': {
            id: 'work-x', objective: 'x', followUps: [],
            startedAt: 1, updatedAt: 1, a2aTasks: {},
          },
        },
      }),
      'utf8',
    );
    expect(Object.keys(loadActiveDeckWorks(dir))).toEqual(['ws-good']);
  });

  it('re-derives workspaceId from the key so a forged inner field cannot cross workspaces', () => {
    writeFileSync(
      getDeckWorkPath(dir),
      JSON.stringify({
        version: 1,
        active: {
          'ws-1': {
            id: 'work-1', workspaceId: 'ws-victim', objective: 'x', followUps: [],
            startedAt: 1, updatedAt: 1, a2aTasks: {},
          },
        },
      }),
      'utf8',
    );
    expect(loadActiveDeckWork('ws-1', dir)!.workspaceId).toBe('ws-1');
  });

  it('writes valid JSON that round-trips', () => {
    beginOrContinueDeckWork('ws-1', 'objective', dir);
    const raw = JSON.parse(readFileSync(getDeckWorkPath(dir), 'utf8'));
    expect(raw.version).toBe(1);
    expect(raw.active['ws-1'].objective).toBe('objective');
  });
});

describe('renderActiveDeckWorkBlock', () => {
  it('carries the objective, follow-ups and the finalization instruction', () => {
    beginOrContinueDeckWork('ws-1', 'ship the roster', dir, 1_000);
    beginOrContinueDeckWork('ws-1', 'and translate it', dir, 2_000);
    const block = renderActiveDeckWorkBlock(loadActiveDeckWork('ws-1', dir)!);
    expect(block).toContain('[active-work]');
    expect(block).toContain('ship the roster');
    expect(block).toContain('and translate it');
    // The brain must be told that a turn ending is not completion.
    expect(block).toContain('deck_complete_work');
    expect(block).toMatch(/do NOT finish it/i);
  });

  it('lists tracked tasks as POINTERS and tells the brain to query canonical state', () => {
    beginOrContinueDeckWork('ws-1', 'objective', dir, 1_000);
    recordDeckWorkA2aTask(
      'ws-1',
      { taskId: 'task-9', to: 'ws-worker', state: 'completed', ts: 2_000, verifiedItemCount: 0 },
      dir,
    );
    const block = renderActiveDeckWorkBlock(loadActiveDeckWork('ws-1', dir)!);
    expect(block).toContain('task=task-9');
    expect(block).toContain('to=ws-worker');
    expect(block).toContain('verified-evidence=0');
    expect(block).toMatch(/query canonical state/i);
  });
});
