/**
 * A2A 태스크 도메인(`domain:'a2a'`)의 로그 payload 스키마 (envelope-design §5 D11).
 *
 * ┌── PROTOCOL 파일: additive-only 규약 ──────────────────────────────┐
 * │ 이 payload는 append-only 로그에 영속된다. 부트 replay가 과거 레코드를    │
 * │ 이 스키마로 재파싱하므로:                                              │
 * │   - 필드를 제거·개명·의미변경하지 마라(과거 레코드 파싱 붕괴).           │
 * │   - 새 필드는 옵셔널(`?:`)로만 추가하라(구 레코드엔 부재).              │
 * │   - kind 값은 추가만 허용, 기존 값 재사용 금지.                        │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * envelope.payload는 도메인 opaque다(eventlog.ts §1 필드표) — 로그 계층은
 * 이 타입을 해석하지 않는다. 해석·projection 적용은 A2aTaskService의 몫이다.
 */

import type { Task, TaskState, Message, CompletionEvidence } from './types';
import type { A2aRemoteReceipt, A2aRemoteTaskMarkerV1 } from './a2aRemote';

/**
 * A2A 로그 payload 판별 union. kind가 닫힌 enum이라 projection이 미지 kind를
 * 안전하게 무시(fail-closed)한다. evidence는 §6.M 완료증거 스키마다 — 완료증거
 * 게이트(PR-B)는 A2aTaskService.transition이 강제하고, 이 payload는 게이트를 통과한
 * 증거를 실어 나른다(스키마 자체는 검증 로직이 아니라 운반 계약).
 */
export type A2aEventPayload =
  | A2aTaskCreatePayload
  | A2aTaskTransitionPayload
  | A2aTaskCancelPayload
  | A2aExecutorLifecyclePayload
  | A2aTaskMessagePayload
  | A2aRemoteMarkPayload;

/** 태스크 생성 — 정본 레코드 1건을 통째로 실어 projection 시드. */
export interface A2aTaskCreatePayload {
  kind: 'task.create';
  task: Task;
}

/**
 * 상태 전이(working/completed/failed/input-required). VALID_TRANSITIONS는
 * A2aTaskService가 데몬측에서 강제한다(성공 종단='completed', types.ts:624).
 */
export interface A2aTaskTransitionPayload {
  kind: 'task.transition';
  taskId: string;
  to: TaskState;
  /** ISO 8601 — 전이 시각. projection의 status.timestamp/updatedAt에 반영. */
  timestamp: string;
  /** 사람용 상태 메시지(있을 때만). 기계용 evidence와 분리(§① E1). */
  message?: Message;
  /**
   * §6.M 완료증거 — normalizeCompletionEvidenceWire로 재검증 후 저장한다. 완료증거
   * 게이트(PR-B)는 A2aTaskService.transition이 강제한다(completed=구조화 증거,
   * failed=사유). verified≥1은 게이트가 아니라 등급(§② E9)이라 verifiedItemCount로 표기.
   */
  evidence?: CompletionEvidence;
  /** 감사·등급용 검증 아이템 수(0=unverified 완료). 전이 게이트 아님(§② E9). */
  verifiedItemCount?: number;
  /**
   * 강제-실패 감사 마커(완료증거 설계 §③ E10). 부재=일반 전이. `'workspace_removed'`
   * =수신 workspace teardown으로 인한 force-fail(`failTasksForWorkspaceRemoved`) —
   * VALID_TRANSITIONS를 의도적으로 우회한 전이임을 로그에서 구별한다(submitted/
   * input-required→failed는 그래프상 불가한데 수신자 소멸로 어떤 non-terminal도
   * 전진 불가하므로 정당). 일반 transition API로는 이 값이 실리지 않는다.
   */
  forced?: 'workspace_removed' | 'remote_state' | 'remote_held_rejected' | 'remote_link_ended' | 'remote_refused';
  /**
   * Cross-host A2A: the peer's messageId when this transition came from the
   * other host (`forced: 'remote_state'` for a terminal one). Replay re-seeds the
   * per-task remote-message dedupe from it.
   */
  remoteMessageId?: string;
  /**
   * Reopen marker. `'sender_message'` = the sender wrote to a task that had
   * already ended, so it went back to `submitted` for the receiver
   * (`reopenTask`). Like `forced`, this bypasses VALID_TRANSITIONS on purpose;
   * the regular transition API never carries it.
   */
  reopened?: 'sender_message';
}

