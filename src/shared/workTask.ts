/**
 * WorkTask 도메인(`domain:'task'`)의 스키마 + 로그 payload (J0 §2 D2).
 *
 * ┌── PROTOCOL 파일: additive-only 규약 ──────────────────────────────┐
 * │ 이 스키마는 append-only 로그에 영속된다. 부트 replay가 과거 레코드를     │
 * │ 이 타입으로 재파싱하므로(shared/eventlog.ts PROTOCOL 헤더와 동일 규약):  │
 * │   - 필드를 제거·개명·의미변경하지 마라(과거 레코드 파싱 붕괴).           │
 * │   - 새 필드는 옵셔널(`?:`)로만 추가하라(구 레코드엔 부재).              │
 * │   - status·kind enum 값은 추가만 허용, 기존 값 재사용 금지.            │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * WorkTask는 A2A `Task`(shared/types.ts — 에이전트 간 위임 단위)를 오버로드하지
 * 않는다(§1 D1): worktree 미션 단위(branch·worktreePath·paneGroupId·
 * missionChannelId)라 수명주기·전이 그래프가 다르다. 타입 이름·`domain:'task'`
 * 슬롯·RPC `task.mission.*` 접두로 A2A와 물리적으로 분리한다.
 *
 * envelope.payload는 도메인 opaque다 — 로그 계층은 이 타입을 해석하지 않는다.
 * 해석·projection 적용은 WorkTaskService(daemon)의 몫이다.
 */

/**
 * 데몬 스탬프 신원 참조(§2 — §6.L authContext와 동형). authz 앵커는
 * verifiedWorkspaceId다(principalId는 display/routing/감사 전용).
 */
export interface WorkTaskRef {
  principalId: string;
  verifiedWorkspaceId: string;
}

/**
 * 미션 단위 태스크 정본 레코드(§2 D2). J0 전이 그래프는 `open → closed` 하나.
 * 물질화 필드(branch/worktreePath/paneGroupId/prUrl)는 전부 옵셔널 — J1+가
 * `task.update`로 채운다(뒤집기가 아니라 채우기).
 */
export interface WorkTask {
  /** 'wtask-' + UUID. mission.start 진입 시 서버가 선발급(§3 topic 선각인에 필요). */
  id: string;
  /** 사람이 읽는 미션 한 줄. 캡: 채널 topic 캡 상수(CHANNEL_TOPIC_MAX) 재사용. */
  title: string;
  /** J0 전이 그래프는 open→closed 단 하나(§2). */
  status: 'open' | 'closed';
  /** R3 바인딩 — 채널이 아니라 태스크가 링크를 소유(§3). */
  missionChannelId: string;
  createdAt: number;
  closedAt?: number;
  /** 감사 메타(불변). */
  createdBy: WorkTaskRef;
  /**
   * authz 앵커(§3 close 게이트). J0 born-owned: 생성 시 서버가 createdBy로
   * 강제 투입한다(wire 불가 — §5.1). §6.M P2 풀 태스크만 owner 부재로 태어난다
   * (pending = open ∧ owner 부재)지만 J0은 항상 owner 존재.
   */
  owner: WorkTaskRef;
  // ── J1+ 물질화 필드 (J0에선 스키마만, 항상 옵셔널) ──
  branch?: string;
  worktreePath?: string;
  /**
   * 태스크 전용 워크스페이스 id(J1 §1 D1 의미 확정 — J0가 위임한 "그룹 vs 페인
   * 배열" 미결의 판정). 태스크 실행 단위 = 전용 워크스페이스이고, 그 워크스페이스
   * id를 그대로 담는다(신원 축 분리·리부트 생존이 기존 워크스페이스 영속 경로에
   * 무임승차). J0 additive-only 규약상 필드명은 불변, 의미만 확정한다.
   */
  paneGroupId?: string;
  // ── J2 ──
  prUrl?: string;
  /**
   * Detach timestamp (non-destructive close marker). When set, this task was not a
   * "harvest close" but **detached from its parent** — status is still `closed`, but
   * its worktree/branch/PTY/dedicated workspace are untouched and still alive. This
   * is the only signal distinguishing it from an ordinary close. Restored on replay
   * from the close record's `evidence.detachedAt` (workspace-detached). An older
   * daemon doesn't know this field but still recognizes status=closed, so it won't
   * re-attach the child (prevents state resurrection).
   */
  detachedAt?: number;
  // ── §6.M 예약 (P2에서 활성화, J0 미구현 — §5 계약 참조) ──
  /** lease는 데몬 단독 소유(§5.3) — 어떤 caller도 wire로 쓰지 못한다. */
  lease?: { expiresAt: number; claimantRef: string };
}

/**
 * `domain:'task'` 로그 payload 판별 union(§2 D2). kind가 닫힌 enum이라
 * projection이 미지 kind를 안전하게 무시(fail-closed)한다. 로그 계층은 미해석.
 */
