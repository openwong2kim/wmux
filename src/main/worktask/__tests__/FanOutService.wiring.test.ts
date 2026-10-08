// ─── FanOutService post-spawn wiring and launch check (#1919, #1920, #1921) ──
//
// Once a task's pane exists, its worker is starting whatever happens next. So
// a failed materialization (task.mission.update) must not stop the owner from
// getting the task's ledger row (#1921: the T5 read lane reads it) or the
// worker from getting its mission-channel seat (#1920). And the fan-out must
// find out when the worker's agent never started in that pane (#1919).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FanOutService } from '../FanOutService';
import type { FanOutDaemonPort, FanOutLaunchProbe, FanOutRendererPort } from '../FanOutService';
import type { TaskWorktreeManager, TaskWorktreePlan } from '../TaskWorktreeManager';
import { TaskLedger } from '../../../daemon/ledger/TaskLedger';
import { setTaskLedgerForTests } from '../../deck/taskLedgerHost';
import { FanOutGuards, setFanOutGuardsForTests } from '../fanoutGuards';

let root: string;
let ledger: TaskLedger;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-fanout-wiring-'));
  setFanOutGuardsForTests(new FanOutGuards({ dir: root, countLiveTasks: () => 0, ledgerTaskOwner: () => null }));
  ledger = new TaskLedger({ dir: path.join(root, 'ledger') });
  setTaskLedgerForTests(ledger);
});
afterEach(() => {
  setTaskLedgerForTests(null);
  setFanOutGuardsForTests(null);
  fs.rmSync(root, { recursive: true, force: true });
});

function makeWorktrees() {
  const plan = (slug: string): TaskWorktreePlan => ({
    repoRoot: '/repo',
    repoHash: 'h',
    taskSlug: slug,
    worktreePath: path.join(root, 'wt', slug),
    branch: `wtask/${slug}`,
    metaDir: path.join(root, 'meta', slug),
  });
  return {
    preflight: vi.fn(async (_repo: string, _title: string, taskId: string) => ({ ok: true as const, plan: plan(taskId.slice(-8)) })),
    createWorktree: vi.fn(async (p: TaskWorktreePlan) => ({ ok: true as const, worktreePath: p.worktreePath, branch: p.branch })),
    removeWorktree: vi.fn(async () => ({ ok: true as const })),
    resolveBase: vi.fn(async () => ({ oid: 'c'.repeat(40), ref: 'refs/remotes/origin/main' })),
  } as unknown as TaskWorktreeManager;
}

type Reply = Record<string, unknown> | Error;

/** Daemon fake: each scripted method answers from its queue, then `{ok:true}`. */
function makeDaemon(script: { update?: Reply[]; invite?: Reply[] } = {}) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let seq = 0;
  const next = (q: Reply[] | undefined): Reply => (q && q.length > 0 ? (q.shift() as Reply) : { ok: true });
  const port: FanOutDaemonPort = {
    rpc: vi.fn(async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'task.mission.start') {
        seq++;
        return { ok: true, taskId: `wtask-t-${seq}0000000`, channelId: `ch-${seq}` };
      }
      let reply: Reply = { ok: true };
      if (method === 'task.mission.update') reply = next(script.update);
      if (method === 'a2a.channel.invite') reply = next(script.invite);
      if (reply instanceof Error) throw reply;
      return reply;
    }),
  };
  return { port, calls, count: (m: string) => calls.filter((c) => c.method === m).length };
}

function makeRenderer(): FanOutRendererPort {
  let seq = 0;
  return {
    spawnWorkspace: vi.fn(async () => {
      seq++;
      return { workspaceId: `ws-task-${seq}`, ptyId: `pty-${seq}` };
    }),
  };
}

function req(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: 'fo-wiring',
    prompt: 'Do the thing',
    titles: ['Task A'],
    repoPath: '/repo',
    agentCmd: 'claude',
    verifiedWorkspaceId: 'ws-owner',
    ...overrides,
  };
}

function service(
  daemon: FanOutDaemonPort,
  extra: Partial<ConstructorParameters<typeof FanOutService>[0]> = {},
): FanOutService {
  return new FanOutService({
    daemon,
    renderer: makeRenderer(),
    worktrees: makeWorktrees(),
    wiringRetryDelaysMs: [0, 0],
    ...extra,
  });
}