/** 취소(canceled) — sender/receiver 모두 가능(권한은 서비스가 판정). */
export interface A2aTaskCancelPayload {
  kind: 'task.cancel';
  taskId: string;
  timestamp: string;
  /** Cross-host A2A: the peer's messageId when the cancel came from the other host. */
  remoteMessageId?: string;
}

/**
 * Cross-host A2A: one message appended to a remote task's history (a reply in
 * either direction). `message.messageId` is the envelope's messageId, which is
 * the dedupe key for a redelivered reply.
 */
export interface A2aTaskMessagePayload {
  kind: 'task.message';
  taskId: string;
  message: Message;
  timestamp: string;
  /** The peer host wrote it: it is owed a delivery to our local pane. */
  remoteInbound?: true;
}

/**
 * Cross-host A2A: main's delivery outcome for an inbound remote task.
 * `delivered: true` clears any hold; a `held` reason keeps it undelivered.
 */
export interface A2aRemoteMarkPayload {
  kind: 'remote.mark';
  taskId: string;
  /** Set: the mark is for this inbound reply/state item, not the task itself. */
  messageId?: string;
  delivered?: boolean;
  held?: NonNullable<A2aRemoteTaskMarkerV1['held']>;
  /** With `delivered`: the paste stayed in the composer (Enter withheld). */
  note?: 'pasted-not-submitted';
  /** With `delivered`: the pty written to — the local pane's new occupant snapshot. */
  ptyId?: string;
  /** true: main is about to paste (recorded BEFORE the write); false: that attempt wrote nothing. */
  attempted?: boolean;
  /** Task-level: this state was queued for the peer (it no longer owes it). */
  stateSync?: TaskState;
  /** Task-level: this reply of ours was queued for the peer. */
  sent?: string;
  /** Task-level, inbound: our side read the task now. */
  read?: true;
  /** Task-level, inbound: this receipt was queued for the peer. */
  receiptSync?: A2aRemoteReceipt;
  /** Task-level, outbound: the peer sent this receipt. */
  remoteReceipt?: A2aRemoteReceipt;
  /** Task-level: the peer acked every reply / state of ours queued on this task. */
  replyAcked?: true;
  timestamp: string;
}

/**
 * 실행자 생애 이벤트 — **Q1 스키마 예약만**(envelope §5 델타 ⑧, §6.F).
 *
 * execute의 2-프로세스 문제(task 상태=데몬 로그, ClaudeWorker=Main 잔존)의 화해
 * 프로토콜은 §6.F/Q1-4 몫이다. 여기서는 도메인 슬롯·필드만 예약한다 — **기록·펜싱·
 * 하트비트 구현은 아직 없다**. heartbeat(주기·손실허용)는 §6.F 구현 시 §2.7 relaxed
 * 스트림의 첫 소비자로 배정 예정이고, spawn/exit(저빈도)만 커밋 스트림 후보다.
 * A2aTaskService는 이 kind를 append하지 않으며, projection도 무시한다(예약 슬롯).
 */
export interface A2aExecutorLifecyclePayload {
  kind: 'executor-lifecycle';
  taskId: string;
  event: 'spawn' | 'heartbeat' | 'exit';
  /** §6.F 펜싱 토큰 예약 — Q1 미사용(stale 강등×워커 생존 화해는 미래). */
  fenceToken?: number;
}
