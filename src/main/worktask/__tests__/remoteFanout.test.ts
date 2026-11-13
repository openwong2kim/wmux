// fanout_start with `pc`: missions and ledger rows here, start requests to
// another PC. Driven against a real TaskLedger and a daemon fake that keeps
// the requester's contract (a request key answers with the stored request).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskLedger } from '../../../daemon/ledger/TaskLedger';
import { headlessTreeId } from '../../../daemon/a2aRemote/headlessStarter';
import { SPAWN_REQUEST_KEY_RE, type A2aSpawnAskInput, type A2aSpawnOutgoingSummary } from '../../../shared/a2aSpawn';
import { isRemoteTask } from '../../../shared/ledger';
import {
  installRemoteTaskWithdraw, reconcileRemoteTasks, remoteCodeText, remoteFanoutKeys, remoteFanoutRefusal,
  remoteTaskBranch, startRemoteFanout, type RemoteFanoutDaemon, type RemoteFanoutDeps, type RemoteFanoutRequest,
} from '../remoteFanout';

const BOX = '0f1e2d3c-4b5a-4968-8776-655443322110';
const SELF = '7d1e2f30-4b5c-4d6e-9f80-123456789abc';
const LINK = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-remote-fanout-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The daemon as the requester and the mission log answer it. */
function fakeDaemon(opts: { supported?: boolean; askError?: 'unavailable' } = {}) {
  const requests = new Map<string, A2aSpawnOutgoingSummary>(); // by spawnId
  const byKey = new Map<string, string>(); // callerKey:requestKey → spawnId
  const missions = new Map<string, { taskId: string; channelId: string }>();
  const asks: A2aSpawnAskInput[] = [];
  const revoked: string[] = [];
  const closed: string[] = [];
  let n = 0;
  const daemon: RemoteFanoutDaemon = {
    ask: vi.fn(async (input: A2aSpawnAskInput) => {
      asks.push(input);
      if (opts.askError) return { ok: false as const, error: opts.askError };
      const k = `${input.callerKey}:${input.requestKey}`;
      const known = byKey.get(k);
      if (known) return { ok: true as const, spawn: requests.get(known)!, online: true };
      const spawnId = `sp-0f6c1d2e-3a4b-4c5d-8e9f-${String(++n).padStart(12, '0')}`;
      const at = new Date(0).toISOString();
      const spawn: A2aSpawnOutgoingSummary = {
        hostId: BOX, hostName: 'box', spawnId, agent: 'claude', rootId: input.folder.root, from: input.from,
        state: 'sent', createdAt: at, updatedAt: at, expiresAt: at,
      };
      requests.set(spawnId, spawn);
      byKey.set(k, spawnId);
      return { ok: true as const, spawn, online: true };
    }),
    outgoing: async () => ({
      requests: [...requests.values()],
      places: [{ hostId: BOX, name: 'box', online: true, supported: opts.supported ?? true }],
    }),
    selfHostId: async () => SELF,
    revokeLink: vi.fn(async (linkId: string) => {
      revoked.push(linkId);
    }),
    missionStart: async ({ idempotencyKey }) => {
      let m = missions.get(idempotencyKey);
      if (!m) {
        const i = missions.size + 1;
        m = { taskId: `wtask-r${i}`, channelId: `ch-r${i}` };
        missions.set(idempotencyKey, m);
      }
      return m;
    },
    missionClose: async (taskId) => {
      closed.push(taskId);
    },
  };
  const set = (spawnId: string, patch: Partial<A2aSpawnOutgoingSummary>) => requests.set(spawnId, { ...requests.get(spawnId)!, ...patch });
  return { daemon, asks, revoked, closed, requests, set };
}

const depsOf = (daemon: RemoteFanoutDaemon, ledger = new TaskLedger({ dir })): RemoteFanoutDeps => ({ daemon, ledger, rememberChannel: () => undefined });

const request = (n: number, over: Partial<RemoteFanoutRequest> = {}): RemoteFanoutRequest => ({
  idempotencyKey: 'k1', scopedKey: 'ws-owner::k1', ownerWorkspaceId: 'ws-owner', paneId: 'pane-1', pc: 'box', root: 'repo',
  titles: Array.from({ length: n }, (_, i) => `task ${i + 1}`),
  prompts: Array.from({ length: n }, (_, i) => `do ${i + 1}`),
  ...over,
});

