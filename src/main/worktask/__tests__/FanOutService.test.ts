// ─── FanOutService E2E (J1 §0 success criteria — normal·partial failure·idempotency) + preflight rejection ──
//
// Inject fake daemon/renderer/worktrees to unit-test sequence (①~⑤)·compensation·idempotency.
// Real worktree fs covered by TaskWorktreeManager tests — here only simulate plan.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { FanOutService, buildInitialCommand } from '../FanOutService';
import type { FanOutDaemonPort, FanOutRendererPort } from '../FanOutService';
import type { TaskWorktreePlan } from '../TaskWorktreeManager';

let metaRoot: string;
beforeEach(() => {
  metaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-fanout-'));
});
afterEach(() => {
  fs.rmSync(metaRoot, { recursive: true, force: true });
});

/** Plan factory — real temp metaDir so prompt file write actually runs. */
function makePlan(slug: string): TaskWorktreePlan {
  return {
    repoRoot: '/repo',
    repoHash: 'hash1',
    taskSlug: slug,
    worktreePath: path.join(metaRoot, 'wt', slug),
    branch: `wtask/${slug}`,
    metaDir: path.join(metaRoot, 'meta', slug),
  };
}

/** worktrees fake — control preflight/createWorktree/removeWorktree. */
function makeWorktreesFake(opts?: {
  preflightFail?: string;
  createFailOn?: (taskId: string) => boolean;
}) {
  return {
    preflight: vi.fn(async (_repo: string, _title: string, taskId: string) => {
      if (opts?.preflightFail && taskId.includes('preflight')) {
        return { ok: false as const, error: opts.preflightFail };
      }
      return { ok: true as const, plan: makePlan(taskId.slice(-8)) };
    }),
    createWorktree: vi.fn(async (plan: TaskWorktreePlan) => {
      // Hard to reverse taskId from slug but createFailOn judges by branch.
      if (opts?.createFailOn && opts.createFailOn(plan.branch)) {
        return { ok: false as const, error: 'forced create fail' };
      }
      return { ok: true as const, worktreePath: plan.worktreePath, branch: plan.branch };
    }),
    removeWorktree: vi.fn(async () => ({ ok: true as const })),
  } as any;
}

/** daemon fake — mission.start/update/invite/close script. */
function makeDaemonFake(opts?: {
  startFail?: boolean;
  updateFailOn?: (taskId: string) => boolean;
  inviteFail?: boolean;
}) {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let seq = 0;
  const port: FanOutDaemonPort = {
    rpc: vi.fn(async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'task.mission.start') {
        if (opts?.startFail) return { ok: false, error: { code: 'X', message: 'start fail' } };
        seq++;
        return { ok: true, taskId: `wtask-t-${seq}0000000`, channelId: `ch-${seq}` };
      }
      if (method === 'task.mission.update') {
        const tid = String(params['taskId'] ?? '');
        if (opts?.updateFailOn && opts.updateFailOn(tid)) return { ok: false, error: 'update fail' };
        return { ok: true, taskId: tid };
      }
      if (method === 'a2a.channel.invite') {
        if (opts?.inviteFail) return { ok: false, error: 'invite fail' };
        return { ok: true };
      }
      if (method === 'task.mission.close') return { ok: true, taskId: params['taskId'] };
      return { ok: true };
    }),
  };
  return { port, calls };
}

/** renderer fake — spawnWorkspace returns actual workspaceId. Also records returned ptyId
 *  so we can verify FanOutService passes id through unchanged (F11). */
function makeRendererFake(opts?: { spawnFailOn?: (name: string) => boolean }) {
  const spawned: Array<{ name: string; cwd: string; initialCommand: string; returnedPtyId?: string }> = [];
  let seq = 0;
  const port: FanOutRendererPort = {
    spawnWorkspace: vi.fn(async (p) => {
      if (opts?.spawnFailOn && opts.spawnFailOn(p.name)) {
        spawned.push({ ...p });
        return { error: 'spawn fail' };
      }
      seq++;
      const ptyId = `pty-${seq}`;
      spawned.push({ ...p, returnedPtyId: ptyId });
      return { workspaceId: `ws-task-${seq}`, ptyId };
    }),
  };
  return { port, spawned };
}

