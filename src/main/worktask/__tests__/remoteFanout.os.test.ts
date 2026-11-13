// fanout_start with `pc`: missions and ledger rows here, start requests to
// another PC. Driven against a real TaskLedger and a daemon fake that keeps
// the requester's contract (a request key answers with the stored request).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TaskLedger } from '../../../daemon/ledger/TaskLedger';
import { headlessTreeId } from '../../../daemon/a2aRemote/headlessStarter';
import { branchFor } from '../../a2aRemote/spawnWorktree';
import { SPAWN_REQUEST_KEY_RE, type A2aSpawnAskInput, type A2aSpawnOutgoingSummary } from '../../../shared/a2aSpawn';
import { isRemoteTask } from '../../../shared/ledger';
import { TaskCloseService } from '../TaskCloseService';
import { setTaskLedgerForTests } from '../../deck/taskLedgerHost';
import { registerLedgerRpc } from '../../pipe/handlers/ledger.rpc';
import type { RpcContext } from '../../../shared/rpc';
import {
  branchOnPc, installRemoteTaskWithdraw, reconcileRemoteTasks, remoteCodeText, remoteFanoutKeys, remoteFanoutRefusal,
  startRemoteFanout, type RemoteFanoutDaemon, type RemoteFanoutDeps, type RemoteFanoutRequest,
} from '../remoteFanout';