describe('#1921 — a task whose materialization failed still reaches the owner', () => {
  it('registers the ledger row with the spawned workspace and seats the worker, even when task.update never commits', async () => {
    const daemon = makeDaemon({ update: [{ ok: false, error: 'x' }, { ok: false, error: 'x' }, { ok: false, error: 'x' }] });
    const res = await service(daemon.port).start(req());

    const t = res.tasks[0];
    expect(t.ok).toBe(false);
    expect(t.unmaterialized).toBe(true);
    // The T5 lane reads exactly this: an open row whose task workspace is the pane's.
    const open = ledger.list({ ownerWorkspaceId: 'ws-owner', openOnly: true });
    expect(open.map((e) => e.taskWorkspaceId)).toEqual(['ws-task-1']);
    // …and the worker still got its mission-channel seat.
    expect(daemon.count('a2a.channel.invite')).toBe(1);
    expect(t.channelDisconnected).toBe(false);
    // Three attempts (one + two retries) before giving up on materialization.
    expect(daemon.count('task.mission.update')).toBe(3);
  });

  it('retries a task.update that failed once (timeout) and then reports the task materialized', async () => {
    const daemon = makeDaemon({ update: [new Error('RPC timeout: task.mission.update (10000ms)')] });
    const res = await service(daemon.port).start(req());

    expect(daemon.count('task.mission.update')).toBe(2);
    expect(res.tasks[0].ok).toBe(true);
    expect(res.tasks[0].unmaterialized).toBeUndefined();
    expect(res.ok).toBe(true);
  });
});

describe('#1920 — the mission-channel invite is retried', () => {
  it('retries an invite that failed transiently, and the worker ends up seated', async () => {
    const daemon = makeDaemon({ invite: [{ ok: false, error: { code: 'PERSIST_FAILED', message: 'x' } }] });
    const res = await service(daemon.port).start(req());

    expect(daemon.count('a2a.channel.invite')).toBe(2);
    expect(res.tasks[0].channelDisconnected).toBe(false);
  });

  it('counts DUPLICATE_MEMBER as seated (a first attempt that landed but whose reply was lost)', async () => {
    const daemon = makeDaemon({
      invite: [new Error('RPC timeout: a2a.channel.invite (10000ms)'), { ok: false, error: { code: 'DUPLICATE_MEMBER', message: 'Already a member' } }],
    });
    const res = await service(daemon.port).start(req());

    expect(daemon.count('a2a.channel.invite')).toBe(2);
    expect(res.tasks[0].channelDisconnected).toBe(false);
  });

  it('still reports channelDisconnected when every attempt fails', async () => {
    const fail = { ok: false, error: { code: 'NOT_AUTHORIZED', message: 'x' } };
    const daemon = makeDaemon({ invite: [fail, fail, fail] });
    const res = await service(daemon.port).start(req());

    expect(daemon.count('a2a.channel.invite')).toBe(3);
    expect(res.tasks[0].ok).toBe(true);
    expect(res.tasks[0].channelDisconnected).toBe(true);
  });
});

