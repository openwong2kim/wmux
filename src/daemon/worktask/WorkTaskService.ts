/**
 * WorkTaskService — WorkTask(미션 단위)의 **데몬측 정본**(J0 §1~§3 D1~D3).
 *
 * A2aTaskService(daemon/a2a)의 검증된 projection-first 패턴을 따르되, J0 스펙의
 * 차이를 반영한다:
 *   - projection-first: `task.create`/`task.close` envelope를 **먼저 커밋
 *     (append→true)한 뒤에만 projection에 적용**한다. append가 false면 projection
 *     불변(로그가 정본).
 *   - 배타 불변식(동일 canonical worktreePath에 open 최대 1개, §2)의 직렬화는
 *     per-task 락이 아니라 **서비스 전역 write 뮤텍스**다(리뷰 GLM: 서로 다른
 *     태스크의 동시 create는 per-task 락으로 미보호).
 *   - 부트 순서 고정(§1 D — Codex): **replay → reconcile(양방향) → closed GC**.
 *     GC가 reconcile보다 먼저 돌면 "closed 태스크 + active 채널" 복구 대상이
 *     projection에서 사라진다. 추가 안전핀: **archive 미확인 closed 태스크는 GC 면제**.
 *   - `(op, idempotencyKey)` LRU 멱등(§4·§3 MCP 멱등) — 응답 유실 재시도가
 *     중복 채널+중복 태스크를 못 만든다.
 *   - 미션 채널 생성·아카이브는 ChannelService.create/archive를 데몬 내부에서
 *     호출한다(§3의 크래시 순서·보상 archive·no-op 내성 계약).
 *
 * 신원(§3): mission.start/close의 caller는 트랜스포트가 senderPtyId→
 * verifiedWorkspaceId를 서버 해석한 값으로만 authz한다(fail-closed). owner는
 * born-owned: 생성 시 createdBy로 서버가 강제 투입(§5.1 — wire 불가).
 */

import { makeEnvelope } from '../../shared/eventlog';
import type {
  AuthContext,
  EventEnvelope,
  EventEnvelopeDraft,
  TrustTier,
} from '../../shared/eventlog';
import {
  WORKTASK_CLOSED_GC_MS,
  WORKTASK_IDEMPOTENCY_CAP,
  WORKTASK_MAX_OPEN_PER_WORKSPACE,
  WORKTASK_PR_URL_RE,
  missionTopicFor,
  normalizeWorktreePath,
  taskIdFromMissionTopic,
} from '../../shared/workTask';
import type {
  WorkTask,
  WorkTaskClosePayload,
  WorkTaskCreatePayload,
  WorkTaskRef,
  WorkTaskUpdatePayload,
} from '../../shared/workTask';
import { CHANNEL_TOPIC_MAX } from '../../shared/channels';

/** append + readAllRecords만 요구하는 최소 로그 인터페이스(A2aLogLike와 동형). */
export interface WorkTaskLogLike {
  append(draft: EventEnvelopeDraft): Promise<boolean>;
  readAllRecords(): EventEnvelope[];
}

/**
 * ChannelService의 create/archive 중 WorkTaskService가 쓰는 최소 표면만
 * 요구한다(테스트 fake 주입 가능). 반환은 typed Result 봉투.
 */
export interface WorkTaskChannelPort {
  create(params: {
    name: string;
    visibility: 'public' | 'private';
    topic?: string;
    createdBy: { workspaceId: string; memberId: string; principalId?: string };
    verifiedWorkspaceId: string;
    members?: Array<{ workspaceId: string; memberId: string; principalId?: string }>;
  }): Promise<
    | { ok: true; channel: { id: string } }
    | { ok: false; error: { code: string; message: string } }
  >;
  archive(params: {
    channelId: string;
    archivedBy: string;
    verifiedWorkspaceId: string;
  }): Promise<
    | { ok: true }
    | { ok: false; error: { code: string; message: string } }
  >;
  /** 부트 reconcile 전용 — 멤버십 무관 전체 채널 (id, topic, status, 창설 ws).
   *  createdByWorkspaceId는 고아 archive의 authz 신원(창설자는 항상 멤버로
   *  시드되므로 멤버 게이트를 통과한다 — 3모델 리뷰 R1': 빈 신원 archive는 전패). */
  listAllForReconcile(): Array<{
    id: string;
    topic?: string;
    status: 'active' | 'archived';
    createdByWorkspaceId?: string;
  }>;
}

