// A worker's status on the asking PC (A2aRemoteDelivery): what a2a_task_query
// returns in every view, how a peer's `since` is taken, and the per-peer
// receive limit. Real ledger, link store and delivery layer; no transport.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { A2A_REMOTE_PROTOCOL, type A2aRemoteEnvelope, type A2aRemoteStatusV1 } from '../../../shared/a2aRemote';
import { applyTaskQueryView } from '../../../shared/a2aTaskQueryView';
import type { Task } from '../../../shared/types';
import { A2aTaskService } from '../../a2a/A2aTaskService';
import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { A2aRemoteDelivery, REMOTE_STATUS_PER_WINDOW, REMOTE_STATUS_TASK_GAP_MS } from '../delivery';
import { remoteTaskId } from '../ids';
import { LinkStore } from '../linkStore';

const HOST = '22222222-2222-4222-8222-222222222222';
const SINCE = '2026-11-13T06:00:00.000Z';

let dir: string;
let log: AppendOnlyLog;
let delivery: A2aRemoteDelivery;
let tasks: A2aTaskService;
let links: LinkStore;
let logs: string[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-status-'));
  log = new AppendOnlyLog({ dir: path.join(dir, 'log'), fsync: () => undefined });
  log.open();
  tasks = new A2aTaskService({ log, origin: { machineId: 'pc-a', daemonEpoch: 1 } });
  const quiet = (): void => undefined;
  links = new LinkStore({ dir: path.join(dir, 'a2a'), scheduleHarden: quiet });
  logs = [];
  delivery = new A2aRemoteDelivery({
    dir: path.join(dir, 'a2a'),
    links,
    taskService: tasks,
    peers: { list: () => [] },
    remoteHosts: { list: () => [], get: () => undefined, credentialFor: () => null },
    broadcast: quiet,
    refreshLink: async () => undefined,
    log: (_level, msg) => { logs.push(msg); },
  });
});
afterEach(async () => {
  vi.useRealTimers();
  await delivery.stop();
  log.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

/** A task this PC (A) sent over an active link to HOST. */
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
  status: { kind: 'working', since: SINCE, ...status } as A2aRemoteStatusV1,
  sentAt: new Date().toISOString(),
});

const shown = (taskId: string): Record<string, unknown> | undefined =>
  (delivery.withRemoteStatus(tasks.getTask(taskId) as Task).metadata.remote as { status?: Record<string, unknown> }).status;

