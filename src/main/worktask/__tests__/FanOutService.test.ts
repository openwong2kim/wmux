// ─── FanOutService E2E (J1 §0 성공기준 — 정상·부분 실패·멱등) + 프리플라이트 거부 ──
//
// daemon/renderer/worktrees를 fake로 주입해 시퀀스(①~⑤)·보상·멱등을 단위 검증한다.
// worktree fs 실물은 TaskWorktreeManager 테스트가 담당하므로 여기선 plan만 시뮬레이션.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  FanOutService,
  buildInitialCommand,
  workerLaunchCommand,
  firstRunStuckSummary,
  WORKER_DELIVERY_PREAMBLE,
} from '../FanOutService';
import { MODEL_ENV_MARKER, reattachModelEnvMarker, splitModelEnvMarker } from '../../../shared/workerLaunch';
import type { FanOutDaemonPort, FanOutRendererPort } from '../FanOutService';
import type { TaskWorktreePlan } from '../TaskWorktreeManager';
import type { ProjectConfigState } from '../../../shared/wmuxProjectConfig';
import { clearFanoutPortReservationsForTest } from '../fanoutEnvironment';
import { TaskLedger } from '../../../daemon/ledger/TaskLedger';
import { setTaskLedgerForTests } from '../../deck/taskLedgerHost';

let metaRoot: string;
beforeEach(() => {
  metaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-fanout-'));
});
afterEach(() => {
  fs.rmSync(metaRoot, { recursive: true, force: true });
});

/** plan 팩토리 — metaDir을 실 temp로 잡아 프롬프트 파일 쓰기가 실제로 돈다. */
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

/** worktrees fake — preflight/createWorktree/removeWorktree 제어. */
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
      // taskId를 slug로 역추적하기 어렵지만, createFailOn은 branch로 판정.
      if (opts?.createFailOn && opts.createFailOn(plan.branch)) {
        return { ok: false as const, error: 'forced create fail' };
      }
      return { ok: true as const, worktreePath: plan.worktreePath, branch: plan.branch };
    }),
    removeWorktree: vi.fn(async () => ({ ok: true as const })),
  } as any;
}

/** daemon fake — mission.start/update/invite/close 스크립트. */
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

/** renderer fake — spawnWorkspace가 실제 workspaceId를 회수 반환. 반환한 ptyId도
 *  기록해 FanOutService가 그 id를 결과에 무변형 전달하는지 검증 가능케 한다(F11). */