const BOX = '0f1e2d3c-4b5a-4968-8776-655443322110';
const LINK = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d';
const SELF = '7d1e2f30-4b5c-4d6e-9f80-123456789abc';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-remote-fanout-'));
});
afterEach(() => {
  setTaskLedgerForTests(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

/** The daemon as the requester and the mission log answer it. */
function fakeDaemon(opts: { supported?: boolean; askError?: 'unavailable'; askThrows?: boolean; name?: string } = {}) {
  const requests = new Map<string, A2aSpawnOutgoingSummary>(); // by spawnId
  const byKey = new Map<string, string>(); // callerKey:requestKey → spawnId
  const missions = new Map<string, { taskId: string; channelId: string }>();
  const asks: A2aSpawnAskInput[] = [];
  const revoked: string[] = [];
  const closed: string[] = [];
  const closedMissions = new Set<string>();
  const linkEnds = new Map<string, string>(); // linkId → remote workspace id
  let n = 0;
  const daemon: RemoteFanoutDaemon = {
    ask: vi.fn(async (input: A2aSpawnAskInput) => {
      asks.push(input);
      if (opts.askThrows) throw new Error('timed out');
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
      places: [{ hostId: BOX, name: opts.name ?? 'box', online: true, supported: opts.supported ?? true }],
    }),
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
    closedMissions: async () => closedMissions,
    selfHostId: async () => SELF,
    linkRemoteWorkspace: async (linkId) => linkEnds.get(linkId) ?? null,
  };
  const set = (spawnId: string, patch: Partial<A2aSpawnOutgoingSummary>) => requests.set(spawnId, { ...requests.get(spawnId)!, ...patch });
  return { daemon, asks, revoked, closed, closedMissions, linkEnds, requests, set };
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

  it('names the branch on the other PC as its worktree code does, for both modes', () => {
    const spawnId = 'sp-0f6c1d2e-3a4b-4c5d-8e9f-0123456789ab';
    expect(branchOnPc(spawnId, 'hl-0f6c1d2e-3a4b-4c5d-8e9f-0123456789ab', SELF)).toBe(branchFor(headlessTreeId(SELF, spawnId)));
    expect(branchOnPc(spawnId, 'ws-desktop-1', SELF)).toBe(branchFor(spawnId));
    expect(branchOnPc(spawnId, 'hl-x', null)).toBeNull();
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

  it('a request refused here ends its task with a closed row and mission; the same key answers from that row', async () => {
    const f = fakeDaemon({ askError: 'unavailable' });
    const deps = depsOf(f.daemon);
    const res = await startRemoteFanout(request(1), deps);
    if ('error' in res) throw new Error(res.error);
    expect(res.tasks[0]).toMatchObject({ ok: false, reason: expect.stringMatching(/could not be stored or queued/) });
    expect(f.closed).toEqual([res.tasks[0].taskId]);
    expect(deps.ledger.get(res.tasks[0].taskId!)).toMatchObject({ status: 'cancelled', taskWorkspaceId: `unlaunched:${res.tasks[0].taskId}` });
    const again = await startRemoteFanout(request(1), deps);
    if ('error' in again) throw new Error(again.error);
    expect(again.tasks[0]).toMatchObject({ ok: false, reason: expect.stringMatching(/could not be stored or queued/) });
    expect(f.asks).toHaveLength(1);
  });

  it('a retried key whose mission is closed is refused, not asked again', async () => {
    const f = fakeDaemon({ askThrows: true });
    const deps = depsOf(f.daemon);
    const res = await startRemoteFanout(request(1), deps);
    if ('error' in res) throw new Error(res.error);
    // No row (the request got no answer); the mission is then closed.
    f.closedMissions.add(res.tasks[0].taskId!);
    const again = await startRemoteFanout(request(1), deps);
    if ('error' in again) throw new Error(again.error);
    expect(again.tasks[0]).toMatchObject({ ok: false, reason: expect.stringMatching(/mission was closed/) });
    expect(f.asks).toHaveLength(1);
    expect(deps.ledger.list()).toHaveLength(0);
  });

  it('a request with no answer keeps its mission open and is found by its key on a retry', async () => {
    const f = fakeDaemon({ askThrows: true });
    const deps = depsOf(f.daemon);
    const res = await startRemoteFanout(request(1), deps);
    if ('error' in res) throw new Error(res.error);
    expect(res.tasks[0]).toMatchObject({ ok: false, reason: expect.stringMatching(/send the same key again/) });
    expect(f.closed).toEqual([]);
    expect(deps.ledger.list()).toHaveLength(0);
  });

  it('checks the folder id and the PC name it stores before anything is sent', async () => {
    const f = fakeDaemon({ name: 'bad\u0007name' });
    const deps = depsOf(f.daemon);
    expect(await startRemoteFanout(request(1, { root: 'x'.repeat(40) }), deps)).toEqual({ error: expect.stringMatching(/folder id/) });
    expect(f.asks).toHaveLength(0);
    const res = await startRemoteFanout(request(1, { pc: BOX }), deps);
    if ('error' in res) throw new Error(res.error);
    expect(res.pc).toBe(BOX);
    expect(deps.ledger.get(res.tasks[0].taskId!)?.remote?.pc).toBe(BOX);
  });
});

describe('reconcileRemoteTasks', () => {
  it('fails a refused row with a readable reason, and starts one with its link and task', async () => {
    const f = fakeDaemon();
    const deps = depsOf(f.daemon);
    const res = await startRemoteFanout(request(2), deps);
    if ('error' in res) throw new Error(res.error);
    f.set(res.tasks[0].spawnId!, { state: 'refused', code: 'not-allowed' });
    f.set(res.tasks[1].spawnId!, { state: 'started', code: 'started', linkId: LINK });
    await reconcileRemoteTasks(deps);
    // The link is not listed yet: no branch until a later pass sees it.
    expect(deps.ledger.get(res.tasks[1].taskId!)?.remote?.branchOnPc).toBeUndefined();
    f.linkEnds.set(LINK, 'hl-0f6c1d2e-3a4b-4c5d-8e9f-0123456789ab');
    await reconcileRemoteTasks(deps);
    expect(deps.ledger.get(res.tasks[1].taskId!)?.remote?.branchOnPc).toBe(branchFor(headlessTreeId(SELF, res.tasks[1].spawnId!)));
    const refused = deps.ledger.get(res.tasks[0].taskId!)!;
    expect(refused).toMatchObject({ status: 'failed', remote: { state: 'refused', code: 'not-allowed' } });
    expect(refused.summary).toMatch(/not-allowed/);
    const started = deps.ledger.get(res.tasks[1].taskId!)!;
    expect(started).toMatchObject({ status: 'working', remote: { state: 'started', linkId: LINK } });
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

  it('an expired row whose start arrives late is ended', async () => {
    const f = fakeDaemon();
    const deps = depsOf(f.daemon);
    const ledger = deps.ledger as TaskLedger;
    const off = installRemoteTaskWithdraw(ledger, () => deps);
    const res = await startRemoteFanout(request(1), deps);
    if ('error' in res) throw new Error(res.error);
    const spawnId = res.tasks[0].spawnId!;
    f.set(spawnId, { state: 'expired', code: 'expired' });
    await reconcileRemoteTasks(deps);
    await vi.waitFor(() => expect(ledger.get(res.tasks[0].taskId!)?.remote?.withdrawn).toBe(true), { timeout: 5_000 });
    f.set(spawnId, { state: 'started', code: 'started', linkId: LINK });
    await reconcileRemoteTasks(deps);
    expect(f.revoked).toEqual([LINK]);
    off();
  });

  it('a row that ended while the daemon was away, or was completed, is withdrawn by the next pass', async () => {
    const f = fakeDaemon();
    const deps = depsOf(f.daemon);
    const ledger = deps.ledger as TaskLedger;
    const off = installRemoteTaskWithdraw(ledger, () => null); // no daemon at the transitions
    const res = await startRemoteFanout(request(2), deps);
    if ('error' in res) throw new Error(res.error);
    const [a, b] = res.tasks.map((t) => t.taskId!);
    for (const t of res.tasks) f.set(t.spawnId!, { state: 'started', code: 'started', linkId: t.index === 0 ? LINK : '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e' });
    await reconcileRemoteTasks(deps);
    await ledger.closeTask(a);
    const brain = { kind: 'brain' as const, workspaceId: 'ws-owner' };
    const reviewed = await ledger.update({ id: b, status: 'review_requested', actor: brain, expectedRev: ledger.get(b)!.rev });
    if (!reviewed.ok) throw new Error(reviewed.message);
    const done = await ledger.update({ id: b, status: 'completed', actor: brain, expectedRev: reviewed.entry.rev, force: true, reason: 'checked by hand' });
    if (!done.ok) throw new Error(done.message);
    expect(f.revoked).toEqual([]);
    await reconcileRemoteTasks(deps);
    expect(f.revoked.sort()).toEqual([LINK, '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e'].sort());
    off();
  });

  it('runs one pass at a time per ledger', async () => {
    const f = fakeDaemon();
    const deps = depsOf(f.daemon);
    await startRemoteFanout(request(1), deps);
    let lists = 0;
    const outgoing = f.daemon.outgoing;
    f.daemon.outgoing = async () => {
      lists++;
      return outgoing();
    };
    await Promise.all([reconcileRemoteTasks(deps), reconcileRemoteTasks(deps), reconcileRemoteTasks(deps)]);
    expect(lists).toBe(2); // the first pass, then one more for the calls made during it
  });
});

describe('every close path reaches the withdraw', () => {
  const started = async () => {
    const f = fakeDaemon();
    const ledger = new TaskLedger({ dir });
    const deps = depsOf(f.daemon, ledger);
    const off = installRemoteTaskWithdraw(ledger, () => deps);
    const res = await startRemoteFanout(request(1), deps);
    if ('error' in res) throw new Error(res.error);
    f.set(res.tasks[0].spawnId!, { state: 'started', code: 'started', linkId: LINK });
    await reconcileRemoteTasks(deps);
    return { f, ledger, deps, off, id: res.tasks[0].taskId! };
  };

  it('TaskCloseService (worktask close)', async () => {
    const { f, ledger, off, id } = await started();
    setTaskLedgerForTests(ledger);
    const svc = new TaskCloseService({ daemon: { rpc: async (_m, p) => ({ ok: true, taskId: p['taskId'] }) }, worktrees: {} as never });
    expect(await svc.closeTask({ taskId: id, verifiedWorkspaceId: 'ws-owner' })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(f.revoked).toEqual([LINK]), { timeout: 5_000 });
    off();
  });

  it('the ledger RPC (the owner brain cancels it)', async () => {
    const { f, ledger, off, id } = await started();
    const handlers = new Map<string, (p: Record<string, unknown>, ctx?: RpcContext) => Promise<unknown>>();
    registerLedgerRpc({ register: (m: string, h: never) => handlers.set(m, h) } as never, () => null, { getLedger: () => ledger, resolveCallerWorkspace: async () => null });
    const res = (await handlers.get('ledger.update')!({ taskId: id, status: 'cancelled', expectedRev: ledger.get(id)!.rev }, { commanderWorkspace: 'ws-owner' } as RpcContext)) as { ok: boolean };
    expect(res.ok).toBe(true);
    await vi.waitFor(() => expect(f.revoked).toEqual([LINK]), { timeout: 5_000 });
    off();
  });

  it('a revoke that failed is retried after a desktop restart', async () => {
    const f = fakeDaemon();
    const ledger = new TaskLedger({ dir });
    const failing = { ...f.daemon, revokeLink: vi.fn(async () => { throw new Error('daemon away'); }) };
    const deps = depsOf(failing, ledger);
    const off = installRemoteTaskWithdraw(ledger, () => deps);
    const res = await startRemoteFanout(request(1), deps);
    if ('error' in res) throw new Error(res.error);
    f.set(res.tasks[0].spawnId!, { state: 'started', code: 'started', linkId: LINK });
    await reconcileRemoteTasks(deps);
    await ledger.closeTask(res.tasks[0].taskId!);
    await vi.waitFor(() => expect(failing.revokeLink).toHaveBeenCalled(), { timeout: 5_000 });
    expect(ledger.get(res.tasks[0].taskId!)?.remote).toMatchObject({ withdrawn: true });
    expect(ledger.get(res.tasks[0].taskId!)?.remote?.revoked).toBeUndefined();
    off();
    await ledger.flush();
    // After the restart: the row read back from disk, the daemon reachable.
    const after = new TaskLedger({ dir });
    await reconcileRemoteTasks(depsOf(f.daemon, after));
    expect(f.revoked).toEqual([LINK]);
    expect(after.get(res.tasks[0].taskId!)?.remote?.revoked).toBe(true);
  });
});
