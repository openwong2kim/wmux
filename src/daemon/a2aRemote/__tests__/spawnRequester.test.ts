// The asking side of remote spawn, against real stores in a temp folder: what
// is sent and when it is refused here, how answers are taken (and taken again
// when this PC could not write them), expiry, and what survives a restart.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { A2A_FEATURE_SPAWN, type A2aRemoteEnvelope } from '../../../shared/a2aRemote';
import {
  SPAWN_ASKS_OPEN_PER_HOST_MAX,
  SPAWN_ASKS_PER_PANE_PER_HOUR,
  SPAWN_ASK_GRACE_MS,
  spawnFirstMessageId,
  asSpawnLinkId,
  type A2aSpawnAskInput,
  type A2aSpawnResultV1,
} from '../../../shared/a2aSpawn';
import { A2aTaskService } from '../../a2a/A2aTaskService';
import { AppendOnlyLog } from '../../eventlog/AppendOnlyLog';
import { remoteTaskId } from '../ids';
import { LinkStore } from '../linkStore';
import { linkAlias, sendRemoteTask, type OutboundDeps } from '../outbound';
import { A2aSpawnRequester } from '../spawnRequester';
import { SpawnOutgoingStore } from '../spawnOutgoingStore';

const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const quiet = (): void => undefined;

let dir: string;
let log: AppendOnlyLog;
let tasks: A2aTaskService;
let links: LinkStore;
let store: SpawnOutgoingStore;
let sent: Array<{ hostId: string; env: A2aRemoteEnvelope }>;
let features: Map<string, Set<string>>;
let online: boolean;
let clock: number;
let asks: A2aSpawnRequester;

const make = (): A2aSpawnRequester => new A2aSpawnRequester({
  store,
  links,
  taskService: tasks,
  enqueue: (hostId, env) => void sent.push({ hostId, env }),
  hosts: () => [{ hostId: B, name: 'DESK', online }, { hostId: C, name: 'LAPTOP', online: true }],
  features: (h) => features.get(h),
  aliasFor: (l) => linkAlias(l, 'DESK'),
  broadcast: quiet,
  now: () => clock,
  log: quiet,
});

beforeEach(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'a2a-spawn-ask-')));
  log = new AppendOnlyLog({ dir: path.join(dir, 'log'), fsync: () => undefined });
  log.open();
  tasks = new A2aTaskService({ log, origin: { machineId: 'a', daemonEpoch: 1 } });
  links = new LinkStore({ dir: path.join(dir, 'a2a'), scheduleHarden: quiet });
  store = new SpawnOutgoingStore({ dir: path.join(dir, 'a2a'), scheduleHarden: quiet, now: () => clock });
  sent = [];
  features = new Map([[B, new Set([A2A_FEATURE_SPAWN])]]);
  online = true;
  clock = Date.parse('2026-10-23T00:00:00.000Z');
  asks = make();
});