describe('#1919 — the fan-out learns when a worker agent never started', () => {
  const probeOf = (answers: Array<boolean | undefined>): FanOutLaunchProbe & { calls: number } => {
    const probe = {
      calls: 0,
      agentRunning: vi.fn(async () => {
        const a = answers[Math.min(probe.calls, answers.length - 1)];
        probe.calls++;
        return a;
      }),
    };
    return probe;
  };

  it('marks the task launchFailed, flips the cached result, warns, and moves the ledger row to input_required', async () => {
    const probe = probeOf([false]);
    const svc = service(makeDaemon().port, { launchProbe: probe, launchConfirmMs: 0, launchPollMs: 0 });
    const res = await svc.start(req());
    await svc.settleLaunchChecks();

    const t = res.tasks[0];
    expect(t.launchFailed).toBe(true);
    expect(t.ok).toBe(false);
    expect(t.error).toContain('pty-1');
    // The line to re-run is named, so the caller can act on it.
    expect(t.error).toContain('claude');
    // The poll answer is this same object: it now says the fan-out did not work.
    expect(svc.statusOf('fo-wiring')).toEqual({ state: 'done', result: res });
    expect(res.ok).toBe(false);
    expect(res.warnings?.some((w) => w.includes('Task A') && w.includes('did not start'))).toBe(true);
    const row = ledger.list({ id: t.taskId as string })[0];
    expect(row.status).toBe('input_required');
    expect(row.summary).toContain('launch failed');
    expect(row.summary).toContain('pty-1');
    // Still OPEN, so the owner keeps its T5 read lane into the pane.
    expect(ledger.list({ ownerWorkspaceId: 'ws-owner', openOnly: true })).toHaveLength(1);
  });

  it('confirms a launch the probe sees, even if it was not there at first', async () => {
    const probe = probeOf([false, false, true]);
    const svc = service(makeDaemon().port, { launchProbe: probe, launchConfirmMs: 60_000, launchPollMs: 0 });
    const res = await svc.start(req());
    await svc.settleLaunchChecks();

    expect(probe.calls).toBe(3);
    expect(res.tasks[0].launchFailed).toBeUndefined();
    expect(res.tasks[0].ok).toBe(true);
    expect(ledger.list({ id: res.tasks[0].taskId as string })[0].status).toBe('working');
  });

  it('concludes nothing from a probe that cannot tell (no daemon, pane closed)', async () => {
    const probe = probeOf([undefined]);
    const svc = service(makeDaemon().port, { launchProbe: probe, launchConfirmMs: 0, launchPollMs: 0 });
    const res = await svc.start(req());
    await svc.settleLaunchChecks();

    expect(res.tasks[0].launchFailed).toBeUndefined();
    expect(res.ok).toBe(true);
  });

  it('does not fail a pane that was closed before the final read', async () => {
    const probe = probeOf([false, undefined]);
    const svc = service(makeDaemon().port, { launchProbe: probe, launchConfirmMs: 0, launchPollMs: 0 });
    const res = await svc.start(req());
    await svc.settleLaunchChecks();

    expect(res.tasks[0].launchFailed).toBeUndefined();
  });

  it('skips the check when a first-run screen proved the agent is up', async () => {
    const probe = probeOf([false]);
    const svc = service(makeDaemon().port, {
      launchProbe: probe,
      launchConfirmMs: 0,
      launchPollMs: 0,
      firstRun: {
        // Only a running claude prints this, so the launch is proven.
        readScreen: async () => "> do the thing\n\nThere's an issue with the selected model (glm-5.3)\n",
        sendKey: async () => { /* no press reaches a real pane */ },
      },
      firstRunOptions: {
        watchMs: 0,
        pollMs: 0,
        deadlineMs: 50,
        sleep: async () => { /* fake clock below */ },
        now: ((): (() => number) => {
          let t = 0;
          return () => (t += 10);
        })(),
        log: () => { /* silent */ },
      },
      firstRunRecheckMs: -1,
    });
    const res = await svc.start(req());
    await svc.settleLaunchChecks();

    expect(res.tasks[0].firstRunPrompt).toBeTruthy();
    expect(probe.calls).toBe(0);
    expect(res.tasks[0].launchFailed).toBeUndefined();
  });

  it('leaves a row the worker already moved alone (it proves the agent ran)', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    const probe: FanOutLaunchProbe = {
      agentRunning: vi.fn(async () => {
        await gate;
        return false;
      }),
    };
    const svc = service(makeDaemon().port, { launchProbe: probe, launchConfirmMs: 0, launchPollMs: 0 });
    const res = await svc.start(req());
    const id = res.tasks[0].taskId as string;
    const entry = ledger.list({ id })[0];
    await ledger.update({
      id,
      status: 'review_requested',
      actor: { kind: 'worker', workspaceId: 'ws-task-1' },
      expectedRev: entry.rev,
      summary: 'done',
    });
    release?.();
    await svc.settleLaunchChecks();

    expect(ledger.list({ id })[0].status).toBe('review_requested');
  });

  it('reports a dependent task that never launched on the same cached result', async () => {
    const answers = new Map<string, boolean>([['pty-1', true], ['pty-2', false]]);
    const probe: FanOutLaunchProbe = { agentRunning: vi.fn(async (ptyId: string) => answers.get(ptyId)) };
    const svc = service(makeDaemon().port, { launchProbe: probe, launchConfirmMs: 0, launchPollMs: 0, ledger });
    const res = await svc.start(req({ titles: ['First', 'Second'], dependsOn: [[], [0]] }));
    await svc.settleLaunchChecks();
    expect(res.tasks[1].pending).toBeTruthy();

    const first = ledger.list({ id: res.tasks[0].taskId as string })[0];
    await ledger.update({
      id: first.id,
      status: 'review_requested',
      actor: { kind: 'worker', workspaceId: 'ws-task-1' },
      expectedRev: first.rev,
      summary: 'done',
    });
    await svc.drainDeferredLaunches();
    await svc.settleLaunchChecks();

    expect(res.tasks[0].launchFailed).toBeUndefined();
    expect(res.tasks[1].launchFailed).toBe(true);
    expect(res.ok).toBe(false);
    expect(res.warnings?.some((w) => w.startsWith('task 2 (Second)'))).toBe(true);
  });
});
