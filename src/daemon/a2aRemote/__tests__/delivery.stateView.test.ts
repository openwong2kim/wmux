// The asking PC's batched state read (a2a.task.query, view: 'state' with
// taskIds) as the daemon serves it: each sent task goes through
// A2aRemoteDelivery.withRemoteStatus first, so a status held back by the
// per-task gap shows up in the read once the gap is over. Real ledger, link
// store and delivery layer; no transport.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { A2A_REMOTE_PROTOCOL, isRemoteTaskId, type A2aRemoteEnvelope, type A2aRemoteStatusV1 } from '../../../shared/a2aRemote';
import { applyTaskQueryView } from '../../../shared/a2aTaskQueryView';
import type { Task } from '../../../shared/types';
import { A2aTaskService } from '../../a2a/A2aTaskService';
import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { A2aRemoteDelivery, REMOTE_STATUS_TASK_GAP_MS } from '../delivery';
import { remoteTaskId } from '../ids';
import { LinkStore } from '../linkStore';

const HOST = '22222222-2222-4222-8222-222222222222';

let dir: string;
let log: AppendOnlyLog;
let delivery: A2aRemoteDelivery;
let tasks: A2aTaskService;
let links: LinkStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-state-view-'));
  log = new AppendOnlyLog({ dir: path.join(dir, 'log'), fsync: () => undefined });
  log.open();
  tasks = new A2aTaskService({ log, origin: { machineId: 'pc-a', daemonEpoch: 1 } });
  const quiet = (): void => undefined;
  links = new LinkStore({ dir: path.join(dir, 'a2a'), scheduleHarden: quiet });
  delivery = new A2aRemoteDelivery({
    dir: path.join(dir, 'a2a'),
    links,
    taskService: tasks,
    peers: { list: () => [] },
    remoteHosts: { list: () => [], get: () => undefined, credentialFor: () => null },
    broadcast: quiet,
    refreshLink: async () => undefined,
    log: quiet,
  });
});
afterEach(async () => {
  vi.useRealTimers();
  await delivery.stop();
  log.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

/** A task this PC sent over an active link to HOST. */
async function sentTask(): Promise<{ linkId: string; taskId: string }> {
  const linkId = crypto.randomUUID();
  links.receiveProposal({
    linkId,
    local: { kind: 'pane', workspaceId: 'ws-a', paneId: `pane-a-${linkId.slice(0, 4)}` },
    remote: { hostId: HOST, kind: 'pane', workspaceId: 'ws-b', paneId: `pane-b-${linkId.slice(0, 4)}`, label: 'claude' },
    allow: { outbound: true, inbound: true },
  });
  links.accept(linkId);
  const taskId = remoteTaskId(linkId, 'mine-1');
  const res = await tasks.createTask({
    id: taskId,
    title: 'mine',
    from: { workspaceId: 'ws-a', name: 'Frontend', paneId: 'pane-a' },
    to: { workspaceId: `remote:${linkId}`, name: 'pc-b/ws-b/claude' },
    history: [{ kind: 'message', messageId: 'mine-1', role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
    remote: { v: 1, linkId, hostId: HOST, messageId: 'mine-1', direction: 'outbound', kind: 'pane' },
  });
  expect(res.ok).toBe(true);
  return { linkId, taskId };
}

const statusEnv = (linkId: string, taskId: string, status: Partial<A2aRemoteStatusV1>): A2aRemoteEnvelope => ({
  protocol: A2A_REMOTE_PROTOCOL,
  linkId,
  linkVersion: 2,
  messageId: crypto.randomUUID(),
  kind: 'status',
  taskId,
  status: { kind: 'working', since: new Date().toISOString(), ...status } as A2aRemoteStatusV1,
  sentAt: new Date().toISOString(),
});

/** What the daemon's a2a.task.query answers for main's batched state read. */
function stateRead(taskIds: string[]): Array<{ id: string; metadata: { remote?: { status?: { kind: string; detail?: Record<string, unknown> } } } }> {
  const shown = tasks.queryTasks('ws-a', {}).map((t) => (isRemoteTaskId(t.id) ? delivery.withRemoteStatus(t as Task) : t));
  return applyTaskQueryView(shown, { view: 'state', taskIds }) as ReturnType<typeof stateRead>;
}

describe("main's batched state read of tasks sent to another PC", () => {
  it('shows a status held back by the per-task gap once the gap is over, with no further message', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-11-13T07:00:00.000Z'));
    const at = (ms: number): string => new Date(Date.now() + ms).toISOString();
    const a = await sentTask();
    const b = await sentTask();
    await delivery.accept(statusEnv(a.linkId, a.taskId, { kind: 'working', since: at(0) }), { hostId: HOST });
    // Inside the gap: held, not applied yet.
    await delivery.accept(statusEnv(a.linkId, a.taskId, { kind: 'waiting-input', since: at(1) }), { hostId: HOST });
    const statusOf = (rows: ReturnType<typeof stateRead>, id: string) => rows.find((r) => r.id === id)?.metadata.remote?.status;
    expect(statusOf(stateRead([a.taskId, b.taskId]), a.taskId)?.kind).toBe('working');
    vi.setSystemTime(Date.now() + REMOTE_STATUS_TASK_GAP_MS);
    const rows = stateRead([a.taskId, b.taskId]);
    expect(rows.map((r) => r.id).sort()).toEqual([a.taskId, b.taskId].sort());
    expect(statusOf(rows, a.taskId)?.kind).toBe('waiting-input');
    expect(statusOf(rows, b.taskId)).toBeUndefined();
  });

  it('shows a question at once, by kind, without the menu labels', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-11-13T07:00:00.000Z'));
    const a = await sentTask();
    await delivery.accept(statusEnv(a.linkId, a.taskId, { kind: 'working' }), { hostId: HOST });
    await delivery.accept(statusEnv(a.linkId, a.taskId, { kind: 'question', detail: { question: 'menu', menuId: 'toolu_1', options: ['Red', 'Blue'] } }), { hostId: HOST });
    const rows = stateRead([a.taskId]);
    expect(rows[0].metadata.remote?.status).toMatchObject({ kind: 'question', detail: { question: 'menu', menuId: 'toolu_1' } });
    expect(JSON.stringify(rows)).not.toMatch(/Red|Blue/);
  });
});
