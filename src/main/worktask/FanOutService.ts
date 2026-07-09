/**
 * FanOutService — J1 §2 D2. 프롬프트 1개 → N개 격리 태스크 오케스트레이션(main).
 *
 * 스폰은 fs(git worktree)·렌더러 브리지가 전부 필요하고 데몬엔 없다(데몬=정본·채널).
 * 스폰 경로는 렌더러 경유 단일 고정(§2 G4 — main 내부 브리지 발명 금지). 워크스페이스
 * 트리 정본은 렌더러 스토어(session.json)라, 그 정본을 우회하는 main 브리지는 만들지
 * 않는다. 이 서비스는 데몬 RPC(mission.start/update/invite)와 렌더러 spawn RPC를
 * 조립할 뿐이다.
 *
 * 시퀀스(§2 — 태스크당):
 *   ⓪ 프리플라이트(repo 유효성 1회 — 부적격이면 태스크 생성 0)
 *   ① mission.start(멱등키 `{fanout키}-{k}`) → taskId·channelId
 *   ② worktree 생성(TaskWorktreeManager — 전용 루트·직렬 큐)
 *   ③ 렌더러 spawn(workspace + 에이전트 페인, cwd=worktreePath, initialCommand) →
 *      응답에서 실제 workspaceId 회수(핸드셰이크 C3)
 *   ④ task.update({branch, worktreePath, paneGroupId=workspaceId}) 물질화
 *   ⑤ 채널 invite(태스크 워크스페이스를 미션 채널 멤버로 — 실패 비치명) + spawn이
 *      발사한 initialCommand(`{agentCmd} "$(cat '{promptPath}')"` — 경로 단일따옴표 쿼팅)
 *
 * 실패 보상(태스크 단위 원자성): ②~④ 실패 시 그 태스크만 mission.close(채널 archive
 * 포함) + worktree는 삭제하지 않고 보존 목록 기록. 나머지 태스크는 계속. fan-out
 * 전체는 부분 성공을 허용한다.
 *
 * fanout:start 호출 멱등(§2 G1 CRITICAL): 키→결과 LRU, 동일 키 재호출=직전 결과 반환,
 * in-flight 중복=거부.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  FANOUT_MAX_TASKS,
  FANOUT_PROMPT_MAX_BYTES,
  WORKTASK_IDEMPOTENCY_CAP,
  WORKTASK_META_FILENAME,
  type WorkTaskMetaStamp,
} from '../../shared/workTask';
import { TaskWorktreeManager } from './TaskWorktreeManager';
import type { TaskWorktreePlan } from './TaskWorktreeManager';

/** 데몬 RPC 최소 표면(테스트 주입 가능). daemonClient.rpc의 부분집합. */
export interface FanOutDaemonPort {
  rpc(method: string, params: Record<string, unknown>): Promise<unknown>;
}

/** 렌더러 spawn 최소 표면(sendToRenderer 래핑 — 테스트 주입 가능). */
export interface FanOutRendererPort {
  /**
   * 전용 워크스페이스 + 에이전트 페인 스폰. cwd=worktreePath, initialCommand로
   * 프롬프트 발사. 실제 workspaceId를 회수해 반환(핸드셰이크 C3).
   */
  spawnWorkspace(params: {
    name: string;
    cwd: string;
    initialCommand: string;
  }): Promise<{ workspaceId: string; ptyId?: string } | { error: string }>;
}

/** fan-out 호출 입력(렌더러 다이얼로그 → IPC). */
export interface FanOutRequest {
  /** 호출 단위 멱등키(렌더러가 제출 시 1회 발급 — §2 G1). */
  idempotencyKey: string;
  /** 프롬프트 본문(캡 FANOUT_PROMPT_MAX_BYTES). */
  prompt: string;
  /** 태스크별 title(길이 = N). N은 title 배열 길이로 결정한다. */
  titles: string[];
  /** repo 경로(활성 워크스페이스 cwd 기본 — 렌더러가 채움). */
  repoPath: string;
  /** 에이전트 명령(기본 'claude'). */
  agentCmd: string;
  /** 렌더러 신뢰 신원(channelLocal과 동일 trust basis — 프로세스 경계). */
  verifiedWorkspaceId: string;
  /** 미션 채널 멤버 좌표(생성자 memberId — 기본 verifiedWorkspaceId). */
  memberId?: string;
}