describe('remote fan-out keys and names', () => {
  it('derives one caller key and a valid request key per task, the same for the same scoped key', () => {
    const a = remoteFanoutKeys('ws::k');
    expect(a.callerKey).toMatch(/^[0-9a-f]{32}$/);
    expect(a.requestKey(0)).toMatch(SPAWN_REQUEST_KEY_RE);
    expect(a.requestKey(0)).not.toBe(a.requestKey(1));
    expect(remoteFanoutKeys('ws::k').requestKey(3)).toBe(a.requestKey(3));
    expect(remoteFanoutKeys('other::k').callerKey).not.toBe(a.callerKey);
  });

  it('names the branch the other PC makes for the request', () => {
    const spawnId = 'sp-0f6c1d2e-3a4b-4c5d-8e9f-0123456789ab';
    expect(remoteTaskBranch(SELF, spawnId)).toBe(`wmux/remote/${headlessTreeId(SELF, spawnId)}`);
  });

  it('refuses what a task on another PC cannot take', () => {
    expect(remoteFanoutRefusal({})).toBeNull();
    expect(remoteFanoutRefusal({ agents: [{ agent: 'claude' }] })).toBeNull();
    expect(remoteFanoutRefusal({ dependsOn: [[0]] })).toMatch(/depends_on/);
    expect(remoteFanoutRefusal({ agents: [{ agent: 'codex' }] })).toMatch(/only Claude/);
    expect(remoteFanoutRefusal({ agents: [{ agent: 'claude', model: 'opus' }] })).toMatch(/model and effort/);
    for (const k of ['files', 'checkout', 'secretNames', 'connectors', 'preset', 'roles']) expect(remoteFanoutRefusal({ [k]: ['x'] })).not.toBeNull();
    expect(remoteFanoutRefusal({ cancelPending: true })).toMatch(/cancel_pending/);
  });

  it('says why the other PC did not start it', () => {
    expect(remoteCodeText('not-supported', 'box')).toMatch(/starts only Claude without an app/);
    expect(remoteCodeText('not-allowed', 'box', 5000)).toMatch(/longer than it accepts.*not-allowed/);
    expect(remoteCodeText('expired', 'box')).toMatch(/expired/);
  });
});

describe('startRemoteFanout', () => {
  it('asks once per task on the fan-out budget and writes one remote row each', async () => {
    const f = fakeDaemon();
    const deps = depsOf(f.daemon);
    const res = await startRemoteFanout(request(8), deps);
    if ('error' in res) throw new Error(res.error);
    expect(res.tasks).toHaveLength(8);
    expect(res.tasks.every((t) => t.ok && t.state === 'sent')).toBe(true);
    expect(f.asks).toHaveLength(8);
    expect(new Set(f.asks.map((a) => a.callerKey)).size).toBe(1);
    expect(f.asks.every((a) => a.budget === 'fanout' && a.agent === 'claude' && a.expiresInHours === 1 && a.pc === BOX)).toBe(true);
    const rows = deps.ledger.list().filter(isRemoteTask);
    expect(rows).toHaveLength(8);
    expect(rows[0].taskWorkspaceId).toBe(`remote:${rows[0].remote?.spawnId}`);
  });

  it('a desktop restart mid-fan-out, then the same key: one request and one row per task', async () => {
    const f = fakeDaemon();
    // The first run wrote the row of task 1 only (the app went down after it).
    const first = depsOf(f.daemon);
    await startRemoteFanout(request(1), first);
    await (first.ledger as TaskLedger).flush();
    // After the restart: a fresh ledger read from disk, the daemon unchanged.
    const second = depsOf(f.daemon);
    const res = await startRemoteFanout(request(2), second);
    if ('error' in res) throw new Error(res.error);
    expect(f.requests.size).toBe(2);
    expect(f.asks).toHaveLength(2); // task 1 answered from its row, task 2 asked once
    expect(second.ledger.list().filter(isRemoteTask)).toHaveLength(2);
    // Lost between the request and the row: the same key registers the same request.
    const row2 = second.ledger.get(res.tasks[1].taskId!)!;
    expect(row2.remote?.spawnId).toBe(res.tasks[1].spawnId);
  });

  it('refuses an unknown or unsupported PC before any mission', async () => {
    const f = fakeDaemon({ supported: false });
    const deps = depsOf(f.daemon);
    expect(await startRemoteFanout(request(1, { pc: 'nowhere' }), deps)).toEqual({ error: expect.stringMatching(/no paired PC/) });
    expect(await startRemoteFanout(request(1), deps)).toEqual({ error: expect.stringMatching(/cannot start agents/) });
    expect(f.asks).toHaveLength(0);
  });

  it('a request that could not be sent closes its mission and writes no row', async () => {
    const f = fakeDaemon({ askError: 'unavailable' });
    const deps = depsOf(f.daemon);
    const res = await startRemoteFanout(request(1), deps);
    if ('error' in res) throw new Error(res.error);
    expect(res.tasks[0]).toMatchObject({ ok: false, reason: expect.stringMatching(/could not be stored or queued/) });
    expect(f.closed).toEqual([res.tasks[0].taskId]);
    expect(deps.ledger.list()).toHaveLength(0);
  });
});

