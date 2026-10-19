// A bot fan-out's tasks: checked out DETACHED at a commit (the verify preset)
// instead of branched from origin's default branch, materialized with no
// branch, and registered in the ledger with the dispatch the merge lane reads
// as evidence (origin, preset, checkout).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FanOutService, dispatchOriginPinRefusal } from '../FanOutService';
import type { FanOutDaemonPort } from '../FanOutService';
import type { TaskWorktreeManager, TaskWorktreePlan } from '../TaskWorktreeManager';
import { TaskLedger } from '../../../daemon/ledger/TaskLedger';
import { setTaskLedgerForTests } from '../../deck/taskLedgerHost';
import { FanOutGuards, setFanOutGuardsForTests } from '../fanoutGuards';
import { setSecretGrantSource } from '../../factory/secretGrants';
import { ConnectorStore, setConnectorStore } from '../../factory/connectorStore';

const SHA = 'b'.repeat(40);
let root: string;
let ledger: TaskLedger;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp2-fanout-checkout-'));
  setFanOutGuardsForTests(new FanOutGuards({ dir: root, countLiveTasks: () => 0, ledgerTaskOwner: () => null }));
  ledger = new TaskLedger({ dir: path.join(root, 'ledger') });
  setTaskLedgerForTests(ledger);
});
afterEach(() => {
  setTaskLedgerForTests(null);
  setFanOutGuardsForTests(null);
  fs.rmSync(root, { recursive: true, force: true });
});

function rig(checkoutResult: { oid: string } | { error: string } = { oid: SHA }) {
  const plan = (slug: string): TaskWorktreePlan => ({
    repoRoot: '/repo', repoHash: 'h', taskSlug: slug,
    worktreePath: path.join(root, 'wt', slug), branch: `wtask/${slug}`, metaDir: path.join(root, 'meta', slug),
  });
  const worktrees = {
    preflight: vi.fn(async (_r: string, _t: string, taskId: string) => ({ ok: true as const, plan: plan(taskId.slice(-8)) })),
    createWorktree: vi.fn(async (p: TaskWorktreePlan) => ({ ok: true as const, worktreePath: p.worktreePath, branch: p.branch })),
    createDetachedWorktree: vi.fn(async (p: TaskWorktreePlan) => ({ ok: true as const, worktreePath: p.worktreePath, branch: '' })),
    resolveCheckout: vi.fn(async () => checkoutResult),
    resolveBase: vi.fn(async () => ({ oid: 'c'.repeat(40), ref: 'refs/remotes/origin/main' })),
    removeWorktree: vi.fn(async () => ({ ok: true as const })),
    readOriginPin: vi.fn(async (): Promise<string | undefined> => undefined),
  };
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const spawn = vi.fn(async () => ({ workspaceId: 'ws-task-1', ptyId: 'pty-1' }));
  let seq = 0;
  const daemon: FanOutDaemonPort = {
    rpc: vi.fn(async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'task.mission.start') {
        seq++;
        return { ok: true, taskId: `wtask-t-${seq}0000000`, channelId: `ch-${seq}` };
      }
      return { ok: true };
    }),
  };
  const svc = new FanOutService({
    daemon,
    renderer: { spawnWorkspace: spawn },
    worktrees: worktrees as unknown as TaskWorktreeManager,
    wiringRetryDelaysMs: [0, 0],
  });
  return { svc, worktrees, calls, spawn };
}

const base = {
  idempotencyKey: 'ws-bot::bot::bot-0a1b2c3d::wake:w-1:1',
  prompt: 'gate this head',
  titles: ['verify #12'],
  repoPath: '/repo',
  agentCmd: 'claude',
  verifiedWorkspaceId: 'ws-bot',
  caller: { kind: 'bot' as const, botId: 'bot-0a1b2c3d' },
  preset: 'verify',
};