afterEach(() => {
  log.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const input = (over: Partial<A2aSpawnAskInput> = {}): A2aSpawnAskInput => ({
  pc: 'DESK', agent: 'claude', folder: { root: 'web', sub: 'apps/site' }, text: 'fix the build',
  from: { kind: 'pane', workspaceId: 'ws-a', paneId: 'pane-a' }, callerKey: 'pane-a', ...over,
});
const askOk = (over: Partial<A2aSpawnAskInput> = {}): string => {
  const r = asks.ask(input(over));
  if (!r.ok) throw new Error(`refused: ${r.error}`);
  return r.spawn.spawnId;
};
const stateOf = (spawnId: string) => asks.list(spawnId).requests[0];
const started = (spawnId: string, linkId: string = crypto.randomUUID()): A2aSpawnResultV1 => ({
  v: 1, spawnId, code: 'started', endpoint: { kind: 'pane', workspaceId: 'ws-b', paneId: 'pane-b' }, linkVersion: 1, linkId,
});

describe('asking', () => {
  it('stores the request, queues exactly the request fields, and says whether that PC is on', () => {
    online = false;
    const r = asks.ask(input({ pc: 'desk', text: 'fix\u001b[31m the build' }));
    expect(r).toMatchObject({ ok: true, online: false, spawn: { hostId: B, hostName: 'DESK', state: 'sent', rootId: 'web', sub: 'apps/site' } });
    expect(sent).toHaveLength(1);
    const env = sent[0].env;
    expect(env).toMatchObject({ kind: 'link', link: { state: 'spawn', version: 0 }, linkVersion: 0, linkId: env.spawn?.spawnId });
    // Control sequences go before it is stored or sent, as on the receiving side.
    expect(env.spawn?.text).toBe('fix the build');
    expect(Object.keys(env.spawn ?? {}).sort()).toEqual(['agent', 'expiresAt', 'folder', 'from', 'spawnId', 'text', 'v']);
    expect(Date.parse(env.spawn!.expiresAt) - clock).toBe(24 * 3600_000);
    // The summary never carries the prompt.
    expect(JSON.stringify(asks.list())).not.toContain('fix the build');
  });

  it('refuses here: an unknown or ambiguous PC, one that never said spawn.1, a bad field, and the two limits', () => {
    expect(asks.ask(input({ pc: 'NOPE' }))).toMatchObject({ ok: false, error: 'unknown-pc' });
    expect(asks.ask(input({ pc: C }))).toMatchObject({ ok: false, error: 'not-supported' });
    expect(asks.ask(input({ folder: { root: 'web', sub: '../out' } }))).toMatchObject({ ok: false, error: 'bad-request' });
    expect(asks.ask(input({ text: '   ' }))).toMatchObject({ ok: false, error: 'bad-request' });
    expect(asks.ask(input({ expiresInHours: 73 }))).toMatchObject({ ok: false, error: 'bad-request' });
    for (let i = 0; i < SPAWN_ASKS_OPEN_PER_HOST_MAX; i++) askOk({ callerKey: `pane-${i}` });
    expect(asks.ask(input({ callerKey: 'pane-z' }))).toMatchObject({ ok: false, error: 'rate-limited' });
    expect(sent).toHaveLength(SPAWN_ASKS_OPEN_PER_HOST_MAX);
  });

  it('a pane may ask 3 times an hour, answered or not', async () => {
    for (let i = 0; i < SPAWN_ASKS_PER_PANE_PER_HOUR; i++) {
      const id = askOk();
      expect(await asks.onResult(B, { v: 1, spawnId: id, code: 'declined' })).toBe(true);
    }
    expect(asks.ask(input())).toMatchObject({ ok: false, error: 'rate-limited' });
    clock += 3600_000 + 1;
    expect(asks.ask(input()).ok).toBe(true);
  });

  it('a retry with the same requestKey answers the stored request and sends nothing more, across a restart', () => {
    const first = asks.ask(input({ requestKey: 'k-0123456789' }));
    expect(first.ok).toBe(true);
    // A restarted daemon reads the request back from disk.
    store = new SpawnOutgoingStore({ dir: path.join(dir, 'a2a'), scheduleHarden: quiet, now: () => clock });
    asks = make();
    const again = asks.ask(input({ requestKey: 'k-0123456789', text: 'edited after a timeout' }));
    expect(again).toMatchObject({ ok: true, spawn: { spawnId: first.ok ? first.spawn.spawnId : '' } });
    expect(sent).toHaveLength(1);
    expect(store.list()).toHaveLength(1);
    // Another pane's key, a key used for another PC, and a malformed key are not that request.
    expect(asks.ask(input({ requestKey: 'k-0123456789', callerKey: 'pane-b' })).ok).toBe(true);
    expect(sent).toHaveLength(2);
    features.set(C, new Set([A2A_FEATURE_SPAWN]));
    expect(asks.ask(input({ requestKey: 'k-0123456789', pc: 'LAPTOP' }))).toMatchObject({ ok: false, error: 'bad-request' });
    expect(asks.ask(input({ requestKey: 'bad key!' }))).toMatchObject({ ok: false, error: 'bad-request' });
    expect(sent).toHaveLength(2);
  });

  it('a request that could not be queued is not kept', () => {
    const failing = new A2aSpawnRequester({
      store, links, taskService: tasks, enqueue: () => { throw new Error('outbox full'); },
      hosts: () => [{ hostId: B, name: 'DESK', online: true }], features: (h) => features.get(h),
      aliasFor: (l) => linkAlias(l, 'DESK'), broadcast: quiet, now: () => clock, log: quiet,
    });
    expect(failing.ask(input())).toMatchObject({ ok: false, error: 'unavailable' });
    expect(store.list()).toEqual([]);
  });
});

describe('answers', () => {
  it('waiting, then a refusal with its code; the prompt is dropped once final; a later answer changes nothing', async () => {
    const id = askOk();
    expect(await asks.onResult(B, { v: 1, spawnId: id, code: 'waiting-for-approval' })).toBe(true);
    expect(stateOf(id)).toMatchObject({ state: 'waiting' });
    expect(await asks.onResult(B, { v: 1, spawnId: id, code: 'declined' })).toBe(true);
    expect(stateOf(id)).toMatchObject({ state: 'refused', code: 'declined' });
    expect(store.get(B, id)?.text).toBeUndefined();
    expect(await asks.onResult(B, started(id))).toBe(true);
    expect(links.list()).toEqual([]);
    expect(asks.isOutstanding(B, id)).toBe(false);
  });

  it('started: this PC\'s side of the link and its copy of the first task, under the ids both PCs derive', async () => {
    const id = askOk();
    const result = started(id);
    expect(await asks.onResult(B, result)).toBe(true);
    const linkId = asSpawnLinkId(result.linkId)!;
    expect(stateOf(id)).toMatchObject({ state: 'started', linkId });
    expect(links.get(linkId)).toMatchObject({ state: 'active', version: 1, proposer: 'local', allow: { outbound: true, inbound: false } });
    const task = tasks.getTask(remoteTaskId(linkId, spawnFirstMessageId(linkId)))!;
    expect(task.history[0].parts).toEqual([{ kind: 'text', text: 'fix the build' }]);
    expect(task.metadata.from).toMatchObject({ workspaceId: 'ws-a', paneId: 'pane-a' });
    expect(task.metadata.remote).toMatchObject({ direction: 'outbound', linkId, hostId: B });
  });

  it('a started answer this PC could not write is taken again, without a second link', async () => {
    const id = askOk();
    const result = started(id);
    vi.spyOn(tasks, 'createTask').mockResolvedValueOnce({ ok: false, error: 'ledger busy' } as never);
    expect(await asks.onResult(B, result)).toBe(false);
    expect(stateOf(id)).toMatchObject({ state: 'sent' });
    expect(asks.isOutstanding(B, id)).toBe(true);
    expect(await asks.onResult(B, result)).toBe(true);
    expect(links.list()).toHaveLength(1);
    expect(stateOf(id)).toMatchObject({ state: 'started' });
  });

  it('a started answer without a usable link ends the request failed', async () => {
    const id = askOk();
    expect(await asks.onResult(B, { ...started(id), linkVersion: 2 })).toBe(true);
    expect(stateOf(id)).toMatchObject({ state: 'refused', code: 'failed' });
    expect(links.list()).toEqual([]);
  });

  it('an answer from another PC than the one asked is not this request', async () => {
    const id = askOk();
    expect(await asks.onResult(C, started(id))).toBe(true);
    expect(stateOf(id)).toMatchObject({ state: 'sent' });
    expect(asks.isOutstanding(C, id)).toBe(false);
  });

  it('a link this PC asked for is marked on the link itself and carries no images, with no request record needed', async () => {
    const id = askOk();
    const result = started(id);
    await asks.onResult(B, result);
    expect(links.get(result.linkId!)).toMatchObject({ spawned: true, proposer: 'local' });
    // The request record goes (pruned, or its PC forgotten): the link keeps its rule.
    asks.forgetHost(B);
    const deps = {
      linkStore: links, taskService: tasks, outbox: { enqueue: quiet }, aliasFor: (l: Parameters<typeof linkAlias>[0]) => linkAlias(l, 'DESK'),
    } as unknown as OutboundDeps;
    const out = await sendRemoteTask(deps, {
      linkId: result.linkId!, from: { workspaceId: 'ws-a', name: 'a', paneId: 'pane-a' }, title: '', text: 'look', images: ['/tmp/x.png'],
    });
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining('no images') });
  });

  it('a started answer naming a link this request did not reserve ends the request, and that link is left as it was', async () => {
    // An existing link between the same two PCs, made by a person.
    const other = crypto.randomUUID();
    links.receiveProposal({
      linkId: other,
      local: { kind: 'pane', workspaceId: 'ws-a', paneId: 'pane-other' },
      remote: { hostId: B, kind: 'pane', workspaceId: 'ws-b', paneId: 'pane-b' },
      allow: { outbound: true, inbound: true },
    });
    links.accept(other);
    const before = links.get(other);
    const id = askOk();
    expect(await asks.onResult(B, started(id, other))).toBe(true);
    expect(stateOf(id)).toMatchObject({ state: 'refused', code: 'failed' });
    expect(stateOf(id).linkId).toBeUndefined();
    expect(links.get(other)).toEqual(before);
    expect(tasks.getTask(remoteTaskId(other, spawnFirstMessageId(asSpawnLinkId(other)!)))).toBeUndefined();
    // Taken, so the other PC stops sending it.
    expect(asks.isOutstanding(B, id)).toBe(false);
  });

  it('a link id another request already holds is refused too', async () => {
    const first = askOk({ callerKey: 'pane-1' });
    const result = started(first);
    await asks.onResult(B, result);
    const second = askOk({ callerKey: 'pane-2', from: { kind: 'pane', workspaceId: 'ws-a', paneId: 'pane-2' } });
    expect(await asks.onResult(B, started(second, result.linkId!))).toBe(true);
    expect(stateOf(second)).toMatchObject({ state: 'refused', code: 'failed' });
    expect(links.list()).toHaveLength(1);
  });

  it('a first-task id that is another task\'s ends the request without touching that task', async () => {
    const id = askOk();
    const linkId = crypto.randomUUID();
    const taskId = remoteTaskId(linkId, spawnFirstMessageId(asSpawnLinkId(linkId)!));
    await tasks.createTask({ id: taskId, title: 'mine', from: { workspaceId: 'ws-x', name: 'x', paneId: 'pane-x' }, to: { workspaceId: 'ws-y', name: 'y' }, history: [] });
    expect(await asks.onResult(B, started(id, linkId))).toBe(true);
    expect(stateOf(id)).toMatchObject({ state: 'refused', code: 'failed' });
    expect(tasks.getTask(taskId)?.metadata.from.workspaceId).toBe('ws-x');
  });
});