export interface WorkTaskServiceOptions {
  log: WorkTaskLogLike;
  channels: WorkTaskChannelPort;
  /** envelope origin(§8). machineId·daemonEpoch는 부트에서 확정. */
  origin: { machineId: string; daemonEpoch: number };
  /**
   * close authz의 CEO 예외(§3 — GLM: ceoWorkspaceId 메커니즘 인용). 데몬이
   * ceoWorkspaceId를 아는 시점에 주입. 부재면 owner 게이트만.
   */
  ceoWorkspaceId?: string;
  /** GC/타임스탬프 주입(테스트). 기본 Date.now. */
  now?: () => number;
  /**
   * worktreePath 배타 불변식(§5)의 realpath 해석기. 데몬은 fs 접근이 없으므로
   * 주입한다(테스트 = identity, 배선 시 fs.realpathSync 폴백 래핑). 실패(경로
   * 부재 등)는 호출측이 문자열 정규화만으로 폴백하도록 원본을 반환한다. shared
   * normalizeWorktreePath(순수 문자열 정규화) 위에 심링크 해석만 얹는 역할.
   */
  realpath?: (p: string) => string;
}

/** mission.start 입력 — wire 화이트리스트(§2)는 라우터가 강제, 여기선 서버 신원 포함. */
export interface StartMissionInput {
  title: string;
  /** 서버핀 authz 앵커(§3 senderPtyId→verifiedWorkspaceId 해석 결과). */
  verifiedWorkspaceId: string;
  /** 생성자 멤버 id(채널 생성 시 멤버 시드). */
  memberId: string;
  /** 선택 초대 목록(채널 초기 멤버로 시드). */
  invite?: Array<{ workspaceId: string; memberId: string }>;
  /** §3 MCP 멱등키(응답 유실 재시도 흡수). */
  idempotencyKey?: string;
}

export interface CloseMissionInput {
  taskId: string;
  /** 서버핀 authz 앵커(§3). */
  verifiedWorkspaceId: string;
  idempotencyKey?: string;
  /**
   * Non-destructive detach close. When true, performs the same log close + channel
   * archive as an ordinary close, but stamps the close record with workspace-detached
   * evidence to carve in `detachedAt`. worktree/branch/PTY/workspace are concerns
   * outside this layer, so the daemon never touches them anyway (the caller bypasses
   * the remove path). Result carries `detached: true`.
   */
  detach?: boolean;
}

/**
 * task.update 입력(§5 — J0 예약 이행). wire 화이트리스트는 {taskId, branch?,
 * worktreePath?, paneGroupId?}만(prUrl은 J2 몫이라 J1 wire에서 제외). 물질화는
 * 단조 — 이미 설정된 필드의 덮어쓰기는 거부한다.
 */
export interface UpdateMissionInput {
  taskId: string;
  /** 서버핀 authz 앵커(§5 — close와 동일: owner OR CEO). */
  verifiedWorkspaceId: string;
  branch?: string;
  worktreePath?: string;
  paneGroupId?: string;
  /** J3 §2: 비단조 mutable(PR 재생성 갱신 허용) — closed 태스크에도 단독 갱신 가능. */
  prUrl?: string;
}

export type WorkTaskErr = { ok: false; error: string };
export type StartMissionOk = { ok: true; taskId: string; channelId: string };
export type CloseMissionOk = {
  ok: true;
  taskId: string;
  /** J3 §1(CX2): 채널 archive 미확정 — 부트 reconcile이 재시도 수렴. */
  archivePending?: boolean;
  /** Was a detach close (for the caller's UI to check). Absent on an ordinary close. */
  detached?: boolean;
};
export type UpdateMissionOk = { ok: true; taskId: string };

export class WorkTaskService {
  private readonly log: WorkTaskLogLike;
  private readonly channels: WorkTaskChannelPort;
  private readonly origin: { machineId: string; daemonEpoch: number };
  private readonly ceoWorkspaceId: string | undefined;
  private readonly now: () => number;
  /** §5 배타 불변식 realpath 해석기(주입). 기본 = identity(순수 문자열 정규화만). */
  private readonly realpath: (p: string) => string;

  /** projection: taskId → WorkTask(정본 상태의 인메모리 뷰, 로그에서 재파생 가능). */
  private readonly tasks = new Map<string, WorkTask>();
  /**
   * 서비스 전역 write 뮤텍스(§2). 배타 불변식(동일 worktreePath open 1개)의
   * 검사 직렬화는 per-task 락으로 부족하다(서로 다른 태스크의 동시 create).
   * 모든 변이(create/close)를 이 단일 체인에 잇는다.
   */
  private writeChain: Promise<unknown> = Promise.resolve();
  /**
   * §4 멱등: op 네임스페이스(start/close) → (idempotencyKey → 원본 결과). LRU cap.
   * 응답 유실 재시도가 중복 채널·태스크를 만들지 못하게 한다(§3 R3).
   */
  private readonly idempotency = new Map<string, StartMissionOk | CloseMissionOk>();

  constructor(opts: WorkTaskServiceOptions) {
    this.log = opts.log;
    this.channels = opts.channels;
    this.origin = opts.origin;
    this.ceoWorkspaceId = opts.ceoWorkspaceId;
    this.now = opts.now ?? Date.now;
    this.realpath = opts.realpath ?? ((p) => p);
  }

  // ── 부트 복원 (순서 고정: replay → reconcile → GC) ────────────────────

