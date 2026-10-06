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
  it('drops the old report when the task is reopened, so a later end without text has none', async () => {
    const a = make();
    await a.upsert(sent);
    await a.upsert({ a2aTaskId: 'task-1', a2aState: 'completed', result: { summary: 'First run.', at: 5 } });
    await a.upsert({ a2aTaskId: 'task-1', a2aState: 'working' });
    await a.upsert({ a2aTaskId: 'task-1', a2aState: 'completed' });
    expect(a.list({})[0].result).toBeUndefined();
  });

  it('keeps a finished task\'s report across later state-only updates and a reload', async () => {
    const a = make();
    await a.upsert(sent);
    await a.upsert({ a2aTaskId: 'task-1', a2aState: 'completed', result: { summary: 'Done; tests pass.', verification: '1/1', at: 5 } });
    await a.upsert({ a2aTaskId: 'task-1', a2aState: 'completed' });
    await a.flush();
    const [link] = make().list({});
    expect(link.result).toEqual({ summary: 'Done; tests pass.', verification: '1/1', at: 5 });
  });

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
    await s.reconcileDecisions();
    expect(s.get(link.id)).toMatchObject({ state: 'running', decisionIds: ['dec-1'] });
    expect(s.get(link.id)).not.toHaveProperty('reason');
    expect(await s.attachDecision('missing', 'dec-2')).toBeNull();
  });

  it('reads never show a decision that is no longer pending, even before a reconcile', async () => {
    const s = make();
    const link = (await s.upsert({ ...sent, a2aState: 'working' }))!;
    pending.add('dec-1');
    await s.attachDecision(link.id, 'dec-1');
    pending.clear(); // cleared by a loop reset: no answer, no hook yet
    expect(s.get(link.id)?.state).toBe('running');
    expect(s.getByTaskId('task-1')?.state).toBe('running');
    expect(s.list({ states: ['needs-you'] })).toEqual([]);
  });

  it('reconciles every link holding a changed decision in one pass', async () => {
    const s = make();
    const a = (await s.upsert({ ...sent, a2aState: 'working' }))!;
    const b = (await s.upsert({ ...sent, a2aTaskId: 'task-2', a2aState: 'working' }))!;
    pending.add('dec-1');
    await s.attachDecision(a.id, 'dec-1');
    await s.attachDecision(b.id, 'dec-1');
    pending.clear();
    const seen: string[][] = [];
    s.onChange((ids) => seen.push(ids));
    const done = s.reconcileDecisions();
    await s.upsert({ a2aTaskId: 'task-2', title: 'landed mid-reconcile' });
    await done;
    await s.flush();
    expect(seen[0]).toEqual([a.id, b.id]);
    expect(s.get(b.id)).toMatchObject({ state: 'running', title: 'landed mid-reconcile' });
    // Durable: a fresh load sees the settled states.
    expect(make().get(a.id)?.state).toBe('running');
  });

  it('settles stored states on load (a crash between an answer and its write)', async () => {
    const s = make();
    const link = (await s.upsert({ ...sent, a2aState: 'working' }))!;
    pending.add('dec-1');
    await s.attachDecision(link.id, 'dec-1');
    await s.flush();
    pending.clear();
    const fresh = make();
    expect(fresh.get(link.id)?.state).toBe('running');
    await fresh.flush();
    expect(JSON.parse(readFileSync(getWorkLinkPath(dir), 'utf8')).links[0].state).toBe('running');
  });

  it('a hand close sticks; a derived abandoned revives when the task or PR reopens', async () => {
    const s = make();
    const link = (await s.upsert(sent))!;
    expect(await s.setState(link.id, 'abandoned', 'conflict')).toMatchObject({ state: 'abandoned', manualClose: true });
    expect(s.get(link.id)).not.toHaveProperty('reason');
    expect(await s.upsert({ a2aTaskId: 'task-1', a2aState: 'working' })).toMatchObject({ state: 'abandoned' });

    await s.upsert({ ...sent, a2aTaskId: 'task-2', a2aState: 'canceled' });
    expect(s.getByTaskId('task-2')?.state).toBe('abandoned');
    expect(await s.upsert({ a2aTaskId: 'task-2', a2aState: 'submitted' })).toMatchObject({ state: 'queued' });

    const pr = { host: 'github.com', owner: 'acme', repo: 'widget', number: 7 };
    const status = (state: 'open' | 'closed') => ({ state, checks: null, reviewDecision: '', mergeable: '', observedAt: 1 });
    await s.upsert({ ...sent, a2aTaskId: 'task-3', a2aState: 'completed', pr, prStatus: status('closed') });
    expect(s.getByTaskId('task-3')?.state).toBe('abandoned');
    expect(await s.upsert({ a2aTaskId: 'task-3', prStatus: status('open') })).toMatchObject({ state: 'review' });
  });

  it('setState other than abandoned holds only while task and PR say nothing', async () => {
    const s = make();
    const bare = (await s.upsert({ origin: 'manual', owner: { workspaceId: 'ws-1' } }))!;
    expect(await s.setState(bare.id, 'blocked')).toMatchObject({ state: 'blocked', reason: 'other' });
    const tasked = (await s.upsert({ ...sent, a2aState: 'working' }))!;
    expect(await s.setState(tasked.id, 'blocked')).toMatchObject({ state: 'running' });
  });

  it('promotes origin manual to issue, and nothing else', async () => {
    const s = make();
    const issue = { host: 'github.com', owner: 'acme', repo: 'widget', number: 42, title: 'Crash', url: 'https://github.com/acme/widget/issues/42' };
    const m = (await s.upsert(sent))!;
    expect(await s.upsert({ id: m.id, origin: 'issue', issue })).toMatchObject({ origin: 'issue', issue });
    const moa = (await s.upsert({ ...sent, a2aTaskId: 'task-2', origin: 'moa' }))!;
    expect(await s.upsert({ id: moa.id, origin: 'issue', issue })).toMatchObject({ origin: 'moa', issue });
    const i = (await s.upsert({ origin: 'issue', issue, owner: { workspaceId: 'ws-1' } }))!;
    expect(await s.upsert({ id: i.id, origin: 'manual' })).toMatchObject({ origin: 'issue' });
    expect(await s.upsert({ id: m.id, origin: 'issue' })).toMatchObject({ origin: 'issue' });
    const bad = (await s.upsert({ ...sent, a2aTaskId: 'task-3' }))!;
    expect(await s.upsert({ id: bad.id, origin: 'issue' })).toBeNull(); // issue origin needs an issue
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

  it('never evicts the link being committed', async () => {
    clock = 5;
    const stuck = () => 5;
    const ended = Array.from({ length: MAX_WORK_LINKS + 2 }, (_, i) => ({
      id: `l-${i}`, origin: 'manual', owner: { workspaceId: 'ws-1' }, state: 'done', decisionIds: [], createdAt: 5, updatedAt: 5,
    }));
    writeFileSync(getWorkLinkPath(dir), JSON.stringify({ version: 1, links: ended }));
    const s = new WorkLinkStore({ dir, pendingDecisionIds: () => pending, now: stuck });
    expect(await s.attachDecision('l-0', 'dec-1')).not.toBeNull();
    expect(s.get('l-0')?.decisionIds).toEqual(['dec-1']);
    expect(s.list()).toHaveLength(MAX_WORK_LINKS);
  });
});

