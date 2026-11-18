// The asking PC's `a2a.remote.approve.send` (A2aRemoteDelivery): nothing
// leaves unless the task's latest status offers that decision, the PC is
// connected and takes approvals, and the pace allows; the outcome is read back
// from the status. Real ledger, link store and outbox; no transport.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  A2A_APPROVAL_RPC,
  A2A_APPROVALS_SENT_PER_WINDOW,
  A2A_FEATURE_APPROVAL,
  A2A_REMOTE_PROTOCOL,
  type A2aApprovalSendResult,
  type A2aOutboxRecordV1,
  type A2aRemoteEnvelope,
  type A2aRemoteStatusV1,
} from '../../../shared/a2aRemote';
import { applyTaskQueryView } from '../../../shared/a2aTaskQueryView';
import type { Task } from '../../../shared/types';
import { A2aTaskService } from '../../a2a/A2aTaskService';
import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { A2aRemoteDelivery, REMOTE_STATUS_TASK_GAP_MS } from '../delivery';
import { remoteTaskId } from '../ids';
import { LinkStore } from '../linkStore';

const HOST = '22222222-2222-4222-8222-222222222222';
const PROMPT = '0123456789abcdef';

let dir: string;
let log: AppendOnlyLog;
let delivery: A2aRemoteDelivery;
let tasks: A2aTaskService;
let links: LinkStore;
let send: (p: Record<string, unknown>) => Promise<A2aApprovalSendResult>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-approve-'));
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
  const handlers = new Map<string, (p: Record<string, unknown>) => Promise<unknown>>();
  delivery.registerRpc((method, handler) => { handlers.set(method, handler); });
  send = (p) => handlers.get(A2A_APPROVAL_RPC.send)!(p) as Promise<A2aApprovalSendResult>;
  vi.spyOn(delivery, 'statusPeer').mockReturnValue({ connected: true, takesStatus: true, epoch: 'e1' });
  vi.spyOn(delivery, 'liveFeatures').mockReturnValue(new Set([A2A_FEATURE_APPROVAL]));
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await delivery.stop();
  log.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