describe('FanOutService — detached checkout + dispatch record', () => {
  it('checks out detached at the SHA, never branches, and records origin/preset/checkout on the ledger row', async () => {
    const r = rig();
    const res = await r.svc.start({ ...base, checkout: { sha: SHA, detached: true, fetchRef: 'pull/12/head' } });
    expect(res.ok).toBe(true);
    expect(r.worktrees.resolveCheckout).toHaveBeenCalledWith('/repo', SHA, 'pull/12/head');
    expect(r.worktrees.resolveBase).not.toHaveBeenCalled();
    expect(r.worktrees.createWorktree).not.toHaveBeenCalled();
    expect(r.worktrees.createDetachedWorktree).toHaveBeenCalledWith(expect.anything(), SHA);
    expect(res.tasks[0].branch).toBeUndefined();
    const update = r.calls.find((c) => c.method === 'task.mission.update');
    expect(update?.params).not.toHaveProperty('branch');
    expect(update?.params).toHaveProperty('worktreePath');
    const row = ledger.list({ ownerWorkspaceId: 'ws-bot' })[0];
    expect(row.dispatch).toEqual({
      origin: { kind: 'bot', botId: 'bot-0a1b2c3d' },
      preset: 'verify',
      checkout: { sha: SHA, detached: true },
    });
  });

  it('records the asking wake\'s thread on the dispatch, and it survives a ledger replay', async () => {
    const r = rig();
    await r.svc.start({ ...base, checkout: { sha: SHA, detached: true }, threadId: 'pr:github.com/acme/app#12' });
    const row = ledger.list({ ownerWorkspaceId: 'ws-bot' })[0];
    expect(row.dispatch?.threadId).toBe('pr:github.com/acme/app#12');
    await ledger.flush();
    const replayed = new TaskLedger({ dir: path.join(root, 'ledger') }).get(row.id);
    expect(replayed?.dispatch).toEqual(row.dispatch);
  });

  it('records the repository a bot\'s task runs in on the dispatch, and it survives a ledger replay', async () => {
    const r = rig();
    await r.svc.start({ ...base, repoKey: 'github.com/acme/app' });
    const row = ledger.list({ ownerWorkspaceId: 'ws-bot' })[0];
    expect(row.dispatch?.repoKey).toBe('github.com/acme/app');
    await ledger.flush();
    const replayed = new TaskLedger({ dir: path.join(root, 'ledger') }).get(row.id);
    expect(replayed?.dispatch).toEqual(row.dispatch);
  });

  it('records the repository of an owner\'s pane fan-out on the dispatch, and it survives a ledger replay', async () => {
    const r = rig();
    await r.svc.start({ ...base, caller: { kind: 'pane', paneId: 'p1', surfaceId: 's1' }, preset: undefined, repoKey: 'github.com/acme/app' });
    const row = ledger.list({ ownerWorkspaceId: 'ws-bot' })[0];
    expect(row.dispatch).toMatchObject({ origin: { kind: 'pane' }, repoKey: 'github.com/acme/app' });
    await ledger.flush();
    expect(new TaskLedger({ dir: path.join(root, 'ledger') }).get(row.id)?.dispatch).toEqual(row.dispatch);
  });

  it('a bot\'s fan-out is held to the bot\'s origin pin: an origin moved to another port refuses it; a match records the bot\'s pin', async () => {
    const plan = (originPin: string) => async (_r: string, _t: string, taskId: string) => ({
      ok: true as const,
      plan: { repoRoot: '/repo', repoHash: 'h', taskSlug: taskId.slice(-8), worktreePath: path.join(root, 'wt', taskId.slice(-8)), branch: `wtask/${taskId.slice(-8)}`, metaDir: path.join(root, 'meta', taskId.slice(-8)), gitCommonDir: '/repo/.git', originPin },
    });
    const botPin = 'ssh://git@git.corp.example:22/acme/app.git';
    const missions = (r: ReturnType<typeof rig>) => r.calls.filter((c) => c.method === 'task.mission.start').length;
    const moved = rig();
    moved.worktrees.preflight.mockImplementation(plan('ssh://git@git.corp.example:2222/acme/app.git'));
    const refused = await moved.svc.start({ ...base, repoKey: 'git.corp.example/acme/app', originPin: botPin });
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining('re-select the repository') });
    expect(moved.worktrees.createWorktree).not.toHaveBeenCalled();
    expect(missions(moved)).toBe(0);
    expect(ledger.list({ ownerWorkspaceId: 'ws-bot' })).toHaveLength(0);
    // The base is fetched from origin by its own spelling: a respelling refuses too.
    const respelled = rig();
    respelled.worktrees.preflight.mockImplementation(plan('ssh://git@git.corp.example:22/acme/App'));
    expect(await respelled.svc.start({ ...base, repoKey: 'git.corp.example/acme/app', originPin: botPin })).toMatchObject({ ok: false, error: expect.stringContaining('re-select the repository') });
    // origin moved after the batch preflight, before the task's mission: refused, no mission created.
    const late = rig();
    late.worktrees.preflight.mockImplementation(plan(botPin));
    late.worktrees.readOriginPin.mockImplementation(async () => 'ssh://git@git.corp.example:2222/acme/app.git');
    const lateRes = await late.svc.start({ ...base, repoKey: 'git.corp.example/acme/app', originPin: botPin });
    expect(lateRes.tasks[0]).toMatchObject({ ok: false, error: expect.stringContaining('re-select the repository') });
    expect(missions(late)).toBe(0);
    expect(late.worktrees.createWorktree).not.toHaveBeenCalled();
    const same = rig();
    same.worktrees.preflight.mockImplementation(plan(botPin));
    same.worktrees.readOriginPin.mockImplementation(async () => botPin);
    expect((await same.svc.start({ ...base, repoKey: 'git.corp.example/acme/app', originPin: botPin })).ok).toBe(true);
    expect(missions(same)).toBe(1);
    expect(ledger.list({ ownerWorkspaceId: 'ws-bot' })[0].dispatch?.originPin).toBe(botPin);
    expect(dispatchOriginPinRefusal(undefined, 'ssh://git@git.corp.example:2222/acme/app.git')).toBeNull();
    expect(dispatchOriginPinRefusal(botPin, undefined)).toMatch(/re-select/);
  });

  it('records the repository\'s common git dir from the preflight on the dispatch, and it survives a ledger replay', async () => {
    const r = rig();
    r.worktrees.preflight.mockImplementation(async (_r: string, _t: string, taskId: string) => ({
      ok: true as const,
      plan: { repoRoot: '/repo', repoHash: 'h', taskSlug: taskId.slice(-8), worktreePath: path.join(root, 'wt', taskId.slice(-8)), branch: `wtask/${taskId.slice(-8)}`, metaDir: path.join(root, 'meta', taskId.slice(-8)), gitCommonDir: '/repo/.git', originPin: 'ssh://git@git.corp.example:2222/acme/App' },
    }));
    await r.svc.start({ ...base, repoKey: 'github.com/acme/app' });
    const row = ledger.list({ ownerWorkspaceId: 'ws-bot' })[0];
    expect(row.dispatch?.gitCommonDir).toBe('/repo/.git');
    expect(row.dispatch?.originPin).toBe('ssh://git@git.corp.example:2222/acme/App');
    await ledger.flush();
    expect(new TaskLedger({ dir: path.join(root, 'ledger') }).get(row.id)?.dispatch).toMatchObject({ gitCommonDir: '/repo/.git', originPin: 'ssh://git@git.corp.example:2222/acme/App' });
  });

  it('a tainted bot origin keeps its mark on the dispatch, across a ledger replay', async () => {
    const r = rig();
    await r.svc.start({ ...base, caller: { kind: 'bot', botId: 'bot-0a1b2c3d', tainted: true }, checkout: { sha: SHA, detached: true } });
    const row = ledger.list({ ownerWorkspaceId: 'ws-bot' })[0];
    expect(row.dispatch?.origin).toEqual({ kind: 'bot', botId: 'bot-0a1b2c3d', tainted: true });
    await ledger.flush();
    expect(new TaskLedger({ dir: path.join(root, 'ledger') }).get(row.id)?.dispatch?.origin).toEqual({ kind: 'bot', botId: 'bot-0a1b2c3d', tainted: true });
  });

  it('a checkout that cannot be resolved creates nothing', async () => {
    const r = rig({ error: 'commit is not in the repository' });
    const res = await r.svc.start({ ...base, checkout: { sha: SHA, detached: true } });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not in the repository/);
    expect(r.calls.some((c) => c.method === 'task.mission.start')).toBe(false);
  });

  it('refuses a checkout combined with dependsOn or worktree:false', async () => {
    const r = rig();
    const graph = await r.svc.start({ ...base, titles: ['a', 'b'], dependsOn: [[], [0]], checkout: { sha: SHA, detached: true } });
    expect(graph.ok).toBe(false);
    const output = await r.svc.start({ ...base, idempotencyKey: 'k2', worktree: false, outputFolder: 'x', checkout: { sha: SHA, detached: true } });
    expect(output.ok).toBe(false);
  });

  it('a branch fan-out from a pane records its origin, no checkout, and the base commit its branch was created from', async () => {
    const r = rig();
    await r.svc.start({ ...base, caller: { kind: 'pane', paneId: 'p1' }, preset: undefined });
    expect(r.worktrees.createWorktree).toHaveBeenCalledWith(expect.anything(), 'c'.repeat(40));
    expect(ledger.list({ ownerWorkspaceId: 'ws-bot' })[0].dispatch).toEqual({ origin: { kind: 'pane' }, baseOid: 'c'.repeat(40) });
  });

  it('mayLaunch is asked right before each pane spawns: a refusal there launches nothing and closes the task', async () => {
    const r = rig();
    let refusal: string | null = null;
    let asked = 0;
    const res = await r.svc.start({
      ...base,
      titles: ['first', 'second'],
      checkout: { sha: SHA, detached: true },
      // The factory goes off after the first worker launched.
      mayLaunch: () => { asked++; const why = refusal; refusal = 'the agent factory is off'; return why; },
    });
    expect(asked).toBe(2);
    expect(r.spawn).toHaveBeenCalledTimes(1);
    expect(res.tasks[0]).toMatchObject({ ok: true, workspaceId: 'ws-task-1' });
    expect(res.tasks[1]).toMatchObject({ ok: false, error: 'not launched: the agent factory is off' });
    expect(res.tasks[1].workspaceId).toBeUndefined();
    // Its mission is closed and, since no pane was ever started in it, its
    // worktree is rolled back (#2349) and no longer reported as preserved.
    expect(r.calls.filter((c) => c.method === 'task.mission.close')).toHaveLength(1);
    expect(r.worktrees.removeWorktree).toHaveBeenCalledTimes(1);
    expect(r.worktrees.removeWorktree).toHaveBeenCalledWith('/repo', 'h', expect.any(String), undefined, { force: true });
    expect(res.tasks[1].preservedWorktree).toBeUndefined();
    expect(ledger.get(res.tasks[1].taskId!)).toMatchObject({ status: 'cancelled' });
  });

  it('awaitLaunchSlot holds each task before its spawn: the slot is released once the row registers, and a refused slot launches nothing', async () => {
    const r = rig();
    const released: string[] = [];
    const order: string[] = [];
    const res = await r.svc.start({
      ...base,
      titles: ['first', 'second'],
      checkout: { sha: SHA, detached: true },
      mayLaunch: () => { order.push('mayLaunch'); return null; },
      awaitLaunchSlot: async (t) => {
        order.push(`slot:${t.title}`);
        if (t.title === 'second') return { ok: false, reason: 'no agent slot freed within 30 minutes' };
        return { ok: true, release: () => { released.push(t.taskId); order.push(`registered:${ledger.get(t.taskId) ? 'yes' : 'no'}`); } };
      },
    });
    expect(order).toEqual(['slot:first', 'mayLaunch', 'registered:yes', 'slot:second']);
    expect(released).toEqual([res.tasks[0].taskId]);
    expect(r.spawn).toHaveBeenCalledTimes(1);
    expect(res.tasks[1]).toMatchObject({ ok: false, error: 'not launched: no agent slot freed within 30 minutes' });
    expect(r.calls.filter((c) => c.method === 'task.mission.close')).toHaveLength(1);
    // No pane was ever started in it: its worktree is rolled back (#2349)
    // and the task still gets its cancelled row.
    expect(r.worktrees.removeWorktree).toHaveBeenCalledTimes(1);
    expect(r.worktrees.removeWorktree).toHaveBeenCalledWith('/repo', 'h', expect.any(String), undefined, { force: true });
    expect(res.tasks[1].preservedWorktree).toBeUndefined();
    const row = ledger.get(res.tasks[1].taskId!);
    expect(row).toMatchObject({ status: 'cancelled' });
    expect(row!.summary).toContain('not launched: no agent slot freed within 30 minutes');
    expect(row!.summary).toContain('its worktree was removed');
  });

  it('a launch refused for a secret it cannot grant rolls its worktree back and writes the row', async () => {
    const r = rig();
    const res = await r.svc.start({
      ...base,
      checkout: { sha: SHA, detached: true },
      // Not a name a grant can carry: no grant, so no launch.
      secretNames: ['not a valid name!'],
    });
    expect(res.tasks[0]).toMatchObject({ ok: false, error: 'not launched: a secret it names is not stored any more' });
    expect(r.spawn).not.toHaveBeenCalled();
    expect(r.worktrees.removeWorktree).toHaveBeenCalledWith('/repo', 'h', expect.any(String), undefined, { force: true });
    expect(res.tasks[0].preservedWorktree).toBeUndefined();
    expect(ledger.get(res.tasks[0].taskId!)).toMatchObject({ status: 'cancelled' });
  });

  it('a slot granted to a task whose launch is then refused is given back', async () => {
    const r = rig();
    const release = vi.fn();
    const res = await r.svc.start({
      ...base,
      checkout: { sha: SHA, detached: true },
      mayLaunch: () => 'the owner stopped this bot',
      awaitLaunchSlot: async () => ({ ok: true, release }),
    });
    expect(res.tasks[0]).toMatchObject({ ok: false });
    expect(release).toHaveBeenCalledTimes(1);
    expect(r.spawn).not.toHaveBeenCalled();
  });

  it('a worker whose ledger row could not be written keeps its slot held on its workspace', async () => {
    const r = rig();
    const release = vi.fn();
    const hold = vi.fn();
    vi.spyOn(ledger, 'register').mockRejectedValueOnce(new Error('ledger write failed'));
    const res = await r.svc.start({
      ...base,
      checkout: { sha: SHA, detached: true },
      awaitLaunchSlot: async () => ({ ok: true, release, hold }),
    });
    expect(res.tasks[0].workspaceId).toBe('ws-task-1');
    expect(hold).toHaveBeenCalledWith('ws-task-1');
    expect(release).not.toHaveBeenCalled();
  });

  it('a slot granted to a task whose launch then throws is given back once', async () => {
    const r = rig();
    const release = vi.fn();
    const hold = vi.fn();
    setSecretGrantSource(() => ({ values: () => { throw new Error('key store failed'); } }) as never);
    try {
      await r.svc.start({
        ...base,
        checkout: { sha: SHA, detached: true },
        secretNames: ['API_KEY'],
        awaitLaunchSlot: async () => ({ ok: true, release, hold }),
      }).catch(() => undefined);
    } finally {
      setSecretGrantSource(null);
    }
    expect(r.spawn).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(hold).not.toHaveBeenCalled();
  });

  it('a queued task launches with its connections as the library holds them then: one turned off meanwhile is left out', async () => {
    const r = rig();
    const lib = new ConnectorStore(path.join(root, 'connectors.json'), { botIds: () => new Set([base.caller.botId]) });
    lib.load();
    const remote = { transport: 'http' as const, remote: { url: 'https://x.dev/mcp', headers: {} }, secrets: [], tools: { mode: 'all' as const, blocked: [] }, enabled: true, scope: { kind: 'all' as const } };
    const kept = lib.save({ ...remote, name: 'kept' });
    const dropped = lib.save({ ...remote, name: 'dropped' });
    if (!kept.ok || !dropped.ok) throw new Error('library');
    setConnectorStore(lib);
    try {
      await r.svc.start({
        ...base,
        checkout: { sha: SHA, detached: true },
        connectors: [kept.connector, dropped.connector],
        // While the task waits for its slot, the owner switches one off for the bot.
        awaitLaunchSlot: async () => {
          lib.setOffForBot(dropped.connector.id, base.caller.botId, true);
          return { ok: true, release: vi.fn(), hold: vi.fn() };
        },
      });
      const row = ledger.list().find((e) => e.dispatch?.origin?.botId === base.caller.botId);
      expect(row?.dispatch?.connectors).toEqual(['kept']);
      const prompt = fs.readFileSync(path.join(root, 'meta', row!.id.slice(-8), 'prompt.md'), 'utf8');
      expect(prompt).toContain('Connections: kept (tools mcp__kept__*)');
      expect(prompt).not.toContain('dropped');
    } finally {
      setConnectorStore(null);
      await lib.flush();
    }
  });
});
