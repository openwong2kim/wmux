import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MAX_WORK_LINKS, WorkLinkStore, getWorkLinkPath } from '../workLinkStore';

let dir: string;
let pending: Set<string>;
let clock: number;
const make = () => new WorkLinkStore({ dir, pendingDecisionIds: () => pending, now: () => ++clock });

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wmux-worklinks-'));
  pending = new Set();
  clock = 1000;
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const sent = { origin: 'manual' as const, a2aTaskId: 'task-1', a2aState: 'submitted' as const, owner: { workspaceId: 'ws-1' } };

describe('WorkLinkStore', () => {
  it('round-trips through the file', async () => {
    const a = make();
    const link = (await a.upsert({ ...sent, title: 'Fix it', requester: { workspaceId: 'ws-0', paneId: 'p-1' } }))!;
    expect(link).toMatchObject({ state: 'queued', a2aTaskId: 'task-1', decisionIds: [] });
    await a.flush();

    const b = make();
    expect(b.get(link.id)).toEqual(link);
    expect(b.getByTaskId('task-1')).toEqual(link);
    expect(JSON.parse(readFileSync(getWorkLinkPath(dir), 'utf8'))).toMatchObject({ version: 1, links: [link] });
  });

  it('merges by task id, keeps id/origin/createdAt, and re-derives state', async () => {
    const s = make();
    const first = (await s.upsert(sent))!;
    const next = (await s.upsert({ a2aTaskId: 'task-1', a2aState: 'working', origin: 'moa' }))!;
    expect(next).toMatchObject({ id: first.id, origin: 'manual', createdAt: first.createdAt, state: 'running' });
    expect(next.updatedAt).toBeGreaterThan(first.updatedAt);
    expect(s.list()).toHaveLength(1);
  });

  it('refuses a new link without origin and owner, and an invalid one', async () => {
    const s = make();
    expect(await s.upsert({ a2aTaskId: 'nope', a2aState: 'working' })).toBeNull();
    expect(await s.upsert({ ...sent, owner: { workspaceId: 'bad id' } })).toBeNull();
    expect(s.list()).toEqual([]);
  });

  it('keeps one link per task', async () => {
    const s = make();
    const a = (await s.upsert(sent))!;
    const b = (await s.upsert({ origin: 'manual', owner: { workspaceId: 'ws-2' } }))!;
    expect(await s.upsert({ id: b.id, a2aTaskId: a.a2aTaskId })).toBeNull();
    expect(s.get(b.id)!.a2aTaskId).toBeUndefined();
  });

  it('lists by filter, newest first', async () => {
    const s = make();
    await s.upsert(sent);
    await s.upsert({ ...sent, a2aTaskId: 'task-2', owner: { workspaceId: 'ws-2' } });
    expect(s.list().map((l) => l.a2aTaskId)).toEqual(['task-2', 'task-1']);
    expect(s.list({ workspaceId: 'ws-1' }).map((l) => l.a2aTaskId)).toEqual(['task-1']);
  });

  it('attaches a decision and follows it to needs-you and back', async () => {
    const s = make();
    const link = (await s.upsert({ ...sent, a2aState: 'working' }))!;
    pending.add('dec-1');
    expect(await s.attachDecision(link.id, 'dec-1')).toMatchObject({ state: 'needs-you', reason: 'decision', decisionIds: ['dec-1'] });
    pending.delete('dec-1');
    await s.refreshDecision('dec-1');
    expect(s.get(link.id)).toMatchObject({ state: 'running', decisionIds: ['dec-1'] });
    expect(s.get(link.id)).not.toHaveProperty('reason');
    expect(await s.attachDecision('missing', 'dec-2')).toBeNull();
  });

  it('refreshes every link holding an answered decision, keeping their other fields', async () => {
    const s = make();
    const a = (await s.upsert({ ...sent, a2aState: 'working' }))!;
    const b = (await s.upsert({ ...sent, a2aTaskId: 'task-2', a2aState: 'working' }))!;
    pending.add('dec-1');
    await s.attachDecision(a.id, 'dec-1');
    await s.attachDecision(b.id, 'dec-1');
    pending.clear();
    const seen: string[][] = [];
    s.onChange((ids) => seen.push(ids));
    const refresh = s.refreshDecision('dec-1');
    await s.upsert({ a2aTaskId: 'task-2', title: 'landed mid-refresh' });
    await refresh;
    expect(seen[0]).toEqual([a.id, b.id]);
    expect(s.get(a.id)?.state).toBe('running');
    expect(s.get(b.id)).toMatchObject({ state: 'running', title: 'landed mid-refresh' });
  });

  it('setState: abandoned sticks, others yield to the next derivation', async () => {
    const s = make();
    const link = (await s.upsert(sent))!;
    expect(await s.setState(link.id, 'blocked')).toMatchObject({ state: 'blocked', reason: 'other' });
    expect(await s.upsert({ a2aTaskId: 'task-1', a2aState: 'working' })).toMatchObject({ state: 'running' });
    expect(await s.setState(link.id, 'abandoned', 'conflict')).not.toHaveProperty('reason');
    expect(await s.upsert({ a2aTaskId: 'task-1', a2aState: 'completed' })).toMatchObject({ state: 'abandoned' });
  });

  it('tells listeners which links changed', async () => {
    const s = make();
    const seen: string[][] = [];
    const off = s.onChange((ids) => seen.push(ids));
    const link = (await s.upsert(sent))!;
    off();
    await s.upsert({ a2aTaskId: 'task-1', a2aState: 'working' });
    expect(seen).toEqual([[link.id]]);
  });

  it('starts empty on a torn file and writes a good one over it', async () => {
    writeFileSync(getWorkLinkPath(dir), '{"links": [ torn');
    const s = make();
    expect(s.list()).toEqual([]);
    expect(await s.upsert(sent)).not.toBeNull();
    await s.flush();
    expect(make().list()).toHaveLength(1);
  });

  it('starts empty on a file of the wrong shape', () => {
    writeFileSync(getWorkLinkPath(dir), JSON.stringify({ version: 1, links: 'nope' }));
    expect(make().list()).toEqual([]);
  });

  it('drops bad and duplicate records one by one', () => {
    const good = { id: 'a', origin: 'manual', owner: { workspaceId: 'ws-1' }, state: 'queued', decisionIds: [], createdAt: 1, updatedAt: 1, a2aTaskId: 't' };
    writeFileSync(getWorkLinkPath(dir), JSON.stringify({
      version: 1,
      links: [good, { ...good, id: 'b', state: 'bogus' }, { ...good, id: 'c', updatedAt: 5 }, 42, null],
    }));
    expect(make().list().map((l) => l.id)).toEqual(['c']);
  });

  it('evicts the oldest ended links first past the cap', async () => {
    const s = make();
    const done = (await s.upsert({ ...sent, a2aTaskId: 'old-done', a2aState: 'completed' }))!;
    for (let i = 0; i < MAX_WORK_LINKS; i++) {
      await s.upsert({ ...sent, a2aTaskId: `t-${i}` });
    }
    expect(s.list()).toHaveLength(MAX_WORK_LINKS);
    expect(s.get(done.id)).toBeNull();
    expect(s.getByTaskId('t-0')).not.toBeNull();
  });
});
