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
import type { ProjectConfigState } from '../../shared/wmuxProjectConfig';
import { getTaskLedger, rememberMissionChannel, noteWorkTaskClosed } from '../deck/taskLedgerHost';
import {
  FANOUT_TASK_PORT_ENV,
  assignFanoutPorts,
  releaseFanoutPorts,
  resolveFanoutSetup,
  runFanoutSetup,
  type FanoutSetupSkipReason,
} from './fanoutEnvironment';

/**
 * A3 (delegation contract, worker side) — appended to every fan-out prompt.md.
 *
 * A fanned-out worker finishes its task and goes idle. Nothing polls on its
 * behalf, and a channel post addressed to its workspace never reaches its
 * prompt — so a follow-up instruction sent that way is invisible to the worker
 * while the sender reads the silence as "still working". That exact loss is what
 * this paragraph exists to prevent; it is appended AFTER the caller's prompt (and
 * after the FANOUT_PROMPT_MAX_BYTES check, which bounds caller input only) so it
 * never eats into the caller's byte budget or reorders their instructions.
 */
export const WORKER_DELIVERY_PREAMBLE = `

---

## How your next instructions arrive (wmux)

You are running in a wmux pane. When this task is done and you go idle:

- A **task sent to you** (\`a2a_task_send\`) IS pasted into your prompt — it starts a new turn on its own.
- A **channel mention that pins your pane** is pasted the same way, at your next idle moment.
- A channel post that mentions only your *workspace* — or that mentions nobody — is **not** pasted. It raises an unread badge and nothing else.

So going idle is not "waiting for the next message": nothing wakes you for the third case. If you are expecting follow-up work, check \`channel_unread\` / \`a2a_task_query\` yourself before you stop. And report completion in your mission channel (\`channel_post\`) — an idle worker and a hung worker look identical from the outside, and the only difference the sender can see is what you said.

## How completion is recorded (task ledger)

Your task has a row in the task ledger; the brain reads that row, not your prose. A natural-language "done" is **not** completion.

- When the task is done **and your own gate passed** (tsc / lint / tests for what you touched): \`ledger_update({task_id, status: "review_requested", expected_rev, summary})\` — the summary says what landed and what you verified.
- On a blocker you cannot clear yourself: \`ledger_update({task_id, status: "input_required", expected_rev, summary})\` — the summary names what you need.
- \`expected_rev\` is the rev you last read (1 right after fan-out); a stale rev is refused, so re-read and retry. Only the brain can mark \`completed\`.
`;

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
    /** T2 — extra env for the task pane (currently WMUX_TASK_PORT). */
    env?: Record<string, string>;
    /** Orchestrator role for this task's pane. The renderer owns the role→agent
     *  +model bindings (they are UI settings), so main sends the ROLE and the
     *  renderer rewrites the launch command through the same applyRoleBinding
     *  path a human-opened pane uses. Absent = launch the command as given. */
    role?: string;
  }): Promise<
    | {
        workspaceId: string;
        ptyId?: string;
        /** The command the renderer actually launched. Differs from the one we
         *  sent when a role binding swapped the agent or pinned a model, and it
         *  is that version a re-fire must replay. */
        initialCommand?: string;
      }
    | { error: string }
  >;
}

/**
 * T2 — per-project `wmux.json` state + trust verdict (ProjectConfigStore.getState).
 * Injected as a port so the fan-out tests don't need a trust DB on disk.
 */
export interface FanOutProjectPort {
  getState(cwd: string): Promise<ProjectConfigState>;
}

