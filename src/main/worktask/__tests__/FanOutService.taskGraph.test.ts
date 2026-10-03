// files / dependsOn on a fan-out: the scope reaches the worker's prompt, and a
// dependent task is spawned only after its dependency hands in its work.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FanOutService, type FanOutDaemonPort, type FanOutRendererPort } from '../FanOutService';
import type { TaskWorktreePlan } from '../TaskWorktreeManager';
import { TaskLedger } from '../../../daemon/ledger/TaskLedger';
import { setTaskLedgerForTests } from '../../deck/taskLedgerHost';
import { FanOutGuards, setFanOutGuardsForTests } from '../fanoutGuards';

let root: string;
let ledger: TaskLedger;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-fanout-graph-'));
  setFanOutGuardsForTests(new FanOutGuards({ dir: root, countLiveTasks: () => 0, ledgerTaskOwner: () => null }));
  ledger = new TaskLedger({ dir: root });
  setTaskLedgerForTests(ledger);
});
afterEach(() => {
  setFanOutGuardsForTests(null);
  setTaskLedgerForTests(null);
  fs.rmSync(root, { recursive: true, force: true });
});

function plan(slug: string): TaskWorktreePlan {
  return {
    repoRoot: '/repo',
    repoHash: 'h',
    taskSlug: slug,
    worktreePath: path.join(root, 'wt', slug),
    branch: `wtask/${slug}`,
    metaDir: path.join(root, 'meta', slug),
  };
}

function makeService(opts: { dependencyWaitMs?: number; hold?: (n: number) => Promise<void> } = {}) {
  let oid = 0;
  const worktrees = {
    preflight: vi.fn(async (_r: string, _t: string, taskId: string) => ({ ok: true as const, plan: plan(taskId.slice(-8)) })),
    createWorktree: vi.fn(async (p: TaskWorktreePlan, _baseOid?: string) => ({ ok: true as const, worktreePath: p.worktreePath, branch: p.branch })),
    removeWorktree: vi.fn(async () => ({ ok: true as const })),
    // Each resolve is a new fetch: a late task must see a later origin commit.
    resolveBase: vi.fn(async () => ({ oid: String(++oid).repeat(40).slice(0, 40), ref: 'refs/remotes/origin/main' })),
  };
  let seq = 0;
  const daemon: FanOutDaemonPort = {
    rpc: vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'task.mission.start') {
        seq++;
        return { ok: true, taskId: `wtask-t-${seq}0000000`, channelId: `ch-${seq}` };
      }
      if (method === 'task.mission.update') return { ok: true, taskId: params['taskId'] };
      return { ok: true };
    }),
  };
  const spawned: Array<{ name: string; initialCommand: string }> = [];
  let ws = 0;
  const renderer: FanOutRendererPort = {
    spawnWorkspace: vi.fn(async (p) => {
      await opts.hold?.(spawned.length);
      spawned.push(p);
      ws++;
      return { workspaceId: `ws-task-${ws}`, ptyId: `pty-${ws}` };
    }),
  };
  const service = new FanOutService({ daemon, renderer, worktrees: worktrees as any, ledger, autonomy: async () => undefined, dependencyWaitMs: opts.dependencyWaitMs });
  return { service, worktrees, spawned };
}

const req = {
  idempotencyKey: 'graph-1',
  prompt: 'shared',
  titles: ['Build API', 'Build UI'],
  repoPath: '/repo',
  agentCmd: 'claude',
  verifiedWorkspaceId: 'ws-owner',
};

