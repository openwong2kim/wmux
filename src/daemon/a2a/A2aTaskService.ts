/**
 * A2aTaskService — A2A 태스크의 **데몬측 정본**(envelope-design §5 D11).
 *
 * 종전 A2A 정본은 렌더러 인메모리 스토어(a2aSlice)였다 — 30분 GC 비내구라 채널과
 * 비대칭이었다. 본 서비스가 정본을 데몬 append-only 로그로 이동한다:
 *   - projection-first: 태스크 맵 projection을 들고, 모든 전이를 `domain:'a2a'`
 *     envelope로 **먼저 커밋(append→true)한 뒤 projection에 적용**한다. append가
 *     false(배치 롤백)면 projection은 건드리지 않는다 — 로그가 정본이므로.
 *   - `VALID_TRANSITIONS`(types.ts) 데몬측 강제(성공 종단='completed').
 *   - 완료증거(evidence): §6.M PR-B 게이트 **활성**. 종단 전이(completed/failed)는
 *     구조화 증거를 강제한다(validateCompletionEvidence) — completed=summary+≥1
 *     well-formed 아이템, failed=summary(사유). normalizeCompletionEvidenceWire로
 *     먼저 재검증(sanitize)한 뒤 게이트가 판정한다. verified≥1은 게이트가 아니라
 *     completed의 **등급**(E9)이다 — verifiedItemCount는 정직 산출·표기만 한다.
 *   - per-task 직렬화(뮤텍스)로 collect→append→apply 일관성.
 *   - clientMsgId류 멱등(§4): (taskId, idempotencyKey) LRU — 재시도는 append 없이
 *     원본 결과 반환(동일 키 재시도 → 로그 1건).
 *   - 30분 GC 시멘틱은 projection 레벨 유지(a2aSlice 현행 준수, 로그 절단 아님).
 *
 * authContext 스탬핑(§7 PR5): verifiedWorkspaceId는 서버핀 authz 앵커(호출자 제공),
 * principalId는 저장된 task 좌표에서 **서버 유도**한 display/routing 스탬프(위조 불가 —
 * 발신자 주장값은 신뢰하지 않는다, §7:356), trustTier는 'semi-trusted' 고정(§7 표:
 * A2A execute = 우리가 spawn한 ClaudeWorker). principalId/trustTier는 authz가 아니다 —
 * 권한 앵커는 verifiedWorkspaceId뿐이다(§7:358).
 */

import { makeEnvelope } from '../../shared/eventlog';
import type {
  AuthContext,
  EventEnvelope,
  EventEnvelopeDraft,
} from '../../shared/eventlog';
import { panePrincipalId } from '../../shared/principals';
import type {
  Artifact,
  CompletionEvidence,
  Message,
  Task,
  TaskState,
  WmuxTaskMetadata,
} from '../../shared/types';
import { validateTransition, VALID_TRANSITIONS, TERMINAL_STATES } from '../../shared/types';
import {
  isVerifiedItem,
  normalizeCompletionEvidenceWire,
  validateCompletionEvidence,
} from '../../shared/completionEvidence';
import { isVerifiedTaskSender } from '../../shared/a2aReopen';
import { isReceiverPaneGone } from '../../shared/a2aOrphanedTask';
import type {
  A2aTaskCancelPayload,
  A2aTaskCreatePayload,
  A2aTaskTransitionPayload,
} from '../../shared/a2aEventlog';

/** a2aSlice 현행 값 준수(캐시와 동일 시멘틱). */
const GC_MAX_AGE_MS = 30 * 60 * 1000; // 30분
const GC_MAX_TASKS = 500;
/** §4: 멱등 LRU cap/stream — 채널 상수(CHANNEL_IDEMPOTENCY_CAP=1000)와 동형. */
const IDEMPOTENCY_CAP = 1000;

/**
 * 완료증거 게이트(§6.M PR-B) 거부 코드 → 사람용 액션 힌트(설계 §⑤). 코드는 기계 파싱용
 * 안정 식별자, 힌트는 발신 에이전트가 무엇을 붙여 재시도할지 아는 사람용 문구다.
 * shared/completionEvidence는 주석 외 불변(스키마는 envelope PR5 소유 — X9)이라
 * 힌트 매핑은 강제 지점(데몬·렌더러 폴백)에 각각 로컬로 둔다.
 */