describe('reconcileRemoteTasks', () => {
  it('fails a refused row with a readable reason, and starts one with its link, task and branch', async () => {
    const f = fakeDaemon();
    const deps = depsOf(f.daemon);
    const res = await startRemoteFanout(request(2), deps);
    if ('error' in res) throw new Error(res.error);
    f.set(res.tasks[0].spawnId!, { state: 'refused', code: 'not-allowed' });
    f.set(res.tasks[1].spawnId!, { state: 'started', code: 'started', linkId: LINK });
    await reconcileRemoteTasks(deps);
    const refused = deps.ledger.get(res.tasks[0].taskId!)!;
    expect(refused).toMatchObject({ status: 'failed', remote: { state: 'refused', code: 'not-allowed' } });
    expect(refused.summary).toMatch(/not-allowed/);
    const started = deps.ledger.get(res.tasks[1].taskId!)!;
    expect(started).toMatchObject({ status: 'working', remote: { state: 'started', linkId: LINK, branch: remoteTaskBranch(SELF, res.tasks[1].spawnId!) } });
    expect(started.remote?.a2aTaskId).toMatch(/^rt-[0-9a-f]{32}$/);
  });

  it('a waiting row whose request this PC no longer holds ends expired and is never asked again', async () => {
    const f = fakeDaemon();
    const deps = depsOf(f.daemon);
    const res = await startRemoteFanout(request(1), deps);
    if ('error' in res) throw new Error(res.error);
    f.requests.clear();
    await reconcileRemoteTasks(deps);
    expect(deps.ledger.get(res.tasks[0].taskId!)).toMatchObject({ status: 'failed', remote: { state: 'expired', code: 'expired' } });
    const again = await startRemoteFanout(request(1), deps);
    if ('error' in again) throw new Error(again.error);
    expect(f.asks).toHaveLength(1);
    expect(again.tasks[0]).toMatchObject({ ok: false, state: 'expired' });
  });
});

describe('withdrawing a remote task', () => {
  it('closed before it started: the start that arrives later is ended at once, once', async () => {
    const f = fakeDaemon();
    const deps = depsOf(f.daemon);
    const ledger = deps.ledger as TaskLedger;
    const off = installRemoteTaskWithdraw(ledger, () => deps);
    const res = await startRemoteFanout(request(1), deps);
    if ('error' in res) throw new Error(res.error);
    const id = res.tasks[0].taskId!;
    await ledger.closeTask(id);
    await vi.waitFor(() => expect(ledger.get(id)?.remote?.withdrawn).toBe(true), { timeout: 5_000 });
    expect(f.revoked).toEqual([]);
    // The box comes back and starts it.
    f.set(res.tasks[0].spawnId!, { state: 'started', code: 'started', linkId: LINK });
    await reconcileRemoteTasks(deps);
    await reconcileRemoteTasks(deps);
    expect(f.revoked).toEqual([LINK]);
    expect(ledger.get(id)?.remote).toMatchObject({ withdrawn: true, revoked: true, linkId: LINK });
    off();
  });

  it('closed after it started: its link is revoked now', async () => {
    const f = fakeDaemon();
    const deps = depsOf(f.daemon);
    const ledger = deps.ledger as TaskLedger;
    const off = installRemoteTaskWithdraw(ledger, () => deps);
    const res = await startRemoteFanout(request(1), deps);
    if ('error' in res) throw new Error(res.error);
    f.set(res.tasks[0].spawnId!, { state: 'started', code: 'started', linkId: LINK });
    await reconcileRemoteTasks(deps);
    await ledger.closeTask(res.tasks[0].taskId!);
    await vi.waitFor(() => expect(f.revoked).toEqual([LINK]), { timeout: 5_000 });
    off();
  });
});