/** A task this PC (A) sent over an active link to HOST. */
async function sentTask(): Promise<{ linkId: string; taskId: string }> {
  const linkId = crypto.randomUUID();
  links.receiveProposal({
    linkId,
    local: { kind: 'pane', workspaceId: 'ws-a', paneId: `pane-a-${linkId}` },
    remote: { hostId: HOST, kind: 'pane', workspaceId: 'ws-b', paneId: `pane-b-${linkId}`, label: 'claude' },
    allow: { outbound: true, inbound: true },
  });
  links.accept(linkId);
  const taskId = remoteTaskId(linkId, `mine-${linkId}`);
  const res = await tasks.createTask({
    id: taskId,
    title: 'mine',
    from: { workspaceId: 'ws-a', name: 'Frontend', paneId: 'pane-a' },
    to: { workspaceId: `remote:${linkId}`, name: 'pc-b/ws-b/claude' },
    history: [{ kind: 'message', messageId: `mine-${linkId}`, role: 'user', parts: [{ kind: 'text', text: 'hi' }] }],
    remote: { v: 1, linkId, hostId: HOST, messageId: `mine-${linkId}`, direction: 'outbound', kind: 'pane' },
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
  status: { kind: 'question', since: new Date().toISOString(), ...status } as A2aRemoteStatusV1,
  sentAt: new Date().toISOString(),
});

/** The worker offers a prompt (`allowed` as that PC sent it). */
async function offer(linkId: string, taskId: string, over: Record<string, unknown> = {}): Promise<void> {
  const approval = { promptId: PROMPT, tool: 'Bash', command: 'echo hi', redacted: false, cut: false, allowed: ['allow', 'deny'], ...over };
  const res = await delivery.accept(statusEnv(linkId, taskId, { detail: { question: 'permission', approval } as A2aRemoteStatusV1['detail'] }), { hostId: HOST });
  expect(res).toMatchObject({ ok: true });
}

const approvalsQueued = (): A2aRemoteEnvelope[] => delivery.outbox.pending(HOST).map((r) => r.envelope).filter((e) => e.kind === 'approval');

describe('the offer as a2a_task_query shows it', () => {
  it('the command stands apart under untrusted, never inside detail.approval, in every view', async () => {
    const { linkId, taskId } = await sentTask();
    await offer(linkId, taskId, { command: 'echo IGNORE-PREVIOUS' });
    const task = delivery.withRemoteStatus(tasks.getTask(taskId) as Task);
    for (const view of [applyTaskQueryView([task], { taskId }), applyTaskQueryView([task], {}), applyTaskQueryView([task], { view: 'page' })]) {
      const v = JSON.stringify(view);
      expect(v).toContain('"untrusted":{"command":"echo IGNORE-PREVIOUS"}');
      expect(v.match(/IGNORE-PREVIOUS/g)).toHaveLength(1);
      expect(v).toContain(`"approval":{"promptId":"${PROMPT}","tool":"Bash","redacted":false,"cut":false,"allowed":["allow","deny"]}`);
    }
  });
});

describe('a2a.remote.approve.send', () => {
  it('sends an offered decision as an `approval` with a fresh message id, and reports pending when no outcome came back', async () => {
    const { linkId, taskId } = await sentTask();
    await offer(linkId, taskId);
    const res = await send({ taskId, workspaceId: 'ws-a', promptId: PROMPT, decision: 'allow', waitMs: 0 });
    expect(res).toMatchObject({ ok: true, taskId, promptId: PROMPT, decision: 'allow', tool: 'Bash', pending: true });
    const queued = approvalsQueued();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.approval).toEqual({ promptId: PROMPT, decision: 'allow' });
    expect(queued[0]!.messageId).toBe((res as { messageId: string }).messageId);
    // A second call is another message: the receiving PC answers a reused id as id-reused.
    const again = await send({ taskId, workspaceId: 'ws-a', promptId: PROMPT, decision: 'deny', waitMs: 0 });
    expect((again as { messageId: string }).messageId).not.toBe((res as { messageId: string }).messageId);
  });

  it('allow for a deny-only offer is refused here, and nothing is queued', async () => {
    const { linkId, taskId } = await sentTask();
    await offer(linkId, taskId, { tool: 'Read', command: undefined, allowed: ['deny'] });
    expect(await send({ taskId, workspaceId: 'ws-a', promptId: PROMPT, decision: 'allow', waitMs: 0 })).toMatchObject({ ok: false, error: 'deny-only' });
    expect(approvalsQueued()).toEqual([]);
    // Deny goes.
    expect(await send({ taskId, workspaceId: 'ws-a', promptId: PROMPT, decision: 'deny', waitMs: 0 })).toMatchObject({ ok: true, tool: 'Read' });
    expect(approvalsQueued()).toHaveLength(1);
  });

  it('refuses with nothing queued: a bad argument, another prompt id, another workspace, a PC away or not taking approvals', async () => {
    const { linkId, taskId } = await sentTask();
    await offer(linkId, taskId);
    expect(await send({ taskId, workspaceId: 'ws-a', promptId: PROMPT, decision: 'yes' })).toMatchObject({ ok: false, error: 'bad-request' });
    expect(await send({ taskId, workspaceId: 'ws-a', promptId: 'not-hex', decision: 'deny' })).toMatchObject({ ok: false, error: 'bad-request' });
    expect(await send({ taskId, workspaceId: 'ws-a', promptId: 'fedcba9876543210', decision: 'deny' })).toMatchObject({ ok: false, error: 'not-offered' });
    expect(await send({ taskId, workspaceId: 'ws-other', promptId: PROMPT, decision: 'deny' })).toMatchObject({ ok: false, error: 'forbidden' });
    expect(await send({ taskId: 'nope', workspaceId: 'ws-a', promptId: PROMPT, decision: 'deny' })).toMatchObject({ ok: false, error: 'unknown-task' });
    vi.mocked(delivery.liveFeatures).mockReturnValue(new Set());
    expect(await send({ taskId, workspaceId: 'ws-a', promptId: PROMPT, decision: 'deny' })).toMatchObject({ ok: false, error: 'unsupported' });
    vi.mocked(delivery.statusPeer).mockReturnValue({ connected: false, takesStatus: true, epoch: null });
    expect(await send({ taskId, workspaceId: 'ws-a', promptId: PROMPT, decision: 'deny' })).toMatchObject({ ok: false, error: 'unavailable' });
    expect(approvalsQueued()).toEqual([]);
  });

  it(`paced: past ${A2A_APPROVALS_SENT_PER_WINDOW} to one PC in the window, "try again" with a wait and nothing queued`, async () => {
    const { linkId, taskId } = await sentTask();
    await offer(linkId, taskId);
    for (let i = 0; i < A2A_APPROVALS_SENT_PER_WINDOW; i++) {
      expect(await send({ taskId, workspaceId: 'ws-a', promptId: PROMPT, decision: 'deny', waitMs: 0 })).toMatchObject({ ok: true });
    }
    const over = await send({ taskId, workspaceId: 'ws-a', promptId: PROMPT, decision: 'deny', waitMs: 0 });
    expect(over).toMatchObject({ ok: false, error: 'rate-limited' });
    expect((over as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
    expect((over as { message: string }).message).toMatch(/try again/);
    expect(approvalsQueued()).toHaveLength(A2A_APPROVALS_SENT_PER_WINDOW);
  });

  it('a refused send is not counted toward the pace', async () => {
    const { linkId, taskId } = await sentTask();
    await offer(linkId, taskId, { allowed: ['deny'], command: undefined });
    for (let i = 0; i < A2A_APPROVALS_SENT_PER_WINDOW * 2; i++) await send({ taskId, workspaceId: 'ws-a', promptId: PROMPT, decision: 'allow', waitMs: 0 });
    expect(await send({ taskId, workspaceId: 'ws-a', promptId: PROMPT, decision: 'deny', waitMs: 0 })).toMatchObject({ ok: true });
  });

  it('reports the outcome once the status carries it (detail.approvals), with this PC\'s words for a reason', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-11-19T07:00:00.000Z'));
    const { linkId, taskId } = await sentTask();
    await offer(linkId, taskId);
    const pending = send({ taskId, workspaceId: 'ws-a', promptId: PROMPT, decision: 'allow', waitMs: 8_000 });
    await vi.waitFor(() => expect(approvalsQueued()).toHaveLength(1), { timeout: 5_000 });
    const messageId = approvalsQueued()[0]!.messageId;
    await delivery.accept(statusEnv(linkId, taskId, { kind: 'working', detail: { approvals: [{ messageId, outcome: 'not-done', reason: 'chain-broken' }] } }), { hostId: HOST });
    // Applied once the per-task gap is over; the wait reads it then.
    vi.setSystemTime(Date.now() + REMOTE_STATUS_TASK_GAP_MS);
    const res = await pending;
    expect(res).toMatchObject({ ok: true, outcome: { messageId, outcome: 'not-done', reason: 'chain-broken' } });
    expect((res as { outcome: { reasonText: string } }).outcome.reasonText).toMatch(/took other input/);
    expect(res).not.toHaveProperty('pending');
  });

  it('an approval the other PC refuses whole (approvals-off) fails nothing here, and is reported to the wait', async () => {
    const { linkId, taskId } = await sentTask();
    await offer(linkId, taskId);
    const pending = send({ taskId, workspaceId: 'ws-a', promptId: PROMPT, decision: 'deny', waitMs: 5_000 });
    await vi.waitFor(() => expect(approvalsQueued()).toHaveLength(1), { timeout: 5_000 });
    const rec = delivery.outbox.pending(HOST).find((r) => r.envelope.kind === 'approval') as A2aOutboxRecordV1;
    delivery.outbox.refuse(HOST, rec.seq, 'approvals-off');
    await (delivery as unknown as { onRefused(r: A2aOutboxRecordV1, c: string): Promise<void> }).onRefused(rec, 'approvals-off');
    expect(await pending).toMatchObject({ ok: true, outcome: { outcome: 'not-done', reason: 'approvals-off' } });
    expect(tasks.getTask(taskId)!.status.state).toBe('submitted');
  });
});

describe('the receiving PC\'s window, as the asking PC sees it', () => {
  const rateLimited = (messageId: string, retryAfterMs: number) => ({ messageId, outcome: 'not-done', reason: 'rate-limited', retryAfterMs });

  it('a send answered rate-limited (this PC\'s pace started over, say after a restart) returns that outcome with retryAfterMs at once, not pending', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-11-19T07:00:00.000Z'));
    const { linkId, taskId } = await sentTask();
    await offer(linkId, taskId);
    const started = Date.now();
    const pending = send({ taskId, workspaceId: 'ws-a', promptId: PROMPT, decision: 'deny', waitMs: 10_000 });
    await vi.waitFor(() => expect(approvalsQueued()).toHaveLength(1), { timeout: 5_000 });
    const messageId = approvalsQueued()[0]!.messageId;
    // Within the per-task gap: the status is held for later, but the waiting send has its outcome now.
    await delivery.accept(statusEnv(linkId, taskId, { kind: 'working', detail: { approvals: [rateLimited(messageId, 37_000)] } as A2aRemoteStatusV1['detail'] }), { hostId: HOST });
    const res = await pending;
    expect(Date.now() - started).toBeLessThan(REMOTE_STATUS_TASK_GAP_MS);
    expect(res).toMatchObject({ ok: true, outcome: { messageId, outcome: 'not-done', reason: 'rate-limited', retryAfterMs: 37_000 } });
    expect((res as { outcome: { reasonText: string } }).outcome.reasonText).toMatch(/as many approvals/);
    expect(res).not.toHaveProperty('pending');
  });

  it('an outbox resend answered rate-limited again: the task\'s status keeps one outcome for the message, with the new wait', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-11-19T07:00:00.000Z'));
    const { linkId, taskId } = await sentTask();
    await offer(linkId, taskId);
    const first = await send({ taskId, workspaceId: 'ws-a', promptId: PROMPT, decision: 'deny', waitMs: 0 });
    expect(first).toMatchObject({ ok: true, pending: true });
    const messageId = (first as { messageId: string }).messageId;
    await delivery.accept(statusEnv(linkId, taskId, { kind: 'working', detail: { approvals: [rateLimited(messageId, 30_000)] } as A2aRemoteStatusV1['detail'] }), { hostId: HOST });
    vi.setSystemTime(Date.now() + REMOTE_STATUS_TASK_GAP_MS);
    await delivery.accept(statusEnv(linkId, taskId, { kind: 'working', detail: { approvals: [rateLimited(messageId, 12_000)] } as A2aRemoteStatusV1['detail'] }), { hostId: HOST });
    const shown = applyTaskQueryView([delivery.withRemoteStatus(tasks.getTask(taskId) as Task)], { taskId }) as Array<{ metadata: { remote: { status: { detail: { approvals: unknown[] } } } } }>;
    expect(shown[0]!.metadata.remote.status.detail.approvals).toEqual([{ ...rateLimited(messageId, 12_000), reasonText: expect.stringMatching(/as many approvals/) }]);
  });

  it('a burst past the other PC\'s window: every send is answered rate-limited by its own refusal, however few outcomes a status keeps', async () => {
    const { linkId, taskId } = await sentTask();
    await offer(linkId, taskId);
    const sends = Array.from({ length: 6 }, () => send({ taskId, workspaceId: 'ws-a', promptId: PROMPT, decision: 'deny', waitMs: 5_000 }));
    await vi.waitFor(() => expect(approvalsQueued()).toHaveLength(6), { timeout: 5_000 });
    for (const rec of delivery.outbox.pending(HOST).filter((r) => r.envelope.kind === 'approval')) {
      delivery.outbox.refuse(HOST, rec.seq, 'rate-limited');
      await (delivery as unknown as { onRefused(r: A2aOutboxRecordV1, c: string): Promise<void> }).onRefused(rec, 'rate-limited');
    }
    for (const res of await Promise.all(sends)) {
      expect(res).toMatchObject({ ok: true, outcome: { outcome: 'not-done', reason: 'rate-limited', retryAfterMs: 60_000 } });
    }
    expect(tasks.getTask(taskId)!.status.state).toBe('submitted');
  });

  it('never pending for ever: a send whose message is refused whole after its wait shows that outcome in the task\'s status', async () => {
    const { linkId, taskId } = await sentTask();
    await offer(linkId, taskId);
    const res = await send({ taskId, workspaceId: 'ws-a', promptId: PROMPT, decision: 'deny', waitMs: 0 });
    expect(res).toMatchObject({ ok: true, pending: true });
    const rec = delivery.outbox.pending(HOST).find((r) => r.envelope.kind === 'approval') as A2aOutboxRecordV1;
    delivery.outbox.refuse(HOST, rec.seq, 'approvals-off');
    await (delivery as unknown as { onRefused(r: A2aOutboxRecordV1, c: string): Promise<void> }).onRefused(rec, 'approvals-off');
    const status = (delivery.withRemoteStatus(tasks.getTask(taskId) as Task).metadata.remote as { status: { detail: { approvals: unknown[] } } }).status;
    expect(status.detail.approvals).toContainEqual(expect.objectContaining({ messageId: rec.envelope.messageId, outcome: 'not-done', reason: 'approvals-off' }));
  });

  it('a status for another task naming the same message id does not answer the waiting send', async () => {
    const a = await sentTask();
    const b = await sentTask();
    await offer(a.linkId, a.taskId);
    const pending = send({ taskId: a.taskId, workspaceId: 'ws-a', promptId: PROMPT, decision: 'deny', waitMs: 300 });
    await vi.waitFor(() => expect(approvalsQueued()).toHaveLength(1), { timeout: 5_000 });
    const messageId = approvalsQueued()[0]!.messageId;
    await delivery.accept(statusEnv(b.linkId, b.taskId, { kind: 'working', detail: { approvals: [{ messageId, outcome: 'done' }] } as A2aRemoteStatusV1['detail'] }), { hostId: HOST });
    expect(await pending).toMatchObject({ ok: true, pending: true });
  });
});