describe('expiry, refusals, restarts', () => {
  it('a request with no answer ends expired after its expiry and the grace', () => {
    const id = askOk({ expiresInHours: 1 });
    clock += 3600_000 + SPAWN_ASK_GRACE_MS - 1;
    asks.expire();
    expect(stateOf(id).state).toBe('sent');
    clock += 2;
    asks.expire();
    expect(stateOf(id).state).toBe('expired');
  });

  it('an expired request still takes a late started answer: the agent the other PC started gets its link here', async () => {
    const id = askOk({ expiresInHours: 1 });
    clock += 3600_000 + SPAWN_ASK_GRACE_MS + 1;
    asks.expire();
    expect(stateOf(id).state).toBe('expired');
    expect(asks.isOutstanding(B, id)).toBe(true);
    const result = started(id);
    expect(await asks.onResult(B, result)).toBe(true);
    expect(stateOf(id)).toMatchObject({ state: 'started', linkId: result.linkId });
    const linkId = asSpawnLinkId(result.linkId)!;
    expect(tasks.getTask(remoteTaskId(linkId, spawnFirstMessageId(linkId)))?.history[0].parts).toEqual([{ kind: 'text', text: 'fix the build' }]);
  });

  it('an expired request stays expired on a late waiting-for-approval answer', async () => {
    const id = askOk({ expiresInHours: 1 });
    clock += 3600_000 + SPAWN_ASK_GRACE_MS + 1;
    asks.expire();
    expect(await asks.onResult(B, { v: 1, spawnId: id, code: 'waiting-for-approval' })).toBe(true);
    // Read the record itself: list() expires again and would hide a move back to waiting.
    expect(store.get(B, id)?.state).toBe('expired');
  });

  it('a request the other PC refused for good is not supported there', () => {
    const id = askOk();
    asks.onRefused(B, sent[0].env, 'bad-request');
    expect(stateOf(id)).toMatchObject({ state: 'refused', code: 'not-supported' });
  });

  it('requests and targets survive a restart; only a newer targets version is kept; a removed PC takes its own', () => {
    const id = askOk();
    asks.onTargets(B, { v: 1, version: 3, roots: [{ id: 'web', label: 'Web' }], agents: ['claude'] });
    asks.onTargets(B, { v: 1, version: 2, roots: [], agents: [] });
    store = new SpawnOutgoingStore({ dir: path.join(dir, 'a2a'), scheduleHarden: quiet, now: () => clock });
    asks = make();
    expect(stateOf(id)).toMatchObject({ state: 'sent' });
    expect(store.get(B, id)?.text).toBe('fix the build');
    expect(asks.list().places.find((p) => p.hostId === B)).toMatchObject({ supported: true, targets: { version: 3 } });
    asks.forgetHost(B);
    expect(asks.list().requests).toEqual([]);
    expect(asks.list().places.find((p) => p.hostId === B)?.targets).toBeUndefined();
  });
});