/** fan-out 호출 입력(렌더러 다이얼로그 → IPC). */
export interface FanOutRequest {
  /** 호출 단위 멱등키(렌더러가 제출 시 1회 발급 — §2 G1). */
  idempotencyKey: string;
  /** 공통 프롬프트 본문(캡 FANOUT_PROMPT_MAX_BYTES). 옵셔널 — 비워도 된다. */
  prompt: string;
  /** 태스크별 title(길이 = N). N은 title 배열 길이로 결정한다. */
  titles: string[];
  /** 태스크별 개별 프롬프트(titles와 인덱스 정렬, 옵셔널). 유효 프롬프트는
   *  `공통 + "\n\n" + 개별`(빈 쪽 생략)로 결합된다. **공통·개별이 둘 다 비어도
   *  거부하지 않는다** — worktree·브랜치·에이전트 페인만 열고(환경만 조성) 프롬프트는
   *  사람이 직접 입력하는 사용도 정당하다(§7). 결합 결과가 캡을 넘으면만 전체 거부
   *  (부분 스폰 없음). */
  taskPrompts?: string[];
  /** repo 경로(활성 워크스페이스 cwd 기본 — 렌더러가 채움). */
  repoPath: string;
  /** 에이전트 명령(기본 'claude'). */
  agentCmd: string;
  /**
   * Per-task orchestrator role, index-aligned with `titles` (optional; an empty
   * or absent entry means "no role").
   *
   * This is how a fan-out puts different tasks on different agents and models
   * WITHOUT any caller ever naming an executable: the role is a closed
   * vocabulary (ORCH_ROLES), and the agent + model it maps to comes from the
   * operator's own role bindings in Settings. A caller can choose among the
   * bindings the operator configured; it cannot invent a command.
   */
  roles?: string[];
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
  /** T2 — port handed to this task as WMUX_TASK_PORT (absent when the repo
   *  declares no `fanout.portRange`, or the window ran out of free ports). */
  port?: number;
  /** T2 — the worktree setup hook failed; the agent was NOT started (a task
   *  whose dependencies never installed would burn a turn discovering that). */
  setupFailed?: boolean;
}

export interface FanOutResult {
  ok: boolean;
  /** 프리플라이트 부적격 등 fan-out 전체 거부 사유(태스크 생성 0). */
  error?: string;
  tasks: FanOutTaskResult[];
  /** T2 — why the repo's declared `fanout.setup` hook did not run for this
   *  fan-out. Absent when it ran. Reported rather than silent: "trusted the
   *  file, still nothing installed" is otherwise invisible. */
  setupSkipped?: FanoutSetupSkipReason;
  /** T2 — the repo declared a `fanout.portRange` the schema rejected (typo,
   *  privileged/inverted bounds, or wider than the cap), so no task got a
   *  WMUX_TASK_PORT. Distinct from "no range declared", which reports nothing. */
  portRangeInvalid?: true;
}

export interface FanOutServiceOptions {
  daemon: FanOutDaemonPort;
  renderer: FanOutRendererPort;
  worktrees?: TaskWorktreeManager;
  /** T2 — trust-gated `wmux.json` reader. Omitted → no ports, no setup hook. */
  project?: FanOutProjectPort;
}

/**
 * Idempotency-key state, for the wire poll contract. The pipe surface cannot
 * answer a fan-out synchronously (the MCP client's RPC deadline is 10s and a
 * single task's renderer spawn alone is allowed 30s), so it accepts the call,
 * runs it detached, and lets the caller poll by re-sending the same key. This
 * view turns the existing §2 G1 idempotency bookkeeping into that poll answer.
 */
export type FanOutStatus =
  | { state: 'unknown' }
  | { state: 'running' }
  | { state: 'done'; result: FanOutResult };

export class FanOutService {
  private readonly daemon: FanOutDaemonPort;
  private readonly renderer: FanOutRendererPort;
  private readonly worktrees: TaskWorktreeManager;
  /** T2 — per-project wmux.json reader (absent = feature off). */
  private readonly project?: FanOutProjectPort;

  /** §2 G1 멱등: 키 → 완료 결과 LRU. 동일 키 재호출은 직전 결과 반환. */
  private readonly results = new Map<string, FanOutResult>();
  /** §2 G1 in-flight: 진행 중 키(중복 호출 거부). */
  private readonly inFlight = new Set<string>();