  /**
   * 부트 1회. §1 D 순서 고정: **replay → reconcile(양방향) → closed GC**.
   * reconcile은 채널을 만질 수 있으므로(archive) async다.
   */
  async boot(): Promise<void> {
    this.replay();
    await this.reconcile();
    this.gcClosedTasks();
  }

  /** 로그의 `domain:'task'` 레코드를 순서대로 replay해 projection 복원. */
  private replay(): void {
    for (const rec of this.log.readAllRecords()) {
      if (rec.domain !== 'task') continue;
      this.applyPayload(rec.payload);
      this.restoreIdempotency(rec);
    }
  }

  /**
   * 재시작 후 같은 idempotencyKey 재시도가 원본 결과를 반환하도록 멱등 LRU를
   * replay에서 재구성한다(A2aTaskService.restoreIdempotency 동형). start는
   * (taskId, channelId), close는 (taskId)를 원본 결과로 재구성한다.
   * 스코프 신원은 envelope authContext의 서버 스탬프에서 복원한다(위조 불가 값).
   */
  private restoreIdempotency(rec: EventEnvelope): void {
    if (!rec.idempotencyKey) return;
    const ws = rec.authContext.verifiedWorkspaceId;
    const p = rec.payload as { kind?: unknown; task?: unknown; taskId?: unknown };
    if (p.kind === 'task.create') {
      const task = (p as WorkTaskCreatePayload).task;
      if (task && typeof task.id === 'string' && typeof task.missionChannelId === 'string') {
        this.idempotencyRecord('start', ws, rec.idempotencyKey, {
          ok: true,
          taskId: task.id,
          channelId: task.missionChannelId,
        });
      }
      return;
    }
    if (p.kind === 'task.close') {
      const c = p as WorkTaskClosePayload;
      const taskId = c.taskId;
      if (typeof taskId === 'string') {
        // Restore the idempotency receipt for a detach close with detached:true too
        // (hardened after review), so a retry after restart returns the same response
        // as the original success.
        const detached = c.evidence?.kind === 'workspace-detached';
        this.idempotencyRecord('close', ws, rec.idempotencyKey, {
          ok: true,
          taskId,
          ...(detached ? { detached: true } : {}),
        });
      }
    }
  }

  /**
   * payload를 projection에 적용(append 성공 후에만 호출). kind가 닫힌 union이라
   * 미지 kind는 안전하게 무시(fail-closed).
   */
  private applyPayload(payload: unknown): void {
    if (payload === null || typeof payload !== 'object') return;
    const p = payload as { kind?: unknown };
    if (p.kind === 'task.create') {
      const { task } = payload as WorkTaskCreatePayload;
      if (task && typeof task.id === 'string' && !this.tasks.has(task.id)) {
        this.tasks.set(task.id, task);
      }
      return;
    }
    if (p.kind === 'task.close') {
      const c = payload as WorkTaskClosePayload;
      const task = this.tasks.get(c.taskId);
      if (!task || task.status === 'closed') return;
      task.status = 'closed';
      task.closedAt = c.closedAt;
      // If detach evidence is present, restore detachedAt (shared replay/runtime
      // path). Old records lack evidence, so detachedAt stays unset — interpreted
      // as an ordinary close (safe fallback).
      if (c.evidence && c.evidence.kind === 'workspace-detached') {
        task.detachedAt = c.evidence.detachedAt;
      }
      return;
    }
    if (p.kind === 'task.update') {
      // J1 §5: 물질화 필드 단조 커밋. replay/런타임 모두 이 경로로 projection에
      // 반영된다. 단조성(최초 1회 쓰기)·배타 불변식·authz는 updateMission이 append
      // **전에** 게이트한다 — applyPayload는 커밋된 레코드를 그대로 반영하는 순수
      // 적용자이므로 여기서는 존재하는 필드만 덮는다(구 레코드 안전: 부재 필드 무변).
      const u = payload as WorkTaskUpdatePayload;
      const task = this.tasks.get(u.taskId);
      if (!task) return;
      if (task.status === 'closed') {
        // J3 §2: closed 태스크에는 prUrl만 반영(게이트가 append 전에 물질화
        // 동반을 거부하지만, replay 안전을 위해 적용자도 동일 필터).
        if (u.prUrl !== undefined) task.prUrl = u.prUrl;
        return;
      }
      if (u.branch !== undefined) task.branch = u.branch;
      if (u.worktreePath !== undefined) task.worktreePath = u.worktreePath;
      if (u.paneGroupId !== undefined) task.paneGroupId = u.paneGroupId;
      if (u.prUrl !== undefined) task.prUrl = u.prUrl;
      return;
    }
  }

