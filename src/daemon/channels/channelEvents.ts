/**
 * 채널 도메인 이벤트 payload + 부트 replay 적용기 (envelope-design §5, PR3).
 *
 * payload는 "결정된 효과(effect)"를 담는다 — 검증·판정(now()·randomUUID 포함)은
 * 라이브 경로가 이미 끝냈고, replay는 그 결과를 결정론적으로 재적용만 한다.
 * (요청 params를 담아 비즈니스 로직을 재실행하면 now/uuid 비결정성으로 replay가
 * 라이브와 어긋난다 — 효과 기록이 유일한 결정론적 형태다.)
 *
 * ┌── 불변식: 모든 적용기는 멱등이다 ─────────────────────────────────────┐
 * │ (a) at-least-once 계약(§2.6 D17): 승격 레코드·롤백-후-생존 레코드가       │
 * │     replay에 재출현할 수 있다 — 재적용이 무해해야 한다.                   │
 * │ (b) 스냅샷 마커 지연: 스냅샷은 라이브 참조를 write 시점에 직렬화하므로     │
 * │     내용이 마커(snapshotLamport)보다 앞설 수 있다 — 이미 반영된 이벤트의   │
 * │     재적용이 무해해야 마커-이하 보수적 replay가 안전하다.                 │
 * │ 각 적용기는 존재/seq 가드로 이를 보장한다(레코드 정체성 기준).            │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * additive-only: kind 추가만 허용. 기존 kind의 필드 제거·의미변경 금지(디스크 계약).
 * 미지의 kind는 무시(전방 호환 — 미래 데몬이 쓴 레코드를 구 데몬 replay가 통과).
 */

import {
  CHANNEL_IDEMPOTENCY_CAP,
  CHANNEL_MESSAGES_MAX,
  type Channel,
  type ChannelMember,
  type ChannelMessage,
  type ChannelState,
} from '../../shared/channels';

