// ─── channelEvents (PR3) ──────────────────────────────────────────────
// 채널 도메인 replay 적용기의 계약 고정: 결정론 + **멱등**(at-least-once §2.6 및
// 스냅샷 마커 지연 흡수의 전제 — channelEvents.ts 헤더 불변식).

import { describe, it, expect } from 'vitest';
import { applyChannelEvent } from '../channelEvents';
import type { ChannelEventPayload } from '../channelEvents';
import {
  CHANNEL_MESSAGES_MAX,
  type Channel,
  type ChannelMember,
  type ChannelMessage,
  type ChannelState,
} from '../../../shared/channels';

function freshState(): ChannelState {
  return { version: 1, channels: [], members: {}, messages: {}, idempotency: {} };
}

function ch(id: string): Channel {
  return {
    id,
    companyId: 'co',
    name: `name-${id}`,
    visibility: 'public',
    status: 'active',
    createdAt: 1000,
    createdBy: 'ws-1',
    nextSeq: 1,
  };
}

function member(ws: string, mid: string): ChannelMember {
  return { workspaceId: ws, memberId: mid, joinedAt: 1000, historyFromSeq: 0, lastReadSeq: 0 };
}

function msg(channelId: string, seq: number, ws = 'ws-1', mid = 'm-1'): ChannelMessage {
  return {
    channelId,
    seq,
    workspaceId: ws,
    memberId: mid,
    memberName: mid,
    text: `t${seq}`,
    postedAt: 1000 + seq,
    deliveryStatus: 'pending',
    recipientSnapshot: [{ workspaceId: 'ws-2', memberId: 'm-2', status: 'pending' }],
  };
}

/** 동일 payload 2회 적용 == 1회 적용 (멱등 계약). */
function expectIdempotent(state: ChannelState, payload: ChannelEventPayload): void {
  applyChannelEvent(state, payload);
  const after = JSON.parse(JSON.stringify(state));
  applyChannelEvent(state, payload);
  expect(state).toEqual(after);
}