  /**
   * 양방향 reconcile(§3 — Codex+GLM). replay 직후 projection과 채널 상태를 화해한다:
   *   - 채널 방향(고아): topic이 `wmux:mission:{taskId}` 앵커인데 taskId가
   *     projection에 없는 채널 → 고아 판정 → archive(크래시 창 1↔2 보상). 위조
   *     topic 채널(사용자 수동 생성)도 태스크가 없으므로 archive(§6 자해 한정).
   *   - 태스크 방향(closed+active): closed 태스크의 미션 채널이 아직 active면
   *     archive 재시도(멱등 — 이미 archived/부재면 no-op).
   */
  private async reconcile(): Promise<void> {
    const channels = this.channels.listAllForReconcile();
    const byId = new Map(channels.map((c) => [c.id, c]));

    // 채널 방향: 고아 mission-topic 채널 archive.
    for (const ch of channels) {
      if (ch.status === 'archived') continue;
      const anchoredTaskId = taskIdFromMissionTopic(ch.topic);
      if (!anchoredTaskId) continue;
      if (this.tasks.has(anchoredTaskId)) continue; // 정상 바인딩 — projection에 있음.
      // 고아: 데몬 내부 archive. 신원 = 채널의 창설 워크스페이스(3모델 리뷰 R1' —
      // 창설자는 create가 항상 멤버로 시드하므로 멤버 게이트를 통과한다. 빈
      // 신원('')은 isMember/isCeo 전패라 모든 고아 archive가 no-op으로 삼켜져
      // 영구 잔존했다). 창설 ws가 기록에 없으면(구 레코드) best-effort 폴백.
      await this.tryArchive(ch.id, ch.createdByWorkspaceId ?? '');
    }

    // 태스크 방향: closed인데 채널 active면 archive 재시도.
    for (const task of this.tasks.values()) {
      if (task.status !== 'closed') continue;
      const ch = byId.get(task.missionChannelId);
      if (!ch || ch.status === 'archived') continue; // 부재/이미 archived = no-op.
      await this.tryArchive(task.missionChannelId, task.owner.verifiedWorkspaceId);
    }
  }

  /**
   * closedAt + WORKTASK_CLOSED_GC_MS 경과 태스크를 projection에서 퇴출(§1 D13).
   * 로그 절단이 아니라 인메모리 뷰 바운드다(§6.L 컴팩션 몫 불변).
   *
   * "archive 미확인 closed는 GC 면제" 안전핀은 **의도적으로 두지 않는다**(리뷰
   * GLM R3' 반영, 설계 v1.1 §1 안전핀 문구 대체): 부트 순서가 replay → reconcile
   * → GC로 고정돼 있어 GC 시점엔 이번 부트의 archive 재시도가 이미 끝났고, 다음
   * 부트의 replay가 로그에서 전 태스크를 복원하므로 GC가 복구 경로를 끊지 못한다.
   * 반대로 active-채널 면제를 두면 owner-leave 수용 잔여(§3)에서 closed 태스크가
   * projection에 영구 잔류해 GC의 존재 이유(뷰 바운드)가 무산된다.
   */
  gcClosedTasks(): void {
    const now = this.now();
    for (const [id, task] of this.tasks) {
      if (task.status !== 'closed' || task.closedAt === undefined) continue;
      // Detached tasks are exempt from GC (hardened after review). Detach
      // closes while leaving the child worktree alive, so evicting it from the
      // projection would let the cleanup scanner misclassify that live worktree as
      // an orphan-dir (deletion candidate). As long as detachedAt is set, keep it in
      // the projection so the scanner/UI keep protecting it as a "live worktree".
      if (task.detachedAt !== undefined) continue;
      if (now - task.closedAt <= WORKTASK_CLOSED_GC_MS) continue;
      this.tasks.delete(id);
    }
  }

  // ── mutation ───────────────────────────────────────────────────────