/** 채널 도메인 envelope payload (D16 — 1 커밋 = 1 envelope). */
export type ChannelEventPayload =
  | {
      kind: 'create';
      channel: Channel;
      members: ChannelMember[];
    }
  | {
      kind: 'archive';
      channelId: string;
      archivedAt: number;
      archivedBy: string;
    }
  | {
      /**
       * Trash (soft delete). Trashing an ACTIVE channel archives it in the
       * same commit, so the payload carries both effects — 1 commit = 1
       * envelope (D16). `archivedAt`/`archivedBy` are absent when the channel
       * was already archived (the archive effect is then a no-op).
       */
      kind: 'trash';
      channelId: string;
      trashedAt: number;
      trashedBy: string;
      archivedAt?: number;
      archivedBy?: string;
    }
  | {
      /** Restore from trash. Clears the trash marker; the channel stays archived. */
      kind: 'restore';
      channelId: string;
    }
  | {
      /**
       * Permanent deletion of a trashed channel (empty-trash / TTL sweep).
       * NOT to be confused with `purge`, which removes MEMBER rows. This drops
       * the channel row and its members/messages/idempotency maps together —
       * the same tuple `reapEmptyChannels` prunes.
       *
       * `destroyedBy`/`destroyedAt` are ADDITIVE-ONLY audit fields: the applier
       * ignores them (the record is being removed, so there is nothing to stamp
       * them on), and records written before they existed replay identically.
       * They exist so the event log — the only surviving trace of an
       * irreversible deletion — says who deleted the channel and when.
       */
      kind: 'destroy';
      channelId: string;
      destroyedBy?: string;
      destroyedAt?: number;
    }
  | {
      kind: 'join';
      channelId: string;
      member: ChannelMember;
    }
  | {
      kind: 'invite';
      channelId: string;
      member: ChannelMember;
    }
  | {
      kind: 'leave';
      channelId: string;
      workspaceId: string;
      memberId: string;
      /** 라이브 경로가 판정한 emptySince 스탬프(마지막 멤버 이탈 시에만 존재). */
      emptySince?: number;
    }
  | {
      kind: 'kick';
      channelId: string;
      targetWorkspaceId: string;
      targetMemberId: string;
      emptySince?: number;
    }
  | {
      kind: 'purge';
      channelId: string;
      workspaceId: string;
      memberId?: string;
      principalId?: string;
      emptySince?: number;
    }
  | {
      kind: 'post';
      channelId: string;
      /** 결정 완료된 메시지 행(seq·clientMsgId·mentions 포함) 전체. */
      message: ChannelMessage;
      /** 발신자 커서 라이드(§5 — 라이브에서 lastReadSeq === seq-1일 때만 기록). */
      cursorRide?: { workspaceId: string; memberId: string };
      /** 1b 이름 리프레시가 이 커밋에 포함됐을 때의 확정값. */
      nameRefresh?: { workspaceId: string; memberId: string; memberName: string };
    }
  | {
      kind: 'ack';
      channelId: string;
      workspaceId: string;
      /** 있으면 커서 전진(멤버-스코프), 없으면 수신확인만(receipt-only). */
      memberId?: string;
      uptoSeq: number;
      /** 라이브 ack의 now() — lastAttemptAt 스탬프의 결정론 재현용. */
      ackedAt: number;
    }
  | {
      /**
       * A wake nudge failed to reach its pane (channelWakeWorker). Recorded so
       * the messages it was announcing stop looking `pending` forever — a
       * pending row is a promise that something is still being delivered, and
       * after the pane died nothing is.
       *
       * Scoped on BOTH axes on purpose. One member's dead pane says nothing
       * about a sibling member in the same workspace, and a nudge says nothing
       * about messages outside the range it announced — the member had already
       * read everything at or below its cursor, and anything past the head was
       * posted after the nudge went out.
       *
       * Only FAILURES are recorded. A nudge that landed is not a delivery (the
       * hint reaching a pane is not the agent having read the message), so a
       * success has nothing durable to say and recording one would append to
       * the log on every wake tick.
       */
      kind: 'nudge-failed';
      channelId: string;
      workspaceId: string;
      memberId: string;
      /** The member's cursor when the nudge went out — exclusive lower bound. */
      fromSeqExclusive: number;
      /** The channel head when the nudge went out — inclusive upper bound. */
      toSeqInclusive: number;
      /** 라이브의 now() — lastAttemptAt 스탬프의 결정론 재현용. */
      failedAt: number;
    }
  | {
      /**
       * operator-join (설계 §2.1.1) — 오퍼레이터(사람) 좌석 push + 서버-발행 시스템
       * 메시지 append를 **하나의 envelope**로 묶는다. 두 효과를 한 커밋에 실어
       * 원자성을 보장한다: append-only 로그에서는 좌석만 커밋되고 메시지가 실패하는
       * 부분 상태가 구조적으로 불가능해야 하므로("persist 실패 시 좌석·메시지 원자
       * 롤백"), join+post 두 envelope로 쪼갤 수 없다. 1 커밋 = 1 envelope 불변식
       * 유지(D16). 적용기는 멱등: 좌석은 (workspaceId, memberId) 존재 가드, 메시지는
       * seq 존재/trim된 과거 seq 가드(post 적용기와 동형).
       */
      kind: 'operator-join';
      channelId: string;
      member: ChannelMember;
      message: ChannelMessage;
    }
  | {
      /** §6.4c reseed 마커(migrateToEventLog가 append). 상태는 스냅샷이 운반 — replay 무동작. */
      kind: 'legacy-reseed';
      reseedNumber: number;
      stateHash: string;
      detectedAt: number;
    };

/** 멱등 인덱스 compositeKey — ChannelService와 동일 형식(A11 sender-scoped). */
function idemKey(workspaceId: string, clientMsgId: string): string {
  return JSON.stringify([workspaceId, clientMsgId]);
}

/**
 * 부트 replay 적용기(§5). state를 제자리 변형한다. 이벤트 방출 없음(재구성은 무성).
 * 모든 분기가 멱등 — 파일 헤더의 불변식 참조.
 */