export type WorkTaskEventPayload =
  | WorkTaskCreatePayload
  | WorkTaskClosePayload
  | WorkTaskUpdatePayload;

/** 태스크 생성 — 서버 구성 WorkTask를 통째로 실어 projection 시드. */
export interface WorkTaskCreatePayload {
  kind: 'task.create';
  task: WorkTask;
}

/**
 * Evidence for a non-destructive detach close (the first concrete consumer of the
 * §6.M P2 evidence slot). When a close record carries this evidence, a newer daemon
 * interprets it as detach (independence from the parent) and restores
 * `WorkTask.detachedAt`. An older daemon ignores the evidence but still applies the
 * close itself, so it only recognizes status=closed (the parent-child dependency is
 * not resurrected).
 */
export interface WorkTaskDetachEvidence {
  kind: 'workspace-detached';
  /** Detach time (= the close's closedAt). The timestamp that distinguishes it from an ordinary close. */
  detachedAt: number;
}

/**
 * Task close — id, closedAt. `evidence?` used to be the §6.M P2 reserved slot;
 * detach is its first consumer (WorkTaskDetachEvidence). Future evidence kinds
 * widen this union.
 */
export interface WorkTaskClosePayload {
  kind: 'task.close';
  taskId: string;
  closedAt: number;
  /** §6.M P2 completion-evidence slot — detach's non-destructive close is the first concrete consumer (§5.5). */
  evidence?: WorkTaskDetachEvidence;
}

/**
 * J1+ 필드 패치(§2 D2 — 갱신 경로 선예약). J0에선 union에 타입만 예약하고
 * 핸들러는 J1 몫이다(branch/worktreePath/paneGroupId/prUrl 물질화).
 */
export interface WorkTaskUpdatePayload {
  kind: 'task.update';
  taskId: string;
  branch?: string;
  worktreePath?: string;
  paneGroupId?: string;
  prUrl?: string;
}

// ── 상수 캡 (§2 DoS 캡 — 채널 상수 재사용 관례) ─────────────────────────

/**
 * 워크스페이스당 open WorkTask 상한(§2·§6 — 에이전트 start 스팸 방어). 채널
 * 상수(CHANNEL_MAX_MEMBERS)와 동형 수준으로 보수적. 초과 시 명시 에러.
 */
export const WORKTASK_MAX_OPEN_PER_WORKSPACE = 256;

/** §4 멱등 LRU cap — 채널/A2A 상수(1000)와 동형. */
export const WORKTASK_IDEMPOTENCY_CAP = 1000;

/**
 * fan-out 1회 호출당 태스크 상한(J1 §2 — 워크스페이스·PTY 폭주 방어). J0 open
 * 캡(WORKTASK_MAX_OPEN_PER_WORKSPACE=256)과 별개로, 단일 fanout:start 호출이
 * 찍을 수 있는 태스크 수를 8로 제한한다. 초과 시 프리플라이트에서 즉시 거부.
 */
export const FANOUT_MAX_TASKS = 8;

/**
 * fan-out 프롬프트 본문 캡(J1 §4 G5 — argv 한계). `{agentCmd} "$(cat {path})"`의
 * `$(cat)` 치환 결과가 단일 argv가 되므로 Windows 명령줄 한계(8191자)·ARG_MAX를
 * 고려한 플랫폼 최소공배수 8KB. 초과 시 명시 에러("프롬프트를 줄이고 상세는
 * 파일로 만들어 경로를 언급하라").
 */
export const FANOUT_PROMPT_MAX_BYTES = 8 * 1024;

/** closed projection GC 임계(§1 D — 리뷰 반영 GLM: 7일). 인메모리 뷰 바운드다. */
export const WORKTASK_CLOSED_GC_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * prUrl wire 검증(J3 §2 — 리뷰 G5): GitHub PR URL 정합만 수용. prUrl은 비단조
 * mutable 필드라(PR 재생성 갱신 허용) write-once 게이트가 없다 — 형식 게이트가
 * 임의 URL 덮어쓰기를 방어한다.
 */
export const WORKTASK_PR_URL_RE = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/;

/** 미션 채널 topic 앵커 접두(§3) — 고아 reconcile의 유일 마킹. */
export const MISSION_TOPIC_PREFIX = 'wmux:mission:';

/** 미션 topic 앵커 문자열 조립(§3.1 채널 선각인). */
export function missionTopicFor(taskId: string): string {
  return `${MISSION_TOPIC_PREFIX}${taskId}`;
}

/**
 * 미션 topic에서 taskId 추출(§3 부트 reconcile — 채널 방향). 앵커 패턴이
 * 아니면 null. reconcile은 "projection에 없는 taskId"만 archive하므로 위조
 * topic 채널(사용자 수동 생성)도 태스크가 없으면 정리된다(§6 자해 한정).
 */