function baseReq(overrides?: Partial<Parameters<FanOutService['start']>[0]>) {
  return {
    idempotencyKey: 'fo-key-1',
    prompt: 'Do the thing across the codebase',
    titles: ['Task A', 'Task B'],
    repoPath: '/repo',
    agentCmd: 'claude',
    verifiedWorkspaceId: 'ws-ceo',
    ...overrides,
  };
}

describe('buildInitialCommand (§4 D4)', () => {
  it('§7: without promptPath passes agentCmd as-is (does not fire with empty args)', () => {
    expect(buildInitialCommand('claude', undefined)).toBe('claude');
    expect(buildInitialCommand('claude')).toBe('claude');
  });

  it('builds POSIX path substitution command (single-quote path quoting)', () => {
    // Assumes process.platform is not win32 (CI/local).
    if (process.platform !== 'win32') {
      expect(buildInitialCommand('claude', '/m/prompt.md')).toBe("claude \"$(cat '/m/prompt.md')\"");
    } else {
      expect(buildInitialCommand('claude', 'C:\\m\\prompt.md')).toContain('Get-Content -Raw -LiteralPath');
    }
  });

  it('safely quotes shell-reinterpretation-risk paths (space·single-quote·$·backtick)', () => {
    if (process.platform === 'win32') {
      // PowerShell: single-quoted literal; internal `'` becomes `''`.
      const cmd = buildInitialCommand('claude', "C:\\a b\\it's $x`.md");
      expect(cmd).toBe("claude \"$(Get-Content -Raw -LiteralPath 'C:\\a b\\it''s $x`.md')\"");
      return;
    }
    // POSIX: each risky path sits inside a single-quoted literal; `'` is close-escape-open only.
    expect(buildInitialCommand('claude', '/a b/prompt.md')).toBe("claude \"$(cat '/a b/prompt.md')\"");
    expect(buildInitialCommand('claude', "/a/it's.md")).toBe("claude \"$(cat '/a/it'\\''s.md')\"");
    expect(buildInitialCommand('claude', '/a/$x`y.md')).toBe("claude \"$(cat '/a/$x`y.md')\"");
  });

  it('POSIX: file content lands in argv on real sh -c round-trip (no reinterpretation)', () => {
    if (process.platform === 'win32') return;
    // Write prompt file at path containing space·$·backtick·single quote,
    // strip only buildInitialCommand `cat` segment and round-trip via sh to prove argv safety.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wm f$`'-"));
    const promptFile = path.join(dir, "pr'ompt $x`.md");
    const body = 'PROMPT BODY WITH $VAR `backtick` and spaces';
    fs.writeFileSync(promptFile, body, 'utf8');
    try {
      // With agentCmd as printf, "$(cat '...')" rides on printf argv and prints verbatim.
      // If shell re-interprets path, cat fails or reads wrong file — body mismatch.
      const cmd = buildInitialCommand("printf '%s'", promptFile);
      const out = execFileSync('sh', ['-c', cmd], { encoding: 'utf8' });
      expect(out).toBe(body);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('§0 E2E happy path — N=2 all succeed', () => {
  it('steps ①~⑤ run once per task and materialization·invite succeed', async () => {
    const daemon = makeDaemonFake();
    const renderer = makeRendererFake();
    const worktrees = makeWorktreesFake();
    const svc = new FanOutService({ daemon: daemon.port, renderer: renderer.port, worktrees });

    const res = await svc.start(baseReq());
    expect(res.ok).toBe(true);
    expect(res.tasks).toHaveLength(2);
    for (const t of res.tasks) {
      expect(t.ok).toBe(true);
      expect(t.taskId).toBeTruthy();
      expect(t.workspaceId).toBeTruthy();
      expect(t.channelDisconnected).toBe(false);
      // J3 §3·F11: ptyId returned by spawn appears unchanged in result. Same as pty.create
      // session id; onExhausted fires with that sessionId — passthrough here is basis for
      // relaunch registry lookup (ptyId===sessionId) contract.
      expect(t.ptyId).toBe(renderer.spawned[t.index]?.returnedPtyId);
      // F2: initialCommand for relaunch resend also in result (not raw prompt text).
      expect(t.initialCommand).toMatch(/prompt\.md/);
      // J3 §1 CL5: task.json stamp in metaDir (canonical trace after GC).
      const slug = t.taskId!.slice(-8);
      const stampPath = path.join(metaRoot, 'meta', slug, 'task.json');
      expect(fs.existsSync(stampPath)).toBe(true);
      const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8')) as { taskId: string; title: string; createdAt: number };
      expect(stamp.taskId).toBe(t.taskId);
      expect(stamp.title).toBe(t.title);
      expect(typeof stamp.createdAt).toBe('number');
    }
    // mission.start·update twice each, invite twice.
    const methods = daemon.calls.map((c) => c.method);
    expect(methods.filter((m) => m === 'task.mission.start')).toHaveLength(2);
    expect(methods.filter((m) => m === 'task.mission.update')).toHaveLength(2);
    expect(methods.filter((m) => m === 'a2a.channel.invite')).toHaveLength(2);
    // spawn cwd=worktreePath; initialCommand substitutes prompt file path.
    expect(renderer.spawned).toHaveLength(2);
    for (const s of renderer.spawned) {
      expect(s.cwd.replace(/\\/g, '/')).toContain('/wt/');
      expect(s.initialCommand).toMatch(/prompt\.md/);
      // Prompt file actually written outside worktree in metaDir. buildInitialCommand wraps
      // path in single quotes for both POSIX(cat '…') and win32(-LiteralPath '…') —
      // extract inside quotes without assuming leading '/' (win32: 'C:\…prompt.md').
      const promptFile = s.initialCommand.match(/'([^']*prompt\.md)'/)?.[1];
      expect(promptFile && fs.existsSync(promptFile)).toBeTruthy();
      expect(promptFile?.replace(/\\/g, '/')).toContain('/meta/'); // outside worktree
    }
  });

  it('per-task prompts combine with common prompt into different prompt.md per task', async () => {
    const renderer = makeRendererFake();
    const svc = new FanOutService({
      daemon: makeDaemonFake().port,
      renderer: renderer.port,
      worktrees: makeWorktreesFake(),
    });
    const res = await svc.start(
      baseReq({ prompt: 'SHARED CONTEXT', taskPrompts: ['do login page', 'do settings page'] }),
    );
    expect(res.ok).toBe(true);
    const bodies = renderer.spawned.map((s) => {
      const promptFile = s.initialCommand.match(/'([^']*prompt\.md)'/)?.[1];
      return fs.readFileSync(promptFile!, 'utf8');
    });
    expect(bodies[0]).toBe('SHARED CONTEXT\n\ndo login page');
    expect(bodies[1]).toBe('SHARED CONTEXT\n\ndo settings page');
  });

  it('spawns with per-task prompts only when common prompt is empty', async () => {
    const renderer = makeRendererFake();
    const svc = new FanOutService({
      daemon: makeDaemonFake().port,
      renderer: renderer.port,
      worktrees: makeWorktreesFake(),
    });
    const res = await svc.start(baseReq({ prompt: '', taskPrompts: ['task A only', 'task B only'] }));
    expect(res.ok).toBe(true);
    const bodies = renderer.spawned.map((s) => {
      const promptFile = s.initialCommand.match(/'([^']*prompt\.md)'/)?.[1];
      return fs.readFileSync(promptFile!, 'utf8');
    });
    expect(bodies).toEqual(['task A only', 'task B only']);
  });

  it('child mission idempotency keys derive as {fanoutkey}-{k}', async () => {
    const daemon = makeDaemonFake();
    const svc = new FanOutService({
      daemon: daemon.port,
      renderer: makeRendererFake().port,
      worktrees: makeWorktreesFake(),
    });
    await svc.start(baseReq({ idempotencyKey: 'FK' }));
    const startKeys = daemon.calls
      .filter((c) => c.method === 'task.mission.start')
      .map((c) => c.params['idempotencyKey']);
    expect(startKeys).toEqual(['FK-0', 'FK-1']);
  });
});

describe('§0 E2E partial failure — 2nd worktree add fails', () => {
  it('1st succeeds·2nd compensating close + report shows success1/failure1', async () => {
    const daemon = makeDaemonFake();
    const renderer = makeRendererFake();
    // Induce create failure on 2nd task branch. Slug is taskId suffix so hard to predict but
    // createWorktree fake receives branch arg — use counter to fail only 2nd call.
    let createCount = 0;
    const worktrees: any = makeWorktreesFake();
    worktrees.createWorktree = vi.fn(async (plan: TaskWorktreePlan) => {
      createCount++;
      if (createCount === 2) return { ok: false as const, error: 'add failed' };
      return { ok: true as const, worktreePath: plan.worktreePath, branch: plan.branch };
    });
    const svc = new FanOutService({ daemon: daemon.port, renderer: renderer.port, worktrees });

    const res = await svc.start(baseReq());
    expect(res.ok).toBe(false); // partial failure => overall ok=false
    expect(res.tasks[0].ok).toBe(true);
    expect(res.tasks[1].ok).toBe(false);
    expect(res.tasks[1].error).toMatch(/add failed/);
    // 2nd task got compensating close.
    const closes = daemon.calls.filter((c) => c.method === 'task.mission.close');
    expect(closes).toHaveLength(1);
    expect(closes[0].params['taskId']).toBe(res.tasks[1].taskId);
  });

  it('task.update failure marked unmaterialized (no compensating close — preserves successful spawns)', async () => {
    const daemon = makeDaemonFake({ updateFailOn: (tid) => tid.includes('t-2') });
    const svc = new FanOutService({
      daemon: daemon.port,
      renderer: makeRendererFake().port,
      worktrees: makeWorktreesFake(),
    });
    const res = await svc.start(baseReq());
    expect(res.tasks[1].ok).toBe(false);
    expect(res.tasks[1].unmaterialized).toBe(true);
    // Unmaterialized tasks skip compensating close (§2 crash window contract — human closes).
    expect(daemon.calls.filter((c) => c.method === 'task.mission.close')).toHaveLength(0);
  });

  it('invite failure is non-fatal — task success + channelDisconnected', async () => {
    const daemon = makeDaemonFake({ inviteFail: true });
    const svc = new FanOutService({
      daemon: daemon.port,
      renderer: makeRendererFake().port,
      worktrees: makeWorktreesFake(),
    });
    const res = await svc.start(baseReq({ titles: ['Only'] }));
    expect(res.tasks[0].ok).toBe(true);
    expect(res.tasks[0].channelDisconnected).toBe(true);
  });
});

describe('§0 E2E idempotent — same key re-invoke', () => {
  it('completed key re-invoke = zero new creates, returns prior result', async () => {
    const daemon = makeDaemonFake();
    const svc = new FanOutService({
      daemon: daemon.port,
      renderer: makeRendererFake().port,
      worktrees: makeWorktreesFake(),
    });
    const first = await svc.start(baseReq({ idempotencyKey: 'DUP' }));
    const callsAfterFirst = daemon.calls.length;
    const second = await svc.start(baseReq({ idempotencyKey: 'DUP' }));
    expect(second).toEqual(first); // same object as prior result
    expect(daemon.calls.length).toBe(callsAfterFirst); // zero new RPCs
  });

  it('rejects duplicate in-flight call', async () => {
    let releaseStart: () => void = () => {};
    const gate = new Promise<void>((r) => { releaseStart = r; });
    const daemon: FanOutDaemonPort = {
      rpc: vi.fn(async (method: string, params: Record<string, unknown>) => {
        if (method === 'task.mission.start') {
          await gate; // hold first call in-flight
          return { ok: true, taskId: 'wtask-t-1', channelId: 'ch-1' };
        }
        if (method === 'task.mission.update') return { ok: true, taskId: params['taskId'] };
        return { ok: true };
      }),
    };
    const svc = new FanOutService({
      daemon,
      renderer: makeRendererFake().port,
      worktrees: makeWorktreesFake(),
    });
    const p1 = svc.start(baseReq({ idempotencyKey: 'INF', titles: ['A'] }));
    // Second call while p1 is in-flight.
    const p2 = await svc.start(baseReq({ idempotencyKey: 'INF', titles: ['A'] }));
    expect(p2.ok).toBe(false);
    expect(p2.error).toMatch(/already in flight/);
    releaseStart();
    await p1;
  });
});

describe('preflight rejection — zero task creation', () => {
  it('mission.start never called for ineligible repo', async () => {
    const daemon = makeDaemonFake();
    const worktrees = makeWorktreesFake({ preflightFail: 'not a git repository' });
    const svc = new FanOutService({
      daemon: daemon.port,
      renderer: makeRendererFake().port,
      worktrees,
    });
    const res = await svc.start(baseReq());
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/preflight/);
    expect(res.tasks).toHaveLength(0);
    expect(daemon.calls.filter((c) => c.method === 'task.mission.start')).toHaveLength(0);
  });

  it('only titles[1] ineligible (overlong slug·branch conflict) → zero task·channel creation (F3)', async () => {
    const daemon = makeDaemonFake();
    const renderer = makeRendererFake();
    // Global preflight sees all titles — fail only on 2nd title.
    const worktrees: any = makeWorktreesFake();
    let preCount = 0;
    worktrees.preflight = vi.fn(async (_repo: string, _title: string, taskId: string) => {
      // Global pre-check phase (taskId includes 'preflight') — reject only 2nd call.
      if (taskId.includes('preflight')) {
        preCount++;
        if (preCount === 2) {
          return { ok: false as const, error: 'branch already exists: wtask/task-b' };
        }
      }
      return { ok: true as const, plan: makePlan(taskId.slice(-8)) };
    });
    const svc = new FanOutService({ daemon: daemon.port, renderer: renderer.port, worktrees });

    const res = await svc.start(baseReq({ titles: ['Task A', 'Task B'] }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/task 2/);
    expect(res.tasks).toHaveLength(0);
    // mission.start·channel create·spawn all zero (ineligible => zero tasks contract).
    expect(daemon.calls.filter((c) => c.method === 'task.mission.start')).toHaveLength(0);
    expect(renderer.spawned).toHaveLength(0);
  });

  it('rejects prompt over 8KB', async () => {
    const svc = new FanOutService({
      daemon: makeDaemonFake().port,
      renderer: makeRendererFake().port,
      worktrees: makeWorktreesFake(),
    });
    const res = await svc.start(baseReq({ prompt: 'x'.repeat(9000) }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/exceeds/);
  });

  it('§7: does not reject task with both common and individual prompts empty (environment only)', async () => {
    const daemon = makeDaemonFake();
    const renderer = makeRendererFake();
    const svc = new FanOutService({ daemon: daemon.port, renderer: renderer.port, worktrees: makeWorktreesFake() });
    const res = await svc.start(baseReq({ prompt: '', taskPrompts: ['only A has one', ''] }));
    expect(res.ok).toBe(true);
    expect(daemon.calls.filter((c) => c.method === 'task.mission.start')).toHaveLength(2);
    // Task 2 (no prompt) launches agentCmd only — no prompt.md.
    const barePane = renderer.spawned.find((s) => !s.initialCommand.includes('prompt.md'));
    expect(barePane?.initialCommand).toBe('claude');
  });

  it('§7: task without prompts does not write prompt.md at all', async () => {
    const renderer = makeRendererFake();
    const svc = new FanOutService({
      daemon: makeDaemonFake().port,
      renderer: renderer.port,
      worktrees: makeWorktreesFake(),
    });
    const res = await svc.start(baseReq({ prompt: '', titles: ['Task A'], taskPrompts: [''] }));
    expect(res.ok).toBe(true);
    expect(res.tasks[0]?.worktreePath).toBeTruthy();
    const metaDir = path.join(metaRoot, 'meta', res.tasks[0]!.taskId!.slice(-8));
    expect(fs.existsSync(path.join(metaDir, 'prompt.md'))).toBe(false);
    expect(fs.existsSync(path.join(metaDir, 'task.json'))).toBe(true);
  });

  it('rejects entire fanout when any task combined common+individual exceeds 8KB', async () => {
    const svc = new FanOutService({
      daemon: makeDaemonFake().port,
      renderer: makeRendererFake().port,
      worktrees: makeWorktreesFake(),
    });
    const res = await svc.start(
      baseReq({ prompt: 'x'.repeat(5000), taskPrompts: ['short', 'y'.repeat(5000)] }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/task 2 prompt exceeds/);
  });

  it('rejects N > 8', async () => {
    const svc = new FanOutService({
      daemon: makeDaemonFake().port,
      renderer: makeRendererFake().port,
      worktrees: makeWorktreesFake(),
    });
    const res = await svc.start(baseReq({ titles: Array.from({ length: 9 }, (_, i) => `T${i}`) }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/exceeds cap/);
  });
});