describe('WorkLinkStore.abandonOrphaned', () => {
  it('settles open links owned by a workspace that is gone, and only those', async () => {
    const a = make();
    await a.upsert({ ...sent, a2aState: 'working' });
    await a.upsert({ origin: 'manual', a2aTaskId: 'task-2', a2aState: 'working', owner: { workspaceId: 'ws-live' } });
    await a.upsert({ origin: 'manual', a2aTaskId: 'task-3', a2aState: 'completed', owner: { workspaceId: 'ws-1' } });
    expect(a.getByTaskId('task-1')?.state).toBe('running');

    expect(await a.abandonOrphaned((id) => id === 'ws-live')).toBe(1);

    expect(a.getByTaskId('task-1')?.state).toBe('abandoned');
    expect(a.getByTaskId('task-2')?.state).toBe('running');
    expect(a.getByTaskId('task-3')?.state).toBe('done');
    // It holds: a later state-only update of the dead task does not revive it.
    await a.upsert({ a2aTaskId: 'task-1', a2aState: 'working' });
    expect(a.getByTaskId('task-1')?.state).toBe('abandoned');
  });

  it('leaves a link with a PR alone (the PR outlives the workspace)', async () => {
    const a = make();
    await a.upsert({ ...sent, a2aState: 'completed', pr: { host: 'github.com', owner: 'o', repo: 'r', number: 7, url: 'https://github.com/o/r/pull/7' } });
    expect(await a.abandonOrphaned(() => false)).toBe(0);
    expect(a.getByTaskId('task-1')?.state).not.toBe('abandoned');
  });
});

