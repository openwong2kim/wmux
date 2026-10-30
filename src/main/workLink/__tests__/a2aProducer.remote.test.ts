import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { recordPeerTaskState, recordSentTask, workLinkFromRemoteSend } from '../a2aProducer';
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

const peerTask = (state: string, evidence?: unknown) => ({ id: RT, status: { state, ...(evidence ? { evidence } : {}) } });

describe('work links for tasks sent to another PC', () => {
  it('records a remote send as queued work owned by the remote pane, named by its alias', async () => {
    await recordSentTask(send(), store);
    expect(store.getByTaskId(RT)).toMatchObject({
      origin: 'manual',
      state: 'queued',
      owner: { workspaceId: `remote:${LINK}`, name: 'mac-mini/wmux/#w1-2' },
      requester: { workspaceId: 'ws-co', paneId: 'pane-ceo' },
      title: 'Fix the flaky test',
    });
    await recordSentTask(send({ taskId: `rt-${'c'.repeat(32)}`, title: 'Flaky test' }), store);
    expect(store.getByTaskId(`rt-${'c'.repeat(32)}`)?.title).toBe('Flaky test');
  });

  it('follows the peer: a state new to the link is written once, the report kept on completion', async () => {
    await recordSentTask(send(), store);
    await recordPeerTaskState(peerTask('working'), store);
    const running = store.getByTaskId(RT);
    expect(running?.state).toBe('running');
    // The same state listed again on the next pull leaves the link as it was.
    await recordPeerTaskState(peerTask('working'), store);
    expect(store.getByTaskId(RT)?.updatedAt).toBe(running?.updatedAt);
    await recordPeerTaskState(peerTask('completed', { summary: 'Fixed; 3 runs green.', items: [] }), store);
    expect(store.getByTaskId(RT)).toMatchObject({ state: 'done', result: { summary: 'Fixed; 3 runs green.' } });
  });

  it('never invents a link for a task that was not sent from here', async () => {
    await recordPeerTaskState(peerTask('working'), store);
    expect(store.list({})).toEqual([]);
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