  /**
   * mission.start(§3): taskId 선발급 → 채널 create → task.create append → projection 시드.
   *   - append 실패(크래시 아님) → **즉시 보상 archive**(§3 — reaper는 고아 못 줍는다).
   *   - 크래시 창(1↔2) → 부트 reconcile 채널 방향이 줍는다.
   */
  startMission(input: StartMissionInput): Promise<StartMissionOk | WorkTaskErr> {
    return this.withWriteLock(async () => {
      // §3 멱등: 응답 유실 재시도는 저장된 결과 재반환(append 없이).
      // 키는 caller의 서버핀 워크스페이스로 스코프(2모델 리뷰 R2' — 무스코프
      // 전역 키는 타 워크스페이스가 같은 키로 남의 {taskId, channelId}를 받는다).
      const cached = this.idempotencyHit('start', input.verifiedWorkspaceId, input.idempotencyKey);
      if (cached) return cached as StartMissionOk;

      const title = input.title.trim();
      if (title.length === 0) {
        return { ok: false, error: 'task.mission.start: title is required' };
      }
      // 캡: 채널 topic 캡 재사용(§2).
      if (title.length > CHANNEL_TOPIC_MAX) {
        return { ok: false, error: `task.mission.start: title exceeds ${CHANNEL_TOPIC_MAX} characters` };
      }
      // DoS 캡: 워크스페이스당 open 태스크 상한(§2·§6).
      const openCount = [...this.tasks.values()].filter(
        (t) => t.status === 'open' && t.owner.verifiedWorkspaceId === input.verifiedWorkspaceId,
      ).length;
      if (openCount >= WORKTASK_MAX_OPEN_PER_WORKSPACE) {
        return {
          ok: false,
          error: `task.mission.start: open mission limit reached (${WORKTASK_MAX_OPEN_PER_WORKSPACE}) for this workspace`,
        };
      }

      // 0. taskId 서버 선발급(§3.1 topic 선각인에 필요).
      const taskId = this.generateTaskId();
      const nowMs = this.now();

      // 1. 미션 채널 생성(§3.1) — topic에 앵커 선각인. 채널 먼저(역순이면 채널 없는
      //    태스크가 생겨 J1 바닥이 꺼진다).
      const channelResult = await this.channels.create({
        name: this.missionChannelName(title, taskId),
        visibility: 'private',
        topic: missionTopicFor(taskId),
        createdBy: { workspaceId: input.verifiedWorkspaceId, memberId: input.memberId },
        verifiedWorkspaceId: input.verifiedWorkspaceId,
        ...(input.invite && input.invite.length > 0
          ? { members: input.invite.map((m) => ({ workspaceId: m.workspaceId, memberId: m.memberId })) }
          : {}),
      });
      if (!channelResult.ok) {
        return {
          ok: false,
          error: `task.mission.start: mission channel create failed: ${channelResult.error.code}: ${channelResult.error.message}`,
        };
      }
      const channelId = channelResult.channel.id;

      // 2. task.create envelope append → projection 시드.
      const ref: WorkTaskRef = {
        principalId: input.verifiedWorkspaceId,
        verifiedWorkspaceId: input.verifiedWorkspaceId,
      };
      const task: WorkTask = {
        id: taskId,
        title,
        status: 'open',
        missionChannelId: channelId,
        createdAt: nowMs,
        createdBy: ref,
        owner: ref, // §5.1 born-owned: 서버가 createdBy로 강제 투입.
      };
      const payload: WorkTaskCreatePayload = { kind: 'task.create', task };
      const committed = await this.log.append(
        this.envelope(payload, input.verifiedWorkspaceId, input.idempotencyKey),
      );
      if (!committed) {
        // §3 실패 보상: append false(크래시 아님)면 1에서 만든 채널을 즉시 archive.
        // empty-channel reaper는 고아를 못 줍는다(생성자 멤버 잔류 memberCount>0).
        await this.tryArchive(channelId, input.verifiedWorkspaceId);
        return { ok: false, error: 'task.mission.start: daemon log append failed (uncommitted)' };
      }
      this.applyPayload(payload);

      const result: StartMissionOk = { ok: true, taskId, channelId };
      this.idempotencyRecord('start', input.verifiedWorkspaceId, input.idempotencyKey, result);
      return result;
    });
  }

  /**
   * mission.close(§3): authz 게이트(owner OR CEO) → task.close append → projection
   * 적용 → 미션 채널 archive(멱등·no-op 내성).
   *   - 재close: 이미 closed면 멱등 no-op ack(§3 GLM — 에러 아님).
   *   - 채널 상태 무조건 내성: 이미 archived/부재/reaper 소실이면 archive는 no-op.
   */
  closeMission(input: CloseMissionInput): Promise<CloseMissionOk | WorkTaskErr> {
    return this.withWriteLock(async () => {
      // §3 멱등: 응답 유실 재시도 흡수(워크스페이스 스코프 — R2'). 캐시 히트라도
      // 요청 taskId와 불일치하면 미스로 취급한다(2모델 리뷰: 같은 caller가 키를
      // 재사용해 다른 태스크를 close하려는 경우, 이전 성공 영수증을 돌려주면
      // 요청한 close가 조용히 미실행된다 — authz·존재 검증 경로로 흘려보낸다).
      const cached = this.idempotencyHit('close', input.verifiedWorkspaceId, input.idempotencyKey);
      if (cached && (cached as CloseMissionOk).taskId === input.taskId) {
        return cached as CloseMissionOk;
      }

      const task = this.tasks.get(input.taskId);
      if (!task) {
        return { ok: false, error: `task.mission.close: task not found: ${input.taskId}` };
      }
      // authz(§3): owner OR CEO. 태스크 게이트가 1차 방어선(채널 게이트 아님).
      const isOwner = task.owner.verifiedWorkspaceId === input.verifiedWorkspaceId;
      const isCeo =
        this.ceoWorkspaceId !== undefined && this.ceoWorkspaceId === input.verifiedWorkspaceId;
      if (!isOwner && !isCeo) {
        return {
          ok: false,
          error: `task.mission.close: caller ${input.verifiedWorkspaceId} is not the task owner or CEO`,
        };
      }
      // 재close: 이미 closed면 멱등 no-op ack. archive 재시도는 하지 않는다
      // (부트 reconcile 태스크 방향이 담당) — 성립한 close에 대해 caller는 성공을 받는다.
      // A retry on a task already closed via detach reflects detached:true as-is
      // (hardened after review), so the UI doesn't misread it as "detach
      // failed". Conversely, requesting detach late on a task already closed via an
      // ordinary close does not stamp detachedAt — an ordinary close may have
      // already removed the worktree, so detach no longer means anything there.
      if (task.status === 'closed') {
        const result: CloseMissionOk = {
          ok: true,
          taskId: task.id,
          ...(task.detachedAt !== undefined ? { detached: true } : {}),
        };
        this.idempotencyRecord('close', input.verifiedWorkspaceId, input.idempotencyKey, result);
        return result;
      }

      // 1. task.close envelope append → apply to projection. For detach, attach
      //    workspace-detached evidence so a newer daemon can distinguish it from an
      //    ordinary close via detachedAt.
      const closedAt = this.now();
      const payload: WorkTaskClosePayload = {
        kind: 'task.close',
        taskId: task.id,
        closedAt,
        ...(input.detach ? { evidence: { kind: 'workspace-detached', detachedAt: closedAt } } : {}),
      };
      const committed = await this.log.append(
        this.envelope(payload, input.verifiedWorkspaceId, input.idempotencyKey),
      );
      if (!committed) {
        return { ok: false, error: 'task.mission.close: daemon log append failed (uncommitted)' };
      }
      this.applyPayload(payload);

      // 2. 미션 채널 archive — 데몬 내부(owner 신원으로). 실패 내성: 이미 archived/
      //    부재/reaper 소실이면 no-op. close 자체는 성립(로그 커밋됨)이므로 archive
      //    실패는 close를 무르지 않는다(§3 owner-leave 수용 잔여 + reaper 몫).
      const archived = await this.tryArchive(task.missionChannelId, task.owner.verifiedWorkspaceId);

      const result: CloseMissionOk = {
        ok: true,
        taskId: task.id,
        ...(archived ? {} : { archivePending: true }),
        ...(input.detach ? { detached: true } : {}),
      };
      this.idempotencyRecord('close', input.verifiedWorkspaceId, input.idempotencyKey, result);
      return result;
    });
  }