function evidenceGateHint(code: string): string {
  switch (code) {
    case 'completion_evidence_missing':
      return "status 'completed' requires structured completion evidence (summary + >=1 well-formed item)";
    case 'completion_evidence_empty_summary':
      return "status 'completed' requires a non-empty evidence summary";
    case 'completion_evidence_no_items':
      return "status 'completed' requires >=1 well-formed evidence item (command|inspection|artifact)";
    case 'completion_evidence_invalid_item':
      return 'evidence has a malformed item (command items need a non-empty command; every item needs a non-empty summary)';
    case 'completion_evidence_too_large':
      return 'evidence exceeds size caps (items/strings/files/total bytes)';
    case 'completion_evidence_bad_file_path':
      return 'evidence.files must be repo-relative paths (no absolute, drive, ADS, url-scheme, or ".." segments)';
    case 'failure_reason_missing':
      return "status 'failed' requires an evidence summary (the failure reason)";
    case 'cancel_reason_missing':
      return "status 'canceled' requires an evidence summary (why the task is dropped)";
    default:
      return 'attach valid completion evidence and retry';
  }
}

/** append + readAllRecords만 요구하는 최소 로그 인터페이스(AppendOnlyLog 만족). */
export interface A2aLogLike {
  append(draft: EventEnvelopeDraft): Promise<boolean>;
  readAllRecords(): EventEnvelope[];
}

export interface A2aTaskServiceOptions {
  log: A2aLogLike;
  /** envelope origin(§8). machineId·daemonEpoch는 부트에서 확정. */
  origin: { machineId: string; daemonEpoch: number };
  /** GC/타임스탬프 주입(테스트). 기본 Date.now. */
  now?: () => number;
}

/** 한 페인 좌표(선택적 pane-granular authz). */
export interface PaneAddr {
  paneId?: string;
  surfaceId?: string;
}

export interface CreateTaskInput {
  id?: string;
  title: string;
  from: { workspaceId: string; name: string; paneId?: string; surfaceId?: string };
  to: { workspaceId: string; name: string; paneId?: string; surfaceId?: string; ptyId?: string };
  history?: Message[];
  artifacts?: Artifact[];
}

export interface TransitionInput {
  taskId: string;
  to: TaskState;
  /** 서버핀된 호출자 workspace(수신자여야 함). */
  callerWorkspaceId: string;
  /** 알려진 경우의 호출자 페인(pane-granular authz). 헤드리스면 null/undefined. */
  callerAddr?: PaneAddr | null;
  /**
   * 호출자가 페인 신원(senderPtyId)을 주장했는가. S-C2 pane-granular authz는
   * 렌더러 페인 트리에서만 판정 가능하다(ptyId→pane 해석은 렌더러 소유) — 페인
   * 핀 태스크(to.paneId)에 페인 신원 호출자가 오면 데몬은 soft-defer하고 main이
   * 렌더러 검증 경로로 폴백한다(오늘의 판정 지점 보존, 서버측 이관은 PR5/§7).
   */
  callerHasPaneIdentity?: boolean;
  /**
   * The caller must prove its pane to move a pane-pinned task (external
   * callers). Without it, a caller that simply omits senderPtyId fell back to
   * workspace authz and could move another pane's task. Trusted in-process
   * lanes and the headless ClaudeWorker do not set it.
   */
  requirePaneIdentity?: boolean;
  /**
   * Live pane ids of the caller's workspace (stashed included), resolved by
   * main from the pane tree in the same read as `callerAddr` — so it carries
   * the same trust as `callerAddr`. When it is known and lacks the task's
   * `to.paneId`, the addressed pane is gone and a verified pane of the receiver
   * workspace may move the task (#1598). Absent = unknown: no relaxation.
   */
  livePaneIds?: readonly string[];
  /** 사람용 상태 메시지(있을 때만). */
  message?: Message;
  /** §6.M 완료증거(raw). 서비스가 재정규화(sanitize)해 저장 — 게이트 없음. */
  evidence?: unknown;
  /** §4 멱등키(clientMsgId류). 재시도 흡수. */
  idempotencyKey?: string;
}

export interface CancelTaskInput {
  taskId: string;
  callerWorkspaceId: string;
  idempotencyKey?: string;
}

export type OpErr = { ok: false; error: string };
/**
 * 전이/취소/생성 성공 결과는 커밋된 태스크 스냅샷을 동반한다 — 렌더러 캐시가 이 값을
 * **재검증 없이 verbatim 적용**한다(§6.M C6, a2aSlice.applyDaemonTaskUpdate).
 */
export type TransitionOk = { ok: true; verifiedItemCount?: number; task: Task };
export type CancelOk = { ok: true; task: Task };
export type CreateOk = { ok: true; taskId: string; task: Task };
export type ReopenOk = { ok: true; reopened: boolean; task: Task };

export interface QueryFilters {
  status?: TaskState;
  role?: 'user' | 'agent';
  updatedSince?: string;
}

export class A2aTaskService {
  private readonly log: A2aLogLike;
  private readonly origin: { machineId: string; daemonEpoch: number };
  private readonly now: () => number;

  /** projection: taskId → Task(정본 상태의 인메모리 뷰, 로그에서 재파생 가능). */
  private readonly tasks = new Map<string, Task>();
  /** per-task 직렬화 체인(collect→append→apply 일관성). */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** §4 멱등: streamId(taskId) → (idempotencyKey → 원본 결과). LRU cap. */
  private readonly idempotency = new Map<string, Map<string, TransitionOk | CancelOk>>();