  constructor(opts: FanOutServiceOptions) {
    this.daemon = opts.daemon;
    this.renderer = opts.renderer;
    this.worktrees = opts.worktrees ?? new TaskWorktreeManager();
    this.project = opts.project;
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
    } catch (err) {
      // A THROWN run (as opposed to a per-task failure, which run() already
      // folds into the result) must still TERMINATE the key. The pipe surface
      // polls by key: releasing the key here would let the next poll RESTART a
      // fan-out that has already spawned tasks. Record the throw as a failed
      // result instead, so the key answers "done, and it failed".
      const failed: FanOutResult = {
        ok: false,
        error: `fanout:start threw: ${(err as Error).message}`,
        tasks: [],
      };
      this.recordResult(key, failed);
      return failed;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * Idempotency-key state for the wire poll contract (see FanOutStatus). Purely
   * a read of the §2 G1 bookkeeping — it starts nothing and mutates nothing.
   */
  statusOf(key: string): FanOutStatus {
    const done = this.results.get(key);
    if (done) return { state: 'done', result: done };
    if (this.inFlight.has(key)) return { state: 'running' };
    return { state: 'unknown' };
  }

  private async run(req: FanOutRequest): Promise<FanOutResult> {
    // ── 입력 검증 ──
    // title·개별 프롬프트는 인덱스로 정렬된 쌍이다 — 빈 title 필터 전에 먼저 묶어
    // 정렬이 어긋나지 않게 한다(개별 프롬프트가 다른 태스크에 오배달되면 치명).
    const rawPrompts = Array.isArray(req.taskPrompts) ? req.taskPrompts : [];
    // role도 같은 이유로 필터 전에 묶는다 — 뒤에서 원본 인덱스로 읽으면 빈 title
    // 하나에 역할이 통째로 밀려 다른 태스크가 남의 에이전트·모델로 뜬다.
    const rawRoles = Array.isArray(req.roles) ? req.roles : [];
    const entries = req.titles
      .map((t, k) => ({
        title: typeof t === 'string' ? t.trim() : '',
        taskPrompt: typeof rawPrompts[k] === 'string' ? rawPrompts[k].trim() : '',
        role: typeof rawRoles[k] === 'string' ? rawRoles[k].trim() : '',
      }))
      .filter((e) => e.title.length > 0);
    const n = entries.length;
    if (n === 0) {
      return { ok: false, error: 'fanout:start: at least one task title is required', tasks: [] };
    }
    if (n > FANOUT_MAX_TASKS) {
      return { ok: false, error: `fanout:start: task count ${n} exceeds cap ${FANOUT_MAX_TASKS}`, tasks: [] };
    }
    const sharedPrompt = (typeof req.prompt === 'string' ? req.prompt : '').trim();
    // 태스크 유효 프롬프트 = 공통 + 개별(빈 쪽 생략). 둘 다 비어도 거부하지 않는다 —
    // "환경만 조성"(worktree·브랜치·워크스페이스만 열고 프롬프트는 사람이 직접 입력)도
    // 정당한 사용이다(§7 리뷰). 캡 초과만 전체 거부(부분 스폰 없음 — 프리플라이트
    // "태스크 생성 0" 계약과 동형).
    const effectivePrompts: string[] = [];
    for (const [k, e] of entries.entries()) {
      const combined = [sharedPrompt, e.taskPrompt].filter((p) => p.length > 0).join('\n\n');
      if (Buffer.byteLength(combined, 'utf8') > FANOUT_PROMPT_MAX_BYTES) {
        return {
          ok: false,
          error: `fanout:start: task ${k + 1} prompt exceeds ${FANOUT_PROMPT_MAX_BYTES} bytes; shorten it and reference details from a file path`,
          tasks: [],
        };
      }
      effectivePrompts.push(combined);
    }
    const titles = entries.map((e) => e.title);
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

    // ── T2 per-repo fan-out environment(포트 창·setup 훅) ──
    // 신뢰 게이트를 한 번만 통과하고 N개 태스크가 그 결과를 공유한다. 포트는 스폰
    // 전에 전부 확정한다 — 태스크 k가 뜬 뒤 k+1이 같은 창을 다시 스캔하면 아직
    // 바인드되지 않은 포트를 중복 배정할 수 있기 때문이다.
    const env = await this.resolveEnvironment(req.repoPath, n);

    // ── 태스크 순차 처리(직렬 큐가 이미 강제하지만, 스폰 부하도 직렬로) ──
    const tasks: FanOutTaskResult[] = [];
    for (const [k, title] of titles.entries()) {
      const missionIdemKey = `${req.idempotencyKey}-${k}`;
      const r = await this.spawnOne({
        index: k,
        title,
        prompt: effectivePrompts[k],
        agentCmd,
        repoPath: req.repoPath,
        verifiedWorkspaceId,
        memberId,
        missionIdemKey,
        port: env.ports[k],
        setupCommand: env.setupCommand,
        ...(entries[k].role ? { role: entries[k].role } : {}),
      });
      tasks.push(r);
    }

    // 배정됐지만 태스크가 뜨지 못한 포트는 창에 돌려준다(예약 TTL을 기다리지 않게).
    releaseFanoutPorts(tasks.filter((t) => !t.ok).map((t) => env.ports[t.index]));

    const allOk = tasks.every((t) => t.ok);
    return {
      ok: allOk,
      tasks,
      ...(env.setupSkipped ? { setupSkipped: env.setupSkipped } : {}),
      ...(env.portRangeInvalid ? { portRangeInvalid: true as const } : {}),
    };
  }

  /**
   * T2 — read the repo's `wmux.json` once and derive the per-task environment:
   * a distinct port per task from `fanout.portRange`, and the trust-gated
   * `fanout.setup` hook. Any failure here is non-fatal: a fan-out that can't
   * read its project config still spawns, it just spawns the pre-T2 way.
   */
  private async resolveEnvironment(
    repoPath: string,
    count: number,
  ): Promise<{
    ports: (number | undefined)[];
    setupCommand?: string;
    setupSkipped?: FanoutSetupSkipReason;
    portRangeInvalid?: true;
  }> {
    const empty = { ports: new Array<number | undefined>(count).fill(undefined) };
    if (!this.project) return empty;

    let state: ProjectConfigState;
    try {
      state = await this.project.getState(repoPath);
    } catch {
      return empty;
    }

    const fanout = state.config?.fanout;
    const range = fanout?.portRange;
    // 포트 배정은 실행이 아니라 값 주입이라 신뢰 게이트를 요구하지 않는다 —
    // wmux.json이 고를 수 있는 것은 숫자 하나이고, 그 숫자는 `WMUX_TASK_PORT`
    // 안에 머문다(setup 훅과 달리 셸에 닿지 않는다).
    let ports: (number | undefined)[] = empty.ports;
    if (range) {
      try {
        ports = await assignFanoutPorts(range, count);
      } catch {
        ports = empty.ports;
      }
    }
    // 스키마가 거부한 portRange는 "선언 없음"과 구분해 보고한다(오타 진단 가능).
    const portRangeInvalid = fanout?.invalidFields?.includes('portRange') === true;

    const setup = resolveFanoutSetup(state);
    const rangeReport = portRangeInvalid ? { portRangeInvalid: true as const } : {};
    if (setup.run) return { ports, setupCommand: setup.command, ...rangeReport };
    // 'none-declared'는 보고할 게 없다(선언 자체가 없음). 나머지는 "선언은 됐는데
    // (신뢰 부재·형식 오류로) 안 돌았다"라 반드시 노출된다.
    return {
      ports,
      ...rangeReport,
      ...(setup.reason === 'none-declared' ? {} : { setupSkipped: setup.reason }),
    };
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
    /** T2 — WMUX_TASK_PORT for this task (absent = no range / window empty). */
    port?: number;
    /** T2 — trust-gated worktree setup hook (absent = nothing to run). */
    setupCommand?: string;
    /** Orchestrator role for this task's pane (absent = unroled). */
    role?: string;
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

    // 프롬프트 파일(비었으면 생략 — §7 "환경만 조성") + task.json 스탬프를 태스크 메타
    // 디렉토리(worktree 밖 — diff 청정성 §4)에 쓴다. task.json(J3 §1 CL5)은 projection
    // GC 이후에도 전용 루트의 worktree를 taskId·title로 역추적하게 하는 디스크 정본
    // 사이드카다.
    let promptPath: string | undefined;
    try {
      fs.mkdirSync(plan.metaDir, { recursive: true });
      if (ctx.prompt.length > 0) {
        promptPath = path.join(plan.metaDir, 'prompt.md');
        // A3: the caller's prompt verbatim, then the delivery contract (see
        // WORKER_DELIVERY_PREAMBLE). 프롬프트 없이 여는 "환경만 조성" 경로는
        // 파일 자체가 없으므로 계약문도 붙지 않는다 — 사람이 직접 입력한다.
        fs.writeFileSync(promptPath, ctx.prompt + WORKER_DELIVERY_PREAMBLE, 'utf8');
      }
      const stamp: WorkTaskMetaStamp = { taskId, title: ctx.title, createdAt: Date.now() };
      fs.writeFileSync(path.join(plan.metaDir, WORKTASK_META_FILENAME), JSON.stringify(stamp), 'utf8');
    } catch (err) {
      await this.compensate(taskId, ctx.verifiedWorkspaceId, plan);
      return { ...base, error: `prompt file write failed: ${(err as Error).message}`, preservedWorktree: plan.worktreePath };
    }

    // T2 — 태스크 환경 변수(포트). 훅과 에이전트 페인이 같은 값을 본다.
    const taskEnv: Record<string, string> = {};
    if (ctx.port !== undefined) {
      taskEnv[FANOUT_TASK_PORT_ENV] = String(ctx.port);
      base.port = ctx.port;
    }

    // T2 — worktree setup 훅(신뢰된 wmux.json에서만 도달). 에이전트 기동 **전**에
    // 돌린다. 실패는 태스크 실패로 취급하고 페인을 열지 않는다 — 의존성이 안 깔린
    // worktree에서 에이전트를 띄우면 그 사실을 발견하는 데 한 턴을 태운다.
    if (ctx.setupCommand !== undefined) {
      const setupRun = await runFanoutSetup(ctx.setupCommand, plan.worktreePath, taskEnv);
      if (!setupRun.ok) {
        // 이 태스크만 보상한다 — 훅 타임아웃/실패는 fan-out 전체를 접지 않고,
        // 호출부 루프가 다음 태스크를 그대로 이어간다.
        await this.compensate(taskId, ctx.verifiedWorkspaceId, plan);
        // 페인이 뜨지 않았으니 포트는 이 태스크의 것이 아니다 — 결과에서 뺀다
        // (run()이 예약도 함께 반납한다).
        const { port: _unusedPort, ...withoutPort } = base;
        return {
          ...withoutPort,
          setupFailed: true,
          error: `worktree setup hook failed: ${setupRun.error}`,
          preservedWorktree: plan.worktreePath,
        };
      }
    }

    // ③ 렌더러 spawn — 전용 워크스페이스 + 에이전트 페인. cwd=worktreePath,
    //    initialCommand=`{agentCmd} "$(cat '{promptPath}')"`(경로 쿼팅) — 프롬프트가
    //    없으면 인자 없이 agentCmd만(사람이 페인에서 직접 입력). 실제 workspaceId 회수.
    const initialCommand = buildInitialCommand(ctx.agentCmd, promptPath);
    base.initialCommand = initialCommand; // F2 재발사 재료(맨 셸 오배선 방지).
    const wsName = `wtask: ${ctx.title.slice(0, 32)}`;
    let workspaceId: string;
    try {
      const spawned = await this.renderer.spawnWorkspace({
        name: wsName,
        cwd: plan.worktreePath,
        initialCommand,
        ...(Object.keys(taskEnv).length > 0 ? { env: taskEnv } : {}),
        ...(ctx.role ? { role: ctx.role } : {}),
      });
      if ('error' in spawned) {
        await this.compensate(taskId, ctx.verifiedWorkspaceId, plan);
        return { ...base, error: `renderer spawn failed: ${spawned.error}`, preservedWorktree: plan.worktreePath };
      }
      workspaceId = spawned.workspaceId;
      // ptyId는 옵셔널(핸드셰이크가 싣지 못하면 부재) — §3 onExhausted 토스트 매핑용.
      if (spawned.ptyId) base.ptyId = spawned.ptyId;
      // 렌더러가 role 바인딩으로 커맨드를 바꿨다면 재발사 재료도 그 버전이어야
      // 한다 — 아니면 재발사가 역할의 에이전트·모델을 조용히 잃는다.
      if (spawned.initialCommand) base.initialCommand = spawned.initialCommand;
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
    // Lane F: the materialized task enters the ledger as `working` right here,
    // so the owner's brain, the Stop gate and the workers read one state from
    // the first second. Best-effort: a ledger write failure never fails the
    // fan-out (the reconciler mirrors it on the next look).
    try {
      rememberMissionChannel(taskId, channelId);
      await getTaskLedger().register({
        id: taskId,
        taskWorkspaceId: workspaceId,
        ownerWorkspaceId: ctx.verifiedWorkspaceId,
        title: ctx.title,
      });
    } catch {
      // best-effort — see above.
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
      const closed = (await this.daemon.rpc('task.mission.close', { taskId, verifiedWorkspaceId })) as { ok?: boolean } | undefined;
      // Lane F: a closed task leaves the ledger `cancelled` right away.
      if (closed?.ok) await noteWorkTaskClosed(taskId);
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
 *
 * `promptPath`가 undefined면(§7 "환경만 조성" — 프롬프트 없이 worktree·에이전트만 연다)
 * agentCmd만 그대로 반환한다. 빈 문자열 인자(`agentCmd ""`)로 발사하지 않는 이유: CLI마다
 * 빈 인자 처리(무시/에러/빈 프롬프트 전송)가 달라 불확정적이므로, "인자 없음"을 명시적으로
 * 만들어 에이전트가 평소 인터랙티브 기동과 동일하게 뜨도록 한다.
 */
export function buildInitialCommand(agentCmd: string, promptPath?: string): string {
  if (promptPath === undefined) return agentCmd;
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