/** 태스크 단위 결과(리포트 — 상태 구분). */
export interface FanOutTaskResult {
  index: number;
  title: string;
  ok: boolean;
  taskId?: string;
  channelId?: string;
  workspaceId?: string;
  /** 에이전트 페인의 ptyId(spawnWorkspace 반환 — §3 onExhausted 토스트 매핑 재료.
   *  렌더러가 부재 시 매핑 불가 태스크는 토스트 생략 — best-effort). */
  ptyId?: string;
  /** F2 — 발사한 initialCommand(에이전트 기동+프롬프트 주입). 재발사가 원문 프롬프트
   *  대신 이 명령을 재전송하도록 하는 재료(맨 셸이 프롬프트를 실행하는 오배선 방지). */
  initialCommand?: string;
  worktreePath?: string;
  branch?: string;
  /** 실패 사유(ok=false). */
  error?: string;
  /** ④ task.update가 커밋되지 못함(미물질화 — §2 크래시 창 계약). */
  unmaterialized?: boolean;
  /** ⑤ 채널 invite 실패(에이전트는 작동, 채널 발신만 결손 — 비치명). */
  channelDisconnected?: boolean;
  /** 보상 시 보존된 worktree 경로(삭제 안 함 — J3 회수 몫). */
  preservedWorktree?: string;
}

export interface FanOutResult {
  ok: boolean;
  /** 프리플라이트 부적격 등 fan-out 전체 거부 사유(태스크 생성 0). */
  error?: string;
  tasks: FanOutTaskResult[];
}

export interface FanOutServiceOptions {
  daemon: FanOutDaemonPort;
  renderer: FanOutRendererPort;
  worktrees?: TaskWorktreeManager;
}

export class FanOutService {
  private readonly daemon: FanOutDaemonPort;
  private readonly renderer: FanOutRendererPort;
  private readonly worktrees: TaskWorktreeManager;

  /** §2 G1 멱등: 키 → 완료 결과 LRU. 동일 키 재호출은 직전 결과 반환. */
  private readonly results = new Map<string, FanOutResult>();
  /** §2 G1 in-flight: 진행 중 키(중복 호출 거부). */
  private readonly inFlight = new Set<string>();

  constructor(opts: FanOutServiceOptions) {
    this.daemon = opts.daemon;
    this.renderer = opts.renderer;
    this.worktrees = opts.worktrees ?? new TaskWorktreeManager();
  }