export function applyChannelEvent(state: ChannelState, payload: unknown): void {
  if (payload === null || typeof payload !== 'object') return;
  const p = payload as ChannelEventPayload;
  switch (p.kind) {
    case 'create': {
      if (state.channels.some((c) => c.id === p.channel.id)) return; // 멱등
      state.channels.push({ ...p.channel });
      state.members[p.channel.id] = p.members.map((m) => ({ ...m }));
      state.messages[p.channel.id] = [];
      state.idempotency[p.channel.id] = {};
      return;
    }
    case 'archive': {
      const ch = state.channels.find((c) => c.id === p.channelId);
      if (!ch) return;
      ch.status = 'archived';
      ch.archivedAt = p.archivedAt;
      ch.archivedBy = p.archivedBy;
      return;
    }
    case 'trash': {
      const ch = state.channels.find((c) => c.id === p.channelId);
      if (!ch) return;
      // Idempotent: re-applying stamps the same decided values.
      if (p.archivedAt !== undefined) {
        ch.status = 'archived';
        ch.archivedAt = p.archivedAt;
        if (p.archivedBy !== undefined) ch.archivedBy = p.archivedBy;
      }
      ch.trashedAt = p.trashedAt;
      ch.trashedBy = p.trashedBy;
      return;
    }
    case 'restore': {
      const ch = state.channels.find((c) => c.id === p.channelId);
      if (!ch) return;
      // Idempotent: deleting an absent field is a no-op. The channel stays
      // archived — restore undoes the trashing, not the archiving.
      delete ch.trashedAt;
      delete ch.trashedBy;
      return;
    }
    case 'destroy': {
      // Idempotent: an already-destroyed channel filters to the same arrays.
      // `destroyedBy`/`destroyedAt` are audit-only — deliberately not applied
      // to state, so old records without them replay to the same result.
      state.channels = state.channels.filter((c) => c.id !== p.channelId);
      delete state.members[p.channelId];
      delete state.messages[p.channelId];
      delete state.idempotency[p.channelId];
      return;
    }
    case 'join':
    case 'invite': {
      const ch = state.channels.find((c) => c.id === p.channelId);
      if (!ch) return;
      const members = state.members[p.channelId] ?? [];
      // 멱등: 동일 (workspaceId, memberId) 행이 이미 있으면 재적용 no-op.
      if (
        members.some(
          (m) => m.workspaceId === p.member.workspaceId && m.memberId === p.member.memberId,
        )
      ) {
        return;
      }
      members.push({ ...p.member });
      state.members[p.channelId] = members;
      // 라이브 경로는 join/invite 시 emptySince를 무조건 해제한다.
      delete ch.emptySince;
      return;
    }
    case 'leave':
    case 'kick':
    case 'purge': {
      const ch = state.channels.find((c) => c.id === p.channelId);
      if (!ch) return;
      const members = state.members[p.channelId] ?? [];
      const matches = (m: ChannelMember): boolean => {
        if (p.kind === 'leave') {
          return m.workspaceId === p.workspaceId && m.memberId === p.memberId;
        }
        if (p.kind === 'kick') {
          return (
            m.workspaceId === p.targetWorkspaceId && m.memberId === p.targetMemberId
          );
        }
        // purge — 라이브 matcher와 동형(principalId 우선, 그다음 memberId, 없으면 ws 전체).
        return (
          m.workspaceId === p.workspaceId &&
          (p.principalId !== undefined
            ? m.principalId === p.principalId
            : p.memberId === undefined || m.memberId === p.memberId)
        );
      };
      const survivors = members.filter((m) => !matches(m));
      if (survivors.length === members.length) return; // 멱등: 이미 제거됨
      state.members[p.channelId] = survivors;
      if (
        p.emptySince !== undefined &&
        survivors.length === 0 &&
        ch.emptySince === undefined
      ) {
        ch.emptySince = p.emptySince;
      }
      return;
    }
    case 'post': {
      const ch = state.channels.find((c) => c.id === p.channelId);
      if (!ch) return;
      const msgs = (state.messages[p.channelId] ??= []);
      const seq = p.message.seq;
      // 멱등: 같은 seq가 이미 있으면(스냅샷 선반영·승격 재출현) 재적용 no-op.
      if (msgs.some((m) => m.seq === seq)) return;
      // trim된 역사 가드(패널 CL-3): seq < nextSeq인데 msgs에 없다 = 히스토리 캡이
      // 이미 절단한 과거 post다. 재적용하면 tail에 붙어 순서가 깨지고, 캡 trim이
      // 진짜 보존분을 앞에서 축출한다. 스냅샷이 그 효과(커서·멱등 포함)를 이미
      // 반영했으므로 전체 no-op.
      if (seq < ch.nextSeq) return;
      msgs.push({ ...p.message });
      // nextSeq 전진(라이브의 nextSeq++와 동치 — replay는 seq+1로 클램프 전진).
      if (ch.nextSeq <= seq) ch.nextSeq = seq + 1;
      // 커서 라이드 — 라이브 조건(lastReadSeq === seq-1) 그대로, 재적용은 no-op.
      if (p.cursorRide) {
        const row = (state.members[p.channelId] ?? []).find(
          (m) =>
            m.workspaceId === p.cursorRide!.workspaceId &&
            m.memberId === p.cursorRide!.memberId,
        );
        if (row && row.lastReadSeq === seq - 1) row.lastReadSeq = seq;
      }
      // 1b 이름 리프레시(확정값 세팅 — 멱등).
      if (p.nameRefresh) {
        const row = (state.members[p.channelId] ?? []).find(
          (m) =>
            m.workspaceId === p.nameRefresh!.workspaceId &&
            m.memberId === p.nameRefresh!.memberId,
        );
        if (row) row.memberName = p.nameRefresh.memberName;
      }
      // 멱등 인덱스(state.idempotency)는 로그의 projection(§4) — post 적용이 재구성.
      if (p.message.clientMsgId) {
        const map = (state.idempotency[p.channelId] ??= {});
        map[idemKey(p.message.workspaceId, p.message.clientMsgId)] = seq;
        // cap 초과 시 삽입순 선입 삭제(부트 hydration의 FIFO 시드와 동형 —
        // 라이브 LRU의 recency 정보는 로그에 없으므로 삽입순이 결정론적 대용).
        const keys = Object.keys(map);
        for (let i = 0; keys.length - i > CHANNEL_IDEMPOTENCY_CAP; i++) {
          delete map[keys[i]];
        }
      }
      // 히스토리 캡 trim(A2) — 라이브가 post-커밋 후 적용하는 것과 동일 규칙이라
      // 별도 trim 이벤트 없이 replay가 수렴한다.
      if (msgs.length > CHANNEL_MESSAGES_MAX) {
        const trimmed = msgs.slice(msgs.length - CHANNEL_MESSAGES_MAX);
        state.messages[p.channelId] = trimmed;
        const minSeq = trimmed.length > 0 ? trimmed[0].seq : 0;
        const map = state.idempotency[p.channelId];
        if (map) {
          for (const [k, v] of Object.entries(map)) {
            if (v < minSeq) delete map[k];
          }
        }
      }
      return;
    }
    case 'ack': {
      const ch = state.channels.find((c) => c.id === p.channelId);
      if (!ch) return;
      // 수신확인 플립 — delivered로만 단조 전진하므로 재적용 no-op(멱등).
      // `target_gone`도 승격 대상이다: 실패한 nudge는 그 시점의 배달 시도에 대한
      // 기록일 뿐이고, ack는 수신자가 실제로 읽었다는 더 강한 증거다. 승격하지
      // 않으면 한 번 죽은 pane이 그 메시지를 영구히 미배달로 못박는다.
      for (const m of state.messages[p.channelId] ?? []) {
        if (m.seq > p.uptoSeq) continue;
        for (const entry of m.recipientSnapshot ?? []) {
          if (entry.workspaceId === p.workspaceId && entry.status !== 'delivered') {
            entry.status = 'delivered';
            entry.lastAttemptAt = p.ackedAt;
            if (m.deliveryStatus !== 'delivered') m.deliveryStatus = 'delivered';
          }
        }
      }
      // 커서 전진 — advance-only·head 클램프(라이브와 동일), 역행 불가라 멱등.
      if (p.memberId !== undefined) {
        const cursorTarget = Math.min(p.uptoSeq, ch.nextSeq - 1);
        for (const row of state.members[p.channelId] ?? []) {
          if (row.workspaceId !== p.workspaceId || row.memberId !== p.memberId) continue;
          const current = typeof row.lastReadSeq === 'number' ? row.lastReadSeq : -1;
          if (cursorTarget > current) row.lastReadSeq = cursorTarget;
        }
      }
      return;
    }
    case 'nudge-failed': {
      const ch = state.channels.find((c) => c.id === p.channelId);
      if (!ch) return;
      // pending → target_gone만 건드린다: 이미 delivered면 ack가 더 강한 증거이고,
      // 이미 target_gone이면 재적용 no-op(멱등).
      for (const m of state.messages[p.channelId] ?? []) {
        if (m.seq <= p.fromSeqExclusive || m.seq > p.toSeqInclusive) continue;
        let touched = false;
        for (const entry of m.recipientSnapshot ?? []) {
          if (entry.workspaceId !== p.workspaceId || entry.memberId !== p.memberId) continue;
          if (entry.status !== 'pending') continue;
          entry.status = 'target_gone';
          entry.lastAttemptAt = p.failedAt;
          touched = true;
        }
        if (!touched) continue;
        // 메시지 자체는 살아 있는 수신자가 하나도 없을 때만 따라 내려간다
        // (ack의 "적어도 하나 delivered" 규칙을 뒤집어 읽은 것).
        const anyLive = (m.recipientSnapshot ?? []).some((e) => e.status !== 'target_gone');
        if (!anyLive && m.deliveryStatus === 'pending') m.deliveryStatus = 'target_gone';
      }
      return;
    }
    case 'operator-join': {
      const ch = state.channels.find((c) => c.id === p.channelId);
      if (!ch) return;
      // 두 효과를 독립 멱등 가드로 적용(라이브는 항상 둘 다 실행하지만, 재적용
      // 시 부분 반영 스냅샷도 안전하게 흡수한다).
      // 1) 사람 좌석 push — (workspaceId, memberId) 존재 시 no-op(join 적용기와 동형).
      const members = state.members[p.channelId] ?? [];
      if (
        !members.some(
          (m) => m.workspaceId === p.member.workspaceId && m.memberId === p.member.memberId,
        )
      ) {
        members.push({ ...p.member });
        state.members[p.channelId] = members;
        // operatorJoin은 leave 후 재진입도 "새 좌석" → join과 동일하게 emptySince 해제.
        delete ch.emptySince;
      }
      // 2) 시스템 메시지 append — seq 존재/trim된 과거 seq 가드(post 적용기와 동형).
      //    clientMsgId·cursorRide·nameRefresh 없음(시스템 마커).
      const msgs = (state.messages[p.channelId] ??= []);
      const seq = p.message.seq;
      if (!msgs.some((m) => m.seq === seq) && seq >= ch.nextSeq) {
        msgs.push({ ...p.message });
        if (ch.nextSeq <= seq) ch.nextSeq = seq + 1;
        if (msgs.length > CHANNEL_MESSAGES_MAX) {
          state.messages[p.channelId] = msgs.slice(msgs.length - CHANNEL_MESSAGES_MAX);
        }
      }
      return;
    }
    case 'legacy-reseed':
      return; // 상태는 reseed 스냅샷이 운반(§6.4c) — 마커는 감사 전용.
    default:
      return; // 미지 kind — 전방 호환 통과(additive-only).
  }
}