  constructor(opts: A2aTaskServiceOptions) {
    this.log = opts.log;
    this.origin = opts.origin;
    this.now = opts.now ?? Date.now;
  }

  // ── 부트 복원 (cross-restart projection) ────────────────────────────

  /**
   * 로그의 `domain:'a2a'` 레코드를 순서대로 replay해 projection 복원.
   * 비내구→내구 전환의 핵심 가치: 재시작 후 태스크가 살아남는다. 부트 1회 호출.
   */
  restoreFromLog(): void {
    for (const rec of this.log.readAllRecords()) {
      if (rec.domain !== 'a2a') continue;
      this.applyPayload(rec.payload);
      this.restoreIdempotency(rec); // E: 크로스-재시작 멱등 재시드
    }
    // A: 부트 직후 GC — 30분 경과 종단 태스크를 즉시 정리한다. 로그는 영구이므로
    // 이게 없으면 restore가 역대 전 종단 태스크를 매 부트 부활시켜(projection 무한
    // 성장) query에 노출한다. GC는 projection만 바운드(로그 절단은 §9 컴팩션 몫).
    this.gcTerminalTasks();
  }

  /**
   * E(패널): 재시작 후 같은 idempotencyKey 재시도가 원본 결과를 반환하도록 멱등 LRU를
   * replay에서 재구성한다. 없으면 재시도가 캐시 미스→invalid transition(태스크가 이미
   * 전진)으로 변질된다. transition/cancel만 키를 싣는다(create는 결정적 id로 멱등).
   */
  private restoreIdempotency(rec: EventEnvelope): void {
    if (!rec.idempotencyKey) return;
    const p = rec.payload as { kind?: unknown; taskId?: unknown; verifiedItemCount?: unknown };
    if (p.kind !== 'task.transition' && p.kind !== 'task.cancel') return;
    if (typeof p.taskId !== 'string') return;
    const task = this.tasks.get(p.taskId);
    if (!task) return;
    const result: TransitionOk | CancelOk =
      p.kind === 'task.transition'
        ? {
            ok: true,
            task,
            ...(typeof p.verifiedItemCount === 'number' ? { verifiedItemCount: p.verifiedItemCount } : {}),
          }
        : { ok: true, task };
    this.idempotencyRecord(
      p.taskId,
      rec.idempotencyKey,
      p.kind === 'task.transition' ? 'transition' : 'cancel',
      result,
    );
  }

  /**
   * payload를 projection에 적용(append 성공 후에만 호출). kind가 닫힌 union이라
   * 미지 kind(executor-lifecycle 예약 슬롯 등)는 안전하게 무시한다(fail-closed).
   */
  private applyPayload(payload: unknown): void {
    if (payload === null || typeof payload !== 'object') return;
    const p = payload as { kind?: unknown };
    if (p.kind === 'task.create') {
      const { task } = payload as A2aTaskCreatePayload;
      if (task && typeof task.id === 'string' && !this.tasks.has(task.id)) {
        this.tasks.set(task.id, task);
      }
      return;
    }
    if (p.kind === 'task.transition') {
      const t = payload as A2aTaskTransitionPayload;
      const task = this.tasks.get(t.taskId);
      if (!task) return;
      task.status = {
        state: t.to,
        timestamp: t.timestamp,
        ...(t.message ? { message: t.message } : {}),
        ...(t.evidence ? { evidence: t.evidence } : {}),
      };
      task.metadata.updatedAt = t.timestamp;
      return;
    }
    if (p.kind === 'task.cancel') {
      const c = payload as A2aTaskCancelPayload;
      const task = this.tasks.get(c.taskId);
      if (!task) return;
      task.status = { state: 'canceled', timestamp: c.timestamp };
      task.metadata.updatedAt = c.timestamp;
      return;
    }
    // executor-lifecycle / 미지 kind: 예약 슬롯 — projection 무시.
  }

  // ── mutation ───────────────────────────────────────────────────────