  /**
   * fan-out 진입점. 호출 멱등(§2 G1): 동일 키 완료 결과 재반환, in-flight 중복 거부.
   */
  async start(req: FanOutRequest): Promise<FanOutResult> {
    const key = req.idempotencyKey;
    if (!key || key.trim().length === 0) {
      return { ok: false, error: 'fanout:start requires an idempotencyKey', tasks: [] };
    }
    // 완료된 동일 키 → 직전 결과 재반환(재실행 없이).
    const cached = this.results.get(key);
    if (cached) return cached;
    // in-flight 중복 → 거부.
    if (this.inFlight.has(key)) {
      return { ok: false, error: `fanout:start: idempotency key ${key} is already in flight`, tasks: [] };
    }

    this.inFlight.add(key);
    try {
      const result = await this.run(req);
      // 완료 결과 저장(LRU cap).
      this.recordResult(key, result);
      return result;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async run(req: FanOutRequest): Promise<FanOutResult> {
    // ── 입력 검증 ──
    const titles = req.titles.map((t) => (typeof t === 'string' ? t.trim() : '')).filter((t) => t.length > 0);
    const n = titles.length;
    if (n === 0) {
      return { ok: false, error: 'fanout:start: at least one task title is required', tasks: [] };
    }
    if (n > FANOUT_MAX_TASKS) {
      return { ok: false, error: `fanout:start: task count ${n} exceeds cap ${FANOUT_MAX_TASKS}`, tasks: [] };
    }
    const prompt = typeof req.prompt === 'string' ? req.prompt : '';
    if (prompt.trim().length === 0) {
      return { ok: false, error: 'fanout:start: prompt is required', tasks: [] };
    }
    if (Buffer.byteLength(prompt, 'utf8') > FANOUT_PROMPT_MAX_BYTES) {
      return {
        ok: false,
        error: `fanout:start: prompt exceeds ${FANOUT_PROMPT_MAX_BYTES} bytes; shorten it and reference details from a file path`,
        tasks: [],
      };
    }
    const verifiedWorkspaceId = typeof req.verifiedWorkspaceId === 'string' ? req.verifiedWorkspaceId.trim() : '';
    if (!verifiedWorkspaceId) {
      return { ok: false, error: 'fanout:start: verifiedWorkspaceId is required', tasks: [] };
    }
    const agentCmd = typeof req.agentCmd === 'string' && req.agentCmd.trim().length > 0 ? req.agentCmd.trim() : 'claude';
    const memberId = req.memberId && req.memberId.length > 0 ? req.memberId : verifiedWorkspaceId;

    // ── ⓪ 프리플라이트(§2 — repo 유효성 1회 선검증. 부적격이면 태스크 생성 0) ──
    // repo 유효성·bare·submodule·LFS는 taskId 독립이라 첫 항목에서 확정된다. 하지만
    // slug 파생·경로 길이·branch 충돌은 title별로 달라지므로(F3 2모델 리뷰) titles
    // 전체를 선검증한다 — 부적격이 하나라도 있으면 mission.start 전에 N개 전부 거부해
    // "부적격이면 태스크 생성 0" 계약을 이행한다. 실 taskId는 아직 없으므로 인덱스별
    // 자리표시자로 slug/경로/branch를 파생·검증한다.
    for (const [k, preflightTitle] of titles.entries()) {
      const placeholder = `wtask-preflight-${String(k).padStart(8, '0')}`;
      const pf = await this.worktrees.preflight(req.repoPath, preflightTitle, placeholder, {
        checkBranchConflict: true,
      });
      if (!pf.ok) {
        return { ok: false, error: `fanout preflight failed (task ${k + 1}): ${pf.error}`, tasks: [] };
      }
    }

    // ── 태스크 순차 처리(직렬 큐가 이미 강제하지만, 스폰 부하도 직렬로) ──
    const tasks: FanOutTaskResult[] = [];
    for (const [k, title] of titles.entries()) {
      const missionIdemKey = `${req.idempotencyKey}-${k}`;
      const r = await this.spawnOne({
        index: k,
        title,
        prompt,
        agentCmd,
        repoPath: req.repoPath,
        verifiedWorkspaceId,
        memberId,
        missionIdemKey,
      });
      tasks.push(r);
    }

    const allOk = tasks.every((t) => t.ok);
    return { ok: allOk, tasks };
  }

  /** 태스크 1개 스폰(①~⑤). 실패 시 태스크 단위 보상. */
  private async spawnOne(ctx: {
    index: number;
    title: string;
    prompt: string;
    agentCmd: string;
    repoPath: string;
    verifiedWorkspaceId: string;
    memberId: string;
    missionIdemKey: string;
  }): Promise<FanOutTaskResult> {
    const base: FanOutTaskResult = { index: ctx.index, title: ctx.title, ok: false };

    // ① mission.start — taskId·channelId 획득(멱등키 전달).
    let taskId: string;
    let channelId: string;
    try {
      const started = (await this.daemon.rpc('task.mission.start', {
        title: ctx.title,
        verifiedWorkspaceId: ctx.verifiedWorkspaceId,
        memberId: ctx.memberId,
        idempotencyKey: ctx.missionIdemKey,
      })) as { ok?: boolean; taskId?: string; channelId?: string; error?: unknown };
      if (!started?.ok || !started.taskId || !started.channelId) {
        return { ...base, error: `mission.start failed: ${describeErr(started?.error)}` };
      }
      taskId = started.taskId;
      channelId = started.channelId;
    } catch (err) {
      return { ...base, error: `mission.start threw: ${(err as Error).message}` };
    }
    base.taskId = taskId;
    base.channelId = channelId;

    // ② worktree 생성(전용 루트·직렬 큐). 프리플라이트를 태스크별 taskId로 재실행해
    //    실 slug·경로를 확정한다(bare/submodule/LFS는 이미 ⓪에서 걸렸으니 재확인은 저렴).
    const pf = await this.worktrees.preflight(ctx.repoPath, ctx.title, taskId);
    if (!pf.ok) {
      await this.compensate(taskId, ctx.verifiedWorkspaceId);
      return { ...base, error: `worktree preflight failed: ${pf.error}` };
    }
    const plan: TaskWorktreePlan = pf.plan;
    const created = await this.worktrees.createWorktree(plan);
    if (!created.ok) {
      await this.compensate(taskId, ctx.verifiedWorkspaceId);
      return { ...base, error: `worktree create failed: ${created.error}` };
    }
    base.worktreePath = plan.worktreePath;
    base.branch = plan.branch;

    // 프롬프트 파일 + task.json 스탬프를 태스크 메타 디렉토리(worktree 밖 — diff
    // 청정성 §4)에 쓴다. task.json(J3 §1 CL5)은 projection GC 이후에도 전용 루트의
    // worktree를 taskId·title로 역추적하게 하는 디스크 정본 사이드카다.
    let promptPath: string;
    try {
      fs.mkdirSync(plan.metaDir, { recursive: true });
      promptPath = path.join(plan.metaDir, 'prompt.md');
      fs.writeFileSync(promptPath, ctx.prompt, 'utf8');
      const stamp: WorkTaskMetaStamp = { taskId, title: ctx.title, createdAt: Date.now() };
      fs.writeFileSync(path.join(plan.metaDir, WORKTASK_META_FILENAME), JSON.stringify(stamp), 'utf8');
    } catch (err) {
      await this.compensate(taskId, ctx.verifiedWorkspaceId, plan);
      return { ...base, error: `prompt file write failed: ${(err as Error).message}`, preservedWorktree: plan.worktreePath };
    }

    // ③ 렌더러 spawn — 전용 워크스페이스 + 에이전트 페인. cwd=worktreePath,
    //    initialCommand=`{agentCmd} "$(cat '{promptPath}')"`(경로 쿼팅). 실제 workspaceId 회수.
    const initialCommand = buildInitialCommand(ctx.agentCmd, promptPath);
    base.initialCommand = initialCommand; // F2 재발사 재료(맨 셸 오배선 방지).
    const wsName = `wtask: ${ctx.title.slice(0, 32)}`;
    let workspaceId: string;
    try {
      const spawned = await this.renderer.spawnWorkspace({
        name: wsName,
        cwd: plan.worktreePath,
        initialCommand,
      });
      if ('error' in spawned) {
        await this.compensate(taskId, ctx.verifiedWorkspaceId, plan);
        return { ...base, error: `renderer spawn failed: ${spawned.error}`, preservedWorktree: plan.worktreePath };
      }
      workspaceId = spawned.workspaceId;
      // ptyId는 옵셔널(핸드셰이크가 싣지 못하면 부재) — §3 onExhausted 토스트 매핑용.
      if (spawned.ptyId) base.ptyId = spawned.ptyId;
    } catch (err) {
      await this.compensate(taskId, ctx.verifiedWorkspaceId, plan);
      return { ...base, error: `renderer spawn threw: ${(err as Error).message}`, preservedWorktree: plan.worktreePath };
    }
    base.workspaceId = workspaceId;

    // ④ task.update — 물질화 커밋({branch, worktreePath, paneGroupId=workspaceId}).
    // 이 RPC는 MCP 도구 표면은 없지만 파이프 라우터 등록으로 first-party 클라이언트에
    // 도달 가능하다(F4). 변이 방어는 데몬의 owner OR CEO authz 게이트 + 물질화 단조
    // 게이트(이중 물질화 차단)에 있고, main의 이 경로는 owner 신원으로 스탬프된다.
    try {
      const updated = (await this.daemon.rpc('task.mission.update', {
        taskId,
        verifiedWorkspaceId: ctx.verifiedWorkspaceId,
        branch: plan.branch,
        worktreePath: plan.worktreePath,
        paneGroupId: workspaceId,
      })) as { ok?: boolean; error?: unknown };
      if (!updated?.ok) {
        // 미물질화 — 태스크·워크스페이스·worktree는 성립했으나 필드 커밋 실패.
        // §2 크래시 창 계약: 태스크는 open으로 남고 리포트가 "미물질화"로 노출,
        // 사람이 close(자동 재물질화는 J3). 보상 close는 하지 않는다(스폰 성립분 보존).
        return { ...base, unmaterialized: true, error: `task.update failed: ${describeErr(updated?.error)}` };
      }
    } catch (err) {
      return { ...base, unmaterialized: true, error: `task.update threw: ${(err as Error).message}` };
    }

    // ⑤ 채널 invite — 태스크 워크스페이스를 미션 채널 멤버로(실패 비치명 §2 C3).
    let channelDisconnected = false;
    try {
      const invited = (await this.daemon.rpc('a2a.channel.invite', {
        channelId,
        invitedMember: { workspaceId, memberId: workspaceId },
        verifiedWorkspaceId: ctx.verifiedWorkspaceId,
      })) as { ok?: boolean; error?: unknown };
      if (!invited?.ok) channelDisconnected = true;
    } catch {
      channelDisconnected = true;
    }

    return { ...base, ok: true, channelDisconnected };
  }

  /**
   * 태스크 단위 보상(§2): mission.close(J0 보상 경로 재사용 — 채널 archive 포함).
   * worktree는 **삭제하지 않고** 보존(실패 시점 디스크 상태 파괴가 더 위험 — §2).
   * close 실패는 무시(best-effort — 태스크는 미물질화 open으로 남아 리포트에 노출).
   */
  private async compensate(
    taskId: string,
    verifiedWorkspaceId: string,
    _plan?: TaskWorktreePlan,
  ): Promise<void> {
    try {
      await this.daemon.rpc('task.mission.close', { taskId, verifiedWorkspaceId });
    } catch {
      // best-effort 보상 — 실패해도 fan-out은 계속한다.
    }
  }

  private recordResult(key: string, result: FanOutResult): void {
    this.results.set(key, result);
    while (this.results.size > WORKTASK_IDEMPOTENCY_CAP) {
      const oldest = this.results.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.results.delete(oldest);
    }
  }
}

/** 에러 값 표시(문자열/객체 방어). */
function describeErr(err: unknown): string {
  if (err === undefined || err === null) return 'unknown';
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown };
    return `${String(e.code ?? '')}: ${String(e.message ?? JSON.stringify(err))}`;
  }
  return String(err);
}