describe('a refusal of every other kind is applied exactly as before; only `approval` is set apart', () => {
  type Refusing = {
    onRefused(r: A2aOutboxRecordV1, c: string): Promise<void>;
    refusalOwed(r: A2aOutboxRecordV1, c: string): boolean;
  };
  const refusing = (): Refusing => delivery as unknown as Refusing;

  /** A record of `kind` on `taskId`, queued and refused there with `code`. */
  function refused(linkId: string, taskId: string, kind: A2aRemoteEnvelope['kind'], code: string): A2aOutboxRecordV1 {
    const body: Partial<A2aRemoteEnvelope> = kind === 'reply' ? { text: 'hi' }
      : kind === 'answer' ? { answer: { pickerId: PROMPT, option: 1 } }
      : kind === 'status' ? { status: { kind: 'working', since: new Date().toISOString() } }
      : { approval: { promptId: PROMPT, decision: 'deny' } };
    const rec = delivery.outbox.enqueue(HOST, {
      protocol: A2A_REMOTE_PROTOCOL, linkId, linkVersion: 2, messageId: crypto.randomUUID(), kind, taskId, sentAt: new Date().toISOString(), ...body,
    } as A2aRemoteEnvelope);
    return delivery.outbox.refuse(HOST, rec.seq, code as never);
  }

  it('reply: owed, then the task fails with the refusal\'s code, and nothing is owed after', async () => {
    const { linkId, taskId } = await sentTask();
    const rec = refused(linkId, taskId, 'reply', 'forbidden');
    expect(refusing().refusalOwed(rec, 'forbidden')).toBe(true);
    await refusing().onRefused(rec, 'forbidden');
    const task = tasks.getTask(taskId)!;
    expect(task.status.state).toBe('failed');
    expect(JSON.stringify(task.status)).toContain('refused by the other PC: forbidden');
    expect(refusing().refusalOwed(delivery.outbox.get(HOST, rec.seq)!, 'forbidden')).toBe(false);
  });

  for (const kind of ['answer', 'status'] as const) {
    it(`${kind}: names no ledger task, so nothing is owed and the task is left as it was`, async () => {
      const { linkId, taskId } = await sentTask();
      const before = structuredClone(tasks.getTask(taskId));
      const rec = refused(linkId, taskId, kind, 'forbidden');
      expect(refusing().refusalOwed(rec, 'forbidden')).toBe(false);
      await refusing().onRefused(rec, 'forbidden');
      expect(tasks.getTask(taskId)).toEqual(before);
    });
  }

  it('approval: never owed, the task left as it was, and the refusal kept for its sender', async () => {
    const { linkId, taskId } = await sentTask();
    await offer(linkId, taskId);
    const before = structuredClone(tasks.getTask(taskId));
    const rec = refused(linkId, taskId, 'approval', 'forbidden');
    expect(refusing().refusalOwed(rec, 'forbidden')).toBe(false);
    await refusing().onRefused(rec, 'forbidden');
    expect(tasks.getTask(taskId)).toEqual(before);
    const kept = (delivery as unknown as { refusedApprovals: Map<string, unknown> }).refusedApprovals.get(rec.envelope.messageId);
    expect(kept).toMatchObject({ outcome: 'not-done', reasonText: 'refused by the other PC (forbidden); nothing was typed' });
  });
});
