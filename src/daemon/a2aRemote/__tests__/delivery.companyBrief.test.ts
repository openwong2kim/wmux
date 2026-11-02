// A company CEO's task to another PC: the sendTask RPC passes a complete
// brief through to this PC's copy (only its own fields) and refuses an
// incomplete one. Real link store, ledger and outbox; no transport.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { A2A_REMOTE_RPC } from '../../../shared/a2aRemoteDelivery';
import { COMPANY_BRIEF_KIND, isCompanyTask } from '../../../shared/company';
import { A2aTaskService } from '../../a2a/A2aTaskService';
import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { A2aRemoteDelivery } from '../delivery';
import { LinkStore } from '../linkStore';

const HOST = '22222222-2222-4222-8222-222222222222';
const BRIEF = { kind: COMPANY_BRIEF_KIND, v: 1, goal: 'g', scope: 's', acceptance: 'a', verify: 'v', report: 'r' };
const TEXT = 'Take it.\n\nGoal:\ng';

let dir: string;
let log: AppendOnlyLog;
let tasks: A2aTaskService;
let delivery: A2aRemoteDelivery;
let links: LinkStore;
let rpc: (method: string, params: Record<string, unknown>) => Promise<unknown>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-brief-'));
  log = new AppendOnlyLog({ dir: path.join(dir, 'log'), fsync: () => undefined });
  log.open();
  tasks = new A2aTaskService({ log, origin: { machineId: 'pc-a', daemonEpoch: 1 } });
  const quiet = (): void => undefined;
  links = new LinkStore({ dir: path.join(dir, 'a2a'), scheduleHarden: quiet });
  delivery = new A2aRemoteDelivery({
    dir: path.join(dir, 'a2a'),
    links,
    taskService: tasks,
    peers: { list: () => [{ hostId: HOST, name: 'PC-B' }] },
    remoteHosts: { list: () => [], get: () => undefined, credentialFor: () => null },
    broadcast: quiet,
    refreshLink: async () => undefined,
    log: quiet,
  });
  const handlers = new Map<string, (p: Record<string, unknown>) => Promise<unknown>>();
  delivery.registerRpc((method, handler) => handlers.set(method, handler));
  rpc = (method, params) => handlers.get(method)!(params);
});
afterEach(async () => {
  await delivery.stop();
  log.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

function activeLink(): string {
  const linkId = crypto.randomUUID();
  links.receiveProposal({
    linkId,
    local: { kind: 'pane', workspaceId: 'ws-a', paneId: 'pane-a' },
    remote: { hostId: HOST, kind: 'pane', workspaceId: 'ws-b', paneId: 'pane-b', label: 'codex' },
    allow: { outbound: true, inbound: true },
  });
  links.accept(linkId);
  return linkId;
}

const send = (linkId: string, extra: Record<string, unknown>): Promise<unknown> =>
  rpc(A2A_REMOTE_RPC.sendTask, { linkId, from: { workspaceId: 'ws-a', name: 'ws-a', paneId: 'pane-a' }, title: 'T', text: TEXT, ...extra });

describe('a2a.remote.sendTask with a company brief', () => {
  it('keeps the brief, with only its own fields, as data on this PC\'s copy; the envelope has the text only', async () => {
    const linkId = activeLink();
    const res = (await send(linkId, { brief: { ...BRIEF, blockedBy: ['task-1'], deliveryKey: 'dk', note: 'not a brief field' } })) as { ok: boolean; taskId: string };
    expect(res.ok).toBe(true);
    const t = tasks.getTask(res.taskId)!;
    expect(t.history[0].parts).toEqual([
      { kind: 'text', text: TEXT },
      { kind: 'data', data: { ...BRIEF, blockedBy: ['task-1'] }, metadata: { mimeType: 'application/json' } },
    ]);
    expect(isCompanyTask(t.history)).toBe(true);
    const sent = delivery.outbox.pending(HOST).map((r) => r.envelope);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'task', text: TEXT });
    expect(JSON.stringify(sent[0])).not.toContain(COMPANY_BRIEF_KIND);
  });

  it('refuses an incomplete or non-brief value as bad-request, and makes nothing', async () => {
    const linkId = activeLink();
    for (const brief of [{ ...BRIEF, report: '' }, { ...BRIEF, v: 2 }, 'brief', null]) {
      // eslint-disable-next-line no-await-in-loop -- one at a time
      expect(await send(linkId, { brief })).toEqual({ ok: false, error: 'bad-request: brief must be a complete version-1 company brief' });
    }
    expect(tasks.taskCount).toBe(0);
    expect(delivery.outbox.pending(HOST)).toEqual([]);
  });

  it('a send without a brief is unchanged', async () => {
    const res = (await send(activeLink(), {})) as { ok: boolean; taskId: string };
    expect(tasks.getTask(res.taskId)!.history[0].parts).toEqual([{ kind: 'text', text: TEXT }]);
  });
});