  /**
   * task.update(§5 — J0 예약 이행): 물질화 필드 단조 커밋. 게이트 순서:
   *   1. 존재·open 검사(closed 거부 — 물질화는 살아있는 태스크만).
   *   2. authz(owner OR CEO — close 미러). 물질화는 소유자 행위다.
   *   3. 단조성: 이미 설정된 branch/worktreePath/paneGroupId의 덮어쓰기 거부
   *      (동일 값 재쓰기는 멱등 no-op 허용 — 재시도 흡수).
   *   4. worktreePath 배타 불변식: canonical(realpath+normalize) 정규화 후 동일
   *      경로를 가진 **다른** open 태스크가 있으면 거부. 전역 write 뮤텍스 하 검사라
   *      서로 다른 태스크의 동시 update가 같은 경로를 이중 점유하지 못한다.
   * 통과 시 task.update envelope append → projection 적용.
   */
  updateMission(input: UpdateMissionInput): Promise<UpdateMissionOk | WorkTaskErr> {
    return this.withWriteLock(async () => {
      const task = this.tasks.get(input.taskId);
      if (!task) {
        return { ok: false, error: `task.mission.update: task not found: ${input.taskId}` };
      }
      if (task.status === 'closed') {
        // J3 §2(리뷰 CX6): closed 태스크는 prUrl 단독 갱신만 허용 — PR은 close
        // 후에도 생성 가능하다. 물질화 필드 동반 시엔 기존대로 거부.
        const hasMaterialization =
          input.branch !== undefined ||
          input.worktreePath !== undefined ||
          input.paneGroupId !== undefined;
        if (hasMaterialization || input.prUrl === undefined) {
          return { ok: false, error: `task.mission.update: task is closed: ${input.taskId}` };
        }
      }
      // authz(§5): owner OR CEO — close 게이트와 동일 앵커.
      const isOwner = task.owner.verifiedWorkspaceId === input.verifiedWorkspaceId;
      const isCeo =
        this.ceoWorkspaceId !== undefined && this.ceoWorkspaceId === input.verifiedWorkspaceId;
      if (!isOwner && !isCeo) {
        return {
          ok: false,
          error: `task.mission.update: caller ${input.verifiedWorkspaceId} is not the task owner or CEO`,
        };
      }

      // prUrl 형식 게이트(J3 §2 — 리뷰 G5): GitHub PR URL 정합만. 비단조라
      // write-once 방어가 없으므로 형식이 유일한 wire 방어선이다.
      if (input.prUrl !== undefined && !WORKTASK_PR_URL_RE.test(input.prUrl)) {
        return {
          ok: false,
          error: `task.mission.update: prUrl must match https://github.com/{owner}/{repo}/pull/{n}`,
        };
      }

      // 단조성 게이트: 이미 물질화된 필드를 다른 값으로 덮으려 하면 거부.
      // 동일 값은 통과(멱등 재시도 — 아래 patch 조립에서 no-op 필드는 제거).
      const monotonicViolation = (
        field: 'branch' | 'worktreePath' | 'paneGroupId',
        next: string | undefined,
      ): string | null => {
        if (next === undefined) return null;
        const cur = task[field];
        if (cur !== undefined && cur !== next) {
          return `task.mission.update: ${field} is already materialized (monotonic; overwrite refused)`;
        }
        return null;
      };
      for (const [field, next] of [
        ['branch', input.branch],
        ['worktreePath', input.worktreePath],
        ['paneGroupId', input.paneGroupId],
      ] as const) {
        const err = monotonicViolation(field, next);
        if (err) return { ok: false, error: err };
      }

      // 배타 불변식(§5): worktreePath 신규 설정 시 canonical로 정규화 후 다른 open
      // 태스크와 충돌 검사. 이미 같은 값이 설정된 self는 위 단조 게이트를 통과했으니
      // 여기서 재검사할 필요 없지만, 신규 설정 케이스만 걸러 타 태스크와 대조한다.
      const isNewWorktreePath =
        input.worktreePath !== undefined && task.worktreePath === undefined;
      if (isNewWorktreePath) {
        const canonical = this.canonicalWorktreePath(input.worktreePath as string);
        for (const other of this.tasks.values()) {
          if (other.id === task.id) continue;
          if (other.status !== 'open') continue;
          if (other.worktreePath === undefined) continue;
          if (this.canonicalWorktreePath(other.worktreePath) === canonical) {
            return {
              ok: false,
              error: `task.mission.update: worktreePath already claimed by open task ${other.id}`,
            };
          }
        }
      }

      // patch 조립: 실제 변경(신규 값)만 담는다. 동일 값 재쓰기 필드는 제외해
      // 로그를 no-op 레코드로 오염시키지 않는다.
      const patch: WorkTaskUpdatePayload = { kind: 'task.update', taskId: task.id };
      let changed = false;
      if (input.branch !== undefined && task.branch === undefined) {
        patch.branch = input.branch;
        changed = true;
      }
      if (input.worktreePath !== undefined && task.worktreePath === undefined) {
        patch.worktreePath = input.worktreePath;
        changed = true;
      }
      if (input.paneGroupId !== undefined && task.paneGroupId === undefined) {
        patch.paneGroupId = input.paneGroupId;
        changed = true;
      }
      // prUrl(J3 §2): 비단조 — 현재 값과 다르면 갱신(동일 값 재쓰기는 no-op).
      if (input.prUrl !== undefined && task.prUrl !== input.prUrl) {
        patch.prUrl = input.prUrl;
        changed = true;
      }
      // 변경 없음(전부 동일 값 재시도) = 멱등 성공 no-op(append 없이).
      if (!changed) {
        return { ok: true, taskId: task.id };
      }

      const committed = await this.log.append(
        this.envelope(patch, input.verifiedWorkspaceId),
      );
      if (!committed) {
        return { ok: false, error: 'task.mission.update: daemon log append failed (uncommitted)' };
      }
      this.applyPayload(patch);
      return { ok: true, taskId: task.id };
    });
  }