/**
 * initialCommand 조립(§4 D4). POSIX `{agentCmd} "$(cat '{path}')"` / Windows PowerShell
 * `{agentCmd} "$(Get-Content -Raw -LiteralPath '{path}')"`. 프롬프트 본문은 파일 안이라
 * 쿼팅 표면이 경로에 한정된다 — 경로를 셸 단일따옴표로 감싸 공백·`$`·백틱·따옴표가
 * 셸에 재해석되지 않게 한다(F1 3모델 리뷰 conf10). sanitizePtyText가 `$()`·따옴표를
 * 보존함은 §4 C9 테스트로 확정.
 */
export function buildInitialCommand(agentCmd: string, promptPath: string): string {
  if (process.platform === 'win32') {
    // PowerShell 단일따옴표 리터럴: 내부 `'`는 `''`로 이스케이프. -LiteralPath로
    // glob·경로 특수문자 해석까지 봉쇄.
    const escaped = promptPath.replace(/'/g, "''");
    return `${agentCmd} "$(Get-Content -Raw -LiteralPath '${escaped}')"`;
  }
  // POSIX 단일따옴표 리터럴: 내부 `'`는 `'\''`(닫고-이스케이프-열기)로 처리.
  const escaped = promptPath.replace(/'/g, "'\\''");
  return `${agentCmd} "$(cat '${escaped}')"`;
}