  /**
   * 태스크 생성 → `task.create` envelope append → projection 시드.
   * 멱등(A3): 동일 id가 이미 있으면 append 없이 기존 유지(완료 태스크 부활 방지).
   */
  createTask(input: CreateTaskInput): Promise<CreateOk | OpErr> {
    const id = input.id ?? this.generateTaskId();
    return this.withTaskLock(id, async () => {
      // A3 멱등: 결정적 id(chmention-*) 재배달은 기존 상태를 보존.
      const existing = this.tasks.get(id);
      if (existing) return { ok: true, taskId: id, task: existing };

      const nowIso = this.isoNow();
      const metadata: WmuxTaskMetadata = {
        title: input.title,
        from: input.from,
        to: input.to,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      const task: Task = {
        kind: 'task',
        id,
        status: { state: 'submitted', timestamp: nowIso },
        history: input.history ?? [],
        artifacts: input.artifacts ?? [],
        metadata,
      };
      const payload: A2aTaskCreatePayload = { kind: 'task.create', task };
      // create의 행위자 = 발신자(from) — principalId를 from pane 좌표에서 서버 유도.
      const committed = await this.log.append(
        this.envelope(payload, input.from.workspaceId, this.derivePrincipalId(task, 'from', input.from.workspaceId)),
      );
      if (!committed) {
        return { ok: false, error: 'a2a.task.create: daemon log append failed (uncommitted)' };
      }
      this.applyPayload(payload);
      return { ok: true, taskId: id, task };
    });
  }

  /**
   * 상태 전이 — 데몬 정본 게이트. 권한 + VALID_TRANSITIONS + 완료증거 게이트(PR-B) 강제.
   * append(true) 후에만 projection 적용. 멱등키가 있으면 재시도 흡수(로그 1건).
   */
  transition(input: TransitionInput): Promise<TransitionOk | OpErr> {
    return this.withTaskLock(input.taskId, async () => {
      const task = this.tasks.get(input.taskId);
      if (!task) return { ok: false, error: `a2a.task.update: task not found: ${input.taskId}` };

      // 권한: 수신자 workspace만 상태 갱신 가능(a2aSlice 현행 계약).
      if (task.metadata.to.workspaceId !== input.callerWorkspaceId) {
        return { ok: false, error: `a2a.task.update: caller ${input.callerWorkspaceId} is not the receiver` };
      }
      // pane-granular authz(S-C2): 호출자 페인이 알려졌고(callerAddr) 태스크가 특정
      // 수신 페인에 핀됐으면(to.paneId) 그 페인이어야 한다. callerAddr 부재(헤드리스
      // ClaudeWorker)면 ws-authz — 이 불변식이 워커 완료 전이를 막지 않게 한다.
      // #1598: a pinned task whose receiver pane no longer exists is adopted by
      // any verified pane of the receiver workspace (checked above), instead of
      // being stuck forever. A live receiver pane keeps the rule.
      if (
        input.callerAddr && task.metadata.to.paneId && task.metadata.to.paneId !== input.callerAddr.paneId
        && !isReceiverPaneGone(task.metadata.to, input.callerWorkspaceId, input.livePaneIds)
      ) {
        return { ok: false, error: 'a2a.task.update: caller pane is not the addressed receiver pane' };
      }
      // S-C2 soft-defer: 페인 핀 태스크 + 페인 신원 주장 호출자인데 callerAddr가
      // 해석되지 않은 경우(ptyId→pane 해석은 렌더러 소유) — 데몬이 ws-authz로
      // 통과시키면 오늘의 페인 게이트(a2aSlice)가 우회된다. 렌더러 검증 경로로
      // 폴백하도록 soft 거부한다(main의 A2A_DAEMON_SOFT_ERRORS 계약).
      if (input.callerHasPaneIdentity && !input.callerAddr && task.metadata.to.paneId) {
        return { ok: false, error: 'a2a.task.update: pane-authz deferred to renderer (pane-pinned task)' };
      }
      if (input.requirePaneIdentity && !input.callerAddr && task.metadata.to.paneId) {
        return { ok: false, error: 'a2a.task.update: this task is pinned to a pane; only that pane can update it (no verified pane identity)' };
      }
      // §4 멱등: 앞서 커밋된 동일 키면 append 없이 원본 결과. 위치는 authz·soft-defer
      // **뒤**(리뷰 codex 델타: 히트가 authz를 앞지르면 키를 아는 비참여자가 커밋 스냅샷을
      // 재생 조회 — authz 우회), validateTransition **앞**(종단 재시도가 invalid
      // transition으로 변질되지 않게). 정당한 재시도는 동일 입력이라 authz를 항상 재통과.
      const cached = this.idempotencyHit(input.taskId, input.idempotencyKey, 'transition');
      if (cached) return cached as TransitionOk;
      // VALID_TRANSITIONS 데몬측 강제(성공 종단='completed').
      if (!validateTransition(task.status.state, input.to)) {
        const from = task.status.state;
        const allowed = VALID_TRANSITIONS[from];
        const guidance = allowed.length
          ? `allowed next: [${allowed.join(', ')}]`
          : `'${from}' is a terminal state with no further transitions`;
        return { ok: false, error: `a2a.task.update: invalid transition ${from} -> ${input.to}. ${guidance}.` };
      }

      // evidence 정규화(§6.M): untrusted wire를 재검증(sanitize)한다. malformed shape는
      // 렌더러 wire 경계(useRpcBridge completion_evidence_malformed)와 동형으로 거부한다
      // — 조용히 드롭하면 렌더러(거부)와 데몬(커밋)이 갈라진다(split). 미지 kind·타입
      // 혼동 아이템은 여기서 malformed로 죽고, shape는 맞지만 well-formed가 아닌
      // 아이템(빈 command 등)은 아래 게이트가 completion_evidence_invalid_item으로 잡는다.
      let evidence: CompletionEvidence | undefined;
      let verifiedItemCount: number | undefined;
      if (input.evidence !== undefined) {
        const normalized = normalizeCompletionEvidenceWire(input.evidence);
        if (!normalized) {
          return {
            ok: false,
            error: 'a2a.task.update: completion_evidence_malformed: evidence must be a plain object with string summary and well-formed items',
          };
        }
        evidence = normalized;
      }

      // 완료증거 게이트(§6.M PR-B — 활성). 종단 전이(completed/failed)는 구조화 증거를
      // 강제한다. pane-authz·불법 전이 거부(위)가 게이트보다 먼저라 게이트는 합법 전이에만
      // 도달한다(기존 에러 메시지·도그푸드 어서션 보존). verified≥1은 게이트가 아니라
      // 등급(E9) — verdict가 verifiedItemCount를 정직 산출한다(0 허용).
      // A receiver's cancel needs a reason (evidence.summary), like failed.
      if (input.to === 'completed' || input.to === 'failed' || input.to === 'canceled') {
        const verdict = validateCompletionEvidence(input.to, evidence);
        if (!verdict.ok) {
          return { ok: false, error: `a2a.task.update: ${verdict.code}: ${evidenceGateHint(verdict.code)}` };
        }
        verifiedItemCount = verdict.verifiedItemCount;
      } else if (evidence !== undefined) {
        // 비종단 전이(working/input-required)는 게이트 비대상 — evidence 수용 + 등급 카운트만.
        verifiedItemCount = evidence.items.filter(isVerifiedItem).length;
      }

      const payload: A2aTaskTransitionPayload = {
        kind: 'task.transition',
        taskId: input.taskId,
        to: input.to,
        timestamp: this.isoNow(),
        ...(input.message ? { message: input.message } : {}),
        ...(evidence ? { evidence } : {}),
        ...(verifiedItemCount !== undefined ? { verifiedItemCount } : {}),
      };
      // transition의 행위자 = 수신자(authz가 callerWorkspaceId===to.workspaceId 강제) —
      // principalId를 저장된 to pane 좌표에서 서버 유도(위조 불가).
      const authWs = input.callerWorkspaceId;
      const committed = await this.log.append(
        this.envelope(payload, authWs, this.derivePrincipalId(task, 'to', authWs), input.idempotencyKey),
      );
      if (!committed) {
        return { ok: false, error: 'a2a.task.update: daemon log append failed (uncommitted)' };
      }
      this.applyPayload(payload);

      const result: TransitionOk = {
        ok: true,
        ...(verifiedItemCount !== undefined ? { verifiedItemCount } : {}),
        task, // 커밋된 projection 스냅샷 — 캐시 verbatim 적용의 원본(C6)
      };
      this.idempotencyRecord(input.taskId, input.idempotencyKey, 'transition', result);
      return result;
    });
  }

  /**
   * 취소 — sender/receiver 모두 가능. VALID_TRANSITIONS(→canceled) 강제.
   */
  cancelTask(input: CancelTaskInput): Promise<CancelOk | OpErr> {
    return this.withTaskLock(input.taskId, async () => {
      const task = this.tasks.get(input.taskId);
      if (!task) return { ok: false, error: `a2a.task.cancel: task not found: ${input.taskId}` };

      const isSender = task.metadata.from.workspaceId === input.callerWorkspaceId;
      const isReceiver = task.metadata.to.workspaceId === input.callerWorkspaceId;
      if (!isSender && !isReceiver) {
        return { ok: false, error: `a2a.task.cancel: caller ${input.callerWorkspaceId} is not sender or receiver` };
      }
      // §4 멱등: transition과 대칭 — 히트는 authz 뒤(비참여자 키 재생 조회 차단),
      // op 네임스페이스 분리(transition 키로 cancel 결과를 재생하지 못하게 — codex 델타).
      const cached = this.idempotencyHit(input.taskId, input.idempotencyKey, 'cancel');
      if (cached) return cached as CancelOk;
      // G(패널): 이미 종단이면 멱등 no-op 성공 — 취소의 목적(종단 도달)이 이미
      // 충족됐다. reject하면 종전 렌더러 passthrough 경로 대비 회귀다(호출자는
      // 취소를 눌렀는데 에러를 받는다). 로그 append 없이 현 상태 반환.
      if ((TERMINAL_STATES as readonly string[]).includes(task.status.state)) {
        return { ok: true, task };
      }
      if (!validateTransition(task.status.state, 'canceled')) {
        return { ok: false, error: `a2a.task.cancel: cannot cancel task in state ${task.status.state}` };
      }

      const payload: A2aTaskCancelPayload = {
        kind: 'task.cancel',
        taskId: input.taskId,
        timestamp: this.isoNow(),
      };
      // cancel의 행위자 = sender 또는 receiver — 위에서 판정한 역할로 pane을 선택한다
      // (self-address task에선 sender 우선 — 취소는 통상 발신자 행위). principalId를 그
      // 측 pane 좌표에서 서버 유도.
      const committed = await this.log.append(
        this.envelope(payload, input.callerWorkspaceId, this.derivePrincipalId(task, isSender ? 'from' : 'to', input.callerWorkspaceId), input.idempotencyKey),
      );
      if (!committed) {
        return { ok: false, error: 'a2a.task.cancel: daemon log append failed (uncommitted)' };
      }
      this.applyPayload(payload);
      const result: CancelOk = { ok: true, task };
      this.idempotencyRecord(input.taskId, input.idempotencyKey, 'cancel', result);
      return result;
    });
  }

  /**
   * Reopen an ended task because its sender wrote to it again. A message on a
   * completed/failed/canceled task is new work for the receiver, so the task
   * goes back to `submitted` and shows up in the receiver's inbox like a new
   * one. Only the sender may do this. A task that has not ended is left as it
   * is (a `working` task stays `working`), and that is not an error.
   *
   * VALID_TRANSITIONS has no edge out of a terminal state, so this entry point
   * bypasses it on purpose, the same posture as failTasksForWorkspaceRemoved;
   * the regular transition API still refuses terminal -> submitted. The commit
   * is a plain `task.transition` payload (plus a `reopened` marker), so a log
   * replayed by an older daemon still lands on `submitted`.
   */
  reopenTask(input: { taskId: string; callerWorkspaceId: string; callerPaneId?: string }): Promise<ReopenOk | OpErr> {
    return this.withTaskLock(input.taskId, async () => {
      const task = this.tasks.get(input.taskId);
      if (!task) return { ok: false, error: `a2a.task.reopen: task not found: ${input.taskId}` };
      // Only a provable sender: in a same-workspace task that means the `from`
      // pane itself (main resolves callerPaneId from the caller's pane tree).
      if (!isVerifiedTaskSender(task.metadata, input.callerWorkspaceId, input.callerPaneId)) {
        return { ok: false, error: 'a2a.task.reopen: caller is not the verified sender of this task' };
      }
      if (!(TERMINAL_STATES as readonly string[]).includes(task.status.state)) {
        return { ok: true, reopened: false, task };
      }
      const payload: A2aTaskTransitionPayload = {
        kind: 'task.transition',
        taskId: input.taskId,
        to: 'submitted',
        timestamp: this.isoNow(),
        reopened: 'sender_message',
      };
      const committed = await this.log.append(
        this.envelope(payload, input.callerWorkspaceId, this.derivePrincipalId(task, 'from', input.callerWorkspaceId)),
      );
      if (!committed) {
        return { ok: false, error: 'a2a.task.reopen: daemon log append failed (uncommitted)' };
      }
      this.applyPayload(payload);
      return { ok: true, reopened: true, task };
    });
  }

  /**
   * B(패널·완료증거 설계 §③ E10) — workspace teardown 전용 강제-실패 진입점.
   * 수신 workspace가 제거되면 그 workspace로 향한 non-terminal 태스크는 어떤
   * 전진도 불가하다(수신자 소멸). `VALID_TRANSITIONS`를 **의도적으로 우회**해
   * (submitted/input-required→failed는 그래프상 불가) failed로 커밋한다 —
   * 일반 transition API는 이 전이를 여전히 거부한다(진입점이 그래프 완화가 아님).
   *
   * 이게 없으면 teardown이 렌더러 캐시에서만 태스크를 죽이고 데몬 정본엔 미도달 →
   * 재시작 시 restoreFromLog가 죽은 태스크를 working/submitted로 부활시켜 정본이
   * 실제와 어긋난다(내구성 정본 주장 훼손). 데몬 부트 게이트가 workspace 제거를
   * 아는 유일 지점(a2a.channel.purgeMembership 핸들러)에서 호출된다.
   *
   * @returns 실제로 failed로 커밋된 태스크 수.
   */
  async failTasksForWorkspaceRemoved(workspaceId: string, reason: string): Promise<number> {
    // 스냅샷 후 순회 — 락 안에서 status가 바뀌므로 순회 중 Map 변형 회피.
    const targets = [...this.tasks.values()].filter(
      (t) =>
        t.metadata.to.workspaceId === workspaceId &&
        !(TERMINAL_STATES as readonly string[]).includes(t.status.state),
    );
    let failed = 0;
    for (const target of targets) {
      // eslint-disable-next-line no-await-in-loop -- per-task 직렬화(정상 전이와 순서 보장)
      const ok = await this.withTaskLock(target.id, async () => {
        // 락 대기 중 정상 전이로 종단됐으면 멱등 skip(이중 커밋 방지).
        const cur = this.tasks.get(target.id);
        if (!cur || (TERMINAL_STATES as readonly string[]).includes(cur.status.state)) return false;
        const payload: A2aTaskTransitionPayload = {
          kind: 'task.transition',
          taskId: target.id,
          to: 'failed',
          timestamp: this.isoNow(),
          forced: 'workspace_removed',
          // 합성 완료증거(§③ E10): 실패 사유만(items 없음). force-fail은 완료증거
          // 게이트(PR-B)를 **의도적으로 우회**하는 데몬 네이티브 진입점이라
          // validateCompletionEvidence를 거치지 않는다 — 수신자 소멸 태스크를 그대로 커밋.
          evidence: { summary: reason, items: [] },
        };
        // 데몬 강제-실패(teardown): 제거되는 수신 workspace를 authz 앵커로, principalId는
        // 수신 pane(to) 좌표에서 서버 유도(cur는 위 가드로 non-null).
        const committed = await this.log.append(
          this.envelope(payload, workspaceId, this.derivePrincipalId(cur, 'to', workspaceId)),
        );
        if (!committed) return false;
        this.applyPayload(payload);
        return true;
      });
      if (ok) failed++;
    }
    return failed;
  }

  // ── read ───────────────────────────────────────────────────────────

  getTask(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  queryTasks(workspaceId: string, filters?: QueryFilters): Task[] {
    const out: Task[] = [];
    for (const task of this.tasks.values()) {
      const isSender = task.metadata.from.workspaceId === workspaceId;
      const isReceiver = task.metadata.to.workspaceId === workspaceId;
      if (!isSender && !isReceiver) continue;
      if (filters?.role === 'user' && !isSender) continue;
      if (filters?.role === 'agent' && !isReceiver) continue;
      if (filters?.status && task.status.state !== filters.status) continue;
      // 증분 커서(A9): ISO-8601 문자열 사전순=시간순. strictly-after.
      if (filters?.updatedSince && !(task.metadata.updatedAt > filters.updatedSince)) continue;
      out.push(task);
    }
    return out;
  }

  /** 관측용(테스트/디버그): 현재 projection 태스크 수. */
  get taskCount(): number {
    return this.tasks.size;
  }

  // ── GC (projection 레벨, 로그 절단 아님) ────────────────────────────

  /**
   * 30분 초과 종단 태스크 제거 + 하드캡 초과 시 **오래된 종단분만** 축출.
   *
   * a2aSlice(UI 캐시)의 GC와 달리 **비종단(활성) 태스크는 절대 축출하지 않는다**
   * (패널 델타): 이건 데몬 정본 projection이라 활성 태스크를 지우면 라이브
   * 태스크를 잃는다(query/transition이 'task not found'). 종단분만으로 캡에 못
   * 미치면 projection은 캡을 넘긴 채 유지된다 — 활성 작업 보존이 정답이고, 실제
   * 동시 태스크 수가 자연 바운드다. 로그 상주분 절단은 §9 컴팩션 몫(여기 아님).
   */
  gcTerminalTasks(): void {
    const now = this.now();
    for (const [id, task] of this.tasks) {
      if (
        (TERMINAL_STATES as readonly string[]).includes(task.status.state) &&
        now - new Date(task.metadata.updatedAt).getTime() > GC_MAX_AGE_MS
      ) {
        this.tasks.delete(id);
        this.idempotency.delete(id);
      }
    }
    if (this.tasks.size <= GC_MAX_TASKS) return;
    let toRemove = this.tasks.size - GC_MAX_TASKS;
    // 종단 태스크만 축출 후보 — 활성은 절대 지우지 않는다(정본 무결성).
    const terminalOldest = [...this.tasks.values()]
      .filter((t) => (TERMINAL_STATES as readonly string[]).includes(t.status.state))
      .sort((a, b) => new Date(a.metadata.updatedAt).getTime() - new Date(b.metadata.updatedAt).getTime());
    for (const task of terminalOldest) {
      if (toRemove <= 0) break;
      this.tasks.delete(task.id);
      this.idempotency.delete(task.id);
      toRemove--;
    }
  }

  // ── 내부 ────────────────────────────────────────────────────────────

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }

  private generateTaskId(): string {
    // a2aSlice generateId('task')와 동형 — 조정 없는 유일 id.
    return `task-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /** makeEnvelope 초안 조립(발급 필드는 append 소관). */
  private envelope(
    payload: unknown,
    verifiedWorkspaceId: string,
    principalId: string,
    idempotencyKey?: string,
  ): EventEnvelopeDraft {
    return makeEnvelope({
      domain: 'a2a',
      payload,
      origin: this.origin,
      authContext: this.buildAuthContext(verifiedWorkspaceId, principalId),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  }

  /**
   * principalId 서버 유도(§7). 행위자(actor)의 **역할**을 호출자가 명시한다(actorSide) —
   * create·sender-cancel의 행위자는 from, transition(수신자 강제)·teardown·receiver-cancel은
   * to. 역할을 workspaceId 일치로 추론하지 않는 이유: self-address task(from.ws===to.ws)에서는
   * 양쪽이 같은 ws라 추론이 불가능해 행위자를 오기한다(리뷰 3모델 합의 — Codex·GLM·Claude).
   *
   * 유도 소스는 task.metadata의 pane 좌표다. transition/cancel의 좌표는 생성 시 서버 저장값이라
   * 상태를 갱신하는 caller가 위조할 수 없다. create의 from 좌표는 그 호출의 신선한 입력이지만
   * 정상 토폴로지에선 렌더러 경계 해석값이다(§7:356의 "senderPtyId→레지스트리" 서버 유도는
   * A2A 경로에선 데몬이 ptyId→pane을 해석하지 못하므로(S-C2, 렌더러 소유) 좌표 유도가 그
   * 데몬-경계 등가물이다 — 채널 경로처럼 상류가 레지스트리 해석 principalId를 주입하지는 않는다).
   * pane 미핀(ws-level task·헤드리스 ClaudeWorker)이면 verifiedWorkspaceId 폴백.
   * principalId는 display/routing·감사 전용이라 이 유도가 어긋나도 authz는 불변이다
   * (권한 앵커 = verifiedWorkspaceId, §7:358).
   */
  private derivePrincipalId(task: Task, actorSide: 'from' | 'to', verifiedWorkspaceId: string): string {
    const addr = task.metadata[actorSide];
    if (addr.paneId) return panePrincipalId(addr.workspaceId, addr.paneId);
    return verifiedWorkspaceId;
  }

  /**
   * authContext 조립(§7 PR5). verifiedWorkspaceId = 서버핀 authz 앵커(호출자 제공).
   * principalId = derivePrincipalId가 서버 유도한 display/routing 스탬프. trustTier =
   * 'semi-trusted' 고정: A2A task RPC는 caller가 GUI human인지 우리가 spawn한 ClaudeWorker인지
   * 구별할 신뢰 신호를 싣지 않으므로(§7 표의 trusted/semi-trusted 구분 입력 부재) 보수적
   * 하위 등급으로 단일화한다(발신자 주장 차단). 정밀 등급 배정은 caller trust 신호 배선 후속.
   * trustTier/principalId는 display·감사 전용이라 authz에 무영향(§7:358).
   */
  private buildAuthContext(
    verifiedWorkspaceId: string,
    principalId: string,
  ): AuthContext {
    return {
      principalId,
      verifiedWorkspaceId,
      trustTier: 'semi-trusted',
    };
  }

  /**
   * 멱등 키는 op 네임스페이스로 분리 저장한다(codex 델타): transition과 cancel이 같은
   * (taskId, key) 평면을 공유하면 한 op의 키로 다른 op의 캐시 결과를 재생할 수 있다
   * (예: cancel 키 재사용 transition이 CancelOk를 TransitionOk로 오반환).
   */
  private idempotencyHit(
    taskId: string,
    key: string | undefined,
    op: 'transition' | 'cancel',
  ): TransitionOk | CancelOk | undefined {
    if (!key) return undefined;
    return this.idempotency.get(taskId)?.get(`${op}:${key}`);
  }

  private idempotencyRecord(
    taskId: string,
    key: string | undefined,
    op: 'transition' | 'cancel',
    result: TransitionOk | CancelOk,
  ): void {
    if (!key) return;
    let stream = this.idempotency.get(taskId);
    if (!stream) {
      stream = new Map();
      this.idempotency.set(taskId, stream);
    }
    stream.set(`${op}:${key}`, result);
    // LRU: Map은 삽입 순서를 보존 — cap 초과 시 가장 오래된 키부터 축출.
    while (stream.size > IDEMPOTENCY_CAP) {
      const oldest = stream.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      stream.delete(oldest);
    }
  }

  /**
   * per-task 직렬화. prev 체인 뒤에 fn을 잇고, 다음 대기자가 prev 실패로 거부되지
   * 않도록 저장 체인은 에러를 삼킨다(ChannelService.withChannelLock 동형). 테일에서
   * 정착 시 항목을 정리해 locks 맵을 바운드한다.
   */
  private withTaskLock<T>(taskId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(taskId) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const chain = run.then(
      () => undefined,
      () => undefined,
    );
    this.locks.set(taskId, chain);
    void chain.then(() => {
      if (this.locks.get(taskId) === chain) this.locks.delete(taskId);
    });
    return run;
  }
}