  // ── read ───────────────────────────────────────────────────────────

  /** task.mission.list(§3): caller가 owner인 미션 목록(J0 파이프 RPC 전용). */
  listMissions(verifiedWorkspaceId: string): WorkTask[] {
    const out: WorkTask[] = [];
    for (const task of this.tasks.values()) {
      if (task.owner.verifiedWorkspaceId === verifiedWorkspaceId) out.push(task);
    }
    return out;
  }

  getTask(taskId: string): WorkTask | undefined {
    return this.tasks.get(taskId);
  }

  /**
   * Channel retention anchor: is there an **open** task pointing at this channel
   * as its mission channel? This stops the channel retention sweep
   * (ChannelService.sweepRetention) from destroying the channel of a live mission
   * and turning its `#` link into CHANNEL_NOT_FOUND. The projection is bounded by
   * the closed-task GC, so the linear scan is cheap (called once per hour on this path).
   */
  hasOpenTaskForChannel(channelId: string): boolean {
    if (!channelId) return false;
    for (const task of this.tasks.values()) {
      if (task.status === 'open' && task.missionChannelId === channelId) return true;
    }
    return false;
  }

  /** 관측용(테스트/디버그): 현재 projection 태스크 수. */
  get taskCount(): number {
    return this.tasks.size;
  }

  // ── 내부 ────────────────────────────────────────────────────────────

  /**
   * archive 시도(멱등·내성). CHANNEL_NOT_FOUND / 이미 archived는 no-op(§3 R5).
   * NOT_AUTHORIZED(owner-leave 수용 잔여)·PERSIST_FAILED도 삼킨다 — 부트/close
   * 경로 모두 archive 실패가 정본(태스크 로그)을 무르지 않게 한다.
   */
  private async tryArchive(channelId: string, verifiedWorkspaceId: string): Promise<boolean> {
    try {
      const res = await this.channels.archive({
        channelId,
        archivedBy: verifiedWorkspaceId,
        verifiedWorkspaceId,
      });
      // 성공·실패 코드 모두 무해 처리 — CHANNEL_NOT_FOUND/CHANNEL 이미 archived/
      // NOT_AUTHORIZED는 §3 계약상 no-op으로 삼킨다. 확정 여부만 반환(J3 CX2:
      // 미확정이면 close 응답에 archivePending으로 표시 — 부트 reconcile 수렴).
      return res.ok === true;
    } catch {
      // 채널 서비스 예외도 삼킨다 — 태스크 무결성은 채널 실존에 의존하지 않는다.
      return false;
    }
  }

