// The `delivered` mark main sends may carry what it submitted to the pane
// (`submit`). The daemon's mark RPC records a well-formed one for the pty the
// mark names, on the task or on the inbox item marked, and keeps it on replay;
// a malformed one, or one for another pty, is dropped and the delivery still
// recorded. A mark without it is recorded exactly as before.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { A2A_REMOTE_RPC, type A2aRemoteTaskState } from '../../../shared/a2aRemoteDelivery';
import type { Message } from '../../../shared/types';
import { A2aTaskService } from '../../a2a/A2aTaskService';
import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { A2aRemoteDelivery } from '../delivery';
import { LinkStore } from '../linkStore';

const LINK = '11111111-1111-4111-8111-111111111111';
const HOST = '22222222-2222-4222-8222-222222222222';
const REMOTE_WS = `remote:${LINK}`;
const PROOF = { ptyId: 'pty-9', incarnation: 'inc-1', keyEpoch: 'ep-1', submitRevision: 12, promptHash: 'c'.repeat(64) };

type Handler = (p: Record<string, unknown>) => Promise<unknown>;

let dir: string;
const open: Array<{ delivery: A2aRemoteDelivery; log: AppendOnlyLog }> = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-submit-proof-'));
});
afterEach(async () => {
  for (const o of open.splice(0)) {
    await o.delivery.stop();
    o.log.close();
  }
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

function boot(): { mark: Handler; tasks: A2aTaskService } {
  const log = new AppendOnlyLog({ dir: path.join(dir, 'log'), fsync: () => undefined });
  log.open();
  const tasks = new A2aTaskService({ log, origin: { machineId: 'pc-b', daemonEpoch: open.length + 1 } });
  tasks.restoreFromLog();
  const quiet = (): void => undefined;
  const delivery = new A2aRemoteDelivery({
    dir: path.join(dir, 'a2a'),
    links: new LinkStore({ dir: path.join(dir, 'a2a'), scheduleHarden: quiet }),
    taskService: tasks,
    peers: { list: () => [] },
    remoteHosts: { list: () => [], get: () => undefined, credentialFor: () => null },
    broadcast: quiet,
    refreshLink: async () => undefined,
    log: quiet,
  });
  open.push({ delivery, log });
  const handlers = new Map<string, Handler>();
  delivery.registerRpc((method, handler) => handlers.set(method, handler as Handler));
  return { mark: handlers.get(A2A_REMOTE_RPC.mark)!, tasks };
}

function msg(id: string, text: string, role: Message['role'] = 'user'): Message {
  return { kind: 'message', messageId: id, role, parts: [{ kind: 'text', text }] };
}

async function inbound(tasks: A2aTaskService, id: string): Promise<void> {
  const res = await tasks.createTask({
    id,
    title: 'T',
    from: { workspaceId: REMOTE_WS, name: 'pc-a/ws/pane' },
    to: { workspaceId: 'ws-local', name: 'Local', paneId: 'pane-l' },
    history: [msg('m-0', 'do the thing')],
    remote: { v: 1, linkId: LINK, hostId: HOST, messageId: 'm-0', direction: 'inbound', delivered: false },
  });
  expect(res.ok).toBe(true);
}

const remoteOf = (tasks: A2aTaskService, id: string): A2aRemoteTaskState => tasks.getTask(id)!.metadata.remote as A2aRemoteTaskState;

describe('the submit proof on a delivered mark', () => {
  it('a well-formed one for the marked pty is stored on the task and kept on replay', async () => {
    const { mark, tasks } = boot();
    await inbound(tasks, 'rt-a');
    expect(await mark({ taskId: 'rt-a', delivered: true, ptyId: 'pty-9', submit: PROOF })).toEqual({ ok: true });
    expect(remoteOf(tasks, 'rt-a')).toMatchObject({ delivered: true, submit: PROOF });
    const first = open.splice(0)[0];
    await first.delivery.stop();
    first.log.close();
    const again = boot();
    expect(remoteOf(again.tasks, 'rt-a')).toMatchObject({ delivered: true, submit: PROOF });
  });

  it('a malformed one, or one for another pty, is dropped and the delivery is still recorded', async () => {
    const { mark, tasks } = boot();
    const bad: Array<Record<string, unknown>> = [
      { ...PROOF, promptHash: 'C'.repeat(64) },
      { ...PROOF, promptHash: 'c'.repeat(63) },
      { ...PROOF, submitRevision: -1 },
      { ...PROOF, submitRevision: 1.5 },
      { ...PROOF, incarnation: '' },
      { ...PROOF, keyEpoch: undefined },
      { ...PROOF, transcriptOffsetAtBase: -5 },
      { ...PROOF, ptyId: 7 },
      { ...PROOF, ptyId: 'pty-other' },
    ];
    for (const [i, submit] of bad.entries()) {
      await inbound(tasks, `rt-bad-${i}`);
      expect(await mark({ taskId: `rt-bad-${i}`, delivered: true, ptyId: 'pty-9', submit })).toEqual({ ok: true });
      expect(remoteOf(tasks, `rt-bad-${i}`).delivered).toBe(true);
      expect(remoteOf(tasks, `rt-bad-${i}`)).not.toHaveProperty('submit');
    }
    // Without a pty on the mark there is nothing to tie it to.
    await inbound(tasks, 'rt-nopty');
    expect(await mark({ taskId: 'rt-nopty', delivered: true, submit: PROOF })).toEqual({ ok: true });
    expect(remoteOf(tasks, 'rt-nopty')).not.toHaveProperty('submit');
    // Not with a hold or an attempt either.
    await inbound(tasks, 'rt-held');
    expect(await mark({ taskId: 'rt-held', held: 'pane-missing', ptyId: 'pty-9', submit: PROOF })).toEqual({ ok: true });
    expect(remoteOf(tasks, 'rt-held')).not.toHaveProperty('submit');
  });

  it('a delivered mark that only adds or changes the proof is recorded; the same one again appends nothing', async () => {
    const { mark, tasks } = boot();
    await inbound(tasks, 'rt-add');
    expect(await mark({ taskId: 'rt-add', delivered: true, ptyId: 'pty-9' })).toEqual({ ok: true });
    expect(remoteOf(tasks, 'rt-add')).not.toHaveProperty('submit');
    expect(await mark({ taskId: 'rt-add', delivered: true, ptyId: 'pty-9', submit: PROOF })).toEqual({ ok: true });
    expect(remoteOf(tasks, 'rt-add')).toMatchObject({ submit: PROOF });
    const later = { ...PROOF, submitRevision: 13 };
    expect(await mark({ taskId: 'rt-add', delivered: true, ptyId: 'pty-9', submit: later })).toEqual({ ok: true });
    expect(remoteOf(tasks, 'rt-add')).toMatchObject({ submit: later });
    const records = open[0].log.readAllRecords().length;
    expect(await mark({ taskId: 'rt-add', delivered: true, ptyId: 'pty-9', submit: later })).toEqual({ ok: true });
    expect(open[0].log.readAllRecords().length).toBe(records);
  });

  it('a mark without one is recorded as before', async () => {
    const { mark, tasks } = boot();
    await inbound(tasks, 'rt-plain');
    expect(await mark({ taskId: 'rt-plain', delivered: true, ptyId: 'pty-9' })).toEqual({ ok: true });
    expect(remoteOf(tasks, 'rt-plain')).toEqual({ v: 1, linkId: LINK, hostId: HOST, messageId: 'm-0', direction: 'inbound', delivered: true });
    expect(tasks.getTask('rt-plain')!.metadata.to.ptyId).toBe('pty-9');
  });

  it('an item delivery stores it on the inbox item', async () => {
    const { mark, tasks } = boot();
    await inbound(tasks, 'rt-item');
    expect((await tasks.markRemote({ taskId: 'rt-item', delivered: true })).ok).toBe(true);
    await tasks.appendRemoteMessage({ taskId: 'rt-item', linkId: LINK, actorWorkspaceId: REMOTE_WS, message: msg('r-1', 'and this', 'user') });
    expect(await mark({ taskId: 'rt-item', messageId: 'r-1', delivered: true, ptyId: 'pty-9', submit: PROOF })).toEqual({ ok: true });
    const remote = remoteOf(tasks, 'rt-item');
    expect(remote.inbox?.find((i) => i.messageId === 'r-1')).toMatchObject({ delivered: true, submit: PROOF });
    expect(remote).not.toHaveProperty('submit');
  });
});