describe('applyChannelEvent — 멱등 replay 적용기', () => {
  it('create: 채널·초기멤버 적용, 재적용 no-op', () => {
    const s = freshState();
    expectIdempotent(s, { kind: 'create', channel: ch('c1'), members: [member('ws-1', 'm-1')] });
    expect(s.channels).toHaveLength(1);
    expect(s.members['c1']).toHaveLength(1);
    expect(s.messages['c1']).toEqual([]);
  });

  it('join/invite: 멤버 추가 + emptySince 해제, 중복 행 재적용 no-op', () => {
    const s = freshState();
    applyChannelEvent(s, { kind: 'create', channel: { ...ch('c1'), emptySince: 500 }, members: [] });
    expectIdempotent(s, { kind: 'join', channelId: 'c1', member: member('ws-2', 'm-2') });
    expect(s.members['c1']).toHaveLength(1);
    expect(s.channels[0].emptySince).toBeUndefined();
    expectIdempotent(s, { kind: 'invite', channelId: 'c1', member: member('ws-3', 'm-3') });
    expect(s.members['c1']).toHaveLength(2);
  });

  it('leave/kick: 행 제거 + 판정된 emptySince 적용, 재적용 no-op', () => {
    const s = freshState();
    applyChannelEvent(s, { kind: 'create', channel: ch('c1'), members: [member('ws-2', 'm-2')] });
    expectIdempotent(s, {
      kind: 'leave', channelId: 'c1', workspaceId: 'ws-2', memberId: 'm-2', emptySince: 2000,
    });
    expect(s.members['c1']).toHaveLength(0);
    expect(s.channels[0].emptySince).toBe(2000);
  });

  it('purge: matcher 동형(principalId 우선), 재적용 no-op', () => {
    const s = freshState();
    const m = { ...member('ws-2', 'm-2'), principalId: 'p-2' };
    applyChannelEvent(s, { kind: 'create', channel: ch('c1'), members: [m, member('ws-2', 'other')] });
    expectIdempotent(s, { kind: 'purge', channelId: 'c1', workspaceId: 'ws-2', principalId: 'p-2' });
    // principalId 매치 행만 제거 — 같은 ws의 다른 행은 생존.
    expect(s.members['c1'].map((r) => r.memberId)).toEqual(['other']);
  });

  it('archive: 상태 전이, 재적용 no-op', () => {
    const s = freshState();
    applyChannelEvent(s, { kind: 'create', channel: ch('c1'), members: [] });
    expectIdempotent(s, { kind: 'archive', channelId: 'c1', archivedAt: 3000, archivedBy: 'ws-1' });
    expect(s.channels[0].status).toBe('archived');
    expect(s.channels[0].archivedAt).toBe(3000);
  });

  it('post: 메시지 push + nextSeq 전진 + 커서 라이드 + 멱등 인덱스, 같은 seq 재적용 no-op', () => {
    const s = freshState();
    applyChannelEvent(s, {
      kind: 'create', channel: ch('c1'), members: [{ ...member('ws-1', 'm-1'), lastReadSeq: 0 }],
    });
    const m = { ...msg('c1', 1), clientMsgId: 'cli-1' };
    expectIdempotent(s, {
      kind: 'post', channelId: 'c1', message: m,
      cursorRide: { workspaceId: 'ws-1', memberId: 'm-1' },
    });
    expect(s.messages['c1']).toHaveLength(1);
    expect(s.channels[0].nextSeq).toBe(2);
    expect(s.members['c1'][0].lastReadSeq).toBe(1); // 라이드 적용, 재적용 무해
    expect(s.idempotency['c1'][JSON.stringify(['ws-1', 'cli-1'])]).toBe(1);
  });

  it('post: 히스토리 캡 초과 시 trim + 잘린 seq의 멱등 엔트리 드롭(라이브 A2와 동형)', () => {
    const s = freshState();
    applyChannelEvent(s, { kind: 'create', channel: ch('c1'), members: [] });
    // 첫/마지막 메시지에만 clientMsgId — trim-프룬을 LRU 캡 축출과 분리해 검증.
    for (let i = 1; i <= CHANNEL_MESSAGES_MAX + 1; i++) {
      const withKey = i === 1 || i === CHANNEL_MESSAGES_MAX + 1;
      applyChannelEvent(s, {
        kind: 'post', channelId: 'c1',
        message: { ...msg('c1', i), ...(withKey ? { clientMsgId: `cli-${i}` } : {}) },
      });
    }
    expect(s.messages['c1']).toHaveLength(CHANNEL_MESSAGES_MAX);
    expect(s.messages['c1'][0].seq).toBe(2); // seq 1 잘림
    // 잘린 seq(1)를 가리키던 멱등 엔트리는 드롭, 보존 구간 엔트리는 생존.
    expect(s.idempotency['c1'][JSON.stringify(['ws-1', 'cli-1'])]).toBeUndefined();
    expect(
      s.idempotency['c1'][JSON.stringify(['ws-1', `cli-${CHANNEL_MESSAGES_MAX + 1}`])],
    ).toBe(CHANNEL_MESSAGES_MAX + 1);
  });

  it('ack: pending→delivered 플립 + advance-only 커서(head 클램프), 재적용 no-op', () => {
    const s = freshState();
    applyChannelEvent(s, {
      kind: 'create', channel: ch('c1'), members: [{ ...member('ws-2', 'm-2'), lastReadSeq: 0 }],
    });
    applyChannelEvent(s, { kind: 'post', channelId: 'c1', message: msg('c1', 1) });
    expectIdempotent(s, {
      kind: 'ack', channelId: 'c1', workspaceId: 'ws-2', memberId: 'm-2',
      uptoSeq: 99, ackedAt: 5000, // head(1) 클램프 검증 겸용
    });
    const m = s.messages['c1'][0];
    expect(m.deliveryStatus).toBe('delivered');
    expect(m.recipientSnapshot?.[0].status).toBe('delivered');
    expect(m.recipientSnapshot?.[0].lastAttemptAt).toBe(5000);
    expect(s.members['c1'][0].lastReadSeq).toBe(1); // min(99, nextSeq-1)
  });

  it('ack: 커서 역행 불가(advance-only)', () => {
    const s = freshState();
    applyChannelEvent(s, {
      kind: 'create', channel: { ...ch('c1'), nextSeq: 6 },
      members: [{ ...member('ws-2', 'm-2'), lastReadSeq: 5 }],
    });
    applyChannelEvent(s, {
      kind: 'ack', channelId: 'c1', workspaceId: 'ws-2', memberId: 'm-2', uptoSeq: 3, ackedAt: 1,
    });
    expect(s.members['c1'][0].lastReadSeq).toBe(5); // 역행 없음
  });

  it('legacy-reseed 마커·미지 kind·비객체 payload: 전부 무동작 통과', () => {
    const s = freshState();
    const before = JSON.parse(JSON.stringify(s));
    applyChannelEvent(s, { kind: 'legacy-reseed', reseedNumber: 1, stateHash: 'h', detectedAt: 1 });
    applyChannelEvent(s, { kind: 'future-unknown-kind', whatever: true });
    applyChannelEvent(s, null);
    applyChannelEvent(s, 'garbage');
    expect(s).toEqual(before);
  });

  it('부재 채널 대상 이벤트(리퍼로 프룬된 채널의 잔존 레코드): 무동작', () => {
    const s = freshState();
    const before = JSON.parse(JSON.stringify(s));
    applyChannelEvent(s, { kind: 'post', channelId: 'gone', message: msg('gone', 1) });
    applyChannelEvent(s, { kind: 'ack', channelId: 'gone', workspaceId: 'ws-1', uptoSeq: 1, ackedAt: 1 });
    applyChannelEvent(s, { kind: 'archive', channelId: 'gone', archivedAt: 1, archivedBy: 'w' });
    expect(s).toEqual(before);
  });
  it('trash: active 채널을 같은 커밋에서 archive + trash 마킹(멱등)', () => {
    const s = freshState();
    applyChannelEvent(s, { kind: 'create', channel: ch('c1'), members: [member('ws-1', 'm-1')] });
    const p: ChannelEventPayload = {
      kind: 'trash',
      channelId: 'c1',
      trashedAt: 5000,
      trashedBy: 'ws-human',
      archivedAt: 5000,
      archivedBy: 'ws-human',
    };
    applyChannelEvent(s, p);
    const after = JSON.parse(JSON.stringify(s));
    applyChannelEvent(s, p); // 재적용 = 무변화
    expect(s).toEqual(after);
    expect(s.channels[0].status).toBe('archived');
    expect(s.channels[0].trashedAt).toBe(5000);
    expect(s.channels[0].trashedBy).toBe('ws-human');
  });

  it('trash: 이미 archived면 archive 효과 없이 마커만(archivedAt 보존)', () => {
    const s = freshState();
    applyChannelEvent(s, { kind: 'create', channel: ch('c1'), members: [member('ws-1', 'm-1')] });
    applyChannelEvent(s, { kind: 'archive', channelId: 'c1', archivedAt: 1000, archivedBy: 'ws-1' });
    applyChannelEvent(s, { kind: 'trash', channelId: 'c1', trashedAt: 5000, trashedBy: 'ws-human' });
    expect(s.channels[0].archivedAt).toBe(1000);
    expect(s.channels[0].archivedBy).toBe('ws-1');
    expect(s.channels[0].trashedAt).toBe(5000);
  });

  it('restore: 마커만 제거하고 archived는 유지(멱등)', () => {
    const s = freshState();
    applyChannelEvent(s, { kind: 'create', channel: ch('c1'), members: [member('ws-1', 'm-1')] });
    applyChannelEvent(s, {
      kind: 'trash',
      channelId: 'c1',
      trashedAt: 5000,
      trashedBy: 'ws-human',
      archivedAt: 5000,
      archivedBy: 'ws-human',
    });
    applyChannelEvent(s, { kind: 'restore', channelId: 'c1' });
    const after = JSON.parse(JSON.stringify(s));
    applyChannelEvent(s, { kind: 'restore', channelId: 'c1' });
    expect(s).toEqual(after);
    expect(s.channels[0].status).toBe('archived');
    expect(s.channels[0].trashedAt).toBeUndefined();
    expect(s.channels[0].trashedBy).toBeUndefined();
  });

  it('destroy: 대상 채널의 4개 맵만 제거하고 이웃은 보존(멱등)', () => {
    const s = freshState();
    applyChannelEvent(s, { kind: 'create', channel: ch('c1'), members: [member('ws-1', 'm-1')] });
    applyChannelEvent(s, { kind: 'create', channel: ch('c2'), members: [member('ws-1', 'm-1')] });
    applyChannelEvent(s, { kind: 'post', channelId: 'c1', message: msg('c1', 1) });
    applyChannelEvent(s, { kind: 'post', channelId: 'c2', message: msg('c2', 1) });

    applyChannelEvent(s, { kind: 'destroy', channelId: 'c1' });
    const after = JSON.parse(JSON.stringify(s));
    applyChannelEvent(s, { kind: 'destroy', channelId: 'c1' }); // 재적용 = 무변화
    expect(s).toEqual(after);

    expect(s.channels.map((c) => c.id)).toEqual(['c2']);
    expect(s.members['c1']).toBeUndefined();
    expect(s.messages['c1']).toBeUndefined();
    expect(s.idempotency['c1']).toBeUndefined();
    // 이웃 불변.
    expect(s.members['c2']).toHaveLength(1);
    expect(s.messages['c2']).toHaveLength(1);
  });

  it('부재 채널 대상 trash/restore: 무동작', () => {
    const s = freshState();
    const before = JSON.parse(JSON.stringify(s));
    applyChannelEvent(s, { kind: 'trash', channelId: 'gone', trashedAt: 1, trashedBy: 'w' });
    applyChannelEvent(s, { kind: 'restore', channelId: 'gone' });
    applyChannelEvent(s, { kind: 'destroy', channelId: 'gone' });
    expect(s).toEqual(before);
  });
});