  /** 미션 채널 이름 `mission-{slug}-{shortId}`(§3.1 — 충돌은 shortId 흡수). */
  private missionChannelName(title: string, taskId: string): string {
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32);
    // shortId는 taskId의 **끝** 8자(= random 세그먼트). 앞 8자는 now().toString(36)
    // 타임스탬프라(현 epoch에서 정확히 8자) 엔트로피가 0 — 같은 ms·같은 title 두
    // start가 동일 채널명을 만들어 중복 거부로 자기 DoS된다(리뷰 Claude R4').
    const shortId = taskId.replace(/^wtask-/, '').slice(-8);
    const base = slug.length > 0 ? `mission-${slug}-${shortId}` : `mission-${shortId}`;
    // 채널 이름 규칙: 소문자/숫자로 시작. slug가 숫자·하이픈으로 시작하면 접두가 'mission-'이라 항상 안전.
    return base.slice(0, 64);
  }

  private generateTaskId(): string {
    return `wtask-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /**
   * worktreePath의 canonical 형(§5 배타 불변식 비교 키). 심링크 해석(realpath —
   * 주입, 실패 시 원본)을 먼저 적용한 뒤 순수 문자열 정규화(shared)로 접는다.
   * 서로 다른 표기·심링크 경유의 같은 체크아웃을 하나로 모은다.
   */
  private canonicalWorktreePath(raw: string): string {
    let resolved = raw;
    try {
      resolved = this.realpath(raw);
    } catch {
      // realpath 실패(경로 부재 등) — 문자열 정규화만으로 폴백.
    }
    return normalizeWorktreePath(resolved);
  }

  /** makeEnvelope 초안 조립(발급 필드는 append 소관). trustTier는 채널·A2A와 동형 보수 등급. */
  private envelope(
    payload: unknown,
    verifiedWorkspaceId: string,
    idempotencyKey?: string,
  ): EventEnvelopeDraft {
    return makeEnvelope({
      domain: 'task',
      payload,
      origin: this.origin,
      authContext: this.buildAuthContext(verifiedWorkspaceId),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
  }

  private buildAuthContext(verifiedWorkspaceId: string): AuthContext {
    const trustTier: TrustTier = 'semi-trusted';
    return {
      // principalId는 display/routing/감사 전용(authz 아님) — J0은 워크스페이스로 스탬프.
      principalId: verifiedWorkspaceId,
      verifiedWorkspaceId,
      trustTier,
    };
  }

  /**
   * 멱등 키는 `{op}:{verifiedWorkspaceId}:{key}` — caller의 서버핀 워크스페이스로
   * 네임스페이스한다(2모델 리뷰 R2'). 무스코프 전역 키는 ① 타 워크스페이스가
   * 같은 키로 남의 {taskId, channelId} 결과(private 채널 id 누출)를 받고 ② close
   * 캐시 히트가 owner 게이트보다 먼저 반환돼 authz를 우회한다. A2aTaskService가
   * (taskId, key)로 1차 스코프해 봉쇄한 문제의 동형.
   */
  private idempotencyHit(
    op: 'start' | 'close',
    verifiedWorkspaceId: string,
    key: string | undefined,
  ): StartMissionOk | CloseMissionOk | undefined {
    if (!key) return undefined;
    return this.idempotency.get(`${op}:${verifiedWorkspaceId}:${key}`);
  }

  private idempotencyRecord(
    op: 'start' | 'close',
    verifiedWorkspaceId: string,
    key: string | undefined,
    result: StartMissionOk | CloseMissionOk,
  ): void {
    if (!key) return;
    this.idempotency.set(`${op}:${verifiedWorkspaceId}:${key}`, result);
    // LRU: Map은 삽입 순서 보존 — cap 초과 시 가장 오래된 키부터 축출.
    while (this.idempotency.size > WORKTASK_IDEMPOTENCY_CAP) {
      const oldest = this.idempotency.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.idempotency.delete(oldest);
    }
  }

  /**
   * 서비스 전역 write 직렬화(§2). A2aTaskService.withTaskLock와 동형이나 키가
   * 없다(단일 체인) — 배타 불변식 검사가 서로 다른 태스크의 동시 create를 봐야 하므로.
   */
  private withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(fn, fn);
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}

// normalizeWorktreePath는 §2 배타 불변식(J1 활성)의 정규화 유틸 — 여기서 re-export해
// 데몬측 소비자가 shared 경로를 알 필요 없게 한다(계약 응집).
export { normalizeWorktreePath };