function makeRendererFake(opts?: {
  spawnFailOn?: (name: string) => boolean;
  /** Stand in for the renderer's role-binding rewrite: what it ACTUALLY launched. */
  rewriteCommand?: (p: { initialCommand: string; role?: string }) => string;
}) {
  const spawned: Array<{
    name: string;
    cwd: string;
    initialCommand: string;
    /** T2 — per-task env (WMUX_TASK_PORT) main hands the renderer. */
    env?: Record<string, string>;
    /** Per-task orchestrator role main forwards for binding resolution. */
    role?: string;
    returnedPtyId?: string;
  }> = [];
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
      const rewritten = opts?.rewriteCommand?.(p);
      return {
        workspaceId: `ws-task-${seq}`,
        ptyId,
        ...(rewritten ? { initialCommand: rewritten } : {}),
      };
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
  it('§7: promptPath 없으면 agentCmd만 그대로(빈 인자로 발사하지 않는다)', () => {
    expect(buildInitialCommand('claude', undefined)).toBe('claude');
    expect(buildInitialCommand('claude')).toBe('claude');
  });

  it('POSIX 경로 치환 명령을 만든다(경로 단일따옴표 쿼팅)', () => {
    // process.platform이 win32가 아닌 CI/로컬 기준.
    if (process.platform !== 'win32') {
      expect(buildInitialCommand('claude', '/m/prompt.md')).toBe("claude \"$(cat '/m/prompt.md')\"");
    } else {
      expect(buildInitialCommand('claude', 'C:\\m\\prompt.md')).toContain('Get-Content -Raw -LiteralPath');
    }
  });

  it('셸 재해석 위험 경로(공백·단일따옴표·$·백틱)를 안전하게 쿼팅한다', () => {
    if (process.platform === 'win32') {
      // PowerShell: 단일따옴표 리터럴, 내부 `'`는 `''`.
      const cmd = buildInitialCommand('claude', "C:\\a b\\it's $x`.md");
      expect(cmd).toBe("claude \"$(Get-Content -Raw -LiteralPath 'C:\\a b\\it''s $x`.md')\"");
      return;
    }
    // POSIX: 각 위험 경로가 단일따옴표 리터럴 안에 담기고 `'`만 닫고-이스케이프-열기.
    expect(buildInitialCommand('claude', '/a b/prompt.md')).toBe("claude \"$(cat '/a b/prompt.md')\"");
    expect(buildInitialCommand('claude', "/a/it's.md")).toBe("claude \"$(cat '/a/it'\\''s.md')\"");
    expect(buildInitialCommand('claude', '/a/$x`y.md')).toBe("claude \"$(cat '/a/$x`y.md')\"");
  });

  it('POSIX: 실제 sh -c 왕복에서 파일 내용이 argv로 실린다(재해석 없음)', () => {
    if (process.platform === 'win32') return;
    // 공백·$·백틱·단일따옴표를 모두 담은 경로에 프롬프트 파일을 쓰고,
    // buildInitialCommand의 `cat` 부분만 떼어 sh로 왕복해 argv 안전성을 확증한다.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wm f$`'-"));
    const promptFile = path.join(dir, "pr'ompt $x`.md");
    const body = 'PROMPT BODY WITH $VAR `backtick` and spaces';
    fs.writeFileSync(promptFile, body, 'utf8');
    try {
      // agentCmd를 printf로 두면 "$(cat '...')"가 printf의 argv로 실려 그대로 출력된다.
      // 셸이 경로를 재해석하면 cat이 실패하거나 다른 파일을 읽어 body와 어긋난다.
      const cmd = buildInitialCommand("printf '%s'", promptFile);
      const out = execFileSync('sh', ['-c', cmd], { encoding: 'utf8' });
      expect(out).toBe(body);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── F15: the worker's model is wmux's decision, not the login shell's ─────────

describe('workerLaunchCommand (F15)', () => {
  const POSIX = { platform: 'darwin' as NodeJS.Platform };

  it('neutralises a shell-exported ANTHROPIC_MODEL for a plain claude worker', () => {
    // The command is TYPED into the pane's interactive login shell, so ~/.zshrc
    // has already re-exported ANTHROPIC_MODEL by then; only a prefix on the line
    // itself runs late enough to win.
    const launch = workerLaunchCommand('claude', '/m/prompt.md', POSIX);
    expect(launch.command).toBe(`${MODEL_ENV_MARKER}claude "$(cat '/m/prompt.md')"`);
    expect(launch.neutralisedModelEnv).toBe(true);
  });

  it('uses a same-shell form, so an aliased claude still resolves', () => {
    // `env -u VAR claude` execs a BINARY: after `claude migrate-installer` many
    // machines have only `alias claude=~/.claude/local/claude` and that form dies
    // with "env: claude: No such file or directory".
    const cmd = workerLaunchCommand('claude', undefined, POSIX).command;
    expect(cmd.startsWith('env ')).toBe(false);
    expect(cmd).toContain('unset ANTHROPIC_MODEL; ');
    // The alias-carrying shell really does expand the word after the `;` — an
    // `env -u` form would have looked for a BINARY that is not on PATH at all.
    const script = ['shopt -s expand_aliases', "alias claude='printf ALIASED'", cmd].join('\n');
    expect(execFileSync('bash', ['-c', script], { encoding: 'utf8' })).toBe('ALIASED');
  });

  it('stands down when a gateway is routing claude (ANTHROPIC_BASE_URL set)', () => {
    // A gateway operator NEEDS their model name: unset it and claude asks the
    // gateway for a default claude-* model it does not serve. The test is in the
    // PANE's shell, not in main — main's process.env is not the environment that
    // has the problem (Finder-launched wmux inherits none of it).
    const cmd = workerLaunchCommand('claude', '/m/prompt.md', POSIX).command.replace(
      /claude "\$\(cat[^)]*\)"$/,
      'printf %s "${ANTHROPIC_MODEL-<unset>}"',
    );
    const withGateway = execFileSync('sh', ['-c', cmd], {
      encoding: 'utf8',
      env: { ...process.env, ANTHROPIC_BASE_URL: 'https://gw.example', ANTHROPIC_MODEL: 'glm-5.3' },
    });
    expect(withGateway).toBe('glm-5.3');
    const withoutGateway = execFileSync('sh', ['-c', cmd], {
      encoding: 'utf8',
      env: { ...process.env, ANTHROPIC_BASE_URL: '', ANTHROPIC_MODEL: 'glm-5.3' },
    });
    expect(withoutGateway).toBe('<unset>');
  });

  it('leaves the quoting of the prompt path byte-identical', () => {
    const nasty = "/a b/it's $x`y.md";
    const launch = workerLaunchCommand('claude', nasty, POSIX);
    expect(launch.command.endsWith(buildInitialCommand('claude', nasty, 'darwin'))).toBe(true);
    // …and the shell really hands the file body to argv, marker included.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-launch-'));
    try {
      const promptFile = path.join(dir, "a b/it's $x`y.md");
      fs.mkdirSync(path.dirname(promptFile), { recursive: true });
      const body = 'do the thing "$(rm -rf /)" `boom`';
      fs.writeFileSync(promptFile, body, 'utf8');
      const cmd = MODEL_ENV_MARKER + buildInitialCommand("printf '%s'", promptFile, 'darwin');
      expect(execFileSync('sh', ['-c', cmd], { encoding: 'utf8' })).toBe(body);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves a command that already chooses a model alone', () => {
    for (const cmd of ['claude --model opus', 'claude --model=opus', 'claude -m opus']) {
      const launch = workerLaunchCommand(cmd, '/m/prompt.md', POSIX);
      expect(launch.neutralisedModelEnv).toBe(false);
      expect(splitModelEnvMarker(launch.command).marker).toBe('');
    }
  });

  it('leaves a non-claude launcher alone — no other agent reads the variable', () => {
    const launch = workerLaunchCommand('codex', '/m/prompt.md', POSIX);
    expect(launch.command).toBe("codex \"$(cat '/m/prompt.md')\"");
    expect(launch.neutralisedModelEnv).toBe(false);
  });

  it('does NOT stand down for a roled task — main cannot see the binding', () => {
    // "has a role" is not "has a model": an unbound role, or one bound to an
    // agent with no model, injects no --model at all. The renderer decides,
    // where the binding actually resolves.
    const launch = workerLaunchCommand('claude', '/m/prompt.md', POSIX);
    expect(launch.neutralisedModelEnv).toBe(true);
  });

  it('refuses anything but a single simple command, and says why', () => {
    // A claude launch the marker would change the meaning of: `unset X; a && b`
    // leaves `b` running with the variable unset in a way nobody wrote.
    for (const cmd of ['claude && echo hi', 'claude | tee log', 'claude `hostname`']) {
      const launch = workerLaunchCommand(cmd, '/m/prompt.md', POSIX);
      expect(launch.neutralisedModelEnv).toBe(false);
      expect(splitModelEnvMarker(launch.command).marker).toBe('');
      expect(launch.note).toContain('simple command');
    }
    // …and a form whose first token is not the launcher at all never gets as
    // far as that question: the stem is `a` / `FOO=1` / `claude;`, none of which
    // is an agent wmux knows, so the command is left alone with nothing to say.
    for (const cmd of ['a | claude', 'FOO=1 claude', 'claude; echo hi']) {
      const launch = workerLaunchCommand(cmd, '/m/prompt.md', POSIX);
      expect(launch.neutralisedModelEnv).toBe(false);
      expect(splitModelEnvMarker(launch.command).marker).toBe('');
    }
  });

  it('says so instead of emitting a POSIX-only marker on win32', () => {
    const launch = workerLaunchCommand('claude', 'C:\\m\\prompt.md', { platform: 'win32' });
    expect(launch.neutralisedModelEnv).toBe(false);
    expect(launch.note).toContain('win32');
  });

  it('still works for the "environment only" launch with no prompt file', () => {
    expect(workerLaunchCommand('claude', undefined, POSIX).command).toBe(`${MODEL_ENV_MARKER}claude`);
  });
});

describe('firstRunStuckSummary (F15)', () => {
  it('names the model and the shell profile when nothing was neutralised', () => {
    const s = firstRunStuckSummary({ headline: 'selected-model error', reason: 'model', model: 'glm-5.3' });
    expect(s).toContain('glm-5.3');
    expect(s).toContain('/model <model>');
    expect(s).toContain('shell profile');
  });

  it('exonerates the shell profile when the launch already unset the variable', () => {
    const s = firstRunStuckSummary(
      { headline: 'selected-model error', reason: 'model', model: 'glm-5.3' },
      { neutralisedModelEnv: true },
    );
    expect(s).toContain('ANTHROPIC_BASE_URL');
    expect(s).not.toContain('shell profile');
  });

  it('still asks for a keypress on a menu the watch could not clear', () => {
    expect(firstRunStuckSummary({ headline: 'fullscreen renderer upsell', reason: 'unanswered' })).toContain(
      'keypress',
    );
  });
});

describe('§0 E2E 정상 — N=2 전부 성공', () => {
  it('①~⑤ 시퀀스가 태스크당 한 번씩 돌고 물질화·invite가 성립한다', async () => {
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
      // J3 §3·F11: spawn이 반환한 ptyId가 결과에 그대로 실린다(변형 없음). 이 ptyId는
      // pty.create의 세션 id와 동일하고 onExhausted가 그 sessionId로 발화하므로,
      // 여기서의 무변형 전달이 재발사 레지스트리 조회(ptyId===sessionId) 계약의 근거다.
      expect(t.ptyId).toBe(renderer.spawned[t.index]?.returnedPtyId);
      // F2: 재발사가 재전송할 initialCommand도 결과에 실린다(원문 프롬프트 아님).
      expect(t.initialCommand).toMatch(/prompt\.md/);
      // J3 §1 CL5: task.json 스탬프가 metaDir에 각인된다(GC 이후 역추적 정본).
      const slug = t.taskId!.slice(-8);
      const stampPath = path.join(metaRoot, 'meta', slug, 'task.json');
      expect(fs.existsSync(stampPath)).toBe(true);
      const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8')) as { taskId: string; title: string; createdAt: number };
      expect(stamp.taskId).toBe(t.taskId);
      expect(stamp.title).toBe(t.title);
      expect(typeof stamp.createdAt).toBe('number');
    }
    // mission.start·update 각 2회, invite 2회.
    const methods = daemon.calls.map((c) => c.method);
    expect(methods.filter((m) => m === 'task.mission.start')).toHaveLength(2);
    expect(methods.filter((m) => m === 'task.mission.update')).toHaveLength(2);
    expect(methods.filter((m) => m === 'a2a.channel.invite')).toHaveLength(2);
    // spawn cwd=worktreePath, initialCommand는 프롬프트 파일 경로 치환.
    expect(renderer.spawned).toHaveLength(2);
    for (const s of renderer.spawned) {
      expect(s.cwd.replace(/\\/g, '/')).toContain('/wt/');
      expect(s.initialCommand).toMatch(/prompt\.md/);
      // 프롬프트 파일이 실제로 worktree 밖 metaDir에 쓰였다. buildInitialCommand는
      // POSIX(cat '…')·win32(-LiteralPath '…') 둘 다 경로를 단일따옴표로 감싸므로
      // 선행 '/' 가정 없이 따옴표 안쪽만 뽑는다(win32는 'C:\…prompt.md'로 시작).
      const promptFile = s.initialCommand.match(/'([^']*prompt\.md)'/)?.[1];
      expect(promptFile && fs.existsSync(promptFile)).toBeTruthy();
      expect(promptFile?.replace(/\\/g, '/')).toContain('/meta/'); // worktree 밖
    }
  });

  it('태스크별 프롬프트가 공통 프롬프트와 결합돼 태스크마다 다른 prompt.md로 쓰인다', async () => {
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
    // A3: 호출자 프롬프트는 그대로 앞에 오고, 배달 계약문이 뒤에 붙는다.
    expect(bodies[0]).toBe('SHARED CONTEXT\n\ndo login page' + WORKER_DELIVERY_PREAMBLE);
    expect(bodies[1]).toBe('SHARED CONTEXT\n\ndo settings page' + WORKER_DELIVERY_PREAMBLE);
  });

  it('공통 프롬프트가 비어도 태스크별 프롬프트만으로 스폰된다', async () => {
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
    expect(bodies).toEqual([
      'task A only' + WORKER_DELIVERY_PREAMBLE,
      'task B only' + WORKER_DELIVERY_PREAMBLE,
    ]);
  });

  it('A3: 배달 계약문이 워커 프롬프트에 실려, 유휴 후 지시가 어떻게 오는지 워커가 안다', async () => {
    const renderer = makeRendererFake();
    const svc = new FanOutService({
      daemon: makeDaemonFake().port,
      renderer: renderer.port,
      worktrees: makeWorktreesFake(),
    });
    const res = await svc.start(baseReq({ prompt: 'BUILD IT', taskPrompts: [''] }));
    expect(res.ok).toBe(true);
    const promptFile = renderer.spawned[0].initialCommand.match(/'([^']*prompt\.md)'/)?.[1];
    const body = fs.readFileSync(promptFile!, 'utf8');
    expect(body.startsWith('BUILD IT')).toBe(true);
    expect(body).toContain('a2a_task_send');
    expect(body).toContain('channel_unread');
    // 계약문의 핵심: 워크스페이스 단위 채널 포스트는 프롬프트에 붙지 않는다.
    expect(body).toMatch(/not.*pasted/i);
  });

  it('하위 mission 멱등키가 {fanout키}-{k}로 파생된다', async () => {
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

describe('§0 E2E 부분 실패 — 2번째 worktree add 실패', () => {
  it('1번째 성립·2번째 보상 close + 리포트에 성공1/실패1', async () => {
    const daemon = makeDaemonFake();
    const renderer = makeRendererFake();
    // 2번째 태스크의 branch로 create 실패 유도. slug는 taskId 말미라 예측이 어렵지만
    // createWorktree fake는 branch 인자를 받는다. 2번째 호출만 실패시키는 카운터 사용.
    let createCount = 0;
    const worktrees: any = makeWorktreesFake();
    worktrees.createWorktree = vi.fn(async (plan: TaskWorktreePlan) => {
      createCount++;
      if (createCount === 2) return { ok: false as const, error: 'add failed' };
      return { ok: true as const, worktreePath: plan.worktreePath, branch: plan.branch };
    });
    const svc = new FanOutService({ daemon: daemon.port, renderer: renderer.port, worktrees });

    const res = await svc.start(baseReq());
    expect(res.ok).toBe(false); // 부분 실패 = 전체 ok=false
    expect(res.tasks[0].ok).toBe(true);
    expect(res.tasks[1].ok).toBe(false);
    expect(res.tasks[1].error).toMatch(/add failed/);
    // 2번째는 보상 close가 호출됐다.
    const closes = daemon.calls.filter((c) => c.method === 'task.mission.close');
    expect(closes).toHaveLength(1);
    expect(closes[0].params['taskId']).toBe(res.tasks[1].taskId);
  });

  it('task.update 실패는 미물질화로 표시(보상 close 없음 — 스폰 성립분 보존)', async () => {
    const daemon = makeDaemonFake({ updateFailOn: (tid) => tid.includes('t-2') });
    const svc = new FanOutService({
      daemon: daemon.port,
      renderer: makeRendererFake().port,
      worktrees: makeWorktreesFake(),
    });
    const res = await svc.start(baseReq());
    expect(res.tasks[1].ok).toBe(false);
    expect(res.tasks[1].unmaterialized).toBe(true);
    // 미물질화는 보상 close를 하지 않는다(§2 크래시 창 계약 — 사람이 close).
    expect(daemon.calls.filter((c) => c.method === 'task.mission.close')).toHaveLength(0);
  });

  it('invite 실패는 비치명 — 태스크 성공 + channelDisconnected', async () => {
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

describe('§0 E2E 멱등 — 동일 키 재호출', () => {
  it('완료 키 재호출 = 신규 생성 0, 직전 결과 재반환', async () => {
    const daemon = makeDaemonFake();
    const svc = new FanOutService({
      daemon: daemon.port,
      renderer: makeRendererFake().port,
      worktrees: makeWorktreesFake(),
    });
    const first = await svc.start(baseReq({ idempotencyKey: 'DUP' }));
    const callsAfterFirst = daemon.calls.length;
    const second = await svc.start(baseReq({ idempotencyKey: 'DUP' }));
    expect(second).toEqual(first); // 직전 결과 동일 객체 반환
    expect(daemon.calls.length).toBe(callsAfterFirst); // 신규 RPC 0
  });

  it('in-flight 중복 호출은 거부', async () => {
    let releaseStart: () => void = () => {};
    const gate = new Promise<void>((r) => { releaseStart = r; });
    const daemon: FanOutDaemonPort = {
      rpc: vi.fn(async (method: string, params: Record<string, unknown>) => {
        if (method === 'task.mission.start') {
          await gate; // 첫 호출을 in-flight로 붙잡는다
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
    // p1이 in-flight인 동안 두 번째 호출.
    const p2 = await svc.start(baseReq({ idempotencyKey: 'INF', titles: ['A'] }));
    expect(p2.ok).toBe(false);
    expect(p2.error).toMatch(/already in flight/);
    releaseStart();
    await p1;
  });
});

describe('프리플라이트 거부 — 태스크 생성 0', () => {
  it('부적격 repo면 mission.start가 한 번도 안 불린다', async () => {
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

  it('titles[1]만 부적격(초장문 slug·브랜치 충돌)이면 태스크·채널 생성 0 (F3)', async () => {
    const daemon = makeDaemonFake();
    const renderer = makeRendererFake();
    // 전역 프리플라이트가 titles 전체를 본다: 2번째 title에서만 실패시킨다.
    const worktrees: any = makeWorktreesFake();
    let preCount = 0;
    worktrees.preflight = vi.fn(async (_repo: string, _title: string, taskId: string) => {
      // 전역 선검증 단계(taskId에 'preflight' 포함)에서 2번째 호출만 거부.
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
    // mission.start·채널 생성·spawn 전부 0(부적격이면 태스크 생성 0 계약).
    expect(daemon.calls.filter((c) => c.method === 'task.mission.start')).toHaveLength(0);
    expect(renderer.spawned).toHaveLength(0);
  });

  it('프롬프트 8KB 초과 거부', async () => {
    const svc = new FanOutService({
      daemon: makeDaemonFake().port,
      renderer: makeRendererFake().port,
      worktrees: makeWorktreesFake(),
    });
    const res = await svc.start(baseReq({ prompt: 'x'.repeat(9000) }));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/exceeds/);
  });

  it('§7: 공통·개별 프롬프트가 둘 다 빈 태스크도 거부하지 않는다(환경만 조성)', async () => {
    const daemon = makeDaemonFake();
    const renderer = makeRendererFake();
    const svc = new FanOutService({ daemon: daemon.port, renderer: renderer.port, worktrees: makeWorktreesFake() });
    const res = await svc.start(baseReq({ prompt: '', taskPrompts: ['only A has one', ''] }));
    expect(res.ok).toBe(true);
    expect(daemon.calls.filter((c) => c.method === 'task.mission.start')).toHaveLength(2);
    // 태스크 2(프롬프트 없음)는 prompt.md 없이 agentCmd만 그대로 발사된다
    // (F15의 ANTHROPIC_MODEL 중화 접두사만 앞에 붙는다 — POSIX에서).
    const barePane = renderer.spawned.find((s) => !s.initialCommand.includes('prompt.md'));
    expect(splitModelEnvMarker(barePane?.initialCommand ?? '').command).toBe('claude');
  });

  it('§7: 프롬프트 없는 태스크는 prompt.md를 아예 쓰지 않는다', async () => {
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

  it('공통+개별 결합이 8KB를 넘는 태스크가 있으면 전체 거부', async () => {
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

  it('N > 8 거부', async () => {
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

// ─── statusOf + the throw contract (the wire poll handle) ──────────────────
//
// The pipe surface cannot answer a fan-out synchronously (the MCP client's RPC
// deadline is 10s and one task's spawn alone is allowed 30s), so it accepts the
// call, runs it detached and lets the caller poll by re-sending the same key.
// That makes the key's terminal state load-bearing in a way it was not when
// only the GUI called this.
describe('statusOf — the idempotency key as a poll handle', () => {
  function svcWith(worktrees: ReturnType<typeof makeWorktreesFake>) {
    return new FanOutService({
      daemon: makeDaemonFake().port,
      renderer: makeRendererFake().port,
      worktrees,
    });
  }

  it('is unknown for a key that was never started', () => {
    expect(svcWith(makeWorktreesFake()).statusOf('never-seen')).toEqual({ state: 'unknown' });
  });

  it('is running while in flight and done once recorded', async () => {
    const svc = svcWith(makeWorktreesFake());
    const inFlight = svc.start(baseReq());
    expect(svc.statusOf('fo-key-1')).toEqual({ state: 'running' });
    const result = await inFlight;
    expect(svc.statusOf('fo-key-1')).toEqual({ state: 'done', result });
  });

  it('records a THROWN run as a failed result instead of releasing the key', async () => {
    // Critical for the wire: if a throw released the key, statusOf would answer
    // 'unknown' and the caller's next poll would RESTART a fan-out that may
    // already have spawned tasks. The key must terminate, not reopen.
    const worktrees = makeWorktreesFake();
    worktrees.preflight = vi.fn(async () => {
      throw new Error('boom');
    });
    const svc = svcWith(worktrees);

    const first = await svc.start(baseReq());
    expect(first.ok).toBe(false);
    expect(first.error).toMatch(/threw: boom/);

    const status = svc.statusOf('fo-key-1');
    expect(status).toEqual({ state: 'done', result: first });

    // The poll — same key again — returns the recorded failure and runs nothing.
    const preflightCalls = worktrees.preflight.mock.calls.length;
    const second = await svc.start(baseReq());
    expect(second).toBe(first);
    expect(worktrees.preflight.mock.calls.length).toBe(preflightCalls);
  });
});

describe('T2 per-repo fan-out environment (ports + setup hook)', () => {
  /** project fake — the trust-gated wmux.json reader FanOutService consumes. */
  function makeProjectFake(state: ProjectConfigState) {
    return { getState: vi.fn(async () => state) };
  }

  // Port reservations are module state shared by every fan-out in the process,
  // so each case starts from an empty ledger.
  beforeEach(() => {
    clearFanoutPortReservationsForTest();
  });

  it('hands each task a distinct WMUX_TASK_PORT from the declared range', async () => {
    const daemon = makeDaemonFake();
    const renderer = makeRendererFake();
    const worktrees = makeWorktreesFake();
    const svc = new FanOutService({
      daemon: daemon.port,
      renderer: renderer.port,
      worktrees,
      project: makeProjectFake({
        found: true,
        root: '/repo',
        trust: 'trusted',
        config: { version: 1, fanout: { portRange: { min: 39100, max: 39120 } } },
      }),
    });

    const res = await svc.start(baseReq());
    expect(res.ok).toBe(true);
    const ports = res.tasks.map((t) => t.port);
    expect(ports.every((p) => typeof p === 'number')).toBe(true);
    expect(new Set(ports).size).toBe(2);
    // The same value reaches the pane's environment, not just the report.
    for (const [k, t] of res.tasks.entries()) {
      expect(renderer.spawned[k]?.env?.WMUX_TASK_PORT).toBe(String(t.port));
    }
  });

  it('never runs a setup hook from an untrusted wmux.json, and says so', async () => {
    const daemon = makeDaemonFake();
    const renderer = makeRendererFake();
    const worktrees = makeWorktreesFake();
    // A hook that would leave a marker file behind if it were ever executed.
    const marker = path.join(metaRoot, 'hook-ran');
    const svc = new FanOutService({
      daemon: daemon.port,
      renderer: renderer.port,
      worktrees,
      project: makeProjectFake({
        found: true,
        root: '/repo',
        trust: 'stale',
        config: { version: 1, fanout: { setup: `node -e "require('fs').writeFileSync('${marker}','x')"` } },
      }),
    });

    const res = await svc.start(baseReq());
    expect(res.ok).toBe(true);
    expect(res.setupSkipped).toBe('stale');
    expect(fs.existsSync(marker)).toBe(false);
    // The tasks themselves still spawn — an ungated hook is skipped, not fatal.
    expect(res.tasks.every((t) => t.ok)).toBe(true);
  });

  it('reports a malformed portRange instead of silently handing out no ports', async () => {
    const daemon = makeDaemonFake();
    const renderer = makeRendererFake();
    const svc = new FanOutService({
      daemon: daemon.port,
      renderer: renderer.port,
      worktrees: makeWorktreesFake(),
      // The schema rejected the range but KEPT the trusted setup declaration —
      // one typo must not disarm the other field.
      project: makeProjectFake({
        found: true,
        root: '/repo',
        trust: 'trusted',
        config: { version: 1, fanout: { invalidFields: ['portRange'] } },
      }),
    });

    const res = await svc.start(baseReq());
    expect(res.ok).toBe(true);
    expect(res.portRangeInvalid).toBe(true);
    expect(res.tasks.every((t) => t.port === undefined)).toBe(true);
    // No port reaches the pane. The pane env is not EMPTY — a claude worker
    // always carries the A-1 first-run flag — so the assertion is about the
    // port key, not about the env being absent.
    expect(renderer.spawned.every((s) => s.env?.WMUX_TASK_PORT === undefined)).toBe(true);
  });

  it('fails ONLY the task whose setup hook failed, and gives it no port', async () => {
    const daemon = makeDaemonFake();
    const renderer = makeRendererFake();
    // A hook that fails the first time it runs and succeeds afterwards, so one
    // task's failure can be observed not to take the other one down.
    const sentinel = path.join(metaRoot, 'first-run');
    const hookScript = path.join(metaRoot, 'hook.js');
    fs.writeFileSync(
      hookScript,
      `const fs = require('fs');\n` +
        `if (!fs.existsSync(${JSON.stringify(sentinel)})) {\n` +
        `  fs.writeFileSync(${JSON.stringify(sentinel)}, '1');\n` +
        `  console.error('setup exploded');\n` +
        `  process.exit(1);\n` +
        `}\n`,
      'utf8',
    );
    // The hook runs IN the worktree, so this fake has to materialize the
    // directory git would have created.
    const worktrees = makeWorktreesFake();
    const create = worktrees.createWorktree;
    worktrees.createWorktree = vi.fn(async (plan: TaskWorktreePlan) => {
      fs.mkdirSync(plan.worktreePath, { recursive: true });
      return create(plan);
    });
    const svc = new FanOutService({
      daemon: daemon.port,
      renderer: renderer.port,
      worktrees,
      project: makeProjectFake({
        found: true,
        root: '/repo',
        trust: 'trusted',
        config: {
          version: 1,
          fanout: { portRange: { min: 39200, max: 39220 }, setup: `node ${JSON.stringify(hookScript)}` },
        },
      }),
    });

    const res = await svc.start(baseReq());
    expect(res.ok).toBe(false);

    const [first, second] = res.tasks;
    expect(first.ok).toBe(false);
    expect(first.setupFailed).toBe(true);
    expect(first.error).toMatch(/setup exploded/);
    expect(first.preservedWorktree).toBeTruthy();
    // No pane was ever opened for it, so it owns no port.
    expect(first.port).toBeUndefined();
    expect(renderer.spawned.some((s) => s.env?.WMUX_TASK_PORT === '39200')).toBe(false);

    // The next task ran its (now-succeeding) hook and spawned normally.
    expect(second.ok).toBe(true);
    expect(typeof second.port).toBe('number');
    expect(renderer.spawned).toHaveLength(1);
    // Compensation was scoped to the failed task only.
    const closed = daemon.calls.filter((c) => c.method === 'task.mission.close');
    expect(closed).toHaveLength(1);
    expect(closed[0]?.params.taskId).toBe(first.taskId);
  });
});

describe('per-task roles', () => {
  it('keeps a role paired with its title when an empty title is dropped', async () => {
    // Same failure the taskPrompt pairing above guards: filtering titles after
    // indexing shifts every later task onto the wrong role — and a role decides
    // which agent and model that task runs on, so the mis-delivery is silent.
    const daemon = makeDaemonFake();
    const renderer = makeRendererFake();
    const worktrees = makeWorktreesFake();
    const svc = new FanOutService({ daemon: daemon.port, renderer: renderer.port, worktrees });

    await svc.start(
      baseReq({
        titles: ['Task A', '   ', 'Task C'],
        roles: ['Builder', 'Tester', 'Reviewer'],
      }),
    );

    expect(renderer.spawned.map((s) => s.role)).toEqual(['Builder', 'Reviewer']);
  });

  it('forwards no role for an unroled task', async () => {
    const daemon = makeDaemonFake();
    const renderer = makeRendererFake();
    const worktrees = makeWorktreesFake();
    const svc = new FanOutService({ daemon: daemon.port, renderer: renderer.port, worktrees });

    await svc.start(baseReq({ titles: ['Task A', 'Task B'], roles: ['Builder', ''] }));

    expect(renderer.spawned[0].role).toBe('Builder');
    expect(renderer.spawned[1].role).toBeUndefined();
  });

  it('records the command the renderer actually launched as the re-fire material', async () => {
    // The renderer may swap the agent and pin a model for the task's role. A
    // re-fire replays base.initialCommand, so storing the pre-binding string
    // would bring the task back on the default agent with nothing said.
    const daemon = makeDaemonFake();
    const renderer = makeRendererFake({
      // Mirrors the real renderer: the marker comes OFF before the role rewrite
      // (both role steps gate on the first token) and goes back on only if the
      // rewritten command still names no model of its own.
      rewriteCommand: (p) => {
        const { marker, command } = splitModelEnvMarker(p.initialCommand);
        const rewritten = p.role === 'Reviewer' ? command.replace(/^claude/, 'codex --model o3') : command;
        return reattachModelEnvMarker(marker, rewritten, undefined).command;
      },
    });
    const worktrees = makeWorktreesFake();
    const svc = new FanOutService({ daemon: daemon.port, renderer: renderer.port, worktrees });

    const res = await svc.start(baseReq({ titles: ['Build it', 'Review it'], roles: ['Builder', 'Reviewer'] }));

    // Builder's binding pins no model here, so the neutralisation is KEPT —
    // except on win32, where main attaches no marker at all (it is POSIX, and
    // the pane's shell there is PowerShell), so the recorded line is the bare
    // Get-Content form the renderer stub echoed back.
    const builderLaunched = renderer.spawned[0].initialCommand;
    expect(res.tasks[0].initialCommand).toBe(builderLaunched);
    expect(splitModelEnvMarker(builderLaunched).marker).toBe(
      process.platform === 'win32' ? '' : MODEL_ENV_MARKER,
    );
    expect(splitModelEnvMarker(builderLaunched).command.startsWith('claude')).toBe(true);
    // …and Reviewer's `--model o3` makes it redundant, so it comes off.
    expect(res.tasks[1].initialCommand?.startsWith('codex --model o3')).toBe(true);
    // …and the prompt file argument survived the rewrite either way.
    for (const t of res.tasks) expect(t.initialCommand).toMatch(/prompt\.md/);
  });
});

// ── A-1: worker first run ────────────────────────────────────────────────────

describe('fan-out worker first run (A-1)', () => {
  it('hands a claude worker the sandboxed flag, and no other agent', async () => {
    const daemon = makeDaemonFake();
    const renderer = makeRendererFake();
    const svc = new FanOutService({
      daemon: daemon.port,
      renderer: renderer.port,
      worktrees: makeWorktreesFake(),
    });

    await svc.start(baseReq());
    expect(renderer.spawned.every((s) => s.env?.CLAUDE_CODE_SANDBOXED === '1')).toBe(true);

    const other = makeRendererFake();
    const svc2 = new FanOutService({
      daemon: makeDaemonFake().port,
      renderer: other.port,
      worktrees: makeWorktreesFake(),
    });
    await svc2.start(baseReq({ idempotencyKey: 'fo-key-codex', agentCmd: 'codex' }));
    expect(other.spawned.every((s) => s.env?.CLAUDE_CODE_SANDBOXED === undefined)).toBe(true);
  });

  it('reports a worker still stuck on a first-run screen instead of calling it working', async () => {
    const upsell = [
      'Try the new fullscreen renderer?',
      '❯ 1. Yes, try it',
      '  2. Not now',
      'Enter to confirm · Esc to cancel',
    ].join('\n');
    const keys: string[] = [];
    const daemon = makeDaemonFake();
    const renderer = makeRendererFake();
    const svc = new FanOutService({
      daemon: daemon.port,
      renderer: renderer.port,
      worktrees: makeWorktreesFake(),
      firstRun: {
        // A pane that never clears, so the watch exhausts its dismissals.
        readScreen: async () => upsell,
        sendKey: async (_ptyId, sequence) => {
          keys.push(sequence);
        },
      },
    });

    const res = await svc.start(baseReq({ idempotencyKey: 'fo-key-stuck', titles: ['Task A'] }));
    expect(res.tasks[0].firstRunStuck).toBe(true);
    expect(res.tasks[0].firstRunPrompt).toBe('fullscreen renderer upsell');
    // It DID try the dismissal the screen advertises before giving up.
    expect(keys).toEqual(['\x1b', '\x1b', '\x1b']);
  });

  // ── F15 ────────────────────────────────────────────────────────────────────

  it('records the neutralised command it actually launched', async () => {
    const daemon = makeDaemonFake();
    const renderer = makeRendererFake();
    const svc = new FanOutService({
      daemon: daemon.port,
      renderer: renderer.port,
      worktrees: makeWorktreesFake(),
    });

    const res = await svc.start(baseReq({ idempotencyKey: 'fo-key-f15', titles: ['Task A'] }));
    const launched = renderer.spawned[0].initialCommand;
    // What main recorded for F2 re-fire is what the renderer was told to launch.
    expect(res.tasks[0].initialCommand).toBe(launched);
    if (process.platform === 'win32') {
      expect(launched.startsWith('claude')).toBe(true);
    } else {
      expect(launched.startsWith(`${MODEL_ENV_MARKER}claude `)).toBe(true);
    }
  });

  it('moves a worker whose first turn died on its model to input_required', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-f15-ledger-'));
    const ledger = new TaskLedger({ dir });
    setTaskLedgerForTests(ledger);
    try {
      const screen = [
        '> do the thing',
        '',
        "There's an issue with the selected model (glm-5.3)",
        '',
      ].join('\n');
      const keys: string[] = [];
      const daemon = makeDaemonFake();
      const renderer = makeRendererFake();
      const svc = new FanOutService({
        daemon: daemon.port,
        renderer: renderer.port,
        worktrees: makeWorktreesFake(),
        firstRun: {
          readScreen: async () => screen,
          sendKey: async (_p, seq) => {
            keys.push(seq);
          },
        },
      });

      const res = await svc.start(baseReq({ idempotencyKey: 'fo-key-model', titles: ['Task A'] }));
      // The watch ran even though the launch carries the marker — a stem read
      // straight off the recorded command would have said `[`.
      expect(res.tasks[0].firstRunStuck).toBe(true);
      expect(res.tasks[0].firstRunPrompt).toBe('selected-model error');
      // No blind press: this is not a menu, and wmux does not type at one.
      expect(keys).toEqual([]);

      const row = ledger.list({ id: res.tasks[0].taskId as string })[0];
      expect(row.status).toBe('input_required');
      expect(row.summary).toContain('glm-5.3');
      expect(row.summary).toContain('/model <model>');
      // On POSIX the launch DID neutralise the variable, so the summary must
      // not send the operator back to their shell profile for a model it did
      // not set. win32 attaches no marker, so there the profile IS the cause.
      if (process.platform === 'win32') {
        expect(row.summary).toContain('ANTHROPIC_MODEL');
      } else {
        expect(row.summary).toContain('ANTHROPIC_BASE_URL');
      }
    } finally {
      setTaskLedgerForTests(null);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('catches a model error that only lands AFTER the composer painted', async () => {
    // The clean-read exit fires at ~6 s, about when the composer finishes
    // painting — the error needs the first turn to be sent and refused first,
    // so the watch would otherwise call this worker healthy and walk away.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wmux-f15-late-'));
    const ledger = new TaskLedger({ dir });
    setTaskLedgerForTests(ledger);
    try {
      const composer = ['\u276f Try "write a test"', '\u23f5\u23f5 auto mode on'].join('\n');
      const late = ['> do the thing', '', "There's an issue with the selected model (glm-5.3)"].join('\n');
      let reads = 0;
      const svc = new FanOutService({
        daemon: makeDaemonFake().port,
        renderer: makeRendererFake().port,
        worktrees: makeWorktreesFake(),
        firstRun: {
          readScreen: async () => {
            reads += 1;
            return reads >= 3 ? late : composer;
          },
          sendKey: async () => { /* nothing to press on either screen */ },
        },
        firstRunOptions: { watchMs: 0, pollMs: 0, deadlineMs: 5, log: () => { /* silent */ } },
        firstRunRecheckMs: 0,
      });

      const res = await svc.start(baseReq({ idempotencyKey: 'fo-key-late', titles: ['Task A'] }));
      // The watch itself saw a healthy pane and did not hold the fan-out up.
      expect(res.tasks[0].ok).toBe(true);
      expect(res.tasks[0].firstRunStuck).toBeUndefined();
      expect(ledger.list({ id: res.tasks[0].taskId as string })[0].status).toBe('working');

      await svc.settleFirstRunRechecks();
      const row = ledger.list({ id: res.tasks[0].taskId as string })[0];
      expect(row.status).toBe('input_required');
      expect(row.summary).toContain('glm-5.3');
    } finally {
      setTaskLedgerForTests(null);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
