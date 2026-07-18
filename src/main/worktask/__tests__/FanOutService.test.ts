// ─── FanOutService E2E (J1 §0 성공기준 — 정상·부분 실패·멱등) + 프리플라이트 거부 ──
//
// daemon/renderer/worktrees를 fake로 주입해 시퀀스(①~⑤)·보상·멱등을 단위 검증한다.
// worktree fs 실물은 TaskWorktreeManager 테스트가 담당하므로 여기선 plan만 시뮬레이션.

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
    expect(bodies[0]).toBe('SHARED CONTEXT\n\ndo login page');
    expect(bodies[1]).toBe('SHARED CONTEXT\n\ndo settings page');
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
    expect(bodies).toEqual(['task A only', 'task B only']);
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
    // 태스크 2(프롬프트 없음)는 prompt.md 없이 agentCmd만 그대로 발사된다.
    const barePane = renderer.spawned.find((s) => !s.initialCommand.includes('prompt.md'));
    expect(barePane?.initialCommand).toBe('claude');
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