describe('a worker status on the asking PC', () => {
  it('a menu\'s labels sit only under `untrusted`, in the full task, the legacy list and the summary row alike', async () => {
    const { linkId, taskId } = await sentTask();
    const menu = { kind: 'question' as const, detail: { question: 'menu' as const, menuId: 'toolu_1', options: ['Red', 'Blue'] } };
    expect(await delivery.accept(statusEnv(linkId, taskId, menu), { hostId: HOST })).toMatchObject({ ok: true });
    const task = delivery.withRemoteStatus(tasks.getTask(taskId) as Task);
    const views = [
      applyTaskQueryView([task], { taskId }),
      applyTaskQueryView([task], {}),
      applyTaskQueryView([task], { view: 'page' }),
    ].map((v) => JSON.stringify(v));
    for (const v of views) {
      expect(v).toContain('"untrusted":{"options":["Red","Blue"]}');
      // Nowhere else: not inside a detail, not beside the asker's own fields.
      expect(v.match(/"options":/g)).toHaveLength(1);
    }
    expect(shown(taskId)).toEqual({ kind: 'question', since: SINCE, detail: { question: 'menu', menuId: 'toolu_1' }, untrusted: { options: ['Red', 'Blue'] } });
  });

  it('a `since` far ahead of this PC\'s clock counts as now, and the newest is chosen by time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-11-13T07:00:00.000Z'));
    const { linkId, taskId } = await sentTask();
    await delivery.accept(statusEnv(linkId, taskId, { kind: 'question', since: '2099-01-01T00:00:00.000Z' }), { hostId: HOST });
    const pinned = Date.parse(shown(taskId)!.since as string);
    expect(pinned).toBeLessThanOrEqual(Date.now() + 60_000);
    // A later real status still replaces it (it is not held back by the far-future date).
    vi.setSystemTime(Date.now() + REMOTE_STATUS_TASK_GAP_MS);
    await delivery.accept(statusEnv(linkId, taskId, { kind: 'waiting-input', since: new Date(Date.now() + 61_000).toISOString() }), { hostId: HOST });
    expect(shown(taskId)!.kind).toBe('waiting-input');
    // An older one does not, once its gap is over either.
    await delivery.accept(statusEnv(linkId, taskId, { kind: 'working', since: SINCE }), { hostId: HOST });
    vi.setSystemTime(Date.now() + REMOTE_STATUS_TASK_GAP_MS);
    expect(shown(taskId)!.kind).toBe('waiting-input');
  });

  it('64 tasks each changing every 5 s for a minute: every task ends with the last status it sent, nothing dropped', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.parse('2026-11-13T07:00:00.000Z');
    vi.setSystemTime(t0);
    const sent = [];
    for (let i = 0; i < 64; i++) sent.push(await sentTask());
    const last = new Map<string, Partial<A2aRemoteStatusV1>>();
    for (let step = 0; step <= 12; step++) {
      for (const [i, { linkId, taskId }] of sent.entries()) {
        // Spread over the 5 s like real senders, each task 5 s after its own last.
        vi.setSystemTime(t0 + step * 5000 + i * 70);
        const status = { kind: (step + i) % 2 ? 'waiting-input' as const : 'working' as const, since: new Date(Date.now()).toISOString() };
        last.set(taskId, status);
        await delivery.accept(statusEnv(linkId, taskId, status), { hostId: HOST });
      }
    }
    for (const { taskId } of sent) expect(shown(taskId)).toMatchObject(last.get(taskId)!);
    expect(logs).toEqual([]);
  });

  it('a burst on one task: the newest is applied once the gap is over, and a `question` at its end applies at once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-11-13T07:00:00.000Z'));
    const at = (ms: number): string => new Date(Date.now() + ms).toISOString();
    const a = await sentTask();
    await delivery.accept(statusEnv(a.linkId, a.taskId, { kind: 'working', since: at(0) }), { hostId: HOST });
    for (let i = 1; i <= 10; i++) await delivery.accept(statusEnv(a.linkId, a.taskId, { kind: 'working', since: at(i) }), { hostId: HOST });
    await delivery.accept(statusEnv(a.linkId, a.taskId, { kind: 'waiting-input', since: at(11) }), { hostId: HOST });
    expect(shown(a.taskId)!.kind).toBe('working');
    vi.setSystemTime(Date.now() + REMOTE_STATUS_TASK_GAP_MS);
    // Kept, not dropped: it is the task's status once the gap is over, with no further message.
    expect(shown(a.taskId)).toMatchObject({ kind: 'waiting-input' });

    const b = await sentTask();
    for (let i = 0; i < 10; i++) await delivery.accept(statusEnv(b.linkId, b.taskId, { kind: 'working', since: at(i) }), { hostId: HOST });
    await delivery.accept(statusEnv(b.linkId, b.taskId, { kind: 'question', since: at(10), detail: { question: 'menu', menuId: 'toolu_9' } }), { hostId: HOST });
    expect(shown(b.taskId)).toMatchObject({ kind: 'question', detail: { menuId: 'toolu_9' } });
  });

  it('a flood on one task (1000 in a second): one status kept, one waiting, one log line', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-11-13T07:00:00.000Z'));
    const { linkId, taskId } = await sentTask();
    for (let i = 0; i < 1000; i++) {
      vi.setSystemTime(Date.parse('2026-11-13T07:00:00.000Z') + i);
      await delivery.accept(statusEnv(linkId, taskId, { kind: i % 2 ? 'working' : 'waiting-input', since: new Date(Date.now()).toISOString() }), { hostId: HOST });
    }
    const inner = delivery as unknown as { remoteStatuses: Map<string, unknown>; statusGates: Map<string, { waiting?: unknown }> };
    expect(inner.remoteStatuses.size).toBe(1);
    expect(inner.statusGates.size).toBe(1);
    expect(inner.statusGates.get(taskId)!.waiting).toMatchObject({ kind: 'working' });
    expect(logs).toHaveLength(1);
  });

  it(`past ${REMOTE_STATUS_PER_WINDOW} statuses a minute from one PC (a flood guard): the rest taken and dropped unread, one log line`, async () => {
    const { linkId, taskId } = await sentTask();
    for (let i = 0; i < REMOTE_STATUS_PER_WINDOW; i++) {
      await delivery.accept(statusEnv(linkId, taskId, { kind: 'question', since: new Date(Date.parse(SINCE) + i * 1000).toISOString() }), { hostId: HOST });
    }
    const kept = shown(taskId)!.since;
    for (let i = 0; i < 20; i++) {
      // Dropped before any check: even one for a task this PC never sent is not refused, nor logged each time.
      expect(await delivery.accept(statusEnv(linkId, i % 2 ? taskId : 'rt-nope', { kind: 'gone', since: new Date().toISOString() }), { hostId: HOST }))
        .toMatchObject({ ok: true });
    }
    expect(shown(taskId)!.since).toBe(kept);
    expect(logs.filter((l) => l.includes('worker statuses in a minute'))).toHaveLength(1);
  });
});