describe('FanOutService task graph', () => {
  it('refuses overlapping write scopes before anything spawns', async () => {
    const { service, spawned } = makeService();
    const r = await service.start({ ...req, files: [['src/api/**'], ['src/api/routes.ts']] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/overlaps/);
    expect(spawned).toHaveLength(0);
  });

  it('states the write scope in the worker prompt', async () => {
    const { service } = makeService();
    const r = await service.start({ ...req, files: [['src/api/**'], ['src/ui/**']] });
    expect(r.ok).toBe(true);
    const prompt = fs.readFileSync(path.join(plan(r.tasks[0].taskId!.slice(-8)).metaDir, 'prompt.md'), 'utf8');
    expect(prompt).toContain('## Your write scope');
    expect(prompt).toContain('`src/api/**`');
    expect(prompt).not.toContain('src/ui/**');
  });

  it('spawns a dependent task only after its dependency requests review, from a fresh base', async () => {
    const { service, worktrees, spawned } = makeService();
    const launched: string[] = [];
    const r = await service.start({ ...req, dependsOn: [[], [0]], onDeferredLaunch: (t, info) => launched.push(`${t.title}:${info.remaining}`) });
    expect(r.ok).toBe(true);
    expect(spawned).toHaveLength(1);
    expect(r.tasks[1].pending).toEqual({ waitingOn: [0] });
    expect(r.warnings?.some((w) => w.includes('wait for their dependencies'))).toBe(true);

    const dep = ledger.get(r.tasks[0].taskId!)!;
    // `working` → `input_required` is not done: still waiting.
    await ledger.update({ id: dep.id, status: 'input_required', actor: { kind: 'worker', workspaceId: dep.taskWorkspaceId }, expectedRev: dep.rev });
    await service.drainDeferredLaunches();
    expect(spawned).toHaveLength(1);

    await ledger.update({ id: dep.id, status: 'review_requested', actor: { kind: 'worker', workspaceId: dep.taskWorkspaceId }, expectedRev: dep.rev + 1 });
    await service.drainDeferredLaunches();
    expect(spawned).toHaveLength(2);
    expect(launched).toEqual(['Build UI:0']);
    // The cached result is updated in place, so a re-poll shows the launch.
    const again = await service.start(req);
    expect(again.tasks[1].pending).toBeUndefined();
    expect(again.tasks[1].ok).toBe(true);
    // Base fetched again at launch, not reused from the first wave.
    expect(worktrees.resolveBase).toHaveBeenCalledTimes(2);
    expect(worktrees.createWorktree.mock.calls[1][1]).toBe('2'.repeat(40));
    const prompt = fs.readFileSync(path.join(plan(again.tasks[1].taskId!.slice(-8)).metaDir, 'prompt.md'), 'utf8');
    expect(prompt).toContain(`branch \`${r.tasks[0].branch}\``);
  });

  it('drops a dependent task when its dependency is cancelled', async () => {
    const { service, spawned } = makeService();
    const r = await service.start({ ...req, dependsOn: [[], [0]] });
    await ledger.closeTask(r.tasks[0].taskId!);
    await service.drainDeferredLaunches();
    expect(spawned).toHaveLength(1);
    expect(r.tasks[1].pending).toBeUndefined();
    expect(r.tasks[1].error).toMatch(/dependency \(index 0\) was cancelled/);
  });

  it('drops on a cancelled dependency even while another dependency is still working', async () => {
    const { service, spawned } = makeService();
    const r = await service.start({ ...req, titles: ['A', 'B', 'C'], dependsOn: [[], [], [0, 1]] });
    await ledger.closeTask(r.tasks[1].taskId!);
    await service.drainDeferredLaunches();
    expect(spawned).toHaveLength(2);
    expect(r.tasks[2].error).toMatch(/index 1\) was cancelled/);
  });

  it('re-checks a queued task when its turn comes, and lets the owner cancel it', async () => {
    // B and C both wait on A. B's spawn is held; while it is, A is sent back
    // to work, so C — queued behind B — must not spawn when its turn comes.
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    const { service, spawned } = makeService({ hold: async (n) => (n === 1 ? held : undefined) });
    const r = await service.start({ ...req, titles: ['A', 'B', 'C'], dependsOn: [[], [0], [0]] });
    const dep = ledger.get(r.tasks[0].taskId!)!;
    await ledger.update({ id: dep.id, status: 'review_requested', actor: { kind: 'worker', workspaceId: dep.taskWorkspaceId }, expectedRev: 1 });
    await ledger.update({ id: dep.id, status: 'working', actor: { kind: 'brain', workspaceId: 'ws-owner' }, expectedRev: 2 });
    release();
    await service.drainDeferredLaunches();
    expect(spawned.map((p) => p.name)).toEqual(['wtask: A', 'wtask: B']);
    expect(r.tasks[2].pending).toBeDefined();
    expect(service.cancelDependents('graph-1', 'owner said stop')).toBe(1);
    expect(r.tasks[2].error).toMatch(/owner said stop/);
    expect(service.cancelDependents('graph-1', 'again')).toBeNull();
  });

  it('drops waiting tasks at the wait deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { service, spawned } = makeService({ dependencyWaitMs: 1000 });
      const r = await service.start({ ...req, dependsOn: [[], [0]] });
      vi.advanceTimersByTime(1001);
      expect(r.tasks[1].error).toMatch(/did not finish within/);
      expect(spawned).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
