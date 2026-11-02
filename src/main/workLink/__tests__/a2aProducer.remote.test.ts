import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { reconcileRemoteLinks, recordSentTask, workLinkFromRemoteSend } from '../a2aProducer';
import { WorkLinkStore } from '../workLinkStore';
import { parseWorkLink, WORK_LINK_LIMITS } from '../../../shared/workLink';

const LINK = '11111111-1111-4111-8111-111111111111';
const RT = `rt-${'b'.repeat(32)}`;

let dir: string;
let clock: number;
let store: WorkLinkStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'wmux-worklinks-remote-'));
  clock = 1000;
  store = new WorkLinkStore({ dir, pendingDecisionIds: () => new Set(), now: () => ++clock });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const send = (over: Partial<Parameters<typeof workLinkFromRemoteSend>[0]> = {}) => workLinkFromRemoteSend({
  taskId: RT, linkId: LINK, alias: 'mac-mini/wmux/#w1-2', requester: { workspaceId: 'ws-co', paneId: 'pane-ceo' },
  title: '', message: 'Fix the flaky test\nand report back', fromCommander: false, ...over,
});

describe('work links for tasks sent to another PC', () => {
  it('records a remote send as queued work owned by the remote pane, named by its alias', async () => {
    await recordSentTask(send(), store);
    expect(store.getByTaskId(RT)).toMatchObject({
      origin: 'manual',
      state: 'queued',
      owner: { workspaceId: `remote:${LINK}`, name: 'mac-mini/wmux/#w1-2' },
      requester: { workspaceId: 'ws-co', paneId: 'pane-ceo' },
      title: 'Fix the flaky test\nand report back',
    });
    await recordSentTask(send({ taskId: `rt-${'c'.repeat(32)}`, title: 'Flaky test' }), store);
    expect(store.getByTaskId(`rt-${'c'.repeat(32)}`)?.title).toBe('Flaky test');
  });

  it('keeps a finished link and its report once the daemon has dropped the task', async () => {
    await recordSentTask(send(), store);
    await store.upsert({ a2aTaskId: RT, a2aState: 'completed', result: { summary: 'Fixed.', at: 5 } });
    await reconcileRemoteLinks(async () => ({ ok: true, tasks: [] }), store);
    expect(store.getByTaskId(RT)).toMatchObject({ state: 'done', result: { summary: 'Fixed.' } });
  });

  it('changes nothing while the daemon gives no answer', async () => {
    await recordSentTask(send(), store);
    const before = store.getByTaskId(RT);
    await reconcileRemoteLinks(async () => ({ ok: false, error: 'a2a.task.query: task log unavailable' }), store);
    await reconcileRemoteLinks(async () => { throw new Error('DaemonClient not connected'); }, store);
    expect(store.getByTaskId(RT)).toEqual(before);
  });

  it('goes on to the next link when one link\'s query fails', async () => {
    const other = `rt-${'c'.repeat(32)}`;
    await recordSentTask(send(), store);
    await recordSentTask(send({ taskId: other }), store);
    let failed: unknown;
    await reconcileRemoteLinks(async (p) => {
      failed ??= p.taskId;
      if (p.taskId === failed) throw new Error('a2a.task.query timed out');
      return { ok: true, tasks: [{ id: p.taskId, status: { state: 'working' } }] };
    }, store);
    const healthy = failed === RT ? other : RT;
    expect(store.getByTaskId(String(failed))?.a2aState).toBe('submitted');
    expect(store.getByTaskId(healthy)?.a2aState).toBe('working');
  });

  it('keeps the link open when the report read gets no answer, and records the report on the next pull', async () => {
    await recordSentTask(send(), store);
    const before = store.getByTaskId(RT);
    const ended = { id: RT, status: { state: 'completed' } };
    const report = { id: RT, status: { state: 'completed', message: 'Fixed.', evidence: { summary: 'Fixed.', items: [] } } };
    await reconcileRemoteLinks(async (p) => (p.view === 'state' ? { ok: true, tasks: [ended] } : { ok: false, error: 'timed out' }), store);
    expect(store.getByTaskId(RT)).toEqual(before);
    await reconcileRemoteLinks(async (p) => ({ ok: true, tasks: [p.view === 'state' ? ended : report] }), store);
    expect(store.getByTaskId(RT)).toMatchObject({ a2aState: 'completed', result: { summary: 'Fixed.' } });
  });

  it('is not settled as orphaned when local workspaces close: the peer ends it', async () => {
    await recordSentTask(send(), store);
    expect(await store.abandonOrphaned(() => false)).toBe(0);
    expect(store.getByTaskId(RT)?.state).toBe('queued');
  });

  it('reads a remote owner back, and rejects a malformed one', () => {
    const base = { id: 'l1', origin: 'manual', state: 'queued', decisionIds: [], createdAt: 1, updatedAt: 1 };
    const long = 'x'.repeat(WORK_LINK_LIMITS.MAX_PARTY_NAME + 10);
    expect(parseWorkLink({ ...base, owner: { workspaceId: `remote:${LINK}`, name: long } })?.owner.name).toHaveLength(WORK_LINK_LIMITS.MAX_PARTY_NAME);
    expect(parseWorkLink({ ...base, owner: { workspaceId: 'remote:a/b' } })).toBeNull();
    expect(parseWorkLink({ ...base, owner: { workspaceId: 'remote:' } })).toBeNull();
    expect(parseWorkLink({ ...base, owner: { workspaceId: 'ws-1', name: '' } })).toBeNull();
  });
});