export function taskIdFromMissionTopic(topic: string | undefined): string | null {
  if (typeof topic !== 'string') return null;
  if (!topic.startsWith(MISSION_TOPIC_PREFIX)) return null;
  const id = topic.slice(MISSION_TOPIC_PREFIX.length);
  return id.length > 0 ? id : null;
}

/**
 * worktreePath 정규화(§2 배타 불변식 — 리뷰 반영 Codex). 서로 다른 표기의
 * 같은 체크아웃을 하나로 접는다: trailing slash 제거·중복 슬래시 접기·
 * 플랫폼 대소문자 정책(대소문자 무구분 FS=win/mac). realpath 해석(심링크)은
 * 데몬 파일시스템 접근이 필요하므로 호출측 몫이고, 여기서는 문자열 정규화만
 * 담당한다(순수 함수 — 테스트 가능).
 *
 * **J0 실효 명시(§2 리뷰 — Claude)**: J0에선 worktreePath가 항상 미설정이라
 * 이 유틸과 배타 불변식은 계약 선언·정규화까지만이고 활성 사용은 J1 몫이다.
 */
export function normalizeWorktreePath(raw: string, platform: NodeJS.Platform = process.platform): string {
  let p = raw.trim();
  if (p.length === 0) return p;
  // 백슬래시(win)를 슬래시로 통일한 뒤 비교(경로 구분자 정규화).
  p = p.replace(/\\/g, '/');
  // 중복 슬래시 접기(단, 선두 UNC `//`는 보존하지 않음 — J0 실효 0이라 단순화).
  p = p.replace(/\/{2,}/g, '/');
  // trailing slash 제거(루트 '/' 제외).
  if (p.length > 1) p = p.replace(/\/+$/, '');
  // 대소문자 무구분 FS(win32/darwin): canonical lower-case 비교.
  if (platform === 'win32' || platform === 'darwin') p = p.toLowerCase();
  return p;
}

/**
 * 태스크 meta dir에 각인하는 디스크 정본 스탬프(J3 §1 D1 — CL5). 태스크
 * projection이 GC(WORKTASK_CLOSED_GC_MS)로 소멸한 뒤에도 전용 루트에 남은
 * worktree 디렉토리를 taskId·title로 역추적할 수 있게 하는 사이드카다.
 * closedAt은 clean close 시 meta dir째 삭제되므로 대개 부재 — close↔meta삭제
 * 사이 크래시로 worktree가 잔존하는 창에서만 관측된다.
 */
export interface WorkTaskMetaStamp {
  taskId: string;
  title: string;
  createdAt: number;
  closedAt?: number;
}

/** meta dir에 스탬프를 쓰는 파일명(J3 §1 — 정리 스캔 역추적 정본). */
export const WORKTASK_META_FILENAME = 'task.json';

// ── J3 IPC wire 결과 타입(렌더러 안전 — node import 없는 순수 데이터) ──────────
// main측 서비스(TaskCloseService·TaskPrService·WorktaskScanService)는 node를
// import하므로 렌더러 번들에 못 들어간다. preload·렌더러가 공유하는 이 wire 타입은
// 그 서비스 반환을 그대로 미러링한다(계약 표류 시 tsc가 잡도록 손으로 정합 유지).

/** task:close 결과(TaskCloseService.CloseTaskResult 미러). */
export type CloseTaskResultWire =
  | { ok: true; taskId: string; archivePending: boolean; unmaterialized?: boolean }
  | {
      ok: false;
      taskId: string;
      reason: 'unpushed' | 'dirty' | 'error';
      error: string;
      preservedWorktree?: string;
      aheadCount?: number;
    };

/** task:create-pr 결과(TaskPrService.CreatePrResult 미러). */
export type CreatePrResultWire =
  | { ok: true; prUrl: string; recovered?: boolean; commitPending?: boolean }
  | {
      ok: false;
      reason: 'gh-missing' | 'gh-unauth' | 'dirty' | 'no-origin' | 'push-failed' | 'pr-failed' | 'error';
      error: string;
      browseFallback?: string;
    };

/** 정리 스캔 항목 4종(WorktaskScanService.WorktaskScanEntry 미러). */
export type WorktaskScanCategoryWire =
  | 'unmaterialized-open'
  | 'disk-missing'
  | 'preserved'
  | 'orphan-dir';

export interface WorktaskScanEntryWire {
  category: WorktaskScanCategoryWire;
  taskId?: string;
  title?: string;
  /** F1 — 열린 태스크 이상 항목의 owner(부모) ws id(정합화 close 신원). */
  ownerWorkspaceId?: string;
  worktreePath?: string;
  closedAt?: number;
  detail?: string;
}

/** worktask:scan 결과(핸들러 반환 미러). */
export type WorktaskScanResultWire =
  | { ok: true; scannedRoot: string; entries: WorktaskScanEntryWire[] }
  | { ok: false; error: string; scannedRoot: string; entries: WorktaskScanEntryWire[] };
